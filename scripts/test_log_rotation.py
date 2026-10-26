"""B05 local POSIX fixtures; never touches business servers or system rotation rules."""
import ast
import gzip
import importlib.util
import json
import os
from pathlib import Path
import select
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
location = Path(__file__).resolve().parents[1] / "src/features/tools/log_rotation_probe.py"
spec = importlib.util.spec_from_file_location("log_rotation_probe", location)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def request(active, **values):
    result = dict(activePaths=[str(active)], archivePaths=[], configPaths=[], writerPids=[], maxBytesPerFile=262144, maxFdsPerProcess=256, timeoutSeconds=10)
    result.update(values)
    return result


def records(*values):
    return b"".join((json.dumps(dict(sequence=value, message="fixture")) + "\n").encode() for value in values)


class RotationTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="opsark-rotation-")
        self.root = Path(self.folder.name)
        self.active = self.root / "日志 ' \u005c active.log"
        self.active.write_bytes(records(1, 2, 3))

    def tearDown(self):
        self.folder.cleanup()

    def sample(self, path=None, role="active", limit=262144):
        return probe.file_sample(str(path or self.active), role, limit, time.monotonic() + 5)

    def test_python36_syntax(self):
        ast.parse(location.read_text(), feature_version=(3, 6))

    def test_plain_file_identity_content_digest_and_no_content_leak(self):
        before = self.active.read_bytes()
        result = probe.run(request(self.active))
        row = result["files"][0]
        self.assertTrue(result["coverageComplete"])
        self.assertEqual(row["metadata"]["inode"], str(self.active.stat().st_ino))
        self.assertEqual(row["contentSha256"], probe.digest(before))
        self.assertEqual(row["lineCount"], 3)
        self.assertEqual(row["consistency"], "prefix_rechecked")
        self.assertNotIn('"message"', json.dumps(result))
        self.assertEqual(self.active.read_bytes(), before)

    def test_partial_final_record_does_not_claim_complete_file(self):
        self.active.write_bytes(records(1) + b'{"sequence":2')
        result = probe.run(request(self.active))
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["files"][0]["status"], "partial")

    def test_duplicate_json_keys_are_not_silently_accepted(self):
        self.active.write_bytes(b'{"sequence":999,"sequence":1}\n')
        result = probe.run(request(self.active, sequenceCheck=dict(field="sequence", first=1, last=1)))
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["sequence"]["invalidRecords"], 1)

    def test_config_script_count_is_bounded_and_never_executed(self):
        config = self.root / "rotate.conf"
        marker = self.root / "must-not-exist"
        script = "postrotate\n touch " + str(marker) + "\nendscript\n"
        config.write_text('"' + str(self.active) + '" {\n' + script * 17 + '}\n')
        result = probe.config_sample(str(config), 65536, time.monotonic() + 5)
        self.assertEqual(result["status"], "partial")
        self.assertLessEqual(len(result["blocks"][0]["scripts"]), 16)
        self.assertFalse(marker.exists())

    def test_bad_gzip_deflate_returns_partial_receipt_instead_of_crash(self):
        archive = self.root / "bad.gz"
        archive.write_bytes(b'\x1f\x8b\x08\x00\x00\x00\x00\x00\x02\xff\x07' + b'\x00' * 8)
        result = probe.run(request(self.active, archivePaths=[str(archive)]))
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["files"][1]["reason"], "invalid_gzip")

    def test_gzip_real_crc_and_concatenated_members(self):
        archive = self.root / "archive.gz"
        archive.write_bytes(gzip.compress(records(1)) + gzip.compress(records(2)))
        row, content = self.sample(archive, "archive")
        self.assertEqual(row["status"], "complete")
        self.assertTrue(row["compressionValid"])
        self.assertEqual(content, records(1, 2))
        corrupt = bytearray(archive.read_bytes()); corrupt[-8] ^= 1; archive.write_bytes(corrupt)
        row, _ = self.sample(archive, "archive")
        self.assertFalse(row["compressionValid"])
        self.assertEqual(row["reason"], "invalid_gzip")

    def test_gzip_bomb_expanded_bytes_are_bounded_without_validity_claim(self):
        archive = self.root / "bomb.gz"
        archive.write_bytes(gzip.compress(b"x" * 2000000))
        row, content = self.sample(archive, "archive", 4096)
        self.assertEqual(row["status"], "limit_exceeded")
        self.assertEqual(row["reason"], "expanded_byte_limit")
        self.assertEqual(row["expandedBytes"], 4097)
        self.assertIsNone(row["compressionValid"])
        self.assertIsNone(content)

    def test_plain_bytes_line_length_and_record_count_limits(self):
        for body, limit, reason in [(b"x" * 2000, 1024, "compressed_or_plain_byte_limit"),
                                    (b"x" * 65537 + b"\n", 100000, "line_or_record_limit"),
                                    (b"\n" * 100001, 200000, "line_or_record_limit")]:
            self.active.write_bytes(body)
            row, _ = self.sample(limit=limit)
            self.assertEqual((row["status"], row["reason"]), ("limit_exceeded", reason))
            self.assertNotIn("contentSha256", row)

    def test_missing_symlink_ancestor_and_fifo_remain_incomplete(self):
        child = self.root / "real"; child.mkdir(); (child / "log").write_bytes(records(1))
        linked = self.root / "link"; linked.symlink_to(child, target_is_directory=True)
        terminal = self.root / "direct-link"; terminal.symlink_to(self.active)
        fifo = self.root / "fifo"; os.mkfifo(str(fifo))
        for path in [self.root / "missing", terminal, linked / "log", fifo]:
            started = time.monotonic()
            row, content = self.sample(path)
            self.assertNotEqual(row["status"], "complete")
            self.assertIsNone(content)
            self.assertLess(time.monotonic() - started, 1)

    def test_permission_denied_is_not_absence(self):
        with patch.object(probe, "exact_parent", side_effect=PermissionError("controlled")):
            row, _ = self.sample()
        self.assertEqual(row["status"], "permission_denied")

    def test_prefix_rewrite_or_path_replacement_is_changed(self):
        actual = probe.read_fd
        for mode in ("rewrite", "replace"):
            self.active.write_bytes(records(1, 2, 3))
            calls = [0]
            def read(descriptor, size, deadline):
                body = actual(descriptor, size, deadline)
                calls[0] += 1
                if calls[0] == 1:
                    if mode == "replace":
                        self.active.rename(self.root / "previous")
                    self.active.write_bytes(records(4, 5, 6))
                return body
            with patch.object(probe, "read_fd", side_effect=read):
                row, content = self.sample()
            self.assertEqual(row["status"], "changed")
            self.assertIsNone(content)

    def test_append_during_read_is_only_rechecked_prefix_not_full_snapshot(self):
        original, actual = self.active.read_bytes(), probe.read_fd
        calls = [0]
        def read(descriptor, size, deadline):
            body = actual(descriptor, size, deadline)
            calls[0] += 1
            if calls[0] == 1:
                with self.active.open("ab") as handle:
                    handle.write(records(4))
            return body
        with patch.object(probe, "read_fd", side_effect=read):
            row, content = self.sample()
        self.assertEqual(row["status"], "complete")
        self.assertEqual(row["consistency"], "prefix_rechecked")
        self.assertTrue(row["appendObserved"])
        self.assertEqual(content, original)
        self.assertLess(row["readBytes"], self.active.stat().st_size)

    def test_archive_change_during_read_is_not_stable(self):
        actual, calls = probe.read_fd, [0]
        def read(descriptor, size, deadline):
            body = actual(descriptor, size, deadline); calls[0] += 1
            if calls[0] == 1:
                with self.active.open("ab") as handle:
                    handle.write(records(4))
            return body
        with patch.object(probe, "read_fd", side_effect=read):
            row, _ = self.sample(role="archive")
        self.assertEqual(row["status"], "changed")

    def test_real_writable_fd_matches_inode_read_only_fd_does_not(self):
        row, _ = self.sample()
        with self.active.open("ab") as write_handle, self.active.open("rb") as read_handle:
            writable_fd, readonly_fd = write_handle.fileno(), read_handle.fileno()
            result = probe.writer_sample(os.getpid(), [row], 1024, time.monotonic() + 5)
        self.assertEqual(result["status"], "complete")
        self.assertIn(writable_fd, [item["fd"] for item in result["descriptors"]])
        self.assertNotIn(readonly_fd, [item["fd"] for item in result["descriptors"]])
        self.assertEqual(len(result["descriptors"]), 1)
        self.assertEqual(result["descriptors"][0]["path"], str(self.active))
        self.assertTrue(result["descriptors"][0]["append"])

    def test_pid_reuse_and_permission_failure_cannot_claim_writer_identity(self):
        row, _ = self.sample()
        with patch.object(probe, "proc_identity", side_effect=[("11", "writer"), ("12", "other")]):
            result = probe.writer_sample(os.getpid(), [row], 1024, time.monotonic() + 5)
        self.assertEqual((result["status"], result["reason"]), ("unknown", "pid_reused"))
        self.assertEqual(result["descriptors"], [])
        with patch.object(probe, "proc_identity", side_effect=PermissionError("controlled")):
            result = probe.writer_sample(os.getpid(), [row], 1024, time.monotonic() + 5)
        self.assertEqual((result["status"], result["reason"]), ("unknown", "permission_denied"))

    def test_fd_replacement_between_identity_reads_remains_unknown(self):
        row, _ = self.sample()
        other = self.root / "other.log"; other.write_bytes(records(9))
        actual, seen = probe.os.stat, [0]
        with self.active.open("ab") as handle:
            target = "/proc/" + str(os.getpid()) + "/fd/" + str(handle.fileno())
            def moved(path, *args, **kwargs):
                if str(path) == target:
                    seen[0] += 1
                    if seen[0] == 2:
                        return actual(other)
                return actual(path, *args, **kwargs)
            with patch.object(probe.os, "stat", side_effect=moved):
                result = probe.writer_sample(os.getpid(), [row], 1024, time.monotonic() + 5)
        self.assertEqual(result["status"], "unknown")
        self.assertEqual(result["reason"], "proc_unavailable_or_changed")

    def test_sequence_deadline_checked_within_record_loop(self):
        row, raw = self.sample()
        with self.assertRaises(probe.ProbeStop):
            probe.sequence_sample(dict(field="sequence", first=1, last=3), [(row, raw)], time.monotonic() - 1)

    def test_fd_limit_is_unknown_not_no_writer(self):
        row, _ = self.sample()
        result = probe.writer_sample(os.getpid(), [row], 1, time.monotonic() + 5)
        self.assertEqual((result["status"], result["reason"]), ("unknown", "fd_limit"))

    def test_config_only_declarations_and_script_hash_no_execution(self):
        config = self.root / "rotate.conf"; marker = self.root / "not-executed"
        config.write_text('"' + str(self.active).replace("\\", "\\\\") + '" {\n daily\n rotate 7\n maxage 7\n compress\n delaycompress\n create 0640\n postrotate\n touch "' + str(marker) + '"\n endscript\n}')
        value = probe.config_sample(str(config), 65536, time.monotonic() + 5)
        self.assertEqual(value["status"], "complete")
        self.assertEqual(value["blocks"][0]["targets"], [str(self.active)])
        self.assertEqual(value["blocks"][0]["scripts"][0]["phase"], "postrotate")
        self.assertEqual(len(value["blocks"][0]["scripts"][0]["sha256"]), 64)
        self.assertFalse(marker.exists())
        self.assertNotIn(str(marker), json.dumps(value))

    def test_include_and_malformed_config_not_treated_as_effective_config(self):
        config = self.root / "rotate.conf"
        for body in ['include /etc/logrotate.d\n', '"/var/log/x" {\n daily\n', 'mystery value\n', b'\xff']:
            config.write_bytes(body if isinstance(body, bytes) else body.encode())
            result = probe.config_sample(str(config), 65536, time.monotonic() + 5)
            self.assertEqual(result["status"], "partial")

    def test_sequence_missing_duplicate_invalid_and_bounds(self):
        for body, expected in [(records(1, 3), ("mismatch", 1, 0)), (records(1, 2, 2, 3), ("mismatch", 0, 1)),
                               (records(1, 2, 3, 100), ("complete", 0, 0)), (b'{"sequence":true}\n', ("partial", 3, 0)),
                               (b'{"sequence":1,"ignored":NaN}\n', ("partial", 3, 0)), (b'[]\n', ("partial", 3, 0)),
                               (b'{"sequence":1}\n{bad}\n', ("partial", 2, 0))]:
            self.active.write_bytes(body)
            result = probe.run(request(self.active, sequenceCheck=dict(field="sequence", first=1, last=3)))
            seq = result["sequence"]
            self.assertEqual((seq["status"], seq["missingCount"], seq["duplicateCount"]), expected)
            self.assertEqual(seq["scope"], "requested_sequence_window")

    def test_total_sequence_record_limit_across_files(self):
        self.active.write_bytes(records(1) * 50001)
        archive = self.root / "other.log"; archive.write_bytes(records(2) * 50001)
        result = probe.run(request(self.active, archivePaths=[str(archive)], maxBytesPerFile=4194304, sequenceCheck=dict(field="sequence", first=1, last=2)))
        self.assertFalse(result["sequence"]["coverageComplete"])
        self.assertEqual(result["sequence"]["parsedRecords"], 100000)
        self.assertEqual(result["sequence"]["unscannedPaths"], [str(archive)])

    def test_missing_file_does_not_convert_partial_window_to_real_loss(self):
        archive = self.root / "missing.gz"
        result = probe.run(request(self.active, archivePaths=[str(archive)], sequenceCheck=dict(field="sequence", first=1, last=10)))
        self.assertEqual(result["sequence"]["status"], "partial")
        self.assertFalse(result["sequence"]["coverageComplete"])
        self.assertIn(str(archive), result["sequence"]["unscannedPaths"])

    def test_timeout_and_cancel_keep_incomplete_receipt(self):
        for reason in ("timeout", "cancelled"):
            with patch.object(probe, "check", side_effect=probe.ProbeStop(reason)):
                value = probe.run(request(self.active))
            self.assertEqual(value["status"], reason)
            self.assertFalse(value["coverageComplete"])

    def test_production_probe_has_no_mutation_or_subprocess_calls(self):
        tree = ast.parse(location.read_text())
        forbidden = {"system", "Popen", "run", "call", "check_call", "check_output", "kill", "killpg", "rename", "replace", "unlink", "remove", "truncate", "ftruncate", "write"}
        for node in ast.walk(tree):
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                self.assertNotIn(node.func.attr, forbidden)

    def test_real_logrotate_two_cycles_keep_known_window_while_writer_continues(self):
        executable = shutil.which("logrotate")
        self.assertIsNotNone(executable, "local logrotate is required for this explicit POSIX test")
        active = self.root / "live.log"
        writer = r'''import json,os,signal,sys,time
path=sys.argv[1]; pending=[False]; running=[True]; count=0; reopened=0
signal.signal(signal.SIGHUP, lambda *_: pending.__setitem__(0,True))
signal.signal(signal.SIGTERM, lambda *_: running.__setitem__(0,False))
fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
while running[0]:
    if pending[0]:
        new=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_APPEND,0o600)
        os.close(fd); fd=new; pending[0]=False; reopened+=1
    count+=1
    os.write(fd,(json.dumps({'sequence':count,'message':'real-local-writer'})+'\n').encode())
    print(json.dumps({'sequence':count,'reopened':reopened}),flush=True)
    time.sleep(0.01)
os.close(fd)
'''
        child = subprocess.Popen([sys.executable, "-u", "-c", writer, str(active)], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        buffer = [b""]
        def until(predicate):
            deadline = time.monotonic() + 5
            while time.monotonic() < deadline:
                while b"\n" in buffer[0]:
                    line, buffer[0] = buffer[0].split(b"\n", 1)
                    item = json.loads(line)
                    if predicate(item):
                        return item
                ready, _, _ = select.select([child.stdout], [], [], 0.1)
                if ready:
                    data = os.read(child.stdout.fileno(), 4096)
                    if not data:
                        self.fail("writer exited unexpectedly")
                    buffer[0] += data
            self.fail("writer did not reach requested checkpoint")
        try:
            first = until(lambda value: value["sequence"] >= 20)
            config = self.root / "local-logrotate.conf"
            config.write_text('"' + str(active) + '" {\n daily\n rotate 7\n compress\n delaycompress\n create 0600\n missingok\n notifempty\n postrotate\n /bin/kill -HUP ' + str(child.pid) + '\n endscript\n}\n')
            state = self.root / "local-logrotate.state"
            before = probe.run(request(active, writerPids=[child.pid], configPaths=[str(config)]))
            self.assertTrue(before["coverageComplete"])
            self.assertTrue(before["writers"][0]["descriptors"])
            for cycle in (1, 2):
                rotation = subprocess.run([executable, "--force", "--state", str(state), str(config)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
                self.assertEqual(rotation.returncode, 0, rotation.stderr.decode())
                until(lambda value: value["reopened"] >= cycle and value["sequence"] >= first["sequence"] + 10 * cycle)
                self.assertNotEqual(active.stat().st_ino, Path(str(active) + ".1").stat().st_ino)
                if cycle == 1:
                    self.assertEqual(str(Path(str(active) + ".1").stat().st_ino), before["files"][0]["metadata"]["inode"])
            checkpoint = until(lambda value: value["reopened"] == 2)
            archives = [str(active) + ".1", str(active) + ".2.gz"]
            result = probe.run(request(active, archivePaths=archives, writerPids=[child.pid], configPaths=[str(config)], sequenceCheck=dict(field="sequence", first=1, last=checkpoint["sequence"])))
            self.assertIsNone(child.poll())
            self.assertTrue(result["coverageComplete"], result)
            self.assertEqual(result["sequence"]["status"], "complete")
            self.assertEqual(result["sequence"]["missingCount"], 0)
            self.assertEqual(result["sequence"]["duplicateCount"], 0)
            self.assertEqual(result["files"][2]["compression"], "gzip")
            self.assertTrue(result["files"][2]["compressionValid"])
            self.assertEqual(result["writers"][0]["descriptors"][0]["path"], str(active))
            self.assertEqual(before["writers"][0]["startTicks"], result["writers"][0]["startTicks"])
            newer = until(lambda value: value["sequence"] > checkpoint["sequence"] + 3)
            print(json.dumps({"controlledRotation": {"cycles": 2, "writerPid": child.pid, "first": 1, "lastVerified": checkpoint["sequence"],
                  "continuedUntil": newer["sequence"], "missing": 0, "duplicate": 0, "gzipValid": True, "scope": "finite_local_fixture_only"}}))
        finally:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=5)
            child.stdout.close(); child.stderr.close()


if __name__ == "__main__":
    unittest.main(verbosity=2)
