"""Local fixtures only: exercise real process deadlines, signals and HTTP behavior."""
import importlib.util
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
            with patch.object(probe.os, "scandir", side_effect=PermissionError()):
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


if __name__ == "__main__":
    unittest.main()
