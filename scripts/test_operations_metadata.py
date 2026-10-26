"""Local POSIX fixtures for exact, bounded, non-following metadata evidence."""
import ast
import hashlib
import importlib.util
import os
from pathlib import Path
import signal
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
location = Path(__file__).resolve().parents[1] / "src/features/tools/operations_probe.py"
spec = importlib.util.spec_from_file_location("operations_probe_metadata", location)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class MetadataTests(unittest.TestCase):
    def inspect(self, path, **overrides):
        request = dict(path=str(path), hash=True, maxHashBytes=16777216, timeoutSeconds=3)
        request.update(overrides)
        return probe.run("files.inspect", request)

    def test_python36_syntax_and_exact_unicode_backslash_file(self):
        ast.parse(location.read_text(), feature_version=(3, 6))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "中文\\文件\n.txt"
            path.write_bytes(b"exact content\x00\xff")
            result = self.inspect(path)
            info = path.lstat()
        self.assertEqual(result["status"], "complete")
        self.assertTrue(result["coverageComplete"])
        item = result["items"][0]
        self.assertEqual(item["subject"], str(path))
        self.assertEqual(item["sha256"], hashlib.sha256(b"exact content\x00\xff").hexdigest())
        self.assertEqual(item["metadata"]["inode"], str(info.st_ino))
        self.assertEqual(item["metadata"]["modifiedAtNs"], str(info.st_mtime_ns))
        self.assertNotIn("content", item)

    def test_empty_and_exact_budget_files_have_full_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data"
            for content in (b"", b"1234"):
                path.write_bytes(content)
                result = self.inspect(path, maxHashBytes=4)
                self.assertEqual(result["status"], "complete")
                self.assertEqual(result["items"][0]["hashedBytes"], len(content))
                self.assertEqual(result["items"][0]["sha256"], hashlib.sha256(content).hexdigest())

    def test_limit_never_returns_prefix_digest_or_reads_large_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data"
            path.write_bytes(b"12345")
            with patch.object(probe.os, "read", side_effect=AssertionError("must not read")):
                result = self.inspect(path, maxHashBytes=4)
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["items"][0]["hashStatus"], "limit_exceeded")
        self.assertEqual(result["items"][0]["hashedBytes"], 0)
        self.assertNotIn("sha256", result["items"][0])

    def test_metadata_only_never_opens_content(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data"
            path.write_bytes(b"private data")
            with patch.object(probe.os, "read", side_effect=AssertionError("must not read")):
                result = self.inspect(path, hash=False)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["items"][0]["hashStatus"], "not_requested")

    def test_directory_and_special_file_are_not_read_or_recursed(self):
        with tempfile.TemporaryDirectory() as folder:
            fifo = Path(folder) / "pipe"
            os.mkfifo(str(fifo))
            with patch.object(probe.os, "read", side_effect=AssertionError("must not read")):
                directory = self.inspect(folder)
                special = self.inspect(fifo)
        for result, kind in ((directory, "directory"), (special, "other")):
            self.assertEqual(result["status"], "complete")
            self.assertEqual(result["scannedEntries"], 1)
            self.assertEqual(result["items"][0]["fileType"], kind)
            self.assertEqual(result["items"][0]["hashStatus"], "not_applicable")

    def test_broken_and_valid_symlink_return_raw_target_without_following(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "current"
            for target in ("不存在/../版本\\1", "/etc/passwd"):
                path.symlink_to(target)
                with patch.object(probe.os, "read", side_effect=AssertionError("must not read")):
                    result = self.inspect(path)
                self.assertEqual(result["status"], "complete")
                self.assertEqual(result["items"][0]["linkTarget"], target)
                self.assertEqual(result["items"][0]["fileType"], "symlink")
                self.assertEqual(result["items"][0]["hashStatus"], "not_applicable")
                path.unlink()

    def test_invalid_utf8_link_is_unsupported_not_replacement_text(self):
        with tempfile.TemporaryDirectory() as folder:
            path = os.fsencode(folder) + b"/link"
            os.symlink(b"\xff", path)
            result = self.inspect(os.fsdecode(path))
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["items"], [])
        self.assertFalse(result["coverageComplete"])

    def test_ancestor_symlink_is_not_followed(self):
        with tempfile.TemporaryDirectory() as folder:
            alias = Path(folder) / "alias"
            alias.symlink_to("/etc")
            result = self.inspect(alias / "passwd")
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["items"], [])

    def test_missing_leaf_and_missing_parent_are_explicit_absence(self):
        with tempfile.TemporaryDirectory() as folder:
            for relative in ("missing", "missing/child"):
                result = self.inspect(Path(folder) / relative)
                self.assertEqual(result["status"], "complete")
                self.assertTrue(result["coverageComplete"])
                self.assertEqual(result["items"][0]["fileType"], "missing")
                self.assertFalse(result["items"][0]["exists"])
                self.assertNotIn("metadata", result["items"][0])

    def race_read(self, mutation):
        with tempfile.TemporaryDirectory() as folder:
            parent = Path(folder) / "original"
            parent.mkdir()
            path = parent / "data"
            path.write_bytes(b"before" * 20000)
            real_read = os.read
            mutated = []
            def read(fd, length):
                chunk = real_read(fd, length)
                if not mutated:
                    mutated.append(True)
                    mutation(path)
                return chunk
            with patch.object(probe.os, "read", side_effect=read):
                return self.inspect(path)

    def assert_changed(self, result):
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["items"][0]["stability"], "changed")
        self.assertEqual(result["items"][0]["hashStatus"], "changed")
        self.assertNotIn("sha256", result["items"][0])

    def test_in_place_mutation_rejects_mixed_digest(self):
        self.assert_changed(self.race_read(lambda path: path.write_bytes(b"after!" * 20000)))

    def test_second_pass_rejects_mixture_even_if_stat_cannot_observe_change(self):
        with patch.object(probe, "same_file", return_value=True):
            result = self.race_read(lambda path: path.write_bytes(b"after!" * 20000))
        self.assert_changed(result)
        self.assertEqual(result["items"][0]["verifiedReadPasses"], 1)

    def test_two_pass_budget_and_identity_limits_are_reported(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data"
            path.write_bytes(b"1234")
            real_read = os.read
            reads = []
            def read(fd, length):
                chunk = real_read(fd, length)
                reads.append(len(chunk))
                return chunk
            with patch.object(probe.os, "read", side_effect=read):
                result = self.inspect(path, maxHashBytes=4)
        item = result["items"][0]
        self.assertEqual(sum(reads), 8)
        self.assertEqual(item["verifiedReadPasses"], 2)
        self.assertEqual(item["consistency"], "metadata_checked")
        self.assertIn("non_atomic_sample", item["limitations"])
        self.assertTrue(item["sampleStartedAt"])
        self.assertTrue(item["sampleFinishedAt"])

    def test_replaced_file_rejects_old_fd_digest(self):
        def replace(path):
            other = path.with_name("replacement")
            other.write_bytes(b"replacement")
            os.replace(str(other), str(path))
        self.assert_changed(self.race_read(replace))

    def test_renamed_parent_rejects_old_path_even_if_final_inode_same(self):
        def replace_parent(path):
            old = path.parent.with_name("moved")
            path.parent.rename(old)
            path.parent.mkdir()
            os.link(str(old / path.name), str(path))
        self.assert_changed(self.race_read(replace_parent))

    def test_growth_stays_bounded_and_never_returns_prefix_hash(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data"
            path.write_bytes(b"1234")
            real_read = os.read
            reads = []
            def read(fd, length):
                if not reads:
                    with path.open("ab") as stream:
                        stream.write(b"growth")
                chunk = real_read(fd, length)
                reads.append(len(chunk))
                return chunk
            with patch.object(probe.os, "read", side_effect=read):
                result = self.inspect(path, maxHashBytes=4)
        self.assertLessEqual(sum(reads), 5)
        self.assert_changed(result)

    def test_hash_permission_denied_keeps_metadata_without_success(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data"
            path.write_bytes(b"private")
            real_open = os.open
            def denied(name, flags, *args, **kwargs):
                if name == "data":
                    raise PermissionError()
                return real_open(name, flags, *args, **kwargs)
            with patch.object(probe.os, "open", side_effect=denied) as opened:
                with patch.object(probe.os, "supports_dir_fd", set(probe.os.supports_dir_fd) | {opened}):
                    result = self.inspect(path)
        self.assertEqual(result["status"], "permission_denied")
        self.assertEqual(result["items"][0]["hashStatus"], "unavailable")
        self.assertEqual(result["items"][0]["stability"], "unknown")
        self.assertFalse(result["coverageComplete"])

    def test_fifo_replacement_at_open_never_reads_or_blocks(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data"
            path.write_bytes(b"before")
            real_open = os.open
            def replace(name, flags, *args, **kwargs):
                if name == "data":
                    path.unlink()
                    os.mkfifo(str(path))
                return real_open(name, flags, *args, **kwargs)
            with patch.object(probe.os, "open", side_effect=replace) as opened:
                with patch.object(probe.os, "supports_dir_fd", set(probe.os.supports_dir_fd) | {opened}):
                    with patch.object(probe.os, "read", side_effect=AssertionError("must not read")):
                        result = self.inspect(path)
        self.assert_changed(result)

    def test_timeout_and_cancel_keep_partial_without_digest(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "data"
            path.write_bytes(b"data")
            for cancel in (False, True):
                timer = threading.Timer(0.1, lambda: os.kill(os.getpid(), signal.SIGTERM)) if cancel else None
                if timer:
                    timer.start()
                try:
                    with patch.object(probe.os, "read", side_effect=lambda *_args: time.sleep(5)):
                        result = self.inspect(path, timeoutSeconds=1)
                finally:
                    if timer:
                        timer.cancel(); timer.join()
                self.assertEqual(result["status"], "cancelled" if cancel else "timeout")
                self.assertFalse(result["coverageComplete"])
                self.assertNotIn("sha256", result["items"][0])

    def test_missing_fd_features_do_not_claim_success(self):
        with patch.object(probe.os, "supports_follow_symlinks", set()):
            result = self.inspect("/")
        self.assertEqual(result["status"], "unsupported")
        self.assertEqual(result["scannedEntries"], 0)


if __name__ == "__main__":
    unittest.main()
