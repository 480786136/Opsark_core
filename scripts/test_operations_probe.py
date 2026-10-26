"""Local fixtures only: exercise real process deadlines, signals and HTTP behavior."""
import importlib.util
import ast
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from unittest.mock import patch

sys.dont_write_bytecode = True

location = Path(__file__).resolve().parents[1] / "src/features/tools/operations_probe.py"
spec = importlib.util.spec_from_file_location("operations_probe", location)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def test_unsupported_python_reports_actual_version_without_scanning(self):
        with patch.object(probe.sys, "version_info", (3, 5, 10)):
            result = probe.run("disk.inspect", dict(path="/", check="capacity", timeoutSeconds=3))
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["scannedEntries"], 0)
        self.assertEqual(result["items"], [])
        self.assertIn("python>=3.6 (actual 3.5.10)", [item["path"] for item in result["skipped"]])

    def test_python36_syntax_and_available_capacity_features_are_accepted(self):
        ast.parse(location.read_text(), feature_version=(3, 6))
        with patch.object(probe.sys, "version_info", (3, 6, 8)):
            result = probe.run("disk.inspect", dict(path="/", check="capacity", timeoutSeconds=3))
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["coverageComplete"])
        self.assertGreater(result["items"][0]["totalBytes"], 0)

    def test_fd_scan_requirement_does_not_disable_unrelated_capacity(self):
        with patch.object(probe.os, "supports_fd", set()):
            capacity = probe.run("disk.inspect", dict(path="/", check="capacity", timeoutSeconds=3))
            scan = probe.run("disk.inspect", dict(path="/", check="directory", timeoutSeconds=3))
        self.assertEqual(capacity["status"], "complete")
        self.assertEqual(scan["status"], "unsupported")
        self.assertFalse(scan["coverageComplete"])

    def service(self, **values):
        return dict(check="ports", timeoutSeconds=3, logLines=50, sinceMinutes=30, **values)

    def fake_command(self, script, request=None):
        with tempfile.TemporaryDirectory() as folder:
            executable = Path(folder) / "fixture"
            executable.write_text("#!/bin/sh\n" + script)
            executable.chmod(0o700)
            with patch.object(probe.shutil, "which", return_value=str(executable)):
                return probe.run("services.inspect", request or self.service())

    def test_preserves_nonzero_exit_and_output(self):
        result = self.fake_command("printf 'fixture failed\\n'; exit 7")
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["items"][0]["exitCode"], 7)
        self.assertIn("fixture failed", result["items"][0]["text"])
        self.assertFalse(result["coverageComplete"])

    def test_missing_dependency(self):
        with patch.object(probe.shutil, "which", return_value=None):
            result = probe.run("services.inspect", self.service())
        self.assertEqual(result["status"], "unsupported")
        self.assertFalse(result["coverageComplete"])

    def test_ports_use_existing_netstat_when_ss_is_missing(self):
        with tempfile.TemporaryDirectory() as folder:
            executable = Path(folder) / "netstat"
            executable.write_text("#!/bin/sh\nprintf 'netstat read-only: %s\\n' \"$*\"\n")
            executable.chmod(0o700)
            with patch.object(probe.shutil, "which", side_effect=lambda name: str(executable) if name == "netstat" else None):
                result = probe.run("services.inspect", self.service())
        self.assertEqual(result["status"], "complete")
        self.assertIn("netstat read-only: -lntup", result["items"][0]["text"])

    def test_old_systemctl_property_format_and_empty_output(self):
        request = self.service(); request.update(check="status", service="example.service")
        with patch.object(probe.os.path, "isdir", return_value=True):
            valid = self.fake_command("printf 'Id=example.service\\nLoadState=loaded\\nActiveState=active\\nSubState=running\\n'", request)
            empty = self.fake_command("exit 0", request)
        self.assertEqual(valid["status"], "complete")
        self.assertEqual(empty["status"], "error")
        self.assertFalse(empty["coverageComplete"])

    def test_capabilities_are_observed_not_inferred_option_support(self):
        with patch.object(probe.shutil, "which", side_effect=lambda name: "/usr/bin/" + name if name in ("systemctl", "netstat") else None):
            data = probe.capability_report(dict(request=dict(check="status"), status="unsupported", items=[]))
        facts = {fact["name"]: fact for fact in data["facts"]}
        self.assertFalse(facts["jq"]["supported"])
        self.assertTrue(facts["netstat"]["supported"])
        self.assertIsNone(facts["systemctl.show.properties"]["supported"])
        self.assertNotIn("systemctl.show.value", facts)

    def test_bounded_output_does_not_claim_complete(self):
        result = self.fake_command("while :; do printf '012345678901234567890123456789\\n'; done")
        self.assertEqual(result["status"], "partial")
        self.assertLessEqual(len(result["items"][0]["text"].encode()), 32768)
        self.assertTrue(result["truncated"])

    def test_remote_deadline_kills_subprocess_and_keeps_partial_output(self):
        request = self.service(); request["timeoutSeconds"] = 1
        started = time.monotonic()
        result = self.fake_command("printf 'partial\\n'; sleep 20", request)
        self.assertEqual(result["status"], "timeout")
        self.assertIn("partial", result["items"][0]["text"])
        self.assertLess(time.monotonic() - started, 3)

    def test_cancel_signal_stops_child_and_remains_cancelled(self):
        timer = threading.Timer(0.15, lambda: os.kill(os.getpid(), signal.SIGTERM))
        timer.start()
        try:
            result = self.fake_command("printf 'partial\\n'; sleep 20")
        finally:
            timer.cancel(); timer.join()
        self.assertEqual(result["status"], "cancelled")
        self.assertFalse(result["coverageComplete"])

    def test_permission_error_is_not_empty_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            request = dict(path=folder, check="directory", timeoutSeconds=2, maxEntries=100,
                           maxResults=10, maxDepth=4, sameFilesystem=True, excludePaths=[])
            with patch.object(probe.os, "scandir", side_effect=PermissionError()) as scandir:
                with patch.object(probe.os, "supports_fd", set(probe.os.supports_fd) | {scandir}):
                    result = probe.run("disk.inspect", request)
        self.assertEqual(result["status"], "permission_denied")
        self.assertFalse(result["coverageComplete"])

    def test_health_does_not_follow_redirect_or_read_body(self):
        visited = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                visited.append(self.path)
                self.send_response(302)
                self.send_header("Location", "/must-not-follow")
                self.end_headers()
            def log_message(self, *_args):
                pass
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            request = self.service(); request.update(check="health", url="http://127.0.0.1:%s/health" % server.server_port)
            result = probe.run("services.inspect", request)
        finally:
            server.shutdown(); server.server_close(); thread.join()
        self.assertEqual(result["items"][0]["httpStatus"], 302)
        self.assertEqual(visited, ["/health"])

    def health_body(self, body, limit, stall=False, code=200, early_close=False):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                self.send_response(code)
                self.send_header("Content-Length", str(len(body) + (10 if stall or early_close else 0)))
                self.end_headers()
                self.wfile.write(body)
                self.wfile.flush()
                if stall:
                    time.sleep(1.3)
            def log_message(self, *_args):
                pass
        server = HTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            request = self.service()
            request.update(check="health", url="http://127.0.0.1:%s/health" % server.server_port,
                           maxResponseBytes=limit, timeoutSeconds=1 if stall else 3)
            return probe.run("services.inspect", request)
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_health_text_is_bounded_and_status_not_business_success(self):
        result = self.health_body("未就绪".encode("utf-8"), 9, code=503)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["items"][0]["httpStatus"], 503)
        self.assertEqual(result["items"][0]["body"], "未就绪")
        self.assertEqual(result["items"][0]["returnedBytes"], 9)
        self.assertFalse(result["items"][0]["bodyTruncated"])

    def test_health_body_limit_preserves_valid_utf8_prefix(self):
        result = self.health_body("你好世界".encode("utf-8"), 4)
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverageComplete"])
        self.assertTrue(result["truncated"])
        self.assertEqual(result["items"][0]["body"], "你")
        self.assertEqual(result["items"][0]["returnedBytes"], 3)
        self.assertEqual(result["skipped"][0]["reason"], "output_limit")

    def test_health_binary_is_unavailable_not_complete_text(self):
        for body in (b"a\x00b", b"\xff\x80"):
            result = self.health_body(body, 20)
            self.assertEqual(result["status"], "partial")
            self.assertFalse(result["coverageComplete"])
            self.assertEqual(result["items"][0]["bodyEncoding"], "unavailable")
            self.assertEqual(result["items"][0]["body"], "")
            self.assertEqual(result["items"][0]["returnedBytes"], 0)

    def test_health_stalled_body_keeps_partial_bytes_and_http_status(self):
        result = self.health_body(b"partial", 100, stall=True)
        self.assertEqual(result["status"], "timeout")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["items"][0]["httpStatus"], 200)
        self.assertEqual(result["items"][0]["body"], "partial")
        self.assertTrue(result["items"][0]["bodyTruncated"])

    def test_health_incomplete_http_framing_is_not_complete_body(self):
        result = self.health_body(b"partial", 100, early_close=True)
        self.assertEqual(result["status"], "error")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["items"][0]["body"], "partial")
        self.assertTrue(result["items"][0]["bodyTruncated"])


if __name__ == "__main__":
    unittest.main()
