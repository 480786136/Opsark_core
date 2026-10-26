"""B06: real local subprocesses and /proc; no business servers or systemctl writes."""
import ast
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

location = Path(__file__).resolve().parents[1] / "src/features/tools/operations_probe.py"
spec = importlib.util.spec_from_file_location("service_probe", location)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
BOOT = "11111111-2222-3333-4444-555555555555"


class ServiceProbeTests(unittest.TestCase):
    def properties(self, pid=None, **overrides):
        values = dict(Id="example.service", LoadState="loaded", ActiveState="active", SubState="running",
                      MainPID=str(os.getpid() if pid is None else pid), UnitFileState="enabled",
                      ExecStart="{ path=/usr/bin/example ; argv[]=/usr/bin/example --config /etc/example.conf ; }",
                      FragmentPath="/etc/systemd/system/example.service", ExecMainStartTimestampMonotonic="987654321")
        values.update(overrides)
        return "\n".join(key + "=" + value for key, value in values.items() if value is not None) + "\n"

    def fixture(self, outputs, timeout=3, service="example.service"):
        """Only the fixture records argv/count in its private temporary directory."""
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder) / "systemctl"
            calls = Path(folder) / "calls.jsonl"
            script.write_text("#!" + sys.executable + "\n"
                              "import json, pathlib, sys, time\n"
                              "path = pathlib.Path(" + repr(str(calls)) + ")\n"
                              "prior = path.read_text().splitlines() if path.exists() else []\n"
                              "with path.open('a') as stream: stream.write(json.dumps(sys.argv[1:]) + '\\n')\n"
                              "outputs = " + repr(outputs) + "\n"
                              "item = outputs[min(len(prior), len(outputs)-1)]\n"
                              "print(item.get('text', ''), end='', flush=True)\n"
                              "time.sleep(item.get('delay', 0))\n"
                              "sys.exit(item.get('code', 0))\n", encoding="utf-8")
            script.chmod(0o700)
            original_which = probe.shutil.which
            original_isdir = probe.os.path.isdir
            with patch.object(probe.shutil, "which", side_effect=lambda name: str(script) if name == "systemctl" else original_which(name)):
                with patch.object(probe.os.path, "isdir", side_effect=lambda path: True if path == "/run/systemd/system" else original_isdir(path)):
                    result = probe.run("services.inspect", dict(check="status", service=service, timeoutSeconds=timeout,
                                                                 logLines=50, sinceMinutes=30))
            return result, [json.loads(line) for line in calls.read_text().splitlines()]

    def test_old_key_value_format_and_real_process_identity(self):
        result, calls = self.fixture([dict(text=self.properties())])
        item = result["items"][0]
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["matchedEntries"], 1)
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(item["properties"]["UnitFileState"], "enabled")
        self.assertEqual(item["properties"]["FragmentPath"], "/etc/systemd/system/example.service")
        self.assertIn("/usr/bin/example", item["properties"]["ExecStart"])
        identity = item["processIdentity"]
        self.assertEqual(identity["status"], "stable")
        self.assertEqual(identity["service"], "example.service")
        self.assertEqual(identity["pid"], os.getpid())
        self.assertEqual((identity["bootId"], identity["startTimeTicks"]), probe.service_process_snapshot(os.getpid()))
        self.assertLessEqual(identity["sampleStartedAt"], identity["sampleFinishedAt"])
        self.assertEqual(identity["consistency"], "sampled_non_atomic")
        self.assertEqual(identity["verificationExitCode"], 0)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0], calls[1])
        self.assertNotIn("--value", calls[0])
        self.assertEqual(calls[0][-2:], ["--", "example.service"])
        self.assertEqual(calls[0][0], "show")

    def test_missing_extended_properties_remain_absent_not_enabled(self):
        result, _ = self.fixture([dict(text=self.properties(UnitFileState=None, ExecStart=None, FragmentPath=None))])
        self.assertEqual(result["status"], "complete")
        self.assertNotIn("UnitFileState", result["items"][0]["properties"])
        self.assertNotIn("FragmentPath", result["items"][0]["properties"])

    def test_missing_main_pid_is_unknown_without_additional_query(self):
        result, calls = self.fixture([dict(text=self.properties(MainPID=None))])
        self.assertEqual(result["status"], "complete")
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["items"][0]["processIdentity"]["reason"], "missing_main_pid")
        self.assertNotIn("bootId", result["items"][0]["processIdentity"])

    def test_invalid_pid_never_becomes_a_proc_path(self):
        with patch.object(probe, "service_process_snapshot") as snapshot:
            result, calls = self.fixture([dict(text=self.properties(MainPID="1/../../etc/passwd"))])
        snapshot.assert_not_called()
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["items"][0]["processIdentity"]["reason"], "invalid_main_pid")

    def test_duplicate_properties_reject_success(self):
        result, _ = self.fixture([dict(text=self.properties() + "MainPID=0\n")])
        self.assertEqual(result["status"], "error")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["items"][0]["processIdentity"]["status"], "unknown")

    def test_real_nonzero_exit_preserved(self):
        result, calls = self.fixture([dict(text=self.properties(), code=7)])
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["items"][0]["exitCode"], 7)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["items"][0]["processIdentity"]["status"], "unknown")

    def test_missing_requested_properties_has_one_partial_basic_fallback(self):
        basic = self.properties(UnitFileState=None, ExecStart=None, FragmentPath=None, ExecMainStartTimestampMonotonic=None)
        result, calls = self.fixture([dict(text=self.properties(), code=1), dict(text=basic)])
        self.assertEqual(len(calls), 3)
        self.assertEqual(calls[1], calls[2])
        self.assertEqual(calls[1][2], "--property=Id,LoadState,ActiveState,SubState,MainPID")
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["coverageComplete"])
        self.assertTrue(result["truncated"])
        item = result["items"][0]
        self.assertEqual(item["text"], basic)
        self.assertEqual(item["exitCode"], 0)
        self.assertEqual(item["compatibilityAttempt"]["originalExitCode"], 1)
        self.assertEqual(item["compatibilityAttempt"]["reason"], "missing_requested_properties")
        self.assertIn("Result", item["compatibilityAttempt"]["missingProperties"])
        self.assertNotIn("UnitFileState", item["properties"])
        self.assertEqual(item["processIdentity"]["status"], "stable")

    def test_permission_missing_unit_noise_or_invalid_pid_do_not_trigger_fallback(self):
        values = ["Access denied\n", "Failed to get properties: Unit example.service not found.\n",
                  self.properties() + "Warning: failed\n", self.properties(MainPID="bad"),
                  self.properties(LoadState="not-found"), self.properties() + "Id=example.service\n"]
        for output in values:
            result, calls = self.fixture([dict(text=output, code=1)])
            self.assertEqual(len(calls), 1)
            self.assertEqual(result["status"], "error")
            self.assertNotIn("compatibilityAttempt", result["items"][0])

    def test_fallback_failure_does_not_recurse_or_claim_basic_success(self):
        result, calls = self.fixture([dict(text=self.properties(), code=1), dict(text="permission denied\n", code=1)])
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["status"], "error")
        self.assertEqual(result["items"][0]["exitCode"], 1)
        self.assertEqual(result["items"][0]["compatibilityAttempt"]["originalExitCode"], 1)
        self.assertEqual(result["items"][0]["processIdentity"]["status"], "unknown")

    def test_fallback_cannot_reset_total_deadline(self):
        started = time.monotonic()
        result, calls = self.fixture([dict(text=self.properties(), code=1, delay=0.4), dict(text="", delay=10)], timeout=1)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(len(calls), 2)
        self.assertEqual(result["status"], "timeout")
        self.assertEqual(result["items"][0]["compatibilityAttempt"]["originalExitCode"], 1)
        self.assertEqual(result["items"][0]["processIdentity"]["status"], "unknown")

    def test_main_pid_changed_between_reads_is_not_stable(self):
        result, _ = self.fixture([dict(text=self.properties()), dict(text=self.properties(pid=0))])
        identity = result["items"][0]["processIdentity"]
        self.assertEqual(identity["status"], "changed")
        self.assertEqual(identity["reason"], "main_pid_changed")
        self.assertNotIn("startTimeTicks", identity)

    def test_missing_property_in_second_sample_is_unknown_not_confirmed_change(self):
        for changes in (dict(MainPID=None), dict(MainPID="bad"), dict(UnitFileState=None)):
            result, _ = self.fixture([dict(text=self.properties()), dict(text=self.properties(**changes))])
            self.assertEqual(result["items"][0]["processIdentity"]["status"], "unknown")
            self.assertNotIn("startTimeTicks", result["items"][0]["processIdentity"])

    def test_pid_reuse_with_different_start_ticks_is_changed(self):
        with patch.object(probe, "service_process_snapshot", side_effect=[(BOOT, "100"), (BOOT, "200")]):
            result, _ = self.fixture([dict(text=self.properties())])
        self.assertEqual(result["items"][0]["processIdentity"]["reason"], "process_changed")
        self.assertNotIn("bootId", result["items"][0]["processIdentity"])

    def test_boot_change_does_not_reuse_pid_identity(self):
        with patch.object(probe, "service_process_snapshot", side_effect=[(BOOT, "100"), ("22222222-2222-3333-4444-555555555555", "100")]):
            result, _ = self.fixture([dict(text=self.properties())])
        self.assertEqual(result["items"][0]["processIdentity"]["reason"], "boot_changed")

    def test_source_change_is_visible_even_with_same_pid(self):
        result, _ = self.fixture([dict(text=self.properties()), dict(text=self.properties(FragmentPath="/run/systemd/system/example.service"))])
        self.assertEqual(result["items"][0]["properties"]["FragmentPath"], "/etc/systemd/system/example.service")
        self.assertEqual(result["items"][0]["processIdentity"]["reason"], "properties_changed")

    def test_proc_access_denied_keeps_properties_but_identity_unknown(self):
        with patch.object(probe, "service_process_snapshot", side_effect=PermissionError()):
            result, calls = self.fixture([dict(text=self.properties())])
        self.assertEqual(result["status"], "complete")
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["items"][0]["processIdentity"]["reason"], "proc_unavailable")

    def test_zero_pid_only_proves_empty_main_process_slot(self):
        with patch.object(probe, "service_process_snapshot") as snapshot:
            result, calls = self.fixture([dict(text=self.properties(pid=0, ActiveState="inactive", SubState="dead", UnitFileState="disabled"))])
        snapshot.assert_not_called()
        self.assertEqual(len(calls), 2)
        identity = result["items"][0]["processIdentity"]
        self.assertEqual(identity["status"], "not_running")
        self.assertEqual(identity["reason"], "no_main_process")
        self.assertEqual(identity["pid"], 0)
        self.assertNotIn("bootId", identity)

    def test_second_show_failure_keeps_original_exit_and_blocks_complete(self):
        result, _ = self.fixture([dict(text=self.properties()), dict(text="query failed\n", code=8)])
        self.assertEqual(result["status"], "error")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["exitCode"], 0)
        self.assertEqual(result["items"][0]["processIdentity"]["verificationExitCode"], 8)
        self.assertEqual(result["items"][0]["processIdentity"]["reason"], "properties_unavailable")

    def test_one_deadline_bounds_both_queries_and_retains_unknown(self):
        started = time.monotonic()
        result, _ = self.fixture([dict(text=self.properties(), delay=0.25), dict(text="partial\n", delay=10)], timeout=1)
        self.assertLess(time.monotonic() - started, 3)
        self.assertEqual(result["status"], "timeout")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["items"][0]["processIdentity"]["status"], "unknown")
        self.assertNotIn("startTimeTicks", result["items"][0]["processIdentity"])

    def test_second_output_limit_cannot_publish_stable_identity(self):
        result, _ = self.fixture([dict(text=self.properties()), dict(text="x" * 40000)])
        self.assertEqual(result["status"], "partial")
        self.assertTrue(result["truncated"])
        self.assertEqual(len(result["items"]), 1)
        self.assertEqual(result["items"][0]["processIdentity"]["status"], "unknown")

    def test_process_stat_parenthesis_and_large_ticks_are_preserved(self):
        fields = ["S"] + ["0"] * 18 + ["9007199254740993123"] + ["0"] * 5
        with patch.object(probe, "bounded_proc_text", side_effect=[BOOT, "123 (a ) tricky) " + " ".join(fields)]):
            self.assertEqual(probe.service_process_snapshot(123), (BOOT, "9007199254740993123"))

    def test_proc_read_is_bounded_and_python36_syntax_remains_supported(self):
        ast.parse(location.read_text(encoding="utf-8"), feature_version=(3, 6))
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "bounded"
            path.write_text("x" * 100)
            with self.assertRaises(ValueError):
                probe.bounded_proc_text(str(path), 64)
            link = Path(folder) / "link"
            link.symlink_to(path)
            with self.assertRaises(OSError):
                probe.bounded_proc_text(str(link), 128)


if __name__ == "__main__":
    unittest.main(verbosity=2)
