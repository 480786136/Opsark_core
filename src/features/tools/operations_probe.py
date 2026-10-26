"""Bundled read-only probe, sent over the existing managed SSH executor.

Python 3.6+ / POSIX. No shell evaluation, installation, elevation or remote files.
The controller validates input first; the script is not a public command API.
"""
import datetime
import codecs
import errno
import hashlib
import heapq
import http.client
import json
import os
import re
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request


class StopProbe(Exception):
    pass


class UnsafePath(Exception):
    """An ancestor cannot be traversed without following a link."""
    pass


def exact_parent(path):
    """Open every directory component without symlinks; caller owns returned fd."""
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    descriptor = os.open("/", flags)
    chain = []
    try:
        info = os.fstat(descriptor)
        chain.append((info.st_dev, info.st_ino))
        components = [part for part in path.split("/") if part]
        for component in components[:-1]:
            if component in (".", ".."):
                raise UnsafePath()
            info = os.stat(component, dir_fd=descriptor, follow_symlinks=False)
            if stat.S_ISLNK(info.st_mode):
                raise UnsafePath()
            try:
                nested = os.open(component, flags, dir_fd=descriptor)
            except OSError as error:
                if error.errno in (errno.ELOOP, errno.ENOTDIR):
                    raise UnsafePath()
                raise
            os.close(descriptor)
            descriptor = nested
            opened = os.fstat(descriptor)
            if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                raise UnsafePath()
            chain.append((opened.st_dev, opened.st_ino))
        return descriptor, components[-1] if components else ".", chain
    except BaseException:
        os.close(descriptor)
        raise


def file_identity(info):
    # Decimal strings preserve device/inode and nanoseconds beyond JS safe ints.
    return dict(device=str(info.st_dev), inode=str(info.st_ino), mode="%04o" % stat.S_IMODE(info.st_mode),
                uid=info.st_uid, gid=info.st_gid, sizeBytes=info.st_size,
                modifiedAtNs=str(info.st_mtime_ns), changedAtNs=str(info.st_ctime_ns))


def same_file(left, right):
    return stat.S_IFMT(left.st_mode) == stat.S_IFMT(right.st_mode) and file_identity(left) == file_identity(right)


SERVICE_PROPERTIES = ("Id", "LoadState", "ActiveState", "SubState", "MainPID", "Result", "ExecMainStatus",
                      "ActiveEnterTimestamp", "UnitFileState", "ExecStart", "FragmentPath", "ExecMainStartTimestampMonotonic")


def service_properties(text):
    values = {}
    for line in text.splitlines():
        key, separator, value = line.partition("=")
        if separator and key in SERVICE_PROPERTIES:
            if key in values:
                return None
            values[key] = value
    return values if all(values.get(key) for key in ("Id", "LoadState", "ActiveState", "SubState")) else None


def missing_service_properties(item, service):
    """A narrow observation pattern, not a claim about why systemctl failed.

    Never retry permission/no-unit/noisy errors, malformed PID or arbitrary
    exit 1. The fallback can only collect basic facts and remains partial.
    """
    if item["exitCode"] != 1:
        return None
    lines = [line for line in item["text"].splitlines() if line]
    if not lines or any("=" not in line or line.split("=", 1)[0] not in SERVICE_PROPERTIES for line in lines):
        return None
    values = service_properties(item["text"])
    if not values or values.get("LoadState") != "loaded" or values["Id"] not in (service, service + ".service"):
        return None
    pid = values.get("MainPID", "")
    if not re.fullmatch(r"0|[1-9][0-9]*", pid) or int(pid) > 9007199254740991:
        return None
    missing = [key for key in SERVICE_PROPERTIES if key not in values]
    return missing if missing else None


def bounded_proc_text(path, limit):
    """Fixed kernel paths only; no caller path, symlink or unbounded content."""
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        output = bytearray()
        while len(output) <= limit:
            chunk = os.read(descriptor, limit + 1 - len(output))
            if not chunk:
                break
            output.extend(chunk)
        if len(output) > limit:
            raise ValueError("proc observation exceeds bound")
        return bytes(output).decode("ascii", "strict").strip()
    finally:
        os.close(descriptor)


def service_process_snapshot(pid):
    boot = bounded_proc_text("/proc/sys/kernel/random/boot_id", 64)
    if not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", boot):
        raise ValueError("invalid boot identity")
    text = bounded_proc_text("/proc/%s/stat" % pid, 4096)
    if not text.startswith(str(pid) + " (") or ") " not in text:
        raise ValueError("invalid process identity")
    # comm can contain spaces and ')'; field 22 follows the final ') '.
    fields = text.rsplit(") ", 1)[1].split()
    if len(fields) <= 19 or not re.fullmatch(r"[1-9][0-9]*", fields[19]):
        raise ValueError("invalid process start time")
    return boot, fields[19]


def capability_report(result):
    """Only local runtime/executable observations, never inferred business health."""
    facts = [dict(name="python.runtime", supported=sys.version_info >= (3, 6),
                  version=".".join(map(str, sys.version_info[:3])), executable=sys.executable),
             dict(name="python.json", supported=True),
             dict(name="posix.fd_scan", supported=hasattr(os, "O_NOFOLLOW")
                  and getattr(os, "scandir", None) in getattr(os, "supports_fd", set())
                  and os.open in getattr(os, "supports_dir_fd", set()))]
    for name in ("systemctl", "journalctl", "ss", "netstat", "curl", "jq"):
        executable = shutil.which(name)
        facts.append(dict(name=name, supported=bool(executable), **({"executable": executable} if executable else {})))
    # No '--value' probe is needed: the collector uses old and new systemd's
    # property=value format. Its success proves only that exact operation.
    if result["request"].get("check") == "status":
        verified = result["status"] == "complete" and bool(result["items"])
        facts.append(dict(name="systemctl.show.properties", supported=True if verified else None))
    return dict(version=1, observedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), facts=facts)


def run(tool, request):
    started = time.monotonic()
    deadline = started + request["timeoutSeconds"]
    result = dict(request=request, status="complete", items=[], scannedEntries=0,
                  matchedEntries=0, skippedCount=0, skipped=[], coverageComplete=True,
                  truncated=False, elapsedMs=0, finishedAt="")
    stop_reason = ["timeout"]
    last_progress = [0.0]
    largest = []
    totals = {}
    total_allocated = [0]
    child = [None]

    def skip(path, reason):
        result["skippedCount"] += 1
        if len(result["skipped"]) < 100:
            result["skipped"].append(dict(path=path, reason=reason))
        if reason not in ("excluded", "filesystem", "symlink"):
            result["coverageComplete"] = False

    def tick(path=""):
        now = time.monotonic()
        if now >= deadline:
            stop_reason[0] = "timeout"
            raise StopProbe()
        if now - last_progress[0] >= 1:
            print("OPSARK_PROGRESS " + str(result["scannedEntries"]), file=sys.stderr, flush=True)
            last_progress[0] = now
        if result["scannedEntries"] >= request.get("maxEntries", 100000):
            skip(path, "entry_limit")
            raise StopProbe("entry_limit")
        result["scannedEntries"] += 1

    def stop(signum, _frame):
        stop_reason[0] = "timeout" if signum == signal.SIGALRM else "cancelled"
        raise StopProbe()

    def top(item):
        result["matchedEntries"] += 1
        key = (item["sizeBytes"], item["subject"], result["matchedEntries"], item)
        if len(largest) < request["maxResults"]:
            heapq.heappush(largest, key)
        elif key[:3] > largest[0][:3]:
            heapq.heapreplace(largest, key)

    def command(args, kind, subject, publish=True):
        executable = shutil.which(args[0])
        if not executable:
            skip(args[0], "unsupported")
            result["status"] = "unsupported"
            return
        # No shell and no caller-provided executable/flags. Drain a bounded pipe;
        # communicate() would accumulate arbitrary log output in memory.
        process = subprocess.Popen([executable] + args[1:], stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True,
                                   env=dict(os.environ, LC_ALL="C", SYSTEMD_PAGER="cat",
                                            SYSTEMD_COLORS="0", PAGER="cat"))
        child[0] = process
        output = bytearray()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        try:
            while selector.get_map():
                if time.monotonic() >= deadline:
                    raise StopProbe()
                for key, _ in selector.select(min(0.25, max(0, deadline - time.monotonic()))):
                    chunk = os.read(key.fd, 4096)
                    if not chunk:
                        selector.unregister(key.fileobj)
                    else:
                        output.extend(chunk[:32768 - len(output)])
                        if len(output) >= 32768:
                            result["truncated"] = True
                            skip(subject, "output_limit")
                            return
            code = process.wait(timeout=max(0.001, deadline - time.monotonic()))
            item = dict(kind=kind, subject=subject, text=output.decode("utf-8", "replace"), exitCode=code)
            if publish:
                result["items"].append(item)
                result["matchedEntries"] += 1
            if code != 0:
                # Keep the real exit code; never infer permission/success from a pipeline.
                skip(subject, "error")
                result["status"] = "error"
            elif kind == "service":
                if service_properties(item["text"]) is None:
                    skip(subject, "error")
                    result["status"] = "error"
            return item
        finally:
            selector.close()
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                process.wait()
            process.stdout.close()
            child[0] = None
            if publish and output and not any(item.get("subject") == subject for item in result["items"]):
                result["items"].append(dict(kind=kind, subject=subject,
                                            text=output.decode("utf-8", "replace"), exitCode=process.returncode))
                result["matchedEntries"] += 1

    def service_status(service):
        sample_started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        args = ["systemctl", "show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus,ActiveEnterTimestamp,UnitFileState,ExecStart,FragmentPath,ExecMainStartTimestampMonotonic", "--", service]
        item = command(args, "service", service)
        if item is None:
            return
        identity = dict(status="unknown", service=service, sampleStartedAt=sample_started,
                        sampleFinishedAt=sample_started, consistency="sampled_non_atomic", reason="collection_incomplete")
        item["processIdentity"] = identity
        try:
            missing = missing_service_properties(item, service)
            if missing:
                item["compatibilityAttempt"] = dict(originalExitCode=1, reason="missing_requested_properties", missingProperties=missing)
                # One fixed basic observation; its identity verification below
                # reuses the same reduced argv and the original total deadline.
                # Never issue unfiltered show --all or expose Environment.
                args = ["systemctl", "show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState,MainPID", "--", service]
                basic = command(args, "service", service, publish=False)
                if basic is None:
                    identity["reason"] = "properties_unavailable"
                    return
                item.update(text=basic["text"], exitCode=basic["exitCode"])
                if basic["exitCode"] == 0 and service_properties(basic["text"]) is not None:
                    # The initial requested property coverage remains missing.
                    result["status"] = "partial"
            first = service_properties(item["text"])
            if item["exitCode"] != 0 or first is None:
                identity["reason"] = "properties_unavailable"
                return
            item["properties"] = first
            if "MainPID" not in first:
                identity["reason"] = "missing_main_pid"
                return
            raw_pid = first["MainPID"]
            if not re.fullmatch(r"0|[1-9][0-9]*", raw_pid) or int(raw_pid) > 9007199254740991:
                identity["reason"] = "invalid_main_pid"
                return
            pid = int(raw_pid)
            identity["pid"] = pid
            try:
                before = service_process_snapshot(pid) if pid else None
            except (OSError, ValueError, UnicodeError):
                identity["reason"] = "proc_unavailable"
                return
            second_item = command(args, "service", service, publish=False)
            if second_item is not None:
                identity["verificationExitCode"] = second_item["exitCode"]
            second = service_properties(second_item["text"]) if second_item and second_item["exitCode"] == 0 else None
            if second is None:
                identity["reason"] = "properties_unavailable"
                return
            if "MainPID" not in second:
                identity["reason"] = "missing_main_pid"
                return
            if not re.fullmatch(r"0|[1-9][0-9]*", second["MainPID"]) or int(second["MainPID"]) > 9007199254740991:
                identity["reason"] = "invalid_main_pid"
                return
            if second.get("MainPID") != raw_pid:
                identity.update(status="changed", reason="main_pid_changed")
                return
            if set(second) != set(first):
                identity["reason"] = "properties_unavailable"
                return
            if second != first:
                identity.update(status="changed", reason="properties_changed")
                return
            if pid == 0:
                identity.update(status="not_running", reason="no_main_process")
                return
            try:
                after = service_process_snapshot(pid)
            except (OSError, ValueError, UnicodeError):
                identity["reason"] = "proc_unavailable"
                return
            if before != after:
                identity.update(status="changed", reason="boot_changed" if before[0] != after[0] else "process_changed")
                return
            identity.update(status="stable", bootId=after[0], startTimeTicks=after[1])
            del identity["reason"]
        finally:
            identity["sampleFinishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()

    def exact_file():
        path = request["path"]
        tick(path)
        parent = None
        descriptor = None
        item = None
        sample_started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        try:
            try:
                parent, name, chain = exact_parent(path)
                before = os.stat(name, dir_fd=parent, follow_symlinks=False)
            except FileNotFoundError:
                item = dict(kind="file_metadata", subject=path, exists=False, fileType="missing",
                            stability="stable", hashStatus="not_applicable", hashedBytes=0, verifiedReadPasses=0,
                            sampleStartedAt=sample_started, consistency="single_observation",
                            limitations=["non_atomic_sample", "absence_at_sample"])
                result["items"].append(item)
                result["matchedEntries"] = 1
                return
            kind = "regular" if stat.S_ISREG(before.st_mode) else "directory" if stat.S_ISDIR(before.st_mode) else "symlink" if stat.S_ISLNK(before.st_mode) else "other"
            item = dict(kind="file_metadata", subject=path, exists=True, fileType=kind, metadata=file_identity(before),
                        stability="unknown", hashStatus="not_requested" if not request["hash"] else "unavailable" if kind == "regular" else "not_applicable", hashedBytes=0, verifiedReadPasses=0,
                        sampleStartedAt=sample_started, consistency="unverified", limitations=["non_atomic_sample"])
            if kind == "directory":
                item["limitations"].append("self_metadata_only")
            if kind == "symlink":
                item["limitations"].append("target_not_followed")
                target = os.readlink(name, dir_fd=parent)
                # A non-UTF8 link must not be silently replaced with a different name.
                target.encode("utf-8", "strict")
                item["linkTarget"] = target
            result["items"].append(item)
            result["matchedEntries"] = 1
            digest = None
            if request["hash"] and kind == "regular":
                limit = request["maxHashBytes"]
                if before.st_size > limit:
                    item["hashStatus"] = "limit_exceeded"
                    skip(path, "output_limit")
                else:
                    # O_NONBLOCK prevents a raced FIFO replacement from hanging;
                    # O_NOFOLLOW prevents a raced link from reading its target.
                    descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
                    opened = os.fstat(descriptor)
                    if not same_file(before, opened):
                        item.update(stability="changed", hashStatus="changed")
                        skip(path, "changed")
                        return
                    hasher = hashlib.sha256()
                    while True:
                        if time.monotonic() >= deadline:
                            raise StopProbe()
                        remaining = limit - item["hashedBytes"]
                        # One bounded sentinel byte verifies EOF even for procfs
                        # regular files whose st_size does not describe content.
                        chunk = os.read(descriptor, min(65536, remaining + 1))
                        if not chunk:
                            digest = hasher.hexdigest()
                            item["verifiedReadPasses"] = 1
                            break
                        accepted = chunk[:remaining]
                        hasher.update(accepted)
                        item["hashedBytes"] += len(accepted)
                        if len(chunk) > remaining:
                            item["hashStatus"] = "limit_exceeded"
                            skip(path, "output_limit")
                            break
                    if digest is not None:
                        # Coarse filesystem timestamps can miss a same-size
                        # rewrite. Compare a second bounded read of this fd.
                        # This is still an observation, not a transaction/lease.
                        os.lseek(descriptor, 0, os.SEEK_SET)
                        verification = hashlib.sha256()
                        verified_bytes = 0
                        while True:
                            if time.monotonic() >= deadline:
                                raise StopProbe()
                            remaining = limit - verified_bytes
                            chunk = os.read(descriptor, min(65536, remaining + 1))
                            if not chunk:
                                break
                            verification.update(chunk[:remaining])
                            verified_bytes += min(len(chunk), remaining)
                            if len(chunk) > remaining:
                                break
                        if chunk or verified_bytes != item["hashedBytes"] or verification.hexdigest() != digest:
                            item.update(stability="changed", hashStatus="changed")
                            skip(path, "changed")
                            return
                        item["verifiedReadPasses"] = 2
            # Reopen the original lexical path: a held fd alone would otherwise
            # report a renamed/replaced ancestor as the current requested object.
            check_parent = None
            try:
                check_parent, check_name, check_chain = exact_parent(path)
                after = os.stat(check_name, dir_fd=check_parent, follow_symlinks=False)
                stable = chain == check_chain and same_file(before, after)
                if descriptor is not None:
                    stable = stable and same_file(before, os.fstat(descriptor))
                if kind == "symlink":
                    stable = stable and item["linkTarget"] == os.readlink(check_name, dir_fd=check_parent)
            except (OSError, UnsafePath):
                stable = False
            finally:
                if check_parent is not None:
                    os.close(check_parent)
            if digest is not None and item["hashedBytes"] != before.st_size:
                stable = False
            item["stability"] = "stable" if stable else "changed"
            item["consistency"] = "metadata_checked" if stable else "unverified"
            if not stable:
                if request["hash"] and kind == "regular":
                    item["hashStatus"] = "changed"
                skip(path, "changed")
            elif digest is not None:
                item.update(hashStatus="complete", sha256=digest)
        except UnsafePath:
            result["status"] = "unsupported"
            skip(path, "unsupported")
        except UnicodeError:
            result["status"] = "unsupported"
            skip(path, "unsupported")
        finally:
            if item is not None:
                item["sampleFinishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
            if descriptor is not None:
                os.close(descriptor)
            if parent is not None:
                os.close(parent)

    def scan():
        root = request["path"]
        root_stat = os.lstat(root)
        if not stat.S_ISDIR(root_stat.st_mode):
            skip(root, "symlink" if stat.S_ISLNK(root_stat.st_mode) else "error")
            result["coverageComplete"] = False
            result["status"] = "error"
            return
        excluded = set(request["excludePaths"])
        def excluded_path(path):
            return any(path == prefix or path.startswith(prefix.rstrip("/") + "/") for prefix in excluded)
        if excluded_path(root):
            skip(root, "excluded")
            result["coverageComplete"] = False
            return
        # Iterators bound memory by depth, not by directory width. Do not follow
        # symlinks; stat/scandir errors remain explicit coverage gaps.
        stack = []
        seen = set()
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
        try:
            root_fd = os.open(root, flags)
            try:
                root_stat = os.fstat(root_fd)
                stack.append((os.scandir(root_fd), root_fd, root, 0, None))
            except BaseException:
                os.close(root_fd)
                raise
            while stack:
                iterator, directory_fd, parent_path, depth, group = stack[-1]
                try:
                    entry = next(iterator)
                except StopIteration:
                    iterator.close()
                    os.close(directory_fd)
                    stack.pop()
                    continue
                entry_path = os.path.join(parent_path, entry.name)
                tick(entry_path)
                if excluded_path(entry_path):
                    skip(entry_path, "excluded")
                    continue
                try:
                    info = entry.stat(follow_symlinks=False)
                    if stat.S_ISLNK(info.st_mode):
                        skip(entry_path, "symlink")
                        continue
                    if request["sameFilesystem"] and info.st_dev != root_stat.st_dev:
                        skip(entry_path, "filesystem")
                        continue
                    bucket = group or entry_path
                    identity = (info.st_dev, info.st_ino)
                    if identity not in seen:
                        seen.add(identity)
                        allocated = max(0, info.st_blocks * 512)
                        # Presentation depth never limits traversal. Each prefix is
                        # an inclusive aggregate; parent/child rows must not be summed.
                        relative = os.path.relpath(entry_path, root).split(os.sep)
                        for level in range(1, min(len(relative), request.get("reportDepth", 1)) + 1):
                            visible = os.path.join(root, *relative[:level])
                            totals[visible] = totals.get(visible, 0) + allocated
                        total_allocated[0] += allocated
                    if stat.S_ISREG(info.st_mode) and tool == "files.find_large" and info.st_size >= request["minBytes"]:
                        top(dict(kind="file", subject=entry_path, sizeBytes=info.st_size,
                                 allocatedBytes=max(0, info.st_blocks * 512), modifiedAt=info.st_mtime))
                    elif stat.S_ISDIR(info.st_mode):
                        if depth + 1 >= request["maxDepth"]:
                            skip(entry_path, "depth")
                        else:
                            nested_fd = os.open(entry.name, flags, dir_fd=directory_fd)
                            try:
                                opened = os.fstat(nested_fd)
                                if (opened.st_dev, opened.st_ino) != (info.st_dev, info.st_ino):
                                    skip(entry_path, "error")
                                    os.close(nested_fd)
                                else:
                                    stack.append((os.scandir(nested_fd), nested_fd, entry_path, depth + 1, bucket))
                            except BaseException:
                                os.close(nested_fd)
                                raise
                except PermissionError:
                    skip(entry_path, "permission_denied")
                except OSError:
                    skip(entry_path, "error")
        finally:
            for iterator, directory_fd, _, _, _ in stack:
                iterator.close()
                os.close(directory_fd)
            if tool == "disk.inspect":
                # A bounded partial traversal yields lower bounds, never du-equivalent totals.
                result["items"] = [dict(kind="directory", subject=root,
                                        allocatedBytes=total_allocated[0] + max(0, root_stat.st_blocks * 512))]
                ordered = heapq.nsmallest(max(0, request["maxResults"] - 1), totals.items(), key=lambda entry: (-entry[1], entry[0]))
                result["matchedEntries"] = len(totals) + 1
                result["items"].extend(dict(kind="directory", subject=path, allocatedBytes=size)
                                       for path, size in ordered[:max(0, request["maxResults"] - 1)])

    def deleted():
        if not os.path.isdir("/proc/self/fd"):
            result["status"] = "unsupported"
            skip("/proc", "unsupported")
            return
        seen = set()
        with os.scandir("/proc") as processes:
            for process in processes:
                if not process.name.isdigit():
                    continue
                tick(process.path)
                try:
                    with os.scandir(process.path + "/fd") as descriptors:
                        for fd in descriptors:
                            tick(fd.path)
                            try:
                                name = os.readlink(fd.path)
                                if not name.endswith(" (deleted)"):
                                    continue
                                info = os.stat(fd.path)
                                identity = (info.st_dev, info.st_ino)
                                if not stat.S_ISREG(info.st_mode) or identity in seen:
                                    continue
                                seen.add(identity)
                                top(dict(kind="deleted_file", subject=fd.path + " -> " + name,
                                         sizeBytes=info.st_size, allocatedBytes=max(0, info.st_blocks * 512)))
                            except FileNotFoundError:
                                continue  # A process closed its descriptor during the sample.
                            except PermissionError:
                                skip(fd.path, "permission_denied")
                            except OSError:
                                skip(fd.path, "error")
                except FileNotFoundError:
                    continue
                except PermissionError:
                    skip(process.path + "/fd", "permission_denied")
                except OSError:
                    skip(process.path + "/fd", "error")

    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None

    missing = []
    if sys.version_info < (3, 6):
        missing.append(dict(path="python>=3.6 (actual %s)" % ".".join(map(str, sys.version_info[:3])), reason="unsupported"))
    for feature in ("SIGALRM", "setitimer", "ITIMER_REAL"):
        if not hasattr(signal, feature):
            missing.append(dict(path="POSIX signal." + feature, reason="unsupported"))
    if tool == "files.find_large" or (tool == "disk.inspect" and request["check"] == "directory"):
        for feature in ("O_NOFOLLOW", "O_DIRECTORY", "scandir"):
            if not hasattr(os, feature):
                missing.append(dict(path="POSIX os." + feature, reason="unsupported"))
        if getattr(os, "scandir", None) not in getattr(os, "supports_fd", set()) or os.open not in getattr(os, "supports_dir_fd", set()):
            missing.append(dict(path="POSIX fd-relative directory traversal", reason="unsupported"))
    if tool == "files.inspect":
        for feature in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"):
            if not hasattr(os, feature):
                missing.append(dict(path="POSIX os." + feature, reason="unsupported"))
        if not all(method in getattr(os, "supports_dir_fd", set()) for method in (os.open, os.stat, os.readlink)) or os.stat not in getattr(os, "supports_follow_symlinks", set()):
            missing.append(dict(path="POSIX no-follow fd-relative metadata", reason="unsupported"))
    if tool == "disk.inspect" and request["check"] == "capacity" and not hasattr(os, "statvfs"):
        missing.append(dict(path="POSIX os.statvfs", reason="unsupported"))
    if missing:
        result.update(status="unsupported", coverageComplete=False, truncated=True,
                      skippedCount=len(missing), skipped=missing,
                      finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        return result
    previous = {}
    for signum in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT):
        previous[signum] = signal.signal(signum, stop)
    signal.setitimer(signal.ITIMER_REAL, request["timeoutSeconds"])
    try:
        if tool == "files.inspect":
            exact_file()
        elif tool == "files.find_large" or (tool == "disk.inspect" and request["check"] == "directory"):
            scan()
        elif tool == "disk.inspect" and request["check"] == "capacity":
            info = os.statvfs(request["path"])
            result["items"].append(dict(kind="filesystem", subject=request["path"],
                totalBytes=info.f_blocks * info.f_frsize, freeBytes=info.f_bfree * info.f_frsize,
                availableBytes=info.f_bavail * info.f_frsize, usedBytes=(info.f_blocks-info.f_bfree) * info.f_frsize,
                inodeTotal=info.f_files if 0 <= info.f_files <= 9007199254740991 else None,
                inodeFree=info.f_ffree if 0 <= info.f_ffree <= 9007199254740991 else None))
            result["matchedEntries"] = 1
        elif tool == "disk.inspect" and request["check"] == "deleted":
            deleted()
        elif tool == "disk.inspect" and request["check"] == "docker":
            command(["docker", "--host=unix:///var/run/docker.sock", "system", "df", "--format", "{{json .}}"], "docker", "docker:local-default-socket")
        elif tool == "services.inspect":
            check = request["check"]
            service = request.get("service", "")
            if check in ("status", "logs") and not os.path.isdir("/run/systemd/system"):
                result["status"] = "unsupported"
                skip("systemd", "unsupported")
            elif check == "status":
                service_status(service)
            elif check == "logs":
                command(["journalctl", "--no-pager", "--quiet", "--unit=" + service, "--lines=" + str(request["logLines"]), "--since=" + str(request["sinceMinutes"]) + " minutes ago", "--output=short-iso"], "logs", service)
            elif check == "ports":
                args = ["ss", "-lntup"] if shutil.which("ss") else ["netstat", "-lntup"]
                command(args, "ports", "server:listening")
            elif check == "health":
                url = request["url"]
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                try:
                    response = opener.open(urllib.request.Request(url, method="GET", headers={"User-Agent": "Opsark-readonly-probe/1"}), timeout=max(0.001, deadline - time.monotonic()))
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    item = dict(kind="health", subject=url, httpStatus=response.code)
                    result["items"].append(item)
                    result["matchedEntries"] = 1
                    limit = request.get("maxResponseBytes", 0)
                    if limit:
                        body = bytearray()
                        finished = False
                        try:
                            while len(body) <= limit:
                                chunk = getattr(response, "read1", response.read)(min(4096, limit + 1 - len(body)))
                                if not chunk:
                                    remaining = getattr(response, "length", getattr(getattr(response, "fp", None), "length", None))
                                    if remaining not in (None, 0):
                                        raise http.client.IncompleteRead(bytes(body))
                                    finished = True
                                    break
                                body.extend(chunk)
                        finally:
                            # Keep headers and already-read bytes even if the
                            # body stalls or is cancelled. Never turn binary or
                            # invalid UTF-8 into apparent complete text evidence.
                            complete = finished and len(body) <= limit
                            item.update(body="", returnedBytes=0, bodyTruncated=not complete, bodyEncoding="utf-8")
                            try:
                                decoder = codecs.getincrementaldecoder("utf-8")("strict")
                                content = decoder.decode(bytes(body[:limit]), final=complete)
                                if any(ord(char) < 32 and char not in "\t\r\n" for char in content):
                                    raise UnicodeError("non-text response")
                                item.update(body=content, returnedBytes=len(content.encode("utf-8")))
                            except UnicodeError:
                                item.update(bodyEncoding="unavailable", bodyTruncated=True)
                                skip(url, "unsupported")
                            if len(body) > limit:
                                skip(url, "output_limit")
                            if item["bodyTruncated"]:
                                result["truncated"] = True
    except StopProbe as error:
        reason = str(error) or stop_reason[0]
        if reason != "entry_limit":
            skip(request.get("path", request.get("service", request.get("url", "server"))), reason)
        result["status"] = "partial" if reason == "entry_limit" else reason
    except PermissionError:
        result["status"] = "permission_denied"
        skip(request.get("path", "server"), "permission_denied")
    except (TimeoutError, subprocess.TimeoutExpired):
        result["status"] = "timeout"
        skip(request.get("path", "server"), "timeout")
    except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException):
        result["status"] = "error"
        skip(request.get("path", request.get("url", "server")), "error")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for signum, handler in previous.items():
            signal.signal(signum, handler)
        if child[0] is not None and child[0].poll() is None:
            os.killpg(child[0].pid, signal.SIGKILL)
            child[0].wait()
    if largest:
        result["items"] = [entry[3] for entry in sorted(largest, reverse=True)]
    if not result["coverageComplete"] and result["status"] == "complete":
        result["status"] = "partial"
    if result["status"] == "complete" and not result["items"]:
        result["status"] = "no_match"
    result["truncated"] |= result["matchedEntries"] > len(result["items"]) or not result["coverageComplete"]
    result["elapsedMs"] = int((time.monotonic() - started) * 1000)
    result["finishedAt"] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    # Bound the complete JSON including long file names and coverage diagnostics.
    while len(json.dumps(result, ensure_ascii=True).encode("ascii")) > 131072:
        result["truncated"] = True
        if result["skipped"]:
            result["skipped"].pop()
        elif result["items"]:
            result["items"].pop()
        else:
            break
    return result


if __name__ == "__main__":
    payload = json.loads(sys.argv[1])
    result = run(payload["toolId"], payload["request"])
    print("OPSARK_CAPABILITIES " + json.dumps(capability_report(result), ensure_ascii=True), flush=True)
    print("OPSARK_RESULT " + json.dumps(result, ensure_ascii=True), flush=True)
