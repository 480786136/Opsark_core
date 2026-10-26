"""B01 POSIX tests: real temporary locks and controlled fixed command receipts."""
import ast
import fcntl
import importlib.util
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
location = Path(__file__).resolve().parents[1] / "src/features/tools/package_probe.py"
spec = importlib.util.spec_from_file_location("package_probe", location)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def pk_reply(owner="b true", transactions="ao 0", locked="b false"):
    calls = []
    def invoke(args, _deadline):
        calls.append(args)
        if "NameHasOwner" in args:
            return 0, owner
        if "GetTransactionList" in args:
            return 0, transactions
        return 0, locked
    return invoke, calls


class PackageTests(unittest.TestCase):
    def test_python36_syntax(self):
        ast.parse(location.read_text(), feature_version=(3, 6))

    def test_real_flock_then_release_is_observed_without_acquiring_or_removing_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "apt-lock"
            path.write_bytes(b"untouched")
            with path.open("rb") as handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                observed = probe.lock_snapshot([str(path)])[0]
                self.assertEqual(observed["state"], "held")
                self.assertTrue(any(row["pid"] == os.getpid() for row in observed["holders"]))
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            self.assertEqual(probe.lock_snapshot([str(path)])[0]["state"], "clear")
            self.assertEqual(path.read_bytes(), b"untouched")

    def test_real_posix_lock_in_another_process(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "dpkg-lock"
            path.touch()
            child = subprocess.Popen([sys.executable, "-c", "import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.lockf(f,fcntl.LOCK_EX); print('locked',flush=True); sys.stdin.read()", str(path)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE)
            try:
                self.assertEqual(child.stdout.readline(), b"locked\n")
                row = probe.lock_snapshot([str(path)])[0]
                self.assertEqual(row["state"], "held")
                self.assertEqual(row["holders"][0]["pid"], child.pid)
            finally:
                child.stdin.close()
                child.wait(timeout=3)
                child.stdout.close()
            self.assertEqual(probe.lock_snapshot([str(path)])[0]["state"], "clear")

    def test_unrelated_and_waiting_kernel_lock_do_not_block_target(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lock"
            path.touch()
            data = path.stat()
            identity = "%x:%x:%d" % (os.major(data.st_dev), os.minor(data.st_dev), data.st_ino)
            text = "1: POSIX ADVISORY WRITE 123 00:00:99 0 EOF\n2: -> POSIX ADVISORY WRITE 123 " + identity + " 0 EOF\n"
            with patch.object(probe, "read_limited", return_value=text):
                self.assertEqual(probe.lock_snapshot([str(path)])[0]["state"], "clear")

    def test_unreadable_kernel_table_is_unknown_even_when_file_missing(self):
        with patch.object(probe, "read_limited", side_effect=PermissionError()):
            self.assertEqual(probe.lock_snapshot(["/definitely-absent-opsark-lock"])[0]["state"], "unknown")

    def test_stale_pid_file_is_not_deleted_or_treated_as_activity(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "yum.pid"
            path.write_text("12345678\n")
            self.assertEqual(probe.pid_snapshot([str(path)], proc=directory)[0]["state"], "stale")
            self.assertEqual(path.read_text(), "12345678\n")

    def test_reused_pid_and_live_yum_pid_have_distinct_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); pid = root / "yum.pid"; pid.write_text("12")
            proc = root / "12"; proc.mkdir()
            for name, expected in [("unrelated", "unknown"), ("yum", "active")]:
                (proc / "stat").write_text("12 (" + name + ") S " + "0 " * 18 + "123456 0")
                result = probe.pid_snapshot([str(pid)], proc=directory)[0]
                self.assertEqual(result["state"], expected)
                self.assertEqual(result["startTicks"], "123456")

    def test_packagekit_resident_but_idle_does_not_block(self):
        invoke, calls = pk_reply()
        result = probe.packagekit_snapshot(time.monotonic() + 10, invoke)
        self.assertEqual(result, dict(state="idle", locked=False, transactions=[]))
        self.assertEqual(probe.decision_for([], [], result), "clear")
        self.assertTrue(all("--auto-start=no" in call for call in calls))
        self.assertFalse(any("CreateTransaction" in call for call in calls))

    def test_packagekit_absence_does_not_activate_daemon(self):
        invoke, calls = pk_reply(owner="b false")
        self.assertEqual(probe.packagekit_snapshot(time.monotonic() + 10, invoke)["state"], "absent")
        self.assertEqual(len(calls), 1)

    def test_packagekit_transactions_or_locked_are_dynamic_blockers(self):
        for transactions, locked in [('ao 1 "/12_abcd"', 'b false'), ('as 0', 'b true')]:
            invoke, _ = pk_reply(transactions=transactions, locked=locked)
            result = probe.packagekit_snapshot(time.monotonic() + 10, invoke)
            self.assertEqual(result["state"], "active")
            self.assertEqual(probe.decision_for([], [], result), "blocked")

    def test_packagekit_malformed_permission_timeout_remain_unknown(self):
        for invoke in [pk_reply(transactions='ao 1')[0], lambda *_: (1, "denied"), pk_reply(locked="")[0]]:
            self.assertEqual(probe.packagekit_snapshot(time.monotonic() + 10, invoke)["state"], "unknown")

    def test_wait_only_known_dynamic_state_and_stops_at_one_budget(self):
        current = [0.0]
        sleep = lambda seconds: current.__setitem__(0, current[0] + seconds)
        samples = iter([dict(decision="blocked", transactionCoverageComplete=True), dict(decision="clear", transactionCoverageComplete=True)])
        result = probe.wait_for_transactions(lambda _deadline: next(samples), 5, 10, lambda: current[0], sleep)
        self.assertEqual(result[1:], ("cleared", 2, 1000))
        current[0] = 0
        result = probe.wait_for_transactions(lambda _deadline: dict(decision="blocked", transactionCoverageComplete=True), 3, 10, lambda: current[0], sleep)
        self.assertEqual(result[1:], ("exhausted", 3, 3000))
        for state in ("unknown", "clear"):
            current[0] = 0
            result = probe.wait_for_transactions(lambda _deadline: dict(decision=state, transactionCoverageComplete=state != "unknown"), 30, 40, lambda: current[0], sleep)
            self.assertEqual(result[2:], (1, 0))

    def test_apt_policy_and_installed_versions_have_separate_semantics(self):
        calls = []
        def invoke(args, _deadline):
            calls.append(args)
            return (0, "redis-server\tinstalled\t6:7.0.1\n") if args[0] == "dpkg-query" else (0, "redis-server:\n Installed: 6:7.0.1\n Candidate: 6:7.0.2\n")
        result = probe.package_versions("redis-server", "debian", time.monotonic() + 5, invoke)
        self.assertEqual(result["installedVersions"], ["6:7.0.1"])
        self.assertEqual(result["candidateVersions"][0]["version"], "6:7.0.2")
        self.assertIn("Dir::Cache::pkgcache=", calls[1])
        self.assertIn("Dir::Cache::srcpkgcache=", calls[1])

    def test_package_query_error_does_not_mean_absent_or_not_found(self):
        for family in ("debian", "rpm"):
            result = probe.package_versions("test", family, time.monotonic() + 5, lambda *_: (1, "permission denied"))
            self.assertEqual(result["installedStatus"], "unknown")
            self.assertEqual(result["candidateStatus"], "unknown")

    def test_repo_config_does_not_expose_credentials_or_claim_signatures_verified(self):
        with tempfile.TemporaryDirectory() as directory:
            repos = Path(directory) / "yum.repos.d"; repos.mkdir()
            (repos / "sample.repo").write_text("[archive]\nenabled=1\nbaseurl=https://user:secret@example.com/archive?token=secret\ngpgcheck=1\n")
            values, status, _ = probe.source_snapshot("rpm", directory)
            self.assertEqual(status, "complete")
            self.assertEqual(values[0]["origins"], ["https://example.com"])
            self.assertTrue(values[0]["signatureCheck"])
            self.assertNotIn("secret", str(values))

    def test_malformed_and_symlink_source_are_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            repos = Path(directory) / "yum.repos.d"; repos.mkdir()
            (repos / "broken.repo").write_text("bad format")
            (repos / "link.repo").symlink_to(repos / "broken.repo")
            self.assertEqual(probe.source_snapshot("rpm", directory)[1], "partial")

    def test_duplicate_repository_ids_do_not_claim_complete_source_policy(self):
        with tempfile.TemporaryDirectory() as directory:
            repos = Path(directory) / "yum.repos.d"; repos.mkdir()
            for name in ("first", "second"):
                (repos / (name + ".repo")).write_text("[same]\nenabled=1\nbaseurl=https://example.test/\n")
            self.assertEqual(probe.source_snapshot("rpm", directory)[1], "partial")

    def test_source_directory_permission_failure_is_not_an_empty_complete_inventory(self):
        for family in ("rpm", "debian"):
            with self.subTest(family=family), patch.object(probe.os, "scandir", side_effect=PermissionError("controlled directory listing denial")):
                values, status, issues = probe.source_snapshot(family, "/controlled-nonexistent-root")
            self.assertEqual(values, [])
            self.assertEqual(status, "partial")
            self.assertIn("permission_denied", issues)

    def test_source_directory_missing_is_observed_but_enumeration_is_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            self.assertEqual(probe.source_snapshot("rpm", directory)[1], "complete")
            repos = Path(directory) / "yum.repos.d"; repos.mkdir()
            for index in range(33):
                (repos / (str(index) + ".repo")).write_text("[repo" + str(index) + "]\nenabled=1\nbaseurl=https://example.test/\n")
            values, status, issues = probe.source_snapshot("rpm", directory)
            self.assertEqual(len(values), 32)
            self.assertEqual(status, "partial")
            self.assertIn("output_limit", issues)

    def test_source_enumeration_error_keeps_already_observed_sources_partial(self):
        with tempfile.TemporaryDirectory() as directory:
            repos = Path(directory) / "yum.repos.d"; repos.mkdir()
            source = repos / "first.repo"; source.write_text("[first]\nenabled=1\nbaseurl=https://example.test/\n")
            class Entry:
                name, path = source.name, str(source)
            class Entries:
                def __enter__(self):
                    return self
                def __exit__(self, *_args):
                    pass
                def __iter__(self):
                    yield Entry()
                    raise PermissionError("directory changed during enumeration")
            with patch.object(probe.os, "scandir", return_value=Entries()):
                values, status, issues = probe.source_snapshot("rpm", directory)
            self.assertEqual([item["id"] for item in values], ["first"])
            self.assertEqual(status, "partial")
            self.assertIn("permission_denied", issues)

    def test_rpm_cached_sqlite_is_read_only_unranked_and_bound_to_enabled_repository(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "x86_64/7/archive/primary_db.sqlite"; database.parent.mkdir(parents=True)
            connection = sqlite3.connect(str(database))
            connection.execute("CREATE TABLE packages(name TEXT, epoch TEXT, version TEXT, release TEXT, arch TEXT)")
            connection.execute("INSERT INTO packages VALUES ('redis','0','3.2.12','1.el7','x86_64')")
            connection.commit(); connection.close()
            before = database.read_bytes()
            packages = [probe.package_versions("redis", "rpm", time.monotonic() + 5, lambda *_: (1, "package redis is not installed"))]
            probe.rpm_cached_versions(packages, [dict(id="archive", enabled=True)], time.monotonic() + 5, directory)
            self.assertEqual(packages[0]["candidateSelection"], "unranked_cache")
            self.assertEqual(packages[0]["candidateVersions"][0]["version"], "0:3.2.12-1.el7")
            self.assertEqual(database.read_bytes(), before)
            self.assertFalse(Path(str(database) + "-wal").exists())

    def test_missing_rpm_cache_is_unknown_not_package_unavailable(self):
        with tempfile.TemporaryDirectory() as directory:
            packages = [probe.package_versions("redis", "rpm", time.monotonic() + 5, lambda *_: (1, "package redis is not installed"))]
            probe.rpm_cached_versions(packages, [], time.monotonic() + 5, directory)
            self.assertEqual(packages[0]["candidateStatus"], "unknown")

    def test_old_sqlite_does_not_silently_ignore_immutable_or_write_sidecars(self):
        packages = [dict(name="redis", candidateStatus="unknown")]
        with patch.object(probe.sqlite3, "sqlite_version_info", (3, 7, 17)), patch.object(probe.sqlite3, "connect", side_effect=AssertionError("must not open")):
            probe.rpm_cached_versions(packages, [], time.monotonic() + 5)
        self.assertEqual(packages[0]["candidateStatus"], "unknown")

    def test_initial_sample_duration_is_not_wait_time(self):
        current = [0.0]
        def sample(_deadline):
            current[0] += 3
            return dict(decision="clear", transactionCoverageComplete=True)
        result = probe.wait_for_transactions(sample, 0, 10, lambda: current[0], lambda _: None)
        self.assertEqual(result[1:], ("not_requested", 1, 0))

    def test_real_lock_clears_during_one_bounded_wait(self):
        import threading
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "package-lock"; path.touch()
            with path.open("rb") as handle:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
                timer = threading.Timer(0.1, lambda: fcntl.flock(handle.fileno(), fcntl.LOCK_UN))
                timer.start()
                try:
                    def sample(_deadline):
                        rows = probe.lock_snapshot([str(path)])
                        return dict(decision=probe.decision_for(rows, [], dict(state="idle")), transactionCoverageComplete=probe.transaction_coverage(rows, [], dict(state="idle")))
                    result = probe.wait_for_transactions(sample, 2, time.monotonic() + 4)
                finally:
                    timer.join()
            self.assertEqual(result[1], "cleared")
            self.assertEqual(result[2], 2)
            self.assertGreaterEqual(result[3], 900)

    def test_controlled_query_enforces_byte_limit_and_preserves_real_exit(self):
        code, output = probe.query([sys.executable, "-c", "import sys; print('query'); sys.exit(7)"], time.monotonic() + 3)
        self.assertEqual((code, output), (7, "query\n"))
        with self.assertRaises(probe.ProbeLimit) as caught:
            probe.query([sys.executable, "-c", "print('x'*50000)"], time.monotonic() + 3, limit=100)
        self.assertEqual(caught.exception.reason, "output_limit")

    def test_cancel_is_not_swallowed_as_capability_unknown(self):
        def cancel(*_):
            raise probe.ProbeLimit("cancelled")
        for action in [lambda: probe.packagekit_snapshot(100, cancel), lambda: probe.package_versions("redis", "rpm", 100, cancel)]:
            with self.assertRaises(probe.ProbeLimit) as caught:
                action()
            self.assertEqual(caught.exception.reason, "cancelled")

    def test_static_version_gap_does_not_trigger_wait_even_with_a_real_blocker(self):
        names = {"dpkg-query", "apt-cache"}
        unknown = dict(name="redis", installedStatus="absent", installedVersions=[], candidateStatus="unknown", candidateSelection="none", candidateVersions=[])
        with patch.object(probe.shutil, "which", side_effect=lambda name: "/usr/bin/" + name if name in names else None), \
             patch.object(probe, "source_snapshot", return_value=([], "complete", [])), \
             patch.object(probe, "package_versions", return_value=unknown), \
             patch.object(probe, "lock_snapshot", return_value=[]), \
             patch.object(probe, "packagekit_snapshot", return_value=dict(state="active", locked=True, transactions=[])), \
             patch.object(probe, "wait_for_transactions", wraps=probe.wait_for_transactions) as waiting:
            result = probe.run(dict(packages=["redis"], timeoutSeconds=10, waitSeconds=3))
        self.assertEqual(waiting.call_args[0][1], 0)
        self.assertEqual(result["items"][0]["waitOutcome"], "not_waited_incomplete")
        self.assertEqual(result["items"][0]["nextAction"], "resolve_evidence_gap")
        self.assertEqual(result["status"], "partial")

    def test_query_deadline_terminates_only_its_own_read_query(self):
        started = time.monotonic()
        with self.assertRaises(probe.ProbeLimit) as caught:
            probe.query([sys.executable, "-c", "import time; time.sleep(5)"], started + 0.05)
        self.assertEqual(caught.exception.reason, "timeout")
        self.assertLess(time.monotonic() - started, 1)

    def test_known_blocker_does_not_hide_unknown_transaction_coverage(self):
        names = {"dpkg-query", "apt-cache"}
        package = dict(name="redis", installedStatus="absent", installedVersions=[], candidateStatus="available", candidateSelection="apt_policy", candidateVersions=[dict(version="1", architecture="policy-selected", source="apt-cache:local-policy")])
        locks = [dict(path=path, state="unknown" if index == 0 else "clear", holders=[]) for index, path in enumerate(probe.LOCKS["debian"])]
        with patch.object(probe.shutil, "which", side_effect=lambda name: "/usr/bin/" + name if name in names else None), \
             patch.object(probe, "source_snapshot", return_value=([], "complete", [])), \
             patch.object(probe, "package_versions", return_value=package), \
             patch.object(probe, "lock_snapshot", return_value=locks), \
             patch.object(probe, "packagekit_snapshot", return_value=dict(state="active", locked=True, transactions=[])):
            result = probe.run(dict(packages=["redis"], timeoutSeconds=10, waitSeconds=0))
        self.assertEqual(result["items"][0]["decision"], "blocked")
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["items"][0]["nextAction"], "resolve_evidence_gap")

    def test_known_blocker_with_another_unknown_does_not_enter_wait(self):
        current = [0.0]
        snapshot = dict(decision="blocked", transactionCoverageComplete=False)
        result = probe.wait_for_transactions(lambda *_: snapshot, 3, 120, lambda: current[0], lambda duration: current.__setitem__(0, current[0] + duration))
        self.assertEqual(result[1:], ("not_waited_unknown", 1, 0))

    def test_wait_deadline_is_passed_to_resampling_not_only_the_global_deadline(self):
        current, calls, deadlines = [0.0], [0], []
        def sample(*limits):
            calls[0] += 1
            limit = limits[0] if limits else 120
            deadlines.append(limit)
            if calls[0] > 1:
                current[0] = min(current[0] + 8, limit)
                if current[0] >= limit:
                    raise probe.ProbeLimit("timeout")
            return dict(decision="blocked", transactionCoverageComplete=True, locks=[], pidFiles=[], packageKit=dict(state="active", locked=True, transactions=[]))
        result = probe.wait_for_transactions(sample, 3, 120, lambda: current[0], lambda duration: current.__setitem__(0, current[0] + duration))
        self.assertLessEqual(result[3], 3000)
        self.assertEqual(deadlines, [120, 3])
        self.assertEqual(result[1], "sample_timeout")
        self.assertFalse(result[0]["transactionCoverageComplete"])

    def test_resample_real_query_cannot_spend_global_budget_after_wait_deadline(self):
        calls = [0]
        def sample(deadline):
            calls[0] += 1
            if calls[0] > 1:
                probe.query([sys.executable, "-c", "import time; time.sleep(5)"], deadline)
            return dict(decision="blocked", transactionCoverageComplete=True, locks=[], pidFiles=[], packageKit=dict(state="active", locked=True, transactions=[]))
        started = time.monotonic()
        result = probe.wait_for_transactions(sample, 2, started + 120)
        self.assertEqual(result[1], "sample_timeout")
        self.assertEqual(result[2], 2)
        self.assertFalse(result[0]["transactionCoverageComplete"])
        self.assertEqual(result[0]["decision"], "unknown")
        self.assertGreaterEqual(result[3], 1900)
        self.assertLess(time.monotonic() - started, 3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
