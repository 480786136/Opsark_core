"""Local temporary-directory fixtures; does not touch business servers or install dependencies."""
import ast
import gzip
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
location = Path(__file__).resolve().parents[1] / "src/features/tools/file_manifest_probe.py"
spec = importlib.util.spec_from_file_location("file_manifest_probe", location)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def request(path, source="directory", **values):
    result = dict(path=str(path), source=source, maxEntries=1024, maxDepth=16, maxFileBytes=16777216,
                  maxTotalBytes=67108864, maxArchiveBytes=16777216, maxExpandedBytes=67108864, timeoutSeconds=10)
    result.update(values)
    return result


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="opsark-manifest-")
        self.root = Path(self.temp.name)
        self.tree = self.root / "tree"
        self.tree.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def archive(self, entries, compressed=False, fmt=tarfile.PAX_FORMAT):
        path = self.root / ("bundle.tar.gz" if compressed else "bundle.tar")
        with tarfile.open(str(path), "w:gz" if compressed else "w", format=fmt) as tar:
            for name, body, kind, link in entries:
                info = tarfile.TarInfo(name)
                info.type = kind
                info.mode = 0o755 if kind == tarfile.DIRTYPE else 0o644
                info.uid = 1000
                info.gid = 1001
                info.size = len(body)
                info.linkname = link
                tar.addfile(info, io.BytesIO(body))
        return path

    def normal_archive(self, compressed=False):
        return self.archive([("./", b"", tarfile.DIRTYPE, ""), ("./assets", b"", tarfile.DIRTYPE, ""),
                             ("./index.html", b"hello\n", tarfile.REGTYPE, ""), ("./assets/图片.bin", b"\0\xff\x10", tarfile.REGTYPE, "")], compressed)

    def test_python36_syntax(self):
        ast.parse(location.read_text(), feature_version=(3, 6))

    def test_directory_real_content_metadata_and_non_atomic_limit(self):
        (self.tree / "中文 ' \\ $(printf unsafe)").write_bytes(b"private content\0\xff")
        (self.tree / "empty").mkdir()
        result = probe.run(request(self.tree))
        self.assertTrue(result["coverageComplete"])
        self.assertEqual(result["manifestSha256"], probe.manifest_digest(result["entries"]))
        row = next(row for row in result["entries"] if row["kind"] == "regular")
        self.assertEqual(row["sha256"], hashlib.sha256(b"private content\0\xff").hexdigest())
        self.assertEqual(result["readBytes"], 2 * len(b"private content\0\xff"))
        self.assertNotIn("private content", json.dumps(result))
        self.assertEqual(result["consistency"], "sampled_non_atomic")

    def test_empty_directory_is_real_complete_manifest(self):
        result = probe.run(request(self.tree))
        self.assertTrue(result["coverageComplete"])
        self.assertEqual(result["manifestSha256"], hashlib.sha256(b"[]").hexdigest())

    def test_directory_links_record_only_link_identity(self):
        secret = self.root / "outside"
        secret.write_bytes(b"not read")
        (self.tree / "link").symlink_to(secret)
        result = probe.run(request(self.tree))
        self.assertTrue(result["coverageComplete"])
        self.assertFalse(result["safeForDeployment"])
        self.assertEqual(result["entries"][0]["linkTarget"], str(secret))
        self.assertNotIn("sha256", result["entries"][0])
        self.assertEqual(result["readBytes"], 0)

    def test_root_link_ancestor_link_fifo_and_missing_do_not_read(self):
        (self.root / "link").symlink_to(self.tree, target_is_directory=True)
        os.mkfifo(str(self.root / "fifo"))
        for path, source in [(self.root / "link", "directory"), (self.root / "link/file", "tar"),
                             (self.root / "fifo", "tar"), (self.root / "missing", "directory")]:
            result = probe.run(request(path, source))
            self.assertFalse(result["coverageComplete"])
            self.assertIsNone(result["manifestSha256"])

    def test_entry_limit_is_enforced_during_enumeration(self):
        for index in range(10):
            (self.tree / str(index)).write_bytes(b"a")
        result = probe.run(request(self.tree, maxEntries=2))
        self.assertEqual(len(result["entries"]), 2)
        self.assertTrue(result["truncated"])
        self.assertIsNone(result["manifestSha256"])

    def test_depth_limit_marks_unvisited_subtree(self):
        (self.tree / "a").mkdir()
        (self.tree / "a/b").write_bytes(b"hidden")
        result = probe.run(request(self.tree, maxDepth=1))
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["entries"][0]["reason"], "depth_limit")

    def test_file_and_total_content_limits(self):
        (self.tree / "one").write_bytes(b"abcd")
        for values, reason in [(dict(maxFileBytes=3), "file_byte_limit"), (dict(maxTotalBytes=3), "total_byte_limit")]:
            result = probe.run(request(self.tree, **values))
            self.assertFalse(result["coverageComplete"])
            self.assertTrue(any(item["reason"] == reason for item in result["issues"]))
            self.assertEqual(result["readBytes"], 0)

    def test_permission_denied_is_not_empty_directory(self):
        with patch.object(probe.os, "scandir", side_effect=PermissionError("fixture")):
            result = probe.run(request(self.tree))
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["issues"][0]["reason"], "permission_denied")

    def test_undecodable_name_keeps_unknown_not_alias(self):
        raw = os.fsencode(self.tree) + b"/invalid\xff"
        fd = os.open(raw, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        result = probe.run(request(self.tree))
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["issues"][0]["reason"], "invalid_name")
        json.dumps(result).encode("utf-8")

    def test_special_child_is_not_opened(self):
        os.mkfifo(str(self.tree / "pipe"))
        result = probe.run(request(self.tree))
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["entries"][0]["reason"], "unsupported_type")

    def test_content_rewrite_between_passes_invalidates_digest(self):
        file = self.tree / "file"
        file.write_bytes(b"aaa")
        original = probe.Collector.hash_fd
        calls = [0]
        def changed(collector, fd, size):
            value = original(collector, fd, size)
            calls[0] += 1
            if calls[0] == 1:
                file.write_bytes(b"bbb")
            return value
        with patch.object(probe.Collector, "hash_fd", changed):
            result = probe.run(request(self.tree))
        self.assertFalse(result["coverageComplete"])
        self.assertNotIn("sha256", result["entries"][0])

    def test_path_replacement_is_not_an_equal_object(self):
        file = self.tree / "file"
        file.write_bytes(b"same")
        original = probe.Collector.hash_fd
        calls = [0]
        def changed(collector, fd, size):
            value = original(collector, fd, size)
            calls[0] += 1
            if calls[0] == 2:
                file.rename(self.root / "old")
                file.write_bytes(b"same")
            return value
        with patch.object(probe.Collector, "hash_fd", changed):
            result = probe.run(request(self.tree))
        self.assertFalse(result["coverageComplete"])

    def test_tar_and_gzip_real_members_and_outer_digest(self):
        for compressed in (False, True):
            file = self.normal_archive(compressed)
            result = probe.run(request(file, "tar_gzip" if compressed else "tar"))
            self.assertTrue(result["coverageComplete"], result)
            self.assertEqual(result["archiveSha256"], hashlib.sha256(file.read_bytes()).hexdigest())
            self.assertEqual(result["archiveReadBytes"], 2 * file.stat().st_size)
            self.assertEqual(next(row for row in result["entries"] if row["path"] == "assets/图片.bin")["sha256"], hashlib.sha256(b"\0\xff\x10").hexdigest())
            self.assertFalse((self.root / "assets").exists())

    def test_gnu_long_name_and_pax_unicode_supported(self):
        for fmt in (tarfile.GNU_FORMAT, tarfile.PAX_FORMAT):
            name = "deep/" + "中文" * 70
            archive = self.archive([(name, b"body", tarfile.REGTYPE, "")], fmt=fmt)
            result = probe.run(request(archive, "tar"))
            self.assertTrue(result["coverageComplete"], result)
            self.assertEqual(result["entries"][0]["path"], name)

    def test_archive_traversal_absolute_empty_segments_are_rejected(self):
        for name in ["../outside", "/outside", "a/../../b", "a//b", "a/./b"]:
            archive = self.archive([(name, b"bad", tarfile.REGTYPE, "")])
            result = probe.run(request(archive, "tar"))
            self.assertFalse(result["coverageComplete"], name)
            self.assertFalse(result["safeForDeployment"])
            self.assertEqual(result["issues"][0]["reason"], "unsafe_archive_path")

    def test_duplicate_and_parent_file_collisions_are_rejected(self):
        for names in [("a", "./a"), ("a", "a/b"), ("a/b", "a")]:
            archive = self.archive([(name, b"x", tarfile.REGTYPE, "") for name in names])
            result = probe.run(request(archive, "tar"))
            self.assertFalse(result["coverageComplete"])
            self.assertEqual(result["issues"][0]["reason"], "duplicate_path")

    def test_archive_links_never_resolve_to_data_or_deployment_permission(self):
        for kind in (tarfile.SYMTYPE, tarfile.LNKTYPE):
            archive = self.archive([("link", b"", kind, "../../outside")])
            result = probe.run(request(archive, "tar"))
            self.assertFalse(result["coverageComplete"])
            self.assertFalse(result["safeForDeployment"])
            self.assertEqual(result["entries"][0]["linkTarget"], "../../outside")
            self.assertNotIn("sha256", result["entries"][0])

    def test_devices_sparse_and_global_pax_are_not_silently_ignored(self):
        for kind in (tarfile.CHRTYPE, tarfile.FIFOTYPE, tarfile.GNUTYPE_SPARSE, tarfile.XGLTYPE):
            archive = self.archive([("special", b"", kind, "")])
            result = probe.run(request(archive, "tar"))
            self.assertFalse(result["coverageComplete"])
            self.assertEqual(result["issues"][0]["reason"], "unsupported_archive_type")

    def test_invalid_directory_payload_and_link_target_leave_partial_rows(self):
        for body, kind, link in [(b"invalid-directory-data", tarfile.DIRTYPE, ""),
                                  (b"", tarfile.SYMTYPE, "")]:
            archive = self.archive([("invalid", body, kind, link)])
            result = probe.run(request(archive, "tar"))
            self.assertFalse(result["coverageComplete"])
            self.assertEqual(result["entries"][0]["status"], "partial")
            self.assertTrue(result["entries"][0]["reason"])
            self.assertIsNone(result["manifestSha256"])

    def test_bad_checksum_and_truncation_have_no_complete_manifest(self):
        archive = self.normal_archive()
        body = archive.read_bytes()
        for corrupt in [b"z" + body[1:], body[:511], body[:1800], body[:5120] + b"not padding"]:
            archive.write_bytes(corrupt)
            result = probe.run(request(archive, "tar"))
            self.assertFalse(result["coverageComplete"])
            self.assertIsNone(result["manifestSha256"])

    def test_bad_gzip_crc_and_deflate_do_not_escape_as_success(self):
        archive = self.normal_archive(True)
        body = bytearray(archive.read_bytes())
        body[-8] ^= 1
        for corrupt in [bytes(body), b"\x1f\x8b\x08\0\0\0\0\0\x02\xff\x07" + b"\0" * 8]:
            archive.write_bytes(corrupt)
            result = probe.run(request(archive, "tar_gzip"))
            self.assertFalse(result["coverageComplete"])

    def test_compressed_expanded_and_member_budgets_are_independent(self):
        archive = self.normal_archive()
        result = probe.run(request(archive, "tar", maxArchiveBytes=1024))
        self.assertEqual(result["issues"][0]["reason"], "archive_byte_limit")
        archive.write_bytes(gzip.compress(b"\0" * 2000000))
        result = probe.run(request(archive, "tar_gzip", maxExpandedBytes=1024))
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["expandedBytes"], 1025)
        archive = self.archive([("big", b"x" * 4000, tarfile.REGTYPE, "")])
        result = probe.run(request(archive, "tar", maxFileBytes=1024))
        self.assertEqual(result["entries"][0]["status"], "partial")
        self.assertNotIn("sha256", result["entries"][0])

    def test_metadata_header_size_is_bounded_before_payload_allocation(self):
        archive = self.archive([("meta", b"x" * 65537, tarfile.XHDTYPE, "")])
        result = probe.run(request(archive, "tar"))
        self.assertEqual(result["issues"][0]["reason"], "metadata_byte_limit")
        self.assertEqual(result["expandedBytes"], 512)

    def test_duplicate_pax_keys_are_rejected(self):
        def record(key, value):
            body = (key + "=" + value + "\n").encode()
            length = len(body) + 2
            while len(str(length)) + 1 + len(body) != length:
                length = len(str(length)) + 1 + len(body)
            return str(length).encode() + b" " + body
        payload = record("path", "a") + record("path", "b")
        archive = self.archive([("meta", payload, tarfile.XHDTYPE, ""), ("original", b"x", tarfile.REGTYPE, "")])
        result = probe.run(request(archive, "tar"))
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["issues"][0]["reason"], "duplicate_metadata")

    def test_real_gnu_tar_command_format(self):
        (self.tree / "中文.txt").write_bytes(b"gnu-tar-fixture")
        archive = self.root / "real.tar.gz"
        subprocess.run(["tar", "-czf", str(archive), "-C", str(self.tree), "."], check=True, timeout=5, capture_output=True)
        result = probe.run(request(archive, "tar_gzip"))
        self.assertTrue(result["coverageComplete"], result)
        self.assertEqual(result["entries"][0]["path"], "中文.txt")

    def test_timeout_is_not_empty_complete(self):
        clock = [0]
        def tick():
            clock[0] += 1
            return clock[0]
        result = probe.run(request(self.tree, timeoutSeconds=1), clock=tick)
        self.assertEqual(result["status"], "timeout")
        self.assertIsNone(result["manifestSha256"])

    def test_output_limit_preserves_original_coverage_loss(self):
        for index in range(12):
            (self.tree / (str(index) + "长" * 40)).write_bytes(b"x")
        with patch.object(probe, "OUTPUT_LIMIT", 4000):
            result = probe.run(request(self.tree))
        self.assertFalse(result["coverageComplete"])
        self.assertTrue(result["truncated"])
        self.assertLess(len(json.dumps(result, ensure_ascii=True, separators=(",", ":")).encode()), 4000)
        self.assertLess(len(result["entries"]), result["scannedEntries"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
