"""Narrow collector tests; --integration creates owned temporary local units.

No SSH, model call, global package install, or existing-service mutation.
"""
import argparse
import copy
import importlib.util
import json
import os
import pathlib
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / "src/features/tools/application_runtime_probe.py"
spec = importlib.util.spec_from_file_location("application_runtime_probe", SOURCE)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def request(root="/srv/example"):
    return dict(unit="example.service", listenAddress="127.0.0.1", listenPort=18493, releasePath=root, entryPath=root + "/app.py",
                inspectOtherServices=False, maxProcesses=64, maxServices=256, maxEntryBytes=16777216, timeoutSeconds=30)


class RuntimeTests(unittest.TestCase):
    def test_declared_path_boundary(self):
        for key, value in (("entryPath", "/srv/example-other/app.py"), ("entryPath", "/srv/example/../app.py"), ("listenAddress", "0.0.0.0"), ("unit", "example.service; id")):
            with self.subTest(key=key, value=value):
                args = request()
                args[key] = value
                with self.assertRaises((probe.Incomplete, ValueError)):
                    probe.validate_request(args)

    def test_real_disk_hash_link_chain_and_outside_rejection(self):
        with tempfile.TemporaryDirectory(prefix="opsark-runtime-unit-") as root:
            release = pathlib.Path(root) / "release"
            release.mkdir()
            entry = release / "app.py"
            entry.write_text("print('v1')\n")
            current = pathlib.Path(root) / "current"
            current.symlink_to(release)
            args = request(str(current))
            first = probe.inspect_entry(args)
            self.assertFalse(first["loadedCodeVerified"])
            self.assertEqual(first["entry"]["resolvedPath"], str(entry))
            self.assertTrue(any(row["kind"] == "symlink" for row in first["entry"]["chain"]))
            entry.write_text("print('v2')\n")
            self.assertNotEqual(first["diskSha256"], probe.inspect_entry(args)["diskSha256"])
            outside = pathlib.Path(root) / "outside.py"
            outside.write_text("outside")
            entry.unlink()
            entry.symlink_to(outside)
            with self.assertRaisesRegex(probe.Incomplete, "outside_release"):
                probe.inspect_entry(args)

    def test_oversized_and_fifo_entry_not_read(self):
        with tempfile.TemporaryDirectory(prefix="opsark-runtime-unit-") as root:
            path = pathlib.Path(root) / "app.py"
            path.write_bytes(b"abcdef")
            args = request(root)
            args["maxEntryBytes"] = 2
            with self.assertRaisesRegex(probe.Incomplete, "entry_limit"):
                probe.inspect_entry(args)
            path.unlink()
            os.mkfifo(str(path))
            with self.assertRaisesRegex(probe.Incomplete, "special_file"):
                probe.inspect_entry(args)

    def test_missing_service_generation_is_unknown(self):
        fields = dict(Id="example.service", LoadState="loaded", ActiveState="active", SubState="running", MainPID="20", ExecMainStartTimestampMonotonic="100")
        with self.assertRaisesRegex(probe.Incomplete, "property_missing"):
            probe.project_service(fields)
        fields["InvocationID"] = ""
        with self.assertRaisesRegex(probe.Incomplete, "start_identity_missing"):
            probe.project_service(fields)

    def test_real_local_address_rejects_remote(self):
        self.assertIn("127.0.0.1", probe.local_address("127.0.0.1"))
        with self.assertRaisesRegex(probe.Incomplete, "not_local"):
            probe.local_address("192.0.2.99")

    def test_inventory_limit_and_all_loaded_filter(self):
        args = request()
        args["maxServices"] = 1
        with patch.object(probe, "run_systemctl", return_value="a.service loaded active running A\nb.service loaded active running B\n"):
            with self.assertRaisesRegex(probe.Incomplete, "service_limit"):
                probe.inventory(args)
        text = "Id=a.service\nLoadState=loaded\nActiveState=inactive\nSubState=dead\nMainPID=0\nExecMainStartTimestampMonotonic=0\nInvocationID=\n"
        with patch.object(probe, "run_systemctl", side_effect=["a.service loaded inactive dead A\nmissing.service not-found inactive dead Missing\n", text]):
            self.assertEqual([row["name"] for row in probe.inventory(args)], ["a.service"])

    def test_fixed_python_and_gunicorn_binding_does_not_export_argv(self):
        identity = type("Identity", (), {"st_dev": 1, "st_ino": 1})()
        entry = dict(entry=dict(resolvedPath="/srv/example/app.py"), identity=dict(device="2", inode="2"))
        commands = [(b"python\0/srv/example/app.py\0--password\0VERY_SECRET\0", "python_script"),
                    (b"\0".join([b"python", b"/venv/bin/gunicorn", b"--workers", b"2", b"--bind", b"0.0.0.0:8000", b"app:application"]), "gunicorn_module"),
                    (b"gunicorn: worker [app:application]\0", "gunicorn_module"),
                    (b"python\0-m\0gunicorn\0app:application\0", "gunicorn_module"),
                    (b"python\0-c\0open('/srv/example/app.py')\0", "unknown"),
                    (b"python\0/venv/bin/gunicorn\0--pythonpath\0/elsewhere\0app:application\0", "unknown")]
        for command, kind in commands:
            with self.subTest(kind=kind), patch.object(probe.os, "stat", return_value=identity), patch.object(probe, "read_bytes", return_value=command), patch.object(probe.os.path, "realpath", side_effect=lambda item: item):
                result = probe.entry_binding(1, "/usr/bin/python3.10", "/srv/example", entry)
                self.assertEqual(result["kind"], kind)
                self.assertNotIn("VERY_SECRET", json.dumps(result))

    def test_runtime_change_and_inventory_failure_remain_separate(self):
        args = request()
        args["inspectOtherServices"] = True
        before = dict(unit={"mainPid": 1}, identity="first")
        after = dict(unit={"mainPid": 1}, identity="changed")
        with patch.object(probe, "inspect_entry", return_value={"stable": True}), patch.object(probe, "snapshot", side_effect=[before, after]), patch.object(probe, "inventory", return_value=[{"name": "example.service"}]):
            result = probe.collect(args)
            self.assertFalse(result["runtimeBindingComplete"])
            self.assertTrue(result["otherServices"]["complete"])
            self.assertIn("runtime_changed_between_samples", result["issues"])
        with patch.object(probe, "inspect_entry", return_value={"stable": True}), patch.object(probe, "snapshot", return_value=before), patch.object(probe, "inventory", side_effect=PermissionError()):
            result = probe.collect(args)
            self.assertTrue(result["runtimeBindingComplete"])
            self.assertFalse(result["coverageComplete"])
            self.assertFalse(result["otherServices"]["complete"])


def integration(output):
    if not sys.platform.startswith("linux") or os.geteuid() != 0 or not shutil.which("systemd-run"):
        raise RuntimeError("Local Linux root/systemd-run is required; no remote fallback")
    records = []
    with tempfile.TemporaryDirectory(prefix="opsark-runtime-integration-") as root:
        entry = pathlib.Path(root) / "app.py"
        # A real master and two workers share the same listening socket; all
        # descendants stay in the temporary systemd unit's cgroup.
        entry.write_text("import http.server,os,signal,sys\nserver=http.server.HTTPServer(('0.0.0.0',int(sys.argv[1])),http.server.BaseHTTPRequestHandler)\nfor _ in range(2):\n if os.fork()==0:\n  server.serve_forever()\n  sys.exit(0)\nsignal.pause()\n")
        with socket.socket() as candidate:
            candidate.bind(("127.0.0.1", 0))
            port = candidate.getsockname()[1]
        unit = "opsark-runtime-probe-" + uuid.uuid4().hex + ".service"
        result = subprocess.run(["systemd-run", "--quiet", "--unit=" + unit, "--property=Type=exec", "--property=WorkingDirectory=" + root,
                                 sys.executable, "-B", str(entry), str(port)], capture_output=True, text=True, timeout=10)
        if result.returncode:
            raise RuntimeError("temporary unit start failed: " + result.stderr)
        try:
            ready = False
            for _ in range(50):
                try:
                    with socket.create_connection(("127.0.0.1", port), timeout=0.1):
                        ready = True
                    break
                except OSError:
                    time.sleep(0.05)
            if not ready:
                raise RuntimeError("temporary service not ready")
            args = request(root)
            args.update(unit=unit, listenPort=port)
            first = probe.collect(args)
            records.append(dict(name="真实受管Python主进程与双worker共享socket", result=first))
            if not first["runtimeBindingComplete"] or len(first["after"]["processes"]) != 3 or len(first["after"]["sockets"][0]["holderPids"]) != 3:
                raise AssertionError("real runtime binding incomplete: " + json.dumps(first["issues"]))
            # In-place disk replacement must not be described as loaded code.
            entry.write_text(entry.read_text() + "# disk changed; existing processes unchanged\n")
            changed = probe.collect(args)
            records.append(dict(name="原地替换磁盘文件不声明已加载代码", result=changed))
            assert changed["runtimeBindingComplete"] and not changed["entry"]["loadedCodeVerified"]
            assert changed["entry"]["diskSha256"] != first["entry"]["diskSha256"]
            assert changed["before"]["processes"] == first["before"]["processes"]
            args["inspectOtherServices"] = True
            all_services = probe.collect(args)
            records.append(dict(name="同systemd管理器全部已加载服务", result=all_services))
            if not all_services["otherServices"]["complete"]:
                raise AssertionError("real service inventory incomplete: " + json.dumps(all_services["otherServices"]["issues"]))
            args["maxServices"] = 1
            limited = probe.collect(args)
            records.append(dict(name="服务全集超限保留unknown", result=limited))
            assert limited["runtimeBindingComplete"] and not limited["coverageComplete"] and not limited["otherServices"]["complete"]
            args["inspectOtherServices"] = False
            args["listenAddress"] = "192.0.2.99"
            remote = probe.collect(args)
            records.append(dict(name="非本机地址不能绑定通配监听", result=remote))
            assert not remote["runtimeBindingComplete"] and "requested_address_not_local" in remote["issues"]
            print(json.dumps(dict(success=True, samples=len(records), summary=[dict(name=row["name"], status=row["result"]["status"], runtimeBindingComplete=row["result"]["runtimeBindingComplete"], otherServices=row["result"]["otherServices"]["status"], issues=row["result"]["issues"]) for row in records]), ensure_ascii=False))
        finally:
            # Stop only the exact randomly named unit created by this process.
            subprocess.run(["systemctl", "stop", "--", unit], capture_output=True, timeout=10)
            subprocess.run(["systemctl", "reset-failed", "--", unit], capture_output=True, timeout=10)
            if output:
                pathlib.Path(output).write_text(json.dumps(dict(records=records), ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--integration", action="store_true")
    parser.add_argument("--output")
    options, rest = parser.parse_known_args()
    if options.integration:
        integration(options.output)
    else:
        unittest.main(argv=[sys.argv[0]] + rest)
