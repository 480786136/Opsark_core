"""Bounded, read-only Linux package observations. Python 3.6+, no installs.

Only fixed local query commands are spawned; no yum/dnf/plugin initialization,
cache refresh, D-Bus activation, lock acquisition/removal or daemon termination.
"""
import configparser
import datetime
import errno
import glob
import json
import os
import re
import selectors
import shlex
import shutil
import signal
try:
    import sqlite3
except ImportError:
    sqlite3 = None
import stat
import subprocess
import sys
import time
import urllib.parse


LIMITATIONS = ["point_in_time", "standard_paths_only", "visible_pid_namespace", "cached_metadata_only", "not_install_authorization"]
LOCKS = {"debian": ["/var/lib/dpkg/lock", "/var/lib/dpkg/lock-frontend", "/var/lib/apt/lists/lock", "/var/cache/apt/archives/lock"],
         "rpm": ["/var/lib/rpm/.rpm.lock", "/usr/lib/sysimage/rpm/.rpm.lock"]}
PID_FILES = ["/run/yum.pid", "/run/dnf.pid"]
COMMANDS = ("apt-get", "apt-cache", "dpkg-query", "dnf", "yum", "rpm", "busctl")


class ProbeLimit(Exception):
    def __init__(self, reason):
        self.reason = reason


def read_limited(path, limit=32768):
    # O_NONBLOCK prevents a substituted FIFO/device from stalling the collector.
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(descriptor)
        if not stat.S_ISREG(before.st_mode):
            raise ProbeLimit("unsupported")
        data = bytearray()
        while len(data) <= limit:
            part = os.read(descriptor, min(4096, limit + 1 - len(data)))
            if not part:
                break
            data.extend(part)
        if len(data) > limit:
            raise ProbeLimit("output_limit")
        after = os.fstat(descriptor)
        current = os.stat(path, follow_symlinks=False)
        identity = lambda info: (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if identity(before) != identity(after) or identity(after) != identity(current):
            raise ProbeLimit("changed")
        return bytes(data).decode("utf-8", "strict")
    finally:
        os.close(descriptor)


def query(args, deadline, limit=32768):
    """Never shell-evaluate arguments or keep an unbounded communicate buffer."""
    executable = shutil.which(args[0])
    if not executable:
        raise ProbeLimit("unsupported")
    if time.monotonic() >= deadline:
        raise ProbeLimit("timeout")
    process = subprocess.Popen([executable] + args[1:], stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               start_new_session=True, env=dict(os.environ, LC_ALL="C", PAGER="cat", SYSTEMD_PAGER="cat"))
    selector = selectors.DefaultSelector()
    selector.register(process.stdout, selectors.EVENT_READ)
    output = bytearray()
    try:
        until = min(deadline, time.monotonic() + 4)
        while selector.get_map():
            if time.monotonic() >= until:
                raise ProbeLimit("timeout")
            for key, _ in selector.select(min(0.1, max(0, until - time.monotonic()))):
                part = os.read(key.fd, 4096)
                if not part:
                    selector.unregister(key.fileobj)
                else:
                    output.extend(part[:limit + 1 - len(output)])
                    if len(output) > limit:
                        raise ProbeLimit("output_limit")
        code = process.wait(timeout=max(0.001, until - time.monotonic()))
        return code, output.decode("utf-8", "strict")
    finally:
        selector.close()
        if process.poll() is None:
            # Only the exact child query session created above is terminated.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait()
        process.stdout.close()


def parse_kernel_locks(text):
    rows = []
    for line in text.splitlines():
        fields = line.split()
        if not fields:
            continue
        if len(fields) > 1 and fields[1] == "->":
            continue  # Waiting claim, not an acquired lock.
        if len(fields) != 8 or fields[1] not in ("POSIX", "FLOCK", "OFDLCK") or fields[3] not in ("READ", "WRITE"):
            raise ProbeLimit("unsupported")
        try:
            major, minor, inode = fields[5].split(":")
            rows.append(((int(major, 16), int(minor, 16), int(inode)),
                         dict(pid=int(fields[4]), mode=fields[3], kind=fields[1], start=fields[6], end=fields[7])))
        except (ValueError, IndexError):
            raise ProbeLimit("error")
    return rows


def lock_snapshot(paths, kernel_path="/proc/locks"):
    try:
        rows = parse_kernel_locks(read_limited(kernel_path, 1024 * 1024))
    except ProbeLimit as error:
        if error.reason == "cancelled":
            raise
        rows = None
    except (OSError, ValueError, UnicodeError):
        rows = None
    result = []
    for path in paths:
        item = dict(path=path, state="unknown", holders=[])
        try:
            before = os.stat(path, follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode):
                raise ProbeLimit("unsupported")
            key = (os.major(before.st_dev), os.minor(before.st_dev), before.st_ino)
            matches = [value for identity, value in (rows or []) if identity == key]
            after = os.stat(path, follow_symlinks=False)
            if (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino) or rows is None or len(matches) > 32:
                raise ProbeLimit("changed")
            item.update(state="held" if matches else "clear", holders=matches)
        except FileNotFoundError:
            item["state"] = "missing" if rows is not None else "unknown"
        except ProbeLimit as error:
            if error.reason == "cancelled":
                raise
        except OSError:
            pass
        result.append(item)
    return result


def pid_snapshot(paths, proc="/proc"):
    result = []
    for path in paths:
        item = dict(path=path, state="unknown")
        try:
            value = read_limited(path, 64).strip()
            if not re.match(r"^[1-9][0-9]{0,9}$", value) or int(value) > 2147483647:
                raise ProbeLimit("error")
            item["pid"] = int(value)
            try:
                process_stat = read_limited(os.path.join(proc, value, "stat"), 8192)
                close = process_stat.rfind(")")
                tail = process_stat[close + 2:].split()
                process = process_stat[process_stat.find("(") + 1:close]
                if close < 0 or len(tail) < 20 or not tail[19].isdigit():
                    raise ProbeLimit("error")
                item.update(process=process, startTicks=tail[19])
                # PID reuse by unrelated process is unknown, not an active transaction.
                item["state"] = "active" if process in ("yum", "dnf", "dnf5", "rpm", "packagekitd") and tail[0] != "Z" else "unknown"
            except FileNotFoundError:
                item["state"] = "stale"
        except FileNotFoundError:
            item["state"] = "missing"
        except ProbeLimit as error:
            if error.reason == "cancelled":
                raise
        except (OSError, UnicodeError):
            pass
        result.append(item)
    return result


def packagekit_snapshot(deadline, invoke=query):
    unknown = dict(state="unknown", locked=None, transactions=[])
    prefix = ["busctl", "--system", "--timeout=2", "--auto-start=no"]
    try:
        code, output = invoke(prefix + ["call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "NameHasOwner", "s", "org.freedesktop.PackageKit"], deadline)
        if code or output.strip() not in ("b true", "b false"):
            return unknown
        if output.strip() == "b false":
            return dict(state="absent", locked=False, transactions=[])
        code, output = invoke(prefix + ["call", "org.freedesktop.PackageKit", "/org/freedesktop/PackageKit", "org.freedesktop.PackageKit", "GetTransactionList"], deadline)
        values = shlex.split(output)
        if code or len(values) < 2 or values[0] not in ("ao", "as") or not values[1].isdigit() or int(values[1]) != len(values) - 2 or len(values) > 66:
            return unknown
        transactions = values[2:]
        if any(not re.match(r"^/[A-Za-z0-9_/]+$", value) for value in transactions):
            return unknown
        code, output = invoke(prefix + ["get-property", "org.freedesktop.PackageKit", "/org/freedesktop/PackageKit", "org.freedesktop.PackageKit", "Locked"], deadline)
        if code or output.strip() not in ("b true", "b false"):
            return unknown
        locked = output.strip() == "b true"
        return dict(state="active" if locked or transactions else "idle", locked=locked, transactions=transactions)
    except ProbeLimit as error:
        if error.reason == "cancelled":
            raise
        return unknown
    except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired):
        return unknown


def decision_for(locks, pid_files, packagekit):
    if any(item["state"] == "held" for item in locks) or any(item["state"] == "active" for item in pid_files) or packagekit["state"] == "active":
        return "blocked"
    if any(item["state"] == "unknown" for item in locks + pid_files) or packagekit["state"] == "unknown":
        return "unknown"
    return "clear"


def transaction_coverage(locks, pid_files, packagekit):
    # A positive blocker does not establish the state of other queried locks.
    return not any(item["state"] == "unknown" for item in locks + pid_files) and packagekit["state"] != "unknown"


def unknown_snapshot(previous):
    return dict(locks=[dict(path=item["path"], state="unknown", holders=[]) for item in previous.get("locks", [])],
                pidFiles=[dict(path=item["path"], state="unknown") for item in previous.get("pidFiles", [])],
                packageKit=dict(state="unknown", locked=None, transactions=[]),
                decision="unknown", transactionCoverageComplete=False,
                observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())


def wait_for_transactions(sample, seconds, deadline, clock=time.monotonic, sleep=time.sleep):
    current = sample(deadline)
    started = clock()  # Initial inspection is not waiting time.
    count = 1
    initial = current["decision"]
    outcome = "not_requested" if not seconds else "not_waited_unknown" if not current["transactionCoverageComplete"] else "not_needed" if initial == "clear" else "exhausted"
    until = min(deadline, started + seconds)
    waited = False
    while seconds and current["decision"] == "blocked" and current["transactionCoverageComplete"] and clock() < until and count < 31:
        sleep(min(1, until - clock()))
        waited = True
        if clock() >= until:
            break
        count += 1
        try:
            current = sample(until)
            if clock() >= until:
                raise ProbeLimit("timeout")
        except ProbeLimit as error:
            if error.reason != "timeout":
                raise
            # Previous held/idle evidence cannot be relabelled as a fresh sample.
            current = unknown_snapshot(current)
            outcome = "sample_timeout"
            break
        if not current["transactionCoverageComplete"]:
            outcome = "not_waited_unknown"
        elif current["decision"] == "clear":
            outcome = "cleared"
    return current, outcome, count, max(0, int((clock() - started) * 1000)) if waited else 0


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    # Never expose repository URL passwords, query tokens, fragments or paths.
    if parsed.scheme not in ("http", "https", "ftp", "file"):
        return "unresolved"
    if parsed.scheme == "file":
        return "file://local"
    return parsed.scheme + "://" + (parsed.hostname or "unresolved") + ((":" + str(parsed.port)) if parsed.port else "")


def source_paths(directory, suffixes, limit):
    paths, issues, scanned = [], [], 0
    try:
        # glob suppresses enumeration errors; an unreadable directory is not empty.
        with os.scandir(directory) as entries:
            for entry in entries:
                scanned += 1
                if scanned > 1024:
                    issues.append("entry_limit")
                    break
                if entry.name.endswith(suffixes):
                    if len(paths) >= limit:
                        issues.append("output_limit")
                        break
                    paths.append(entry.path)
    except FileNotFoundError:
        pass  # An absent standard source directory was successfully observed.
    except PermissionError:
        issues.append("permission_denied")
    except OSError:
        issues.append("error")
    return sorted(paths), issues


def source_snapshot(family, etc="/etc"):
    sources = []
    if family == "debian":
        paths, issues = source_paths(os.path.join(etc, "apt/sources.list.d"), (".list", ".sources"), 31)
        paths.insert(0, os.path.join(etc, "apt/sources.list"))
    else:
        paths, issues = source_paths(os.path.join(etc, "yum.repos.d"), (".repo",), 32)
    for path in paths:
        try:
            content = read_limited(path)
            if family == "rpm":
                parser = configparser.ConfigParser(interpolation=None, strict=True)
                parser.read_string(content)
                for section in parser.sections():
                    values = parser[section]
                    enabled = values.getboolean("enabled", fallback=True)
                    endpoints = " ".join(values.get(key, "") for key in ("baseurl", "mirrorlist", "metalink")).split()
                    sources.append(dict(id=section, file=path, enabled=enabled, origins=list(dict.fromkeys(origin(value) for value in endpoints))[:8],
                                        signatureCheck=values.getboolean("gpgcheck", fallback=None)))
            elif path.endswith(".sources"):
                for index, paragraph in enumerate(re.split(r"\n\s*\n", content)):
                    fields = {}
                    for line in paragraph.splitlines():
                        if not line or line.startswith("#"):
                            continue
                        if line[:1].isspace():
                            raise ProbeLimit("unsupported")
                        key, value = line.split(":", 1)
                        fields[key.lower()] = value.strip()
                    if not fields:
                        continue
                    if "uris" not in fields or "types" not in fields:
                        raise ProbeLimit("unsupported")
                    sources.append(dict(id="stanza-" + str(index), file=path, enabled=fields.get("enabled", "yes").lower() != "no",
                                        origins=list(dict.fromkeys(origin(value) for value in fields["uris"].split()))[:8], signatureCheck=False if fields.get("trusted", "").lower() == "yes" else None))
            else:
                for index, line in enumerate(content.splitlines()):
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    match = re.match(r"^(deb|deb-src)\s+(?:\[([^\]]*)\]\s+)?(\S+)\s+.+$", line)
                    if not match:
                        raise ProbeLimit("unsupported")
                    sources.append(dict(id="line-" + str(index + 1), file=path, enabled=True, origins=[origin(match.group(3))],
                                        signatureCheck=False if "trusted=yes" in (match.group(2) or "").lower() else None))
        except FileNotFoundError:
            if not (family == "debian" and path.endswith("/sources.list")):
                issues.append("changed")
        except ProbeLimit as error:
            if error.reason == "cancelled":
                raise
            issues.append(error.reason)
        except (OSError, ValueError, configparser.Error, UnicodeError):
            issues.append("error")
    if len(sources) > 64:
        issues.append("output_limit")
    if family == "rpm" and len({source["id"] for source in sources}) != len(sources):
        issues.append("error")  # Duplicate repository IDs have ambiguous effective policy.
    # Local declarations do not prove effective policy, mirrors, reachability or signatures.
    return sources[:64], "partial" if issues else "complete", issues


def package_versions(name, family, deadline, invoke=query):
    item = dict(name=name, installedStatus="unknown", installedVersions=[], candidateStatus="unknown", candidateSelection="none", candidateVersions=[])
    try:
        if family == "debian":
            code, output = invoke(["dpkg-query", "-W", "-f=${binary:Package}\t${db:Status-Status}\t${Version}\n", "--", name], deadline)
            for line in output.splitlines():
                values = line.split("\t")
                if len(values) == 3 and values[0].split(":")[0] == name.split(":")[0]:
                    if values[1] == "installed":
                        item["installedVersions"].append(values[2])
                    elif values[1] in ("not-installed", "config-files"):
                        item["installedStatus"] = "absent"
            if item["installedVersions"]:
                item["installedStatus"] = "installed"
            elif code == 1 and ("no packages found matching " + name) in output:
                item["installedStatus"] = "absent"
            code, output = invoke(["apt-cache", "-o", "Dir::Cache::pkgcache=", "-o", "Dir::Cache::srcpkgcache=", "policy", "--", name], deadline)
            match = re.search(r"^\s*Candidate:\s*(\S+)\s*$", output, re.M)
            if code == 0 and match:
                item.update(candidateStatus="not_found" if match.group(1) == "(none)" else "available", candidateSelection="apt_policy")
                if match.group(1) != "(none)":
                    item["candidateVersions"] = [dict(version=match.group(1), architecture="policy-selected", source="apt-cache:local-policy")]
        elif family == "rpm":
            code, output = invoke(["rpm", "-q", "--qf", "%{NAME}\t%{EPOCH}\t%{VERSION}\t%{RELEASE}\t%{ARCH}\n", "--", name], deadline)
            for line in output.splitlines():
                values = line.split("\t")
                if len(values) == 5 and values[0] == name:
                    item["installedVersions"].append(("0" if values[1] == "(none)" else values[1]) + ":" + values[2] + "-" + values[3] + "." + values[4])
            if code == 0 and item["installedVersions"]:
                item["installedStatus"] = "installed"
            elif code == 1 and output.strip() == "package " + name + " is not installed":
                item["installedStatus"] = "absent"
        if len(item["installedVersions"]) > 16:
            item.update(installedStatus="unknown", installedVersions=item["installedVersions"][:16])
    except ProbeLimit as error:
        if error.reason == "cancelled":
            raise
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        pass
    return item


def rpm_cached_versions(packages, sources, deadline, cache="/var/cache/yum"):
    """Yum primary SQLite only; no solver/plugin invocation, no version ranking."""
    # Older SQLite silently ignores immutable=1; mode=ro alone does not establish
    # a no-sidecar-write guarantee for WAL databases. Do not install/upgrade it.
    if sqlite3 is None or sqlite3.sqlite_version_info < (3, 22, 0):
        return
    databases = sorted(glob.glob(os.path.join(cache, "*/*/*/*primary*.sqlite")))
    if len(databases) > 24:
        return
    enabled = {entry["id"] for entry in sources if entry["enabled"] is True}
    found = {item["name"]: [] for item in packages}
    try:
        if not databases:
            return
        for path in databases:
            repository = os.path.basename(os.path.dirname(path))
            if repository not in enabled:
                continue
            before = os.stat(path, follow_symlinks=False)
            if not stat.S_ISREG(before.st_mode) or before.st_size > 64 * 1024 * 1024 or time.monotonic() >= deadline:
                return
            connection = sqlite3.connect("file:" + urllib.parse.quote(path, safe="/") + "?mode=ro&immutable=1", uri=True, timeout=0)
            try:
                connection.set_progress_handler(lambda: int(time.monotonic() >= deadline), 1000)
                for item in packages:
                    rows = connection.execute("SELECT epoch, version, release, arch FROM packages WHERE name=? LIMIT 33", (item["name"],)).fetchall()
                    if len(rows) > 32:
                        return
                    for epoch, version, release, architecture in rows:
                        if not all(isinstance(value, (str, int)) for value in (epoch, version, release, architecture)):
                            return
                        found[item["name"]].append(dict(version=str(epoch) + ":" + str(version) + "-" + str(release), architecture=str(architecture), source=repository))
            finally:
                connection.close()
            after = os.stat(path, follow_symlinks=False)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                return
        for item in packages:
            values = found[item["name"]]
            # No match in partial cached metadata does not establish nonavailability.
            if values and len(values) <= 32:
                item.update(candidateStatus="available", candidateSelection="unranked_cache", candidateVersions=values)
    except (OSError, sqlite3.Error, ValueError):
        return


def run(request):
    started = time.monotonic()
    deadline = started + request["timeoutSeconds"]
    result = dict(request=request, status="partial", items=[], scannedEntries=1, matchedEntries=0,
                  skippedCount=0, skipped=[], coverageComplete=False, truncated=True, elapsedMs=0, finishedAt="")
    managers = [dict(name=name, executable=shutil.which(name)) for name in COMMANDS if shutil.which(name)]
    names = {item["name"] for item in managers}
    debian, rpm = "dpkg-query" in names and "apt-cache" in names, "rpm" in names
    family = "ambiguous" if debian and rpm else "debian" if debian else "rpm" if rpm else "unsupported"
    item = dict(kind="package_environment", subject="server:package-management", family=family, managers=managers,
                packages=[], sources=[], sourcesStatus="unavailable", locks=[], pidFiles=[],
                packageKit=dict(state="unknown", locked=None, transactions=[]), decision="unknown", transactionCoverageComplete=False, nextAction="resolve_evidence_gap",
                waitOutcome="not_requested", sampleCount=1, waitedMs=0, observedAt="", limitations=LIMITATIONS[:])
    def sample(sample_deadline):
        if time.monotonic() >= sample_deadline:
            raise ProbeLimit("timeout")
        locks = lock_snapshot(LOCKS.get(family, []))
        if time.monotonic() >= sample_deadline:
            raise ProbeLimit("timeout")
        pid_files = pid_snapshot(PID_FILES) if family == "rpm" else []
        if time.monotonic() >= sample_deadline:
            raise ProbeLimit("timeout")
        packagekit = packagekit_snapshot(sample_deadline)
        if time.monotonic() >= sample_deadline:
            raise ProbeLimit("timeout")
        return dict(locks=locks, pidFiles=pid_files, packageKit=packagekit, decision=decision_for(locks, pid_files, packagekit),
                    transactionCoverageComplete=transaction_coverage(locks, pid_files, packagekit),
                    observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
    try:
        if family not in ("debian", "rpm"):
            raise ProbeLimit("unsupported")
        item["sources"], item["sourcesStatus"], _ = source_snapshot(family)
        item["packages"] = [package_versions(name, family, deadline) for name in request["packages"]]
        if family == "rpm":
            rpm_cached_versions(item["packages"], item["sources"], deadline)
        static_complete = item["sourcesStatus"] == "complete" and all(value["installedStatus"] != "unknown" and value["candidateStatus"] != "unknown" for value in item["packages"])
        snapshot, outcome, count, waited = wait_for_transactions(sample, request["waitSeconds"] if static_complete else 0, deadline)
        if request["waitSeconds"] and not static_complete:
            outcome = "not_waited_incomplete"
        item.update(snapshot, waitOutcome=outcome, sampleCount=count, waitedMs=waited)
        within_wait_budget = not request["waitSeconds"] or waited <= request["waitSeconds"] * 1000
        complete = static_complete and item["transactionCoverageComplete"] and within_wait_budget
        if time.monotonic() >= deadline:
            raise ProbeLimit("timeout")
        if complete:
            result.update(status="complete", coverageComplete=True, truncated=False)
        else:
            result["skipped"].append(dict(path="package-management:incomplete-observation", reason="unsupported"))
        item["nextAction"] = "wait_or_report" if item["decision"] == "blocked" and static_complete and item["transactionCoverageComplete"] else "continue_installation_planning" if complete else "resolve_evidence_gap"
    except (ProbeLimit, OSError, ValueError, UnicodeError) as error:
        reason = error.reason if isinstance(error, ProbeLimit) else "permission_denied" if isinstance(error, PermissionError) else "error"
        result["status"] = reason if reason in ("timeout", "cancelled", "unsupported", "permission_denied", "error") else "partial"
        result["skipped"].append(dict(path="package-management", reason=reason))
    finally:
        finished = datetime.datetime.now(datetime.timezone.utc).isoformat()
        if not item["observedAt"]:
            item["observedAt"] = finished
        result.update(items=[item], matchedEntries=1, skippedCount=len(result["skipped"]),
                      elapsedMs=max(0, int((time.monotonic() - started) * 1000)), finishedAt=finished)
    if len(json.dumps(result, ensure_ascii=True).encode("utf-8")) > 120000:
        result.update(status="partial", items=[], matchedEntries=0, coverageComplete=False, truncated=True,
                      skippedCount=1, skipped=[dict(path="package-management", reason="output_limit")])
    return result


if __name__ == "__main__":
    def stopped(_signal, _frame):
        raise ProbeLimit("cancelled")
    signal.signal(signal.SIGTERM, stopped)
    signal.signal(signal.SIGINT, stopped)
    payload = json.loads(sys.argv[1])
    print("OPSARK_RESULT " + json.dumps(run(payload["request"]), ensure_ascii=True, separators=(",", ":")), flush=True)
