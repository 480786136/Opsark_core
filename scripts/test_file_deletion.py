"""真实 POSIX 文件夹具；所有写入、删除及竞争注入只发生在专有临时目录内。"""
import contextlib
import errno
import fcntl
import hashlib
import importlib.util
import io
import json
import mmap
import os
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
LOCATION = Path(__file__).resolve().parents[1] / "src/features/tools/file_deletion.py"
SPEC = importlib.util.spec_from_file_location("exact_file_deletion", LOCATION)
probe = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(probe)


class FileDeletionTests(unittest.TestCase):
    def setUp(self):
        self.owned = tempfile.TemporaryDirectory(prefix="opsark-file-deletion-")
        self.root = Path(self.owned.name).resolve()
        self.candidates = self.root / "candidates"
        self.candidates.mkdir()
        self.control = self.root / "outside-candidates"
        self.control.mkdir()
        self.sentinel = self.control / "must-survive"
        self.sentinel.write_bytes(b"outside candidate set")

    def tearDown(self):
        # No paths from the application are passed to cleanup. TemporaryDirectory
        # owns only the root created by this test, in this same POSIX process.
        try:
            self.assertEqual(self.sentinel.read_bytes(), b"outside candidate set")
        finally:
            self.owned.cleanup()

    def make(self, name, data=b"original"):
        path = self.candidates / name
        path.write_bytes(data)
        return path

    def preview(self, paths):
        return probe.run({"mode": "preview", "paths": [str(p) for p in paths]})["items"]

    def execute_rejected(self, items):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), self.assertRaises((ValueError, OSError)):
            probe.run({"mode": "execute", "items": items})
        receipts = [json.loads(line) for line in output.getvalue().splitlines() if line.strip()]
        for receipt in receipts:
            self.assertFalse(receipt.get("complete", False))
        return receipts

    def attempt_writer(self, path, before):
        # An actual separate process asks the kernel for write access. Without
        # a lease it performs the former red-case same-inode equal-size write
        # and restores mtime. O_NONBLOCK avoids waiting for the kernel's lease
        # break timeout while the test holds a capture syscall boundary.
        script = """import errno,json,os,sys
path,atime,mtime=json.loads(sys.argv[1])
try:
    fd=os.open(path,os.O_WRONLY|os.O_NONBLOCK)
except OSError as error:
    if error.errno not in (errno.EAGAIN,errno.EWOULDBLOCK): raise
    print('blocked-by-lease')
else:
    try: os.write(fd,b'BBBB')
    finally: os.close(fd)
    os.utime(path,ns=(atime,mtime))
    print('modified')
"""
        result = subprocess.run([sys.executable, "-c", script,
                                 json.dumps([str(path), before.st_atime_ns, before.st_mtime_ns])],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5, check=True)
        return result.stdout.decode("ascii").strip()

    def test_exact_three_files_and_new_unlisted_file(self):
        paths = [self.make("file%d" % i) for i in range(3)]
        snapshot = self.preview(paths)
        extra = self.make("created-after-preview", b"not authorized")
        result = probe.run({"mode": "execute", "items": snapshot})
        self.assertEqual(result, {"mode": "execute", "deleted": [str(p) for p in paths]})
        self.assertTrue(all(not p.exists() for p in paths))
        self.assertEqual(extra.read_bytes(), b"not authorized")

    def test_entire_list_is_checked_before_any_deletion(self):
        paths = [self.make("item%d" % i) for i in range(3)]
        snapshot = self.preview(paths)
        paths[-1].write_bytes(b"changed before execute")
        receipts = self.execute_rejected(snapshot)
        self.assertTrue(all(p.exists() for p in paths))
        self.assertEqual(paths[0].read_bytes(), b"original")
        self.assertTrue(receipts)
        self.assertEqual(receipts[-1]["deleted"], [])

    def test_missing_last_file_preserves_earlier_candidates(self):
        first, missing = self.make("first"), self.make("missing")
        snapshot = self.preview([first, missing])
        missing.unlink()
        self.execute_rejected(snapshot)
        self.assertEqual(first.read_bytes(), b"original")

    def test_same_size_change_with_restored_mtime_is_rejected(self):
        path = self.make("same-size", b"AAAA")
        snapshot = self.preview([path])
        before = path.stat()
        time.sleep(0.01)
        path.write_bytes(b"BBBB")
        os.utime(str(path), ns=(before.st_atime_ns, before.st_mtime_ns))
        self.assertEqual(path.stat().st_size, before.st_size)
        self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
        # Some kernels expose the same coarse ctime for these two writes. The
        # frozen digest must reject either case; a clock tick is not evidence.
        self.execute_rejected(snapshot)
        self.assertEqual(path.read_bytes(), b"BBBB")

    def test_equal_metadata_after_real_same_tick_rewrite_is_rejected_by_digest(self):
        path = self.make("coarse-ctime", b"AAAA")
        snapshot = None
        # Reproduce a real timestamp collision, never mock stat/identity. Keep
        # this bounded; no system clock settings or global files are changed.
        for _ in range(200):
            path.write_bytes(b"AAAA")
            candidate = self.preview([path])
            before = path.stat()
            path.write_bytes(b"BBBB")
            os.utime(str(path), ns=(before.st_atime_ns, before.st_mtime_ns))
            if path.stat().st_ctime_ns == before.st_ctime_ns:
                snapshot = candidate
                break
        self.assertIsNotNone(snapshot, "the real coarse timestamp collision fixture did not reproduce")
        parent = probe.open_parent(str(path))
        try:
            self.assertEqual(probe.identity(str(path), parent), probe.metadata(snapshot[0]))
        finally:
            os.close(parent)
        self.assertEqual(snapshot[0]["sha256"], hashlib.sha256(b"AAAA").hexdigest())
        receipts = self.execute_rejected(snapshot)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.read_bytes(), b"BBBB")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_missing_or_tampered_frozen_digest_rejects_before_capture(self):
        path = self.make("digest")
        snapshot = self.preview([path])
        self.assertEqual(snapshot[0]["sha256"], hashlib.sha256(b"original").hexdigest())
        for digest in (None, "0" * 64, "A" * 64, "a" * 63):
            changed = json.loads(json.dumps(snapshot))
            if digest is None:
                del changed[0]["sha256"]
            else:
                changed[0]["sha256"] = digest
            self.execute_rejected(changed)
        self.assertEqual(path.read_bytes(), b"original")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_actual_hash_limit_rejects_sparse_candidate_before_read_or_capture(self):
        path = self.make("oversized-sparse", b"")
        with path.open("wb") as target:
            target.truncate(probe.MAX_HASH_BYTES // 2 + 1)
        parent = probe.open_parent(str(path))
        try:
            item = probe.identity(str(path), parent)
            item["sha256"] = "0" * 64
        finally:
            os.close(parent)
        original_read = probe.os.read
        with patch.object(probe.os, "read", wraps=original_read) as reads:
            with self.assertRaises(ValueError):
                self.preview([path])
            receipts = self.execute_rejected([item])
            reads.assert_not_called()
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.stat().st_size, probe.MAX_HASH_BYTES // 2 + 1)
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_total_hash_accounting_reserves_both_execute_passes_before_moves(self):
        paths = [self.make("bytes3", b"abc"), self.make("bytes4", b"defg")]
        snapshot = self.preview(paths)
        with patch.object(probe, "MAX_HASH_BYTES", 13):
            self.execute_rejected(snapshot)
            with self.assertRaises(ValueError):
                self.preview(paths)
        self.assertTrue(all(path.exists() for path in paths))
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))
        original_read = probe.os.read
        read_sizes = []

        def counted_read(fd, count):
            chunk = original_read(fd, count)
            read_sizes.append(len(chunk))
            return chunk

        with patch.object(probe, "MAX_HASH_BYTES", 14), patch.object(probe.os, "read", side_effect=counted_read):
            result = probe.run({"mode": "execute", "items": snapshot})
        self.assertEqual(result["deleted"], [str(path) for path in paths])
        self.assertEqual(sum(read_sizes), 14)
        self.assertEqual([size for size in read_sizes if size], [3, 4, 3, 4])

    def test_replaced_inode_with_same_size_and_mtime_is_rejected(self):
        path = self.make("same-name", b"AAAA")
        snapshot = self.preview([path])
        before = path.stat()
        replacement = self.make("replacement", b"BBBB")
        os.utime(str(replacement), ns=(before.st_atime_ns, before.st_mtime_ns))
        os.replace(str(replacement), str(path))
        self.execute_rejected(snapshot)
        self.assertEqual(path.read_bytes(), b"BBBB")

    def test_preview_rejects_symlink_directory_and_parent_symlink(self):
        regular = self.make("regular")
        link = self.candidates / "link"
        link.symlink_to(self.sentinel)
        folder = self.candidates / "directory"
        folder.mkdir()
        parent_link = self.candidates / "parent-link"
        parent_link.symlink_to(self.control, target_is_directory=True)
        for path in (link, folder, parent_link / self.sentinel.name):
            with self.subTest(path=path), self.assertRaises((ValueError, OSError)):
                self.preview([regular, path])
            self.assertEqual(regular.read_bytes(), b"original")

    def test_execute_rejects_candidate_replaced_by_link_or_directory(self):
        for replacement_kind in ("symlink", "directory"):
            first = self.make("first-" + replacement_kind)
            target = self.make("target-" + replacement_kind)
            snapshot = self.preview([first, target])
            target.unlink()
            if replacement_kind == "symlink":
                target.symlink_to(self.sentinel)
            else:
                target.mkdir()
            self.execute_rejected(snapshot)
            self.assertEqual(first.read_bytes(), b"original")
            self.assertTrue(target.is_symlink() if replacement_kind == "symlink" else target.is_dir())

    def test_execute_rejects_replaced_parent_symlink(self):
        path = self.make("file")
        snapshot = self.preview([path])
        moved = self.root / "original-parent"
        self.candidates.rename(moved)
        self.candidates.symlink_to(self.control, target_is_directory=True)
        self.execute_rejected(snapshot)
        self.assertEqual((moved / "file").read_bytes(), b"original")

    def test_unicode_spaces_quotes_newlines_tabs_and_literal_shell_characters(self):
        names = ["中文 空格'双\"引号", "line\nbreak\ttab", "$(touch SHOULD_NOT_EXIST)*?\\literal"]
        paths = [self.make(name) for name in names]
        # CLI JSON is exercised as real bytes; no mocked file operations.
        preview = subprocess.run([sys.executable, "-I", "-B", "-S", str(LOCATION), json.dumps({"mode": "preview", "paths": [str(p) for p in paths]}, ensure_ascii=False)],
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        items = json.loads(preview.stdout.decode("utf-8"))["items"]
        self.assertEqual([os.fsencode(item["path"]) for item in items], [os.fsencode(str(p)) for p in paths])
        result = subprocess.run([sys.executable, "-I", "-B", "-S", str(LOCATION), json.dumps({"mode": "execute", "items": items}, ensure_ascii=False)],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)
        self.assertEqual(json.loads(result.stdout.decode("utf-8"))["deleted"], [str(p) for p in paths])
        self.assertFalse((self.candidates / "SHOULD_NOT_EXIST").exists())
        self.assertEqual(list(self.candidates.iterdir()), [])

    def test_invalid_duplicate_relative_and_traversal_paths_do_not_delete(self):
        path = self.make("ordinary")
        for paths in ([], [str(path)] * 2, ["relative"], [str(self.candidates) + "/../outside-candidates/must-survive"],
                      [str(self.candidates) + "//ordinary"], [str(path) + "\x00"], [str(path)] * 101):
            with self.subTest(paths=paths), self.assertRaises(ValueError):
                probe.run({"mode": "preview", "paths": paths})
            self.assertEqual(path.read_bytes(), b"original")

    def test_tampered_identity_and_duplicate_execute_list_are_rejected(self):
        path = self.make("original")
        snapshot = self.preview([path])
        changed = json.loads(json.dumps(snapshot))
        changed[0]["identity"][3] = str(int(changed[0]["identity"][3]) + 1)
        self.execute_rejected(changed)
        self.execute_rejected(snapshot + snapshot)
        self.assertEqual(path.read_bytes(), b"original")

    def test_deleting_one_hardlink_does_not_delete_unlisted_alias(self):
        path = self.make("listed")
        alias = self.control / "unlisted-hardlink"
        os.link(str(path), str(alias))
        snapshot = self.preview([path])
        probe.run({"mode": "execute", "items": snapshot})
        self.assertFalse(path.exists())
        self.assertEqual(alias.read_bytes(), b"original")

    def test_two_candidate_names_for_one_inode_are_rejected_before_mutation(self):
        path = self.make("hardlink-first")
        alias = self.candidates / "hardlink-second"
        os.link(str(path), str(alias))
        snapshot = self.preview([path, alias])
        receipts = self.execute_rejected(snapshot)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.read_bytes(), b"original")
        self.assertEqual(alias.read_bytes(), b"original")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_symlink_inserted_during_capture_is_restored_without_following(self):
        path = self.make("link-race")
        snapshot = self.preview([path])
        original_rename = probe.os.rename
        injected = []

        def replace_before_capture(source, target, **kwargs):
            if source == path.name:
                path.unlink()
                path.symlink_to(self.sentinel)
                injected.append(True)
            return original_rename(source, target, **kwargs)

        with patch.object(probe.os, "rename", side_effect=replace_before_capture):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(injected, [True])
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertTrue(path.is_symlink())
        self.assertEqual(os.readlink(str(path)), str(self.sentinel))
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_io_failure_after_one_private_unlink_reports_only_that_partial_deletion(self):
        paths = [self.make("partial-first"), self.make("partial-second")]
        snapshot = self.preview(paths)
        original_rename = probe.os.rename
        original_unlink = probe.os.unlink
        failed = []
        with contextlib.ExitStack() as injections:
            def fail_second_unlink(name, **kwargs):
                if name == "candidate" and not failed:
                    info = os.stat(name, dir_fd=kwargs["dir_fd"], follow_symlinks=False)
                    if str(info.st_ino) == snapshot[1]["identity"][3]:
                        failed.append(True)
                        raise OSError("injected I/O failure after first deletion")
                return original_unlink(name, **kwargs)

            def arm_after_capture(source, target, **kwargs):
                result = original_rename(source, target, **kwargs)
                if source == paths[1].name:
                    # Parent capability checks have completed. Only this actual
                    # unlink is fault-injected; all other operations remain real.
                    injections.enter_context(patch.object(probe.os, "unlink", side_effect=fail_second_unlink))
                return result

            injections.enter_context(patch.object(probe.os, "rename", side_effect=arm_after_capture))
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(failed, [True])
        self.assertEqual(receipts[-1]["deleted"], [str(paths[0])])
        self.assertFalse(receipts[-1]["complete"])
        self.assertFalse(paths[0].exists())
        self.assertEqual(paths[1].read_bytes(), b"original")

    def test_race_after_final_identity_never_deletes_a_new_public_inode(self):
        path = self.make("racing", b"authorized original")
        replacement = self.make("new-inode", b"not authorized")
        snapshot = self.preview([path])
        original_rename = probe.os.rename
        injected = []

        def replace_before_capture(source, target, **kwargs):
            if source == path.name:
                os.replace(str(replacement), str(path))
                injected.append(True)
            return original_rename(source, target, **kwargs)

        with patch.object(probe.os, "rename", side_effect=replace_before_capture):
            self.execute_rejected(snapshot)
        self.assertEqual(injected, [True], "competition injection must be reached")
        self.assertTrue(path.exists(), "unapproved replacement was deleted after the final identity check")
        self.assertEqual(path.read_bytes(), b"not authorized")

    def test_new_public_file_after_capture_survives_deleting_the_approved_inode(self):
        path = self.make("public", b"approved")
        snapshot = self.preview([path])
        original_rename = probe.os.rename
        injected = []

        def create_after_capture(source, target, **kwargs):
            result = original_rename(source, target, **kwargs)
            if source == path.name:
                path.write_bytes(b"new and unapproved")
                injected.append(True)
            return result

        with patch.object(probe.os, "rename", side_effect=create_after_capture):
            result = probe.run({"mode": "execute", "items": snapshot})
        self.assertEqual(injected, [True])
        self.assertEqual(result["deleted"], [str(path)])
        self.assertEqual(path.read_bytes(), b"new and unapproved")
        self.assertNotEqual(str(path.stat().st_ino), snapshot[0]["identity"][3])

    def test_capture_failure_rolls_back_all_previous_captures_without_deleting(self):
        paths = [self.make("first"), self.make("second")]
        snapshot = self.preview(paths)
        original_rename = probe.os.rename

        def fail_second(source, target, **kwargs):
            if source == paths[1].name:
                raise OSError("injected second capture failure")
            return original_rename(source, target, **kwargs)

        with patch.object(probe.os, "rename", side_effect=fail_second):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(receipts[-1]["retained"], [])
        self.assertTrue(all(path.read_bytes() == b"original" for path in paths))
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_rollback_conflict_preserves_new_public_and_quarantined_original(self):
        paths = [self.make("first", b"approved original"), self.make("second")]
        snapshot = self.preview(paths)
        original_rename = probe.os.rename

        def conflict_then_fail(source, target, **kwargs):
            if source == paths[1].name:
                raise OSError("injected second capture failure")
            result = original_rename(source, target, **kwargs)
            if source == paths[0].name:
                paths[0].write_bytes(b"new public file")
            return result

        with patch.object(probe.os, "rename", side_effect=conflict_then_fail):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(paths[0].read_bytes(), b"new public file")
        self.assertEqual(paths[1].read_bytes(), b"original")
        self.assertEqual(len(receipts[-1]["retained"]), 1)
        retained = receipts[-1]["retained"][0]
        self.assertEqual(retained["original"], str(paths[0]))
        quarantine = Path(retained["quarantine"])
        self.assertEqual(quarantine.parent.parent, self.candidates)
        self.assertTrue(quarantine.parent.name.startswith(".opsark-delete-"))
        self.assertEqual(quarantine.read_bytes(), b"approved original")
        self.assertEqual(quarantine.parent.stat().st_mode & 0o777, 0o700)

    def test_same_inode_modified_before_capture_and_mtime_restored_is_not_deleted(self):
        path = self.make("same-inode-race", b"AAAA")
        snapshot = self.preview([path])
        before = path.stat()
        original_rename = probe.os.rename
        injected = []

        def mutate_before_capture(source, target, **kwargs):
            if source == path.name:
                injected.append(self.attempt_writer(path, before))
            return original_rename(source, target, **kwargs)

        with patch.object(probe.os, "rename", side_effect=mutate_before_capture):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(injected, ["blocked-by-lease"])
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertTrue(path.exists(), "the interrupted capture must restore the original file")
        self.assertEqual(path.read_bytes(), b"AAAA")
        self.assertEqual(path.stat().st_ino, before.st_ino)

    def test_existing_writable_fd_rejects_entire_list_before_any_capture(self):
        first, last = self.make("first"), self.make("last")
        snapshot = self.preview([first, last])
        writer = os.open(str(last), os.O_WRONLY)
        try:
            receipts = self.execute_rejected(snapshot)
        finally:
            os.close(writer)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(first.read_bytes(), b"original")
        self.assertEqual(last.read_bytes(), b"original")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_preview_with_existing_writer_fails_without_returning_a_frozen_snapshot(self):
        path = self.make("preview-busy")
        writer = os.open(str(path), os.O_WRONLY)
        try:
            with self.assertRaises(probe.DeletionError) as failure:
                self.preview([path])
            self.assertEqual(failure.exception.code, "LEASE_CONFLICT")
        finally:
            os.close(writer)
        self.assertEqual(path.read_bytes(), b"original")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_preview_hash_fd_is_leased_and_writer_request_invalidates_snapshot(self):
        path = self.make("preview-race", b"AAAA")
        before = path.stat()
        original_hash = probe.hash_content
        outcomes = []
        original_handler = signal.getsignal(signal.SIGIO)

        def writer_during_hash(fd, leases, budget):
            self.assertEqual(os.fstat(fd).st_ino, before.st_ino)
            self.assertEqual(fcntl.fcntl(fd, fcntl.F_GETLEASE), fcntl.F_RDLCK)
            previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGIO})
            try:
                outcomes.append(self.attempt_writer(path, before))
            finally:
                signal.pthread_sigmask(signal.SIG_SETMASK, previous)
            return original_hash(fd, leases, budget)

        with patch.object(probe, "hash_content", side_effect=writer_during_hash), self.assertRaises(ValueError):
            self.preview([path])
        self.assertEqual(outcomes, ["blocked-by-lease"])
        self.assertEqual(path.read_bytes(), b"AAAA")
        self.assertIs(signal.getsignal(signal.SIGIO), original_handler)
        writable = os.open(str(path), os.O_WRONLY | os.O_NONBLOCK)
        os.close(writable)
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_existing_writable_mapping_even_after_fd_closed_rejects_before_capture(self):
        path = self.make("mapped")
        snapshot = self.preview([path])
        fd = os.open(str(path), os.O_RDWR)
        mapping = mmap.mmap(fd, 0, access=mmap.ACCESS_WRITE)
        os.close(fd)
        try:
            self.execute_rejected(snapshot)
            self.assertEqual(path.read_bytes(), b"original")
            self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))
        finally:
            mapping.close()

    def test_unsupported_lease_rejects_before_mutation_and_releases_earlier_leases(self):
        paths = [self.make("first"), self.make("unsupported")]
        snapshot = self.preview(paths)
        previous_handler = signal.getsignal(signal.SIGIO)
        original_fcntl = fcntl.fcntl
        acquisitions = []

        def reject_second(fd, command, argument=0):
            if command == fcntl.F_SETLEASE and argument == fcntl.F_RDLCK:
                acquisitions.append(fd)
                if len(acquisitions) == 2:
                    raise OSError(errno.EINVAL, "injected filesystem does not support leases")
            return original_fcntl(fd, command, argument)

        with patch.object(probe.fcntl, "fcntl", side_effect=reject_second):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(receipts[-1]["reason"]["code"], "LEASE_UNSUPPORTED")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))
        self.assertIs(signal.getsignal(signal.SIGIO), previous_handler)
        for path in paths:
            writable = os.open(str(path), os.O_WRONLY | os.O_NONBLOCK)
            os.close(writable)
            self.assertEqual(path.read_bytes(), b"original")

    def test_cli_failure_codes_are_explanatory_without_file_content_or_path_echo(self):
        secret = b"SYNTHETIC_PRIVATE_BODY_DO_NOT_ECHO"
        changed = self.make("private-name-do-not-echo", secret)
        snapshot = self.preview([changed])
        changed.write_bytes(secret + b"changed")
        busy = self.make("busy-private-name", secret)
        busy_snapshot = self.preview([busy])
        large = self.make("large-private-name", b"")
        with large.open("wb") as file:
            file.truncate(probe.MAX_HASH_BYTES // 2 + 1)
        writer = os.open(str(busy), os.O_WRONLY)
        try:
            for request, code in [
                ({"mode": "execute", "items": snapshot}, "CANDIDATE_CHANGED"),
                ({"mode": "execute", "items": busy_snapshot}, "LEASE_CONFLICT"),
                ({"mode": "preview", "paths": [str(large)]}, "HASH_LIMIT_EXCEEDED"),
                ({"mode": "preview", "paths": ["PRIVATE_BAD_REQUEST_PATH"]}, "INVALID_REQUEST"),
            ]:
                with self.subTest(code=code):
                    result = subprocess.run([sys.executable, "-I", "-B", "-S", str(LOCATION), json.dumps(request)],
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
                    self.assertEqual(result.returncode, 1)
                    lines = result.stderr.decode("utf-8").splitlines()
                    diagnostics = [json.loads(line[len("OPSARK_DELETE_ERROR "):]) for line in lines
                                   if line.startswith("OPSARK_DELETE_ERROR ")]
                    self.assertEqual(diagnostics, [{"code": code, "message": probe.ERROR_MESSAGES[code]}])
                    self.assertTrue(any(line.startswith("EXACT_FILE_DELETION_FAILED:") for line in lines))
                    self.assertNotIn(secret, result.stderr + result.stdout)
                    self.assertNotIn(b"private-name", result.stderr)
                    self.assertNotIn(b"PRIVATE_BAD_REQUEST_PATH", result.stderr)
                    if request["mode"] == "execute":
                        receipt = json.loads(result.stdout)
                        self.assertFalse(receipt["complete"])
                        self.assertEqual(receipt["deleted"], [])
                        self.assertEqual(receipt["reason"], diagnostics[0])
        finally:
            os.close(writer)
        self.assertTrue(changed.exists() and busy.exists() and large.exists())
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_diagnostic_mapping_never_uses_arbitrary_exception_messages(self):
        secret = "private contents and path /unapproved/hidden"
        for error, code in [(OSError(errno.EIO, secret, secret), "IO_FAILURE"),
                            (ValueError(secret), "INVALID_REQUEST"), (RuntimeError(secret), "INTERNAL_ERROR")]:
            result = probe.safe_error(error)
            self.assertEqual(result, {"code": code, "message": probe.ERROR_MESSAGES[code]})
            self.assertNotIn(secret, json.dumps(result))

    def test_lease_errno_is_classified_without_reflecting_os_error_text(self):
        path = self.make("lease-reason")
        snapshot = self.preview([path])
        original_fcntl = fcntl.fcntl
        for failure_errno, code in [(errno.EINVAL, "LEASE_UNSUPPORTED"), (errno.EPERM, "LEASE_PERMISSION_DENIED"),
                                     (errno.EAGAIN, "LEASE_CONFLICT")]:
            def fail_lease(fd, command, argument=0):
                if command == fcntl.F_SETLEASE and argument == fcntl.F_RDLCK:
                    raise OSError(failure_errno, "PRIVATE_OS_ERROR", str(path))
                return original_fcntl(fd, command, argument)
            with self.subTest(code=code), patch.object(probe.fcntl, "fcntl", side_effect=fail_lease):
                receipts = self.execute_rejected(snapshot)
            self.assertEqual(receipts[-1]["reason"], {"code": code, "message": probe.ERROR_MESSAGES[code]})
            self.assertNotIn("PRIVATE_OS_ERROR", json.dumps(receipts))
        self.assertEqual(path.read_bytes(), b"original")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_writer_through_unlisted_alias_after_capture_aborts_and_restores(self):
        path = self.make("captured", b"AAAA")
        alias = self.control / "alias"
        os.link(str(path), str(alias))
        snapshot, before = self.preview([path]), path.stat()
        original_rename = probe.os.rename
        outcomes = []

        def writer_after_capture(source, target, **kwargs):
            result = original_rename(source, target, **kwargs)
            if source == path.name:
                outcomes.append(self.attempt_writer(alias, before))
            return result

        with patch.object(probe.os, "rename", side_effect=writer_after_capture):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(outcomes, ["blocked-by-lease"])
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.read_bytes(), b"AAAA")
        self.assertEqual(alias.read_bytes(), b"AAAA")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_quarantine_mode_change_before_capture_is_rejected(self):
        path = self.make("mode-change")
        snapshot = self.preview([path])
        original_mkdir = probe.os.mkdir

        def exposed_directory(name, mode, **kwargs):
            result = original_mkdir(name, mode, **kwargs)
            os.chmod(name, 0o755, dir_fd=kwargs["dir_fd"])
            return result

        with patch.object(probe.os, "mkdir", side_effect=exposed_directory):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.read_bytes(), b"original")

    def test_quarantine_owner_change_before_capture_is_rejected(self):
        path = self.make("owner-change")
        snapshot = self.preview([path])
        original_mkdir = probe.os.mkdir
        changed = []
        if os.geteuid() != 0:
            self.fail("the real owner substitution fixture requires a dedicated root POSIX runner")

        def foreign_directory(name, mode, **kwargs):
            result = original_mkdir(name, mode, **kwargs)
            os.chown(name, 65534, -1, dir_fd=kwargs["dir_fd"], follow_symlinks=False)
            changed.append(self.candidates / name)
            return result

        with patch.object(probe.os, "mkdir", side_effect=foreign_directory):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.read_bytes(), b"original")
        self.assertEqual(len(changed), 1)
        self.assertEqual(changed[0].stat().st_uid, 65534)

    def test_lost_lease_before_capture_rejects_and_removes_only_own_empty_directory(self):
        path = self.make("lost-lease")
        snapshot = self.preview([path])
        original_verify = probe.verify_quarantine
        original_acquire = probe.ReadLeases.acquire
        held = []
        lost = []

        def track_acquire(leases, fd):
            original_acquire(leases, fd)
            held.append(fd)

        def release_before_capture(entry, **kwargs):
            original_verify(entry, **kwargs)
            if not lost:
                fcntl.fcntl(held[0], fcntl.F_SETLEASE, fcntl.F_UNLCK)
                lost.append(True)

        with patch.object(probe.ReadLeases, "acquire", new=track_acquire), \
                patch.object(probe, "verify_quarantine", side_effect=release_before_capture):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(lost, [True])
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.read_bytes(), b"original")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_expired_local_lease_window_aborts_after_capture_and_restores(self):
        path = self.make("lease-window")
        snapshot = self.preview([path])
        original_rename = probe.os.rename
        original_clock = probe.time.monotonic
        shifted = []

        def exceed_window(source, target, **kwargs):
            result = original_rename(source, target, **kwargs)
            if source == path.name:
                shifted.append(True)
            return result

        with patch.object(probe.os, "rename", side_effect=exceed_window), \
                patch.object(probe.time, "monotonic", side_effect=lambda: original_clock() + (10 if shifted else 0)):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(shifted, [True])
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.read_bytes(), b"original")
        self.assertFalse(list(self.candidates.glob(".opsark-delete-*")))

    def test_quarantine_replacement_before_open_is_rejected_and_replacement_preserved(self):
        path = self.make("directory-race")
        snapshot = self.preview([path])
        original_open = probe.os.open
        changed = []

        def replace_directory(name, flags, *args, **kwargs):
            if str(name).startswith(".opsark-delete-"):
                original = self.candidates / name
                moved = self.candidates / (name + "-moved")
                original.rename(moved)
                original.mkdir(mode=0o700)
                (original / "unapproved").write_bytes(b"keep")
                changed.append(original)
            return original_open(name, flags, *args, **kwargs)

        with patch.object(probe.os, "open", side_effect=replace_directory):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(len(changed), 1)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.read_bytes(), b"original")
        self.assertEqual((changed[0] / "unapproved").read_bytes(), b"keep")

    def test_quarantine_replacement_after_capture_restores_original_via_held_directory(self):
        path = self.make("after-capture")
        snapshot = self.preview([path])
        original_rename = probe.os.rename
        changed = []

        def replace_captured_directory(source, target, **kwargs):
            result = original_rename(source, target, **kwargs)
            if source == path.name:
                directory = Path(os.readlink("/proc/self/fd/%d" % kwargs["dst_dir_fd"]))
                directory.rename(directory.with_name(directory.name + "-moved"))
                directory.mkdir(mode=0o700)
                (directory / "candidate").write_bytes(b"unapproved")
                changed.append(directory)
            return result

        with patch.object(probe.os, "rename", side_effect=replace_captured_directory):
            receipts = self.execute_rejected(snapshot)
        self.assertEqual(len(changed), 1)
        self.assertEqual(receipts[-1]["deleted"], [])
        self.assertEqual(path.read_bytes(), b"original")
        self.assertEqual((changed[0] / "candidate").read_bytes(), b"unapproved")


if __name__ == "__main__":
    print("真实本机 Python：%s；平台：%s；所有变更仅限 TemporaryDirectory。" % (sys.version.split()[0], sys.platform), flush=True)
    unittest.main(verbosity=2)
