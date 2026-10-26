"""Real loopback HTTP/TLS/proxy and owned temporary JSONL files. No business hosts."""
import contextlib
import hashlib
import http.client
import http.server
import importlib.util
import json
import os
from pathlib import Path
import socket
import signal
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import uuid
from unittest.mock import patch

location = Path(__file__).resolve().parents[1] / "src/features/tools/http_delivery_probe.py"
spec = importlib.util.spec_from_file_location("http_delivery_probe", location)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


@contextlib.contextmanager
def serving(callback, tls=None):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            callback(self)

        def log_message(self, *_args):
            pass
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.daemon_threads = True
    if tls:
        server.socket = tls.wrap_socket(server.socket, server_side=True)
    worker = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True)
    worker.start()
    try:
        yield server.server_port
    finally:
        server.shutdown()
        server.server_close()
        worker.join(2)


def reply(handler, body=b"hello", status=200, extra=None, length=None):
    handler.send_response(status)
    handler.send_header("Content-Length", str(len(body) if length is None else length))
    handler.send_header("Content-Type", "application/octet-stream")
    for key, value in (extra or {}).items():
        handler.send_header(key, value)
    handler.end_headers()
    try:
        handler.wfile.write(body)
    except (BrokenPipeError, ConnectionResetError):
        pass


class HttpDeliveryTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="opsark-http-delivery-")
        self.addCleanup(self.folder.cleanup)
        self.path = Path(self.folder.name) / "backend.jsonl"
        self.path.write_bytes(b"")

    def request(self, port, **changes):
        value = dict(url="http://delivery.test:%d/site%%2Fasset?a=1&a=2" % port,
                     connectAddress="127.0.0.1", bodyMode="sha256", maxBodyBytes=65536, timeoutSeconds=3)
        value.update(changes)
        return value

    def binding(self, request):
        return dict(executionId="http-execution-1", probeId="opsark-" + str(uuid.uuid4()),
                    requestDigest=probe.sha(probe.canonical(request).encode("utf-8")))

    def backend(self, **changes):
        value = dict(path=str(self.path), injection=dict(kind="query", name="opsark_probe"),
                     probeIdPointer="/probe", requestTargetPointer="/target", expectedRequestTarget="/site%2Fasset?a=1&a=2",
                     authorityPointer="/host", expectedAuthority="backend.test", windowMs=60, maxLogBytes=65536)
        value.update(changes)
        return value

    def record(self, handler, **changes):
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(handler.path).query)
        value = dict(probe=query.get("opsark_probe", [handler.headers.get("X-Request-ID", "")]), target=handler.path, host="backend.test")
        value.update(changes)
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(value) + "\n")

    def test_single_get_preserves_host_query_and_ignores_environment_proxy(self):
        calls = []
        def handler(h):
            calls.append((h.path, h.headers["Host"], h.headers["Accept-Encoding"]))
            reply(h, b"\x00\xff\x89binary")
        with serving(handler) as port, patch.dict(os.environ, {"HTTP_PROXY": "http://127.0.0.1:1", "HTTPS_PROXY": "http://127.0.0.1:1", "ALL_PROXY": "http://127.0.0.1:1"}):
            request = self.request(port)
            result = probe.run(request, self.binding(request))
        self.assertEqual(calls, [("/site%2Fasset?a=1&a=2", "delivery.test:%d" % port, "identity")])
        self.assertTrue(result["coverageComplete"])
        self.assertEqual(result["response"]["body"]["sha256"], hashlib.sha256(b"\x00\xff\x89binary").hexdigest())
        self.assertEqual(result["target"]["peerAddress"], "127.0.0.1")
        self.assertNotIn("text", result["response"]["body"])

    def test_redirect_is_observed_without_following(self):
        calls = []
        with serving(lambda h: (calls.append(h.path), reply(h, b"moved", 302, {"Location": "http://127.0.0.1:1/elsewhere"}))) as port:
            request = self.request(port)
            result = probe.run(request, self.binding(request))
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["response"]["httpStatus"], 302)
        self.assertTrue(result["coverageComplete"])

    def test_binary_utf8_and_over_limit_are_distinct(self):
        for content, mode, limit, expected in [("中文".encode(), "utf8", 6, "complete"), (b"\xff", "utf8", 1, "partial"), (b"12345", "sha256", 4, "partial")]:
            with self.subTest(mode=mode, content=content), serving(lambda h: reply(h, content)) as port:
                request = self.request(port, bodyMode=mode, maxBodyBytes=limit)
                result = probe.run(request, self.binding(request))
                self.assertEqual(result["status"], expected)
                self.assertLessEqual(result["response"]["body"]["readBytes"], limit + 1)
                if expected == "partial":
                    self.assertNotIn("sha256", result["response"]["body"])

    def test_encoded_entity_cannot_masquerade_as_uncompressed_resource(self):
        with serving(lambda h: reply(h, b"encoded", extra={"Content-Encoding": "gzip"})) as port:
            request = self.request(port)
            result = probe.run(request, self.binding(request))
        self.assertEqual(result["reason"], "content_encoding_unsupported")
        self.assertFalse(result["coverageComplete"])
        self.assertNotIn("sha256", result["response"]["body"])

    def test_truncated_transport_is_never_a_complete_hash(self):
        with serving(lambda h: reply(h, b"short", length=100)) as port:
            request = self.request(port)
            result = probe.run(request, self.binding(request))
        self.assertFalse(result["coverageComplete"])
        self.assertTrue(result["response"] is None or not result["response"]["body"]["complete"])

    def test_status_only_never_claims_body_eof_or_digest(self):
        with serving(lambda h: reply(h, b"content")) as port:
            request = self.request(port, bodyMode="none")
            result = probe.run(request, self.binding(request))
        self.assertEqual(result["response"]["body"], dict(mode="none", readBytes=0, eof=False, complete=True, encoding="not_requested"))

    def test_output_limit_removes_text_and_complete_digest(self):
        with serving(lambda h: reply(h, b"\x00" * 100000)) as port:
            request = self.request(port, bodyMode="utf8", maxBodyBytes=131072)
            result = probe.run(request, self.binding(request))
        wire = probe.serialize(result)
        self.assertLessEqual(len(wire.encode()) + 1, 262144)
        self.assertEqual(result["reason"], "output_limit")
        self.assertFalse(result["response"]["body"]["complete"])
        self.assertNotIn("text", result["response"]["body"])
        self.assertNotIn("sha256", result["response"]["body"])

    def test_total_timeout_does_not_retry_http(self):
        calls = []
        def slow(h):
            calls.append(1)
            time.sleep(1.2)
            reply(h)
        with serving(slow) as port:
            request = self.request(port, timeoutSeconds=1)
            started = time.monotonic()
            result = probe.run(request, self.binding(request))
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(len(calls), 1)
        self.assertLess(time.monotonic() - started, 1.5)

    def test_owned_process_cancel_has_single_bound_cancelled_receipt(self):
        entered = threading.Event()
        calls = []
        def slow(h):
            calls.append(1)
            entered.set()
            time.sleep(0.4)
            reply(h)
        with serving(slow) as port:
            request = self.request(port)
            binding = self.binding(request)
            child = subprocess.Popen([sys.executable, "-I", "-B", str(location), json.dumps(dict(request=request, binding=binding))], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                self.assertTrue(entered.wait(2), "owned probe did not dispatch")
                child.send_signal(signal.SIGTERM)
                stdout, stderr = child.communicate(timeout=2)
            finally:
                if child.poll() is None:
                    child.kill(); child.wait()
        self.assertEqual(child.returncode, 0, stderr)
        lines = stdout.decode().splitlines()
        self.assertEqual(len(lines), 1)
        result = json.loads(lines[0][len(probe.MARKER):])
        self.assertEqual(result["binding"], binding)
        self.assertEqual(result["status"], "cancelled")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(calls, [1])

    def certificate(self):
        cert = Path(self.folder.name) / "test-ca.pem"
        key = Path(self.folder.name) / "test-key.pem"
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert),
                        "-days", "1", "-subj", "/CN=delivery.test", "-addext", "subjectAltName=DNS:delivery.test"], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(str(cert), str(key))
        return cert, context

    def test_tls_connect_ip_keeps_url_sni_host_and_verifies_certificate(self):
        cert, server_tls = self.certificate()
        names, hosts = [], []
        server_tls.set_servername_callback(lambda _socket, name, _context: names.append(name))
        trusted = ssl.create_default_context(cafile=str(cert))
        with serving(lambda h: (hosts.append(h.headers["Host"]), reply(h)), server_tls) as port:
            request = self.request(port, url="https://delivery.test:%d/" % port)
            with patch.object(probe, "secure_context", return_value=trusted):
                result = probe.run(request, self.binding(request))
        self.assertEqual(names, ["delivery.test"])
        self.assertEqual(hosts, ["delivery.test:%d" % port])
        self.assertEqual(result["target"]["tlsServerName"], "delivery.test")
        self.assertTrue(result["target"]["tlsVerified"])
        self.assertTrue(result["coverageComplete"])

    def test_tls_wrong_hostname_or_untrusted_ca_rejects_before_get(self):
        cert, server_tls = self.certificate()
        calls = []
        for hostname, trusted in [("wrong.test", True), ("delivery.test", False)]:
            with self.subTest(hostname=hostname), serving(lambda h: (calls.append(1), reply(h)), server_tls) as port:
                request = self.request(port, url="https://%s:%d/" % (hostname, port))
                context = ssl.create_default_context(cafile=str(cert)) if trusted else probe.secure_context()
                with patch.object(probe, "secure_context", return_value=context):
                    result = probe.run(request, self.binding(request))
                self.assertEqual(result["reason"], "tls_verification_failed")
                self.assertFalse(result["target"]["tlsVerified"])
        self.assertEqual(calls, [])

    def test_tls_environment_cannot_create_keylog_or_replace_trust(self):
        keylog = Path(self.folder.name) / "must-not-exist.keys"
        with patch.dict(os.environ, {"SSLKEYLOGFILE": str(keylog), "SSL_CERT_FILE": str(self.path), "SSL_CERT_DIR": self.folder.name}):
            context = probe.secure_context()
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertFalse(keylog.exists())

    def test_real_front_proxy_correlates_only_new_backend_path_and_query(self):
        entries = []
        def backend(h):
            entries.append(h.path)
            self.record(h)
            reply(h, b"backend-response")
        with serving(backend) as backend_port:
            def frontend(h):
                conn = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=1)
                conn.request("GET", h.path, headers={"Host": "backend.test"})
                response = conn.getresponse()
                body = response.read()
                conn.close()
                reply(h, body, response.status)
            with serving(frontend) as port:
                request = self.request(port, backendObservation=self.backend())
                binding = self.binding(request)
                old = dict(probe=binding["probeId"], target=probe.target_for(request, binding)["requestTarget"], host="backend.test")
                self.path.write_text(json.dumps(old) + "\n")
                start = self.path.stat().st_size
                result = probe.run(request, binding)
        correlation = result["correlation"]
        self.assertEqual(correlation["status"], "matched")
        self.assertEqual(correlation["matchedCount"], 1)
        self.assertEqual(correlation["startOffset"], start)
        self.assertEqual(correlation["matchedOffsets"], [start])
        self.assertFalse(correlation["sourceVerified"])
        self.assertEqual(entries, ["/site%2Fasset?a=1&a=2&opsark_probe=" + binding["probeId"]])
        self.assertTrue(result["coverageComplete"])

    def test_header_probe_and_json_pointer_escaped_keys(self):
        def callback(h):
            with self.path.open("a") as stream:
                stream.write(json.dumps({"x/id": {"~probe": h.headers["X-Request-ID"]}, "target": h.path}) + "\n")
            reply(h)
        with serving(callback) as port:
            observation = self.backend(injection=dict(kind="header", name="X-Request-ID"), probeIdPointer="/x~1id/~0probe")
            del observation["authorityPointer"]; del observation["expectedAuthority"]
            request = self.request(port, backendObservation=observation)
            result = probe.run(request, self.binding(request))
        self.assertEqual(result["correlation"]["status"], "matched")
        self.assertEqual(result["target"]["requestTarget"], "/site%2Fasset?a=1&a=2")

    def test_old_only_record_is_not_observed_not_a_new_match(self):
        with serving(lambda h: reply(h)) as port:
            request = self.request(port, backendObservation=self.backend())
            binding = self.binding(request)
            self.path.write_text(json.dumps(dict(probe=binding["probeId"], target=probe.target_for(request, binding)["requestTarget"], host="backend.test")) + "\n")
            result = probe.run(request, binding)
        self.assertEqual(result["correlation"]["status"], "not_observed")
        self.assertTrue(result["correlation"]["coverageComplete"])

    def test_matching_id_wrong_path_or_authority_is_unknown(self):
        for changes in [dict(target="/wrong"), dict(host="wrong.test")]:
            with self.subTest(changes=changes), serving(lambda h: (self.record(h, **changes), reply(h))) as port:
                request = self.request(port, backendObservation=self.backend())
                result = probe.run(request, self.binding(request))
                self.assertEqual(result["correlation"]["reason"], "request_mismatch")
                self.assertFalse(result["coverageComplete"])

    def test_multiple_same_probe_records_and_non_jsonl_separator_are_unknown(self):
        for mode in ["duplicate_probe", "bare_cr"]:
            with self.subTest(mode=mode):
                self.path.write_text("")
                def callback(h):
                    self.record(h)
                    if mode == "duplicate_probe":
                        self.record(h)
                    else:
                        with self.path.open("a") as stream: stream.write('{"probe":"other","target":"/"}\r{"probe":"other","target":"/"}\n')
                    reply(h)
                with serving(callback) as port:
                    request = self.request(port, backendObservation=self.backend())
                    result = probe.run(request, self.binding(request))
                self.assertEqual(result["correlation"]["status"], "unknown")
                self.assertFalse(result["coverageComplete"])

    def test_same_inode_baseline_anchor_changed_is_unknown(self):
        self.path.write_text('{"old":"value"}\n')
        original_inode = self.path.stat().st_ino
        def callback(h):
            with self.path.open("r+b") as stream: stream.write(b'{"old":"other"}\n')
            self.record(h)
            reply(h)
        with serving(callback) as port:
            request = self.request(port, backendObservation=self.backend())
            result = probe.run(request, self.binding(request))
        self.assertEqual(self.path.stat().st_ino, original_inode)
        self.assertEqual(result["correlation"]["reason"], "log_changed")
        self.assertFalse(result["coverageComplete"])

    def test_log_rotation_truncation_partial_line_duplicate_keys_and_missing_mapping_are_unknown(self):
        for mode in ["rotation", "truncate", "partial", "duplicate", "mapping", "limit"]:
            with self.subTest(mode=mode):
                self.path.write_text('{"old":"value"}\n')
                def callback(h):
                    if mode == "rotation":
                        self.path.rename(self.path.with_suffix(".old")); self.path.write_text("")
                    elif mode == "truncate": self.path.write_text("")
                    elif mode == "partial":
                        with self.path.open("a") as stream: stream.write('{"probe":')
                    elif mode == "duplicate":
                        with self.path.open("a") as stream: stream.write('{"probe":"a","probe":"b","target":"/"}\n')
                    elif mode == "mapping":
                        with self.path.open("a") as stream: stream.write('{"other":"record"}\n')
                    else:
                        with self.path.open("a") as stream: stream.write("x" * 2048)
                    reply(h)
                with serving(callback) as port:
                    request = self.request(port, backendObservation=self.backend(maxLogBytes=1024))
                    result = probe.run(request, self.binding(request))
                self.assertEqual(result["correlation"]["status"], "unknown")
                self.assertFalse(result["coverageComplete"])

    def test_missing_symlink_permission_and_baseline_partial_line_never_match(self):
        actual = Path(self.folder.name) / "actual"
        actual.write_text("")
        for mode in ["missing", "symlink", "permission", "partial"]:
            with self.subTest(mode=mode):
                if self.path.exists() or self.path.is_symlink(): self.path.unlink()
                if mode == "symlink": self.path.symlink_to(actual)
                elif mode != "missing": self.path.write_text("unfinished" if mode == "partial" else "")
                with serving(lambda h: reply(h)) as port:
                    request = self.request(port, backendObservation=self.backend())
                    if mode == "permission":
                        with patch.object(probe, "exact_open", side_effect=PermissionError()): result = probe.run(request, self.binding(request))
                    else: result = probe.run(request, self.binding(request))
                self.assertEqual(result["correlation"]["status"], "unknown")
                self.assertFalse(result["coverageComplete"])

    def test_private_binding_and_existing_query_cannot_be_reused(self):
        request = self.request(1)
        binding = self.binding(request)
        request["url"] += "&changed=1"
        with self.assertRaisesRegex(ValueError, "binding_mismatch"):
            probe.run(request, binding)
        request = self.request(1, backendObservation=self.backend())
        request["url"] += "&opsark%5fprobe=old"
        with self.assertRaisesRegex(ValueError, "already_present"):
            probe.run(request, self.binding(request))


if __name__ == "__main__":
    unittest.main(verbosity=2)
