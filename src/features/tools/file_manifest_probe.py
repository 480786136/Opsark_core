"""Bounded POSIX observation only: no extraction, writes, subprocesses or link following."""
import datetime
import errno
import gzip
import hashlib
import json
import os
import stat
import sys
import time
import zlib

OUTPUT_LIMIT = 1048576
LIMITATIONS = ["sampled_non_atomic", "symlink_targets_not_read", "metadata_not_acl_xattr", "not_backup_or_deployment_authorization", "explicit_root_only"]
REQUIRED = ("path", "source", "maxEntries", "maxDepth", "maxFileBytes", "maxTotalBytes", "maxArchiveBytes", "maxExpandedBytes", "timeoutSeconds")
BOUNDS = {"maxEntries": (1, 4096), "maxDepth": (1, 64), "maxFileBytes": (1, 67108864),
          "maxTotalBytes": (1, 268435456), "maxArchiveBytes": (1024, 67108864),
          "maxExpandedBytes": (1024, 268435456), "timeoutSeconds": (1, 120)}


class Stop(Exception):
    pass


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def exact_text(value, maximum=4096):
    if not isinstance(value, str) or not value or len(value) > maximum or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise Stop("invalid_name")
    try:
        value.encode("utf-8", "strict")
    except UnicodeError:
        raise Stop("invalid_name")
    return value


def validate(request):
    if not isinstance(request, dict) or set(request) != set(REQUIRED):
        raise ValueError("invalid_request")
    path = exact_text(request["path"])
    if not path.startswith("/") or path != "/" and any(p in ("", ".", "..") for p in path[1:].split("/")):
        raise ValueError("invalid_path")
    if request["source"] not in ("directory", "tar", "tar_gzip"):
        raise ValueError("invalid_source")
    for key, limits in BOUNDS.items():
        if type(request[key]) is not int or not limits[0] <= request[key] <= limits[1]:
            raise ValueError("invalid_limit")


def signature(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_uid, value.st_gid, value.st_size, value.st_mtime_ns, value.st_ctime_ns, value.st_nlink)


def identity(value):
    return dict(device=str(value.st_dev), inode=str(value.st_ino), sizeBytes=value.st_size,
                mode=format(stat.S_IMODE(value.st_mode), "04o"), uid=value.st_uid, gid=value.st_gid,
                mtimeNs=str(value.st_mtime_ns), ctimeNs=str(value.st_ctime_ns))


def exact_parent(path):
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY)
    try:
        components = path[1:].split("/") if path != "/" else ["."]
        for component in components[:-1]:
            newer = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = newer
        return fd, components[-1]
    except BaseException:
        os.close(fd)
        raise


def canonical_entry(item):
    return [item["path"], item["kind"], item["sizeBytes"], item["mode"], item["uid"], item["gid"], item.get("sha256"), item.get("linkTarget")]


def manifest_digest(entries):
    value = [canonical_entry(item) for item in sorted(entries, key=lambda row: row["path"].encode("utf-8"))]
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def error_reason(error):
    if isinstance(error, Stop):
        return str(error)
    if isinstance(error, PermissionError):
        return "permission_denied"
    if isinstance(error, FileNotFoundError):
        return "missing"
    if isinstance(error, OSError) and error.errno in (errno.ELOOP, errno.ENOTDIR):
        return "symlink_or_not_directory"
    return "io_error"


class Collector:
    def __init__(self, request, clock=time.monotonic):
        self.request = request
        self.clock = clock
        self.started = clock()
        self.deadline = self.started + request["timeoutSeconds"]
        self.result = dict(request=request, status="partial", coverageComplete=False, truncated=False,
                           safeForDeployment=False, rootIdentity=None, entries=[], issues=[], issueCount=0,
                           scannedEntries=0, contentBytes=0, readBytes=0, archiveReadBytes=0, expandedBytes=0,
                           manifestSha256=None, archiveSha256=None, sampledAt=timestamp(), finishedAt=None,
                           elapsedMs=0, consistency="sampled_non_atomic", limitations=list(LIMITATIONS))
        self.rechecks = []

    def check(self):
        if self.clock() >= self.deadline:
            raise Stop("timeout")

    def issue(self, path, reason):
        self.result["issueCount"] += 1
        if len(self.result["issues"]) < 128:
            self.result["issues"].append(dict(path=path if isinstance(path, str) and len(path) <= 4096 and not any(0xd800 <= ord(c) <= 0xdfff for c in path) else "", reason=reason))
        if reason.endswith("limit"):
            self.result["truncated"] = True

    def reserve(self, size):
        if size > self.request["maxFileBytes"]:
            raise Stop("file_byte_limit")
        if self.result["contentBytes"] + size > self.request["maxTotalBytes"]:
            raise Stop("total_byte_limit")
        self.result["contentBytes"] += size

    def entry(self, path, kind, size, mode, uid, gid):
        return dict(path=path, kind=kind, status="complete", reason="", sizeBytes=size, mode=format(mode, "04o"), uid=uid, gid=gid)

    def hash_fd(self, fd, size):
        digest = hashlib.sha256()
        read = 0
        while read <= size:
            self.check()
            chunk = os.read(fd, min(65536, size + 1 - read))
            self.result["readBytes"] += len(chunk)
            if not chunk:
                break
            read += len(chunk)
            digest.update(chunk)
        if read != size:
            raise Stop("changed")
        return digest.hexdigest()

    def directory(self, root_fd):
        def visit(fd, relative, depth):
            self.check()
            before = os.fstat(fd)
            # Iterate, never list/sort an unbounded directory before applying its cap.
            # scandir(fd) needs Python 3.7; proc's already-open descriptor path
            # preserves the same Linux inode binding on the supported 3.6 floor.
            with os.scandir("/proc/self/fd/" + str(fd)) as listing:
                for child in listing:
                    self.check()
                    if self.result["scannedEntries"] >= self.request["maxEntries"]:
                        raise Stop("entry_limit")
                    self.result["scannedEntries"] += 1
                    path = ""
                    row = None
                    try:
                        name = exact_text(child.name)
                        path = exact_text(relative + "/" + name if relative else name)
                        info = os.stat(name, dir_fd=fd, follow_symlinks=False)
                        kind = "regular" if stat.S_ISREG(info.st_mode) else "directory" if stat.S_ISDIR(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "other"
                        row = self.entry(path, kind, info.st_size if kind == "regular" else 0, stat.S_IMODE(info.st_mode), info.st_uid, info.st_gid)
                        row["identity"] = identity(info)
                        self.result["entries"].append(row)
                        self.rechecks.append((path, signature(info)))
                        if kind == "regular":
                            self.reserve(info.st_size)
                            opened = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
                            try:
                                if signature(os.fstat(opened)) != signature(info):
                                    raise Stop("changed")
                                first = self.hash_fd(opened, info.st_size)
                                os.lseek(opened, 0, os.SEEK_SET)
                                second = self.hash_fd(opened, info.st_size)
                                if first != second or signature(os.fstat(opened)) != signature(info):
                                    raise Stop("changed")
                                row["sha256"] = first
                            finally:
                                os.close(opened)
                        elif kind == "symlink":
                            row["linkTarget"] = exact_text(os.readlink(name, dir_fd=fd))
                        elif kind == "directory":
                            if depth >= self.request["maxDepth"]:
                                raise Stop("depth_limit")
                            nested = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
                            try:
                                if signature(os.fstat(nested)) != signature(info):
                                    raise Stop("changed")
                                visit(nested, path, depth + 1)
                            finally:
                                os.close(nested)
                        else:
                            raise Stop("unsupported_type")
                        if signature(os.stat(name, dir_fd=fd, follow_symlinks=False)) != signature(info):
                            raise Stop("changed")
                    except (OSError, Stop) as error:
                        reason = error_reason(error)
                        if row is not None:
                            row.update(status="partial", reason=reason)
                            row.pop("sha256", None)
                        self.issue(path, reason)
                        if reason in ("timeout", "entry_limit", "total_byte_limit"):
                            raise Stop(reason)
            if signature(os.fstat(fd)) != signature(before):
                raise Stop("changed")
        visit(root_fd, "", 1)
        # Detect later changes to earlier samples; this still is not an atomic snapshot.
        for relative, old in self.rechecks:
            self.check()
            absolute = self.request["path"].rstrip("/") + "/" + relative
            parent, name = exact_parent(absolute)
            try:
                if signature(os.stat(name, dir_fd=parent, follow_symlinks=False)) != old:
                    self.issue(relative, "changed")
            finally:
                os.close(parent)

    def archive(self, fd, before):
        if before.st_size > self.request["maxArchiveBytes"]:
            raise Stop("archive_byte_limit")
        collector = self

        class Raw:
            def __init__(self):
                self.digest = hashlib.sha256()
                self.count = 0

            def read(self, amount=-1):
                collector.check()
                remaining = collector.request["maxArchiveBytes"] + 1 - self.count
                chunk = os.read(fd, min(65536 if amount < 0 else amount, remaining))
                self.count += len(chunk)
                collector.result["archiveReadBytes"] += len(chunk)
                self.digest.update(chunk)
                if self.count > collector.request["maxArchiveBytes"]:
                    raise Stop("archive_byte_limit")
                return chunk

        raw = Raw()
        stream = gzip.GzipFile(fileobj=raw, mode="rb") if self.request["source"] == "tar_gzip" else raw

        def read(amount):
            self.check()
            left = self.request["maxExpandedBytes"] + 1 - self.result["expandedBytes"]
            data = stream.read(min(amount, left))
            self.result["expandedBytes"] += len(data)
            if self.result["expandedBytes"] > self.request["maxExpandedBytes"]:
                raise Stop("expanded_byte_limit")
            return data

        def exact(amount):
            data = b""
            while len(data) < amount:
                chunk = read(amount - len(data))
                if not chunk:
                    raise Stop("invalid_archive")
                data += chunk
            return data

        def number(field):
            if field[0] & 128:
                value = int.from_bytes(bytes([field[0] & 127]) + field[1:], "big")
            else:
                value = int(field.strip(b"\0 ") or b"0", 8)
            if not 0 <= value <= 9007199254740991:
                raise Stop("invalid_archive")
            return value

        def string(field):
            return field.split(b"\0", 1)[0].decode("utf-8", "strict")

        seen = set()
        pending = {}
        headers = 0
        root_seen = False
        try:
            while True:
                header = exact(512)
                if header == b"\0" * 512:
                    if exact(512) != b"\0" * 512 or pending:
                        raise Stop("invalid_archive")
                    # Consume the trailer and gzip CRC to EOF; an unseen concatenated tar is not ignored.
                    while True:
                        tail = read(65536)
                        if not tail:
                            break
                        if tail.strip(b"\0"):
                            raise Stop("trailing_archive_data")
                    break
                headers += 1
                if headers > self.request["maxEntries"] * 3 + 8:
                    raise Stop("entry_limit")
                expected = number(header[148:156])
                unsigned = sum(header[:148]) + 8 * 32 + sum(header[156:])
                if expected != unsigned:
                    raise Stop("invalid_archive")
                size = number(header[124:136])
                mode = number(header[100:108])
                uid, gid = number(header[108:116]), number(header[116:124])
                if mode > 4095 or uid > 4294967295 or gid > 4294967295:
                    raise Stop("invalid_archive")
                kind = header[156:157]
                if kind in (b"x", b"L", b"K"):
                    if size > 65536:
                        raise Stop("metadata_byte_limit")
                    payload = exact(size)
                    if kind in (b"L", b"K"):
                        key = "path" if kind == b"L" else "linkpath"
                        if key in pending:
                            raise Stop("duplicate_metadata")
                        pending[key] = payload.rstrip(b"\0").decode("utf-8", "strict")
                    else:
                        offset = 0
                        while offset < len(payload):
                            end = payload.find(b" ", offset)
                            if end < 0 or end - offset > 8:
                                raise Stop("invalid_archive")
                            length = int(payload[offset:end])
                            if length <= end - offset + 3 or offset + length > len(payload) or payload[offset + length - 1:offset + length] != b"\n":
                                raise Stop("invalid_archive")
                            key, value = payload[end + 1:offset + length - 1].split(b"=", 1)
                            key, value = key.decode("ascii"), value.decode("utf-8", "strict")
                            if key not in ("path", "linkpath", "mtime", "atime", "ctime"):
                                raise Stop("unsupported_archive_metadata")
                            if key in pending:
                                raise Stop("duplicate_metadata")
                            pending[key] = value
                            offset += length
                    if size % 512:
                        exact(512 - size % 512)
                    continue
                if kind not in (b"0", b"\0", b"5", b"1", b"2"):
                    raise Stop("unsupported_archive_type")
                # A valid GNU/PAX long name overrides a byte-truncated legacy
                # field, whose final bytes may not be complete UTF-8.
                if "path" in pending:
                    name = pending["path"]
                else:
                    name = string(header[:100])
                    if header[257:263] == b"ustar\0":
                        prefix = string(header[345:500])
                        name = prefix + "/" + name if prefix else name
                link = pending["linkpath"] if "linkpath" in pending else string(header[157:257])
                pending = {}
                exact_text(name)
                if name.startswith("/"):
                    raise Stop("unsafe_archive_path")
                while name.startswith("./"):
                    name = name[2:]
                if kind == b"5":
                    name = name.rstrip("/")
                if name in ("", ".") and kind == b"5" and size == 0:
                    if root_seen:
                        raise Stop("duplicate_path")
                    root_seen = True
                    continue
                if not name or any(part in ("", ".", "..") for part in name.split("/")):
                    raise Stop("unsafe_archive_path")
                if (name in seen or any(parent in seen and next(row for row in self.result["entries"] if row["path"] == parent)["kind"] != "directory"
                                       for parent in ["/".join(name.split("/")[:i]) for i in range(1, len(name.split("/")))])
                    or kind != b"5" and any(existing.startswith(name + "/") for existing in seen)):
                    raise Stop("duplicate_path")
                if len(name.split("/")) > self.request["maxDepth"]:
                    raise Stop("depth_limit")
                if self.result["scannedEntries"] >= self.request["maxEntries"]:
                    raise Stop("entry_limit")
                self.result["scannedEntries"] += 1
                seen.add(name)
                entry_kind = "regular" if kind in (b"0", b"\0") else "directory" if kind == b"5" else "hardlink" if kind == b"1" else "symlink"
                row = self.entry(name, entry_kind, size, mode, uid, gid)
                # Publish completeness only after this member's type, payload and
                # padding are validated. A later parse error must leave a usable
                # partial observation, never a contradictory complete row.
                row.update(status="partial", reason="incomplete_read")
                self.result["entries"].append(row)
                if entry_kind in ("hardlink", "symlink"):
                    row.update(status="partial", reason="archive_link", linkTarget=exact_text(link))
                    self.issue(name, "archive_link")
                elif entry_kind == "directory" and size:
                    raise Stop("invalid_archive")
                self.reserve(size)
                digest = hashlib.sha256()
                remaining = size
                while remaining:
                    chunk = exact(min(65536, remaining))
                    digest.update(chunk)
                    remaining -= len(chunk)
                if entry_kind == "regular":
                    row["sha256"] = digest.hexdigest()
                if size % 512:
                    exact(512 - size % 512)
                if entry_kind in ("regular", "directory"):
                    row.update(status="complete", reason="")
            if raw.count != before.st_size:
                raise Stop("changed")
            first = raw.digest.hexdigest()
            os.lseek(fd, 0, os.SEEK_SET)
            second = hashlib.sha256()
            reread = 0
            while reread <= before.st_size:
                self.check()
                chunk = os.read(fd, min(65536, before.st_size + 1 - reread))
                self.result["archiveReadBytes"] += len(chunk)
                if not chunk:
                    break
                reread += len(chunk)
                second.update(chunk)
            if reread != before.st_size or first != second.hexdigest() or signature(os.fstat(fd)) != signature(before):
                raise Stop("changed")
            self.result["archiveSha256"] = first
        finally:
            if isinstance(stream, gzip.GzipFile):
                stream.close()

    def run(self):
        root_fd = None
        try:
            self.check()
            parent, name = exact_parent(self.request["path"])
            try:
                before = os.stat(name, dir_fd=parent, follow_symlinks=False)
                self.result["rootIdentity"] = identity(before)
                expected = stat.S_ISDIR if self.request["source"] == "directory" else stat.S_ISREG
                if not expected(before.st_mode):
                    raise Stop("unsupported_root_type")
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                if self.request["source"] == "directory":
                    flags |= os.O_DIRECTORY
                root_fd = os.open(name, flags, dir_fd=parent)
                if signature(os.fstat(root_fd)) != signature(before):
                    raise Stop("changed")
            finally:
                os.close(parent)
            if self.request["source"] == "directory":
                self.directory(root_fd)
            else:
                self.archive(root_fd, before)
            self.check()
            parent, name = exact_parent(self.request["path"])
            try:
                if signature(os.stat(name, dir_fd=parent, follow_symlinks=False)) != signature(before) or signature(os.fstat(root_fd)) != signature(before):
                    raise Stop("changed")
            finally:
                os.close(parent)
        except (OSError, Stop) as error:
            self.issue("", error_reason(error))
        except (ValueError, UnicodeError, EOFError, zlib.error, OverflowError):
            self.issue("", "invalid_archive")
        finally:
            if root_fd is not None:
                os.close(root_fd)
        for row in self.result["entries"]:
            if row["kind"] == "regular" and "sha256" not in row and row["status"] == "complete":
                row.update(status="partial", reason="incomplete_read")
        complete = not self.result["issueCount"] and all(row["status"] == "complete" for row in self.result["entries"])
        self.result.update(status="complete" if complete else "timeout" if any(item["reason"] == "timeout" for item in self.result["issues"]) else "partial",
                           coverageComplete=complete, safeForDeployment=complete and all(row["kind"] in ("regular", "directory") for row in self.result["entries"]),
                           manifestSha256=manifest_digest(self.result["entries"]) if complete else None,
                           finishedAt=timestamp(), elapsedMs=max(0, int((self.clock() - self.started) * 1000)))
        # Never serialize a prefix as a complete original manifest.
        if len(json.dumps(self.result, ensure_ascii=True, separators=(",", ":")).encode("ascii")) > OUTPUT_LIMIT - 64:
            self.issue("", "output_limit")
            self.result.update(status="partial", coverageComplete=False, safeForDeployment=False, truncated=True, manifestSha256=None)
            while self.result["entries"] and len(json.dumps(self.result, ensure_ascii=True, separators=(",", ":")).encode("ascii")) > OUTPUT_LIMIT - 64:
                self.result["entries"] = self.result["entries"][:len(self.result["entries"]) // 2]
        return self.result


def run(request, clock=time.monotonic):
    validate(request)
    return Collector(request, clock).run()


if __name__ == "__main__":
    value = run(json.loads(sys.argv[1]))
    print("OPSARK_FILE_MANIFEST " + json.dumps(value, ensure_ascii=True, separators=(",", ":")))
