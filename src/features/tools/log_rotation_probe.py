"""Fixed read-only Linux log observation. Python 3.6+, no external commands.

No logrotate invocation, signals, script evaluation, state/cache/config writes.
Explicit files/PIDs only; finite compressed and expanded bytes, FDs and records.
"""
import datetime
import errno
import gzip
import hashlib
import io
import json
import os
import re
import shlex
import signal
import stat
import sys
import time
import zlib

LIMITATIONS = ["exact_paths_and_pids_only", "non_atomic_observation", "configuration_declarations_only",
               "schedule_not_verified", "reopen_support_not_inferred", "sequence_window_only", "not_rotation_authorization"]
MAX_LINE_BYTES = 65536
MAX_RECORDS = 100000


class ProbeStop(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def check(deadline):
    if time.monotonic() >= deadline:
        raise ProbeStop("timeout")


def digest(value):
    return hashlib.sha256(value).hexdigest()


def metadata(info):
    return dict(device=str(info.st_dev), inode=str(info.st_ino), sizeBytes=info.st_size,
                mode=format(stat.S_IMODE(info.st_mode), "04o"), uid=info.st_uid, gid=info.st_gid,
                mtimeNs=str(info.st_mtime_ns), ctimeNs=str(info.st_ctime_ns))


def identity(info):
    return info.st_dev, info.st_ino


def stable(info):
    return identity(info) + (info.st_size, info.st_mtime_ns, info.st_ctime_ns)


def exact_parent(path):
    parts = path.split("/")[1:]
    if not path.startswith("/") or not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError("invalid_path")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            nested = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = nested
        return descriptor, parts[-1]
    except BaseException:
        os.close(descriptor)
        raise


def exact_stat(path):
    parent, name = exact_parent(path)
    try:
        return os.stat(name, dir_fd=parent, follow_symlinks=False)
    finally:
        os.close(parent)


def read_fd(descriptor, size, deadline):
    parts, left = [], size
    while left:
        check(deadline)
        block = os.read(descriptor, min(left, 65536))
        if not block:
            break
        parts.append(block)
        left -= len(block)
    return b"".join(parts)


def file_sample(path, role, max_bytes, deadline):
    started = now()
    row = dict(path=path, role=role, status="error", kind="unknown", compression="unavailable", compressionValid=None,
               readBytes=0, expandedBytes=0, lineCount=0, partialLastLine=False, sampledAt=started,
               finishedAt=started, consistency="unverified", reason="unreadable")
    descriptor, parent, content = None, None, None
    try:
        check(deadline)
        parent, name = exact_parent(path)
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        row["metadata"] = metadata(before)
        row["kind"] = "regular" if stat.S_ISREG(before.st_mode) else "symlink" if stat.S_ISLNK(before.st_mode) else "directory" if stat.S_ISDIR(before.st_mode) else "other"
        if row["kind"] != "regular":
            row.update(status="unsupported", reason="regular_file_required")
            return row, None
        descriptor = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        opened = os.fstat(descriptor)
        if identity(opened) != identity(before) or not stat.S_ISREG(opened.st_mode):
            row.update(status="changed", reason="identity_changed")
            return row, None
        raw = read_fd(descriptor, min(opened.st_size, max_bytes + 1), deadline)
        row["readBytes"] = len(raw)
        if opened.st_size > max_bytes or len(raw) > max_bytes:
            row.update(status="limit_exceeded", reason="compressed_or_plain_byte_limit")
            return row, None
        if len(raw) != opened.st_size:
            row.update(status="changed", reason="short_read")
            return row, None
        os.lseek(descriptor, 0, os.SEEK_SET)
        checked = read_fd(descriptor, len(raw), deadline)
        after, current = os.fstat(descriptor), exact_stat(path)
        same = identity(opened) == identity(after) == identity(current)
        if not same or checked != raw or after.st_size < opened.st_size or current.st_size < opened.st_size:
            row.update(status="changed", reason="identity_or_prefix_changed")
            return row, None
        changed = stable(opened) != stable(after) or stable(after) != stable(current)
        if changed and role != "active":
            row.update(status="changed", reason="archive_or_config_changed")
            return row, None
        row["metadata"] = metadata(opened)
        row["consistency"] = "prefix_rechecked" if role == "active" else "metadata_rechecked"
        row["appendObserved"] = after.st_size > opened.st_size or current.st_size > opened.st_size
        row["rawSha256"] = digest(raw)
        if raw.startswith(b"\x1f\x8b"):
            row["compression"] = "gzip"
            try:
                with gzip.GzipFile(fileobj=io.BytesIO(raw), mode="rb") as zipped:
                    content = zipped.read(max_bytes + 1)
                check(deadline)
                row["expandedBytes"] = len(content)
                if len(content) > max_bytes:
                    row.update(status="limit_exceeded", reason="expanded_byte_limit")
                    return row, None
                row["compressionValid"] = True  # EOF read also verifies gzip CRC/ISIZE.
            except (OSError, EOFError, ValueError, zlib.error):
                row.update(status="error", compressionValid=False, reason="invalid_gzip")
                return row, None
        else:
            row["compression"] = "none"
            content = raw
            row["expandedBytes"] = len(content)
        row["lineCount"] = content.count(b"\n")
        row["partialLastLine"] = bool(content and not content.endswith(b"\n"))
        if row["lineCount"] > MAX_RECORDS or any(len(line) > MAX_LINE_BYTES for line in content.split(b"\n")):
            row.update(status="limit_exceeded", reason="line_or_record_limit")
            return row, None
        incomplete = role != "config" and row["partialLastLine"]
        row.update(status="partial" if incomplete else "complete", reason="partial_record" if incomplete else "sampled", contentSha256=digest(content))
        return row, content
    except FileNotFoundError:
        row.update(status="missing", kind="missing", reason="not_found")
    except PermissionError:
        row.update(status="permission_denied", reason="permission_denied")
    except OSError as error:
        row.update(status="unsupported" if error.errno in (errno.ELOOP, errno.ENOTDIR) else "error",
                   reason="linked_ancestor_or_invalid_directory" if error.errno in (errno.ELOOP, errno.ENOTDIR) else "io_error")
    finally:
        if descriptor is not None:
            os.close(descriptor)
        if parent is not None:
            os.close(parent)
        row["finishedAt"] = now()
    return row, None


def proc_text(path, limit=8192):
    with open(path, "rb") as handle:
        value = handle.read(limit + 1)
    if len(value) > limit:
        raise ValueError("proc_limit")
    return value.decode("utf-8", "strict")


def proc_identity(pid, proc):
    value = proc_text(os.path.join(proc, str(pid), "stat"))
    close = value.rfind(")")
    values = value[close + 2:].split()
    if not value.startswith(str(pid) + " (") or close < 0 or len(values) <= 19:
        raise ValueError("invalid_proc_stat")
    if not values[19].isdigit():
        raise ValueError("invalid_start_ticks")
    return values[19], value[value.index("(") + 1:close]


def writer_sample(pid, files, max_fds, deadline, proc="/proc"):
    row = dict(pid=pid, status="unknown", descriptors=[], scannedFds=0, reason="unobserved")
    identities = {(item["metadata"]["device"], item["metadata"]["inode"]): item["path"] for item in files if item.get("kind") == "regular" and "metadata" in item}
    try:
        before, name = proc_identity(pid, proc)
        row.update(startTicks=before, process=name)
        with os.scandir(os.path.join(proc, str(pid), "fd")) as entries:
            for entry in entries:
                check(deadline)
                if row["scannedFds"] >= max_fds:
                    row.update(reason="fd_limit")
                    return row
                if not entry.name.isdigit():
                    continue
                row["scannedFds"] += 1
                info = os.stat(entry.path)
                if not stat.S_ISREG(info.st_mode):
                    continue
                scope = identities.get((str(info.st_dev), str(info.st_ino)))
                if scope is None:
                    continue
                fdinfo = proc_text(os.path.join(proc, str(pid), "fdinfo", entry.name))
                flag = re.search(r"^flags:\s+([0-7]+)$", fdinfo, re.M)
                if not flag:
                    raise ValueError("unknown_fd_flags")
                flags = int(flag.group(1), 8)
                after = os.stat(entry.path)
                if identity(info) != identity(after):
                    raise ValueError("fd_identity_changed")
                if flags & os.O_ACCMODE in (os.O_WRONLY, os.O_RDWR):
                    row["descriptors"].append(dict(fd=int(entry.name), path=scope, device=str(info.st_dev), inode=str(info.st_ino), append=bool(flags & os.O_APPEND)))
        after, _ = proc_identity(pid, proc)
        if before != after:
            row.update(reason="pid_reused", descriptors=[])
        else:
            row.update(status="complete", reason="sampled")
    except FileNotFoundError:
        row.update(reason="process_or_fd_changed")
    except PermissionError:
        row.update(reason="permission_denied")
    except (OSError, ValueError, UnicodeError):
        row.update(reason="proc_unavailable_or_changed")
    return row


DIRECTIVES = set("daily weekly monthly yearly hourly rotate maxage minage size minsize maxsize compress nocompress delaycompress nodelaycompress copytruncate nocopytruncate copy nocopy renamecopy norenamecopy create nocreate su olddir noolddir dateext nodateext dateformat dateyesterday missingok nomissingok notifempty ifempty sharedscripts nosharedscripts extension addextension start compresscmd uncompresscmd compressext compressoptions createolddir nocreateolddir".split())
SCRIPT_PHASES = set("postrotate prerotate firstaction lastaction preremove".split())


def config_sample(path, max_bytes, deadline):
    sample, raw = file_sample(path, "config", max_bytes, deadline)
    row = dict(path=path, status="partial", reason=sample["reason"], blocks=[], globalDirectives=[], includes=[], scripts=[], unparsedCount=0)
    if sample["status"] != "complete" or raw is None or sample["compression"] != "none":
        return row
    row["sha256"] = digest(raw)
    try:
        block, phase, script = None, None, []
        for line in raw.decode("utf-8", "strict").splitlines():
            check(deadline)
            text = line.strip()
            if phase:
                if text == "endscript":
                    destination = block["scripts"] if block is not None else row["scripts"]
                    if len(destination) < 16:
                        destination.append(dict(phase=phase, sha256=digest("\n".join(script).encode("utf-8"))))
                    else:
                        row["unparsedCount"] += 1
                    phase, script = None, []
                else:
                    script.append(line)
                continue
            if not text or text.startswith("#"):
                continue
            if text in SCRIPT_PHASES:
                phase = text
                continue
            if text.endswith("{"):
                if block is not None or len(row["blocks"]) >= 16:
                    row["unparsedCount"] += 1
                    continue
                targets = shlex.split(text[:-1])
                if not targets or len(targets) > 16 or any(not value.startswith("/") or len(value) > 4096 for value in targets):
                    row["unparsedCount"] += 1
                    continue
                block = dict(targets=targets, directives=[], scripts=[])
                row["blocks"].append(block)
                continue
            if text == "}":
                if block is None:
                    row["unparsedCount"] += 1
                block = None
                continue
            fields = text.split(None, 1)
            directive, value = fields[0], fields[1] if len(fields) > 1 else ""
            if directive == "include":
                if len(row["includes"]) < 16 and len(value) <= 4096:
                    row["includes"].append(value)
                row["unparsedCount"] += 1  # Never follow includes or pretend to resolve global policy.
            elif directive in DIRECTIVES and len(value) <= 4096:
                destination = block["directives"] if block is not None else row["globalDirectives"]
                if len(destination) < 64:
                    destination.append(dict(name=directive, value=value))
                else:
                    row["unparsedCount"] += 1
            else:
                row["unparsedCount"] += 1
        if phase or block is not None:
            row["unparsedCount"] += 1
        row.update(status="complete" if row["unparsedCount"] == 0 else "partial", reason="declarations_only" if row["unparsedCount"] == 0 else "unresolved_syntax_or_include")
    except (ValueError, UnicodeError):
        row.update(reason="invalid_config_text", unparsedCount=row["unparsedCount"] + 1)
    return row


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate_json_key")
        value[key] = item
    return value


def invalid_constant(_value):
    raise ValueError("invalid_json_constant")


def sequence_sample(spec, samples, deadline=float("inf")):
    first, last = spec["first"], spec["last"]
    counts, parsed, invalid, unscanned = {}, 0, 0, []
    for row, content in samples:
        if row["status"] != "complete" or content is None:
            unscanned.append(row["path"])
            continue
        lines = content.split(b"\n")
        if lines[-1]:
            invalid += 1  # A partial record is never silently dropped.
        for line in lines[:-1]:
            check(deadline)
            if parsed >= MAX_RECORDS:
                unscanned.append(row["path"])
                break
            parsed += 1
            try:
                value = json.loads(line.decode("utf-8", "strict"), object_pairs_hook=unique_object, parse_constant=invalid_constant)[spec["field"]]
                if isinstance(value, bool) or not isinstance(value, int) or abs(value) > 9007199254740991:
                    raise ValueError("invalid_sequence")
                if first <= value <= last:
                    counts[value] = counts.get(value, 0) + 1
            except (ValueError, UnicodeError, KeyError, TypeError, RecursionError):
                invalid += 1
    missing = sum(1 for value in range(first, last + 1) if value not in counts)
    duplicate = sum(value - 1 for value in counts.values() if value > 1)
    complete = not unscanned and not invalid
    return dict(field=spec["field"], first=first, last=last, expectedCount=last - first + 1, observedUnique=len(counts),
                parsedRecords=parsed, missingCount=missing, duplicateCount=duplicate, invalidRecords=invalid,
                unscannedPaths=list(dict.fromkeys(unscanned)), coverageComplete=complete,
                status="complete" if complete and not missing and not duplicate else "mismatch" if complete else "partial",
                sampling="independent_file_prefixes", scope="requested_sequence_window")


def run(request):
    started, began = time.monotonic(), now()
    deadline = started + request["timeoutSeconds"]
    result = dict(request=request, status="partial", coverageComplete=False, files=[], configs=[], writers=[],
                  sequence=None, sampledAt=began, finishedAt=began, elapsedMs=0, limitations=LIMITATIONS[:])
    samples = []
    try:
        for role, paths in (("active", request["activePaths"]), ("archive", request["archivePaths"])):
            for path in paths:
                observed = file_sample(path, role, request["maxBytesPerFile"], deadline)
                samples.append(observed)
                result["files"].append(observed[0])
        for path in request["configPaths"]:
            result["configs"].append(config_sample(path, min(request["maxBytesPerFile"], 65536), deadline))
        for pid in request["writerPids"]:
            result["writers"].append(writer_sample(pid, result["files"], request["maxFdsPerProcess"], deadline))
        if request.get("sequenceCheck"):
            result["sequence"] = sequence_sample(request["sequenceCheck"], samples, deadline)
        check(deadline)
        complete = all(item["status"] == "complete" for key in ("files", "configs", "writers") for item in result[key]) and (result["sequence"] is None or result["sequence"]["coverageComplete"])
        result.update(status="complete" if complete else "partial", coverageComplete=complete)
    except ProbeStop as error:
        result["status"] = str(error)
    finally:
        result.update(finishedAt=now(), elapsedMs=max(0, int((time.monotonic() - started) * 1000)))
    if len(json.dumps(result, ensure_ascii=True).encode("utf-8")) > 120000:
        result.update(status="partial", coverageComplete=False, files=[], configs=[], writers=[], sequence=None, incompleteReason="output_limit")
    return result


if __name__ == "__main__":
    def stopped(_signal, _frame):
        raise ProbeStop("cancelled")
    signal.signal(signal.SIGTERM, stopped)
    signal.signal(signal.SIGINT, stopped)
    print("OPSARK_LOG_ROTATION " + json.dumps(run(json.loads(sys.argv[1])), ensure_ascii=True, separators=(",", ":")), flush=True)
