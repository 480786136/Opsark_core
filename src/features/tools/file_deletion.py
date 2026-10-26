"""Exact regular-file deletion. Requests and identity snapshots are Core-owned.

Preview never writes. Execute requires Linux read leases on the entire frozen
list before moving anything. It captures names in checked private directories
and never unlinks public candidate names or expands globs/subdirectories.
"""
import contextlib
import errno
try:
    import fcntl
except ImportError:
    fcntl = None
import hashlib
import json
import os
import signal
import stat
import sys
import time
import uuid

# Execution hashes each candidate before and after capture. Reserve both passes
# before any move; previews apply the same eligibility limit. Actual cumulative
# bytes read by this operation never exceed 256 MiB (128 MiB of candidates).
MAX_HASH_BYTES = 256 * 1024 * 1024
HASH_CHUNK_BYTES = 1024 * 1024

ERROR_MESSAGES = {
    "INVALID_REQUEST": "删除请求或冻结快照格式无效，请重新预览并确认。",
    "UNSUPPORTED_ENVIRONMENT": "运行环境不具备安全删除所需的 Linux 租约和路径保护能力。",
    "LEASE_CONFLICT": "候选文件存在可写句柄或可写映射，未取得只读租约。",
    "LEASE_UNSUPPORTED": "候选文件所在文件系统不支持所需只读租约。",
    "LEASE_PERMISSION_DENIED": "当前用户没有取得候选文件租约的权限。",
    "LEASE_INTERRUPTED": "检测到并发写入请求或租约保护丢失，已中止本次操作。",
    "LEASE_DEADLINE_EXCEEDED": "本次安全操作时间已超限，已中止并尝试恢复捕获项。",
    "CANDIDATE_CHANGED": "候选文件的路径、身份或内容已变化，请重新预览并确认。",
    "HASH_LIMIT_EXCEEDED": "候选文件总大小超过 128 MiB 或累计摘要读取超过 256 MiB。",
    "QUARANTINE_CHANGED": "隔离目录的身份、所有者或权限发生异常变化。",
    "IO_FAILURE": "文件操作发生 I/O 故障，请核对实际结果和保留位置。",
    "INTERNAL_ERROR": "安全删除流程发生内部错误，请核对实际结果，勿重放旧许可。",
}


class DeletionError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(ERROR_MESSAGES[code])


def safe_error(error):
    if isinstance(error, DeletionError):
        code = error.code
    elif isinstance(error, OSError):
        code = "CANDIDATE_CHANGED" if error.errno in (errno.ENOENT, errno.ENOTDIR, errno.ELOOP) else "IO_FAILURE"
    elif isinstance(error, (ValueError, TypeError, KeyError)):
        code = "INVALID_REQUEST"
    else:
        code = "INTERNAL_ERROR"
    return {"code": code, "message": ERROR_MESSAGES[code]}


class ReadLeases:
    """Fail closed on active writers, unsupported leases, or a lease break.

    This program owns its process signal handler. Linux leases are bounded by
    lease-break-time: keep the normal critical operation much shorter, check
    the kernel lease state at every boundary, and abort promptly on SIGIO.
    """
    def __init__(self):
        self.fds = []
        self.previous_handler = None
        self.cleaning_up = False
        self.broken = False
        self.deadline = None

    def start(self):
        if sys.platform != "linux" or fcntl is None or not all(hasattr(fcntl, name) for name in ("F_SETLEASE", "F_GETLEASE", "F_SETOWN")):
            raise DeletionError("UNSUPPORTED_ENVIRONMENT")
        if not hasattr(signal, "pthread_sigmask") or signal.SIGIO in signal.pthread_sigmask(signal.SIG_BLOCK, set()):
            raise DeletionError("UNSUPPORTED_ENVIRONMENT")
        try:
            with open("/proc/sys/fs/lease-break-time", "r") as source:
                break_seconds = int(source.read().strip())
        except (OSError, ValueError):
            raise DeletionError("UNSUPPORTED_ENVIRONMENT") from None
        if break_seconds <= 0:
            raise DeletionError("UNSUPPORTED_ENVIRONMENT")
        self.deadline = time.monotonic() + min(5.0, break_seconds / 2.0)
        self.previous_handler = signal.signal(signal.SIGIO, self.on_break)

    def on_break(self, _number, _frame):
        self.broken = True
        if not self.cleaning_up:
            raise DeletionError("LEASE_INTERRUPTED")

    def acquire(self, fd):
        # A writable open description (including our own) prevents acquisition.
        # EAGAIN/EINVAL/EPERM are failures, never a fallback to metadata-only.
        self.fds.append(fd)
        try:
            fcntl.fcntl(fd, fcntl.F_SETOWN, os.getpid())
            fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_RDLCK)
        except OSError as error:
            if error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                code = "LEASE_CONFLICT"
            elif error.errno in (errno.EINVAL, errno.ENOSYS, errno.ENOTSUP, errno.EOPNOTSUPP):
                code = "LEASE_UNSUPPORTED"
            elif error.errno in (errno.EPERM, errno.EACCES):
                code = "LEASE_PERMISSION_DENIED"
            else:
                code = "IO_FAILURE"
            raise DeletionError(code) from None
        self.check()

    def check(self):
        if self.broken:
            raise DeletionError("LEASE_INTERRUPTED")
        if self.deadline is None or time.monotonic() >= self.deadline:
            raise DeletionError("LEASE_DEADLINE_EXCEEDED")
        if any(fcntl.fcntl(fd, fcntl.F_GETLEASE) != fcntl.F_RDLCK for fd in self.fds):
            raise DeletionError("LEASE_INTERRUPTED")

    @contextlib.contextmanager
    def mutation(self):
        # Deliver a break after the syscall AND its state bookkeeping. Raising
        # between rename and captured=True would otherwise lose recovery state.
        self.check()
        previous = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGIO})
        try:
            self.check()
            yield
        finally:
            signal.pthread_sigmask(signal.SIG_SETMASK, previous)

    def close(self):
        self.cleaning_up = True
        if self.previous_handler is None:
            return
        previous_mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGIO})
        try:
            for fd in self.fds:
                try:
                    fcntl.fcntl(fd, fcntl.F_SETLEASE, fcntl.F_UNLCK)
                except OSError:
                    pass
        finally:
            # Do not deliver a queued lease notification to the restored
            # default handler after this operation has released every lease.
            while signal.sigtimedwait({signal.SIGIO}, 0) is not None:
                pass
            signal.signal(signal.SIGIO, self.previous_handler)
            signal.pthread_sigmask(signal.SIG_SETMASK, previous_mask)


def verify_quarantine(entry, check_name=True):
    """Both the opened directory and its public name must remain ours."""
    directory = os.fstat(entry["quarantine_fd"])
    expected = entry["quarantine_identity"]
    infos = [directory]
    if check_name:
        infos.append(os.stat(entry["quarantine_name"], dir_fd=entry["parent"], follow_symlinks=False))
    for info in infos:
        if not stat.S_ISDIR(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o700 or info.st_uid != os.geteuid():
            raise DeletionError("QUARANTINE_CHANGED")
        if (info.st_dev, info.st_ino) != expected:
            raise DeletionError("QUARANTINE_CHANGED")


def paths_checked(paths):
    if not isinstance(paths, list) or not 1 <= len(paths) <= 100:
        raise ValueError("expected 1..100 exact paths")
    for path in paths:
        if not isinstance(path, str) or not path.startswith("/") or "\x00" in path:
            raise ValueError("invalid absolute path")
        if len(path.encode("utf-8")) > 4096 or any(p in ("", ".", "..") for p in path[1:].split("/")):
            raise ValueError("path must be normalized and name a file")
    if len(set(paths)) != len(paths):
        raise ValueError("duplicate paths")
    return paths


def open_parent(path):
    if not hasattr(os, "O_NOFOLLOW") or os.stat not in os.supports_dir_fd or os.unlink not in os.supports_dir_fd:
        raise DeletionError("UNSUPPORTED_ENVIRONMENT")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for part in path[1:].split("/")[:-1]:
            next_fd = os.open(part, flags, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def identity(path, parent, info=None):
    if info is None:
        info = os.stat(path.rsplit("/", 1)[1], dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISREG(info.st_mode):
        raise DeletionError("CANDIDATE_CHANGED")
    directory = os.fstat(parent)
    # Strings preserve nanosecond and inode precision through JavaScript JSON.
    return {"path": path, "size": info.st_size,
            "identity": [str(value) for value in (
                directory.st_dev, directory.st_ino, info.st_dev, info.st_ino,
                info.st_mode, info.st_nlink, info.st_size, info.st_mtime_ns, info.st_ctime_ns)]}


def metadata(item):
    return {key: item[key] for key in ("path", "size", "identity")}


def hash_content(fd, leases, budget):
    os.lseek(fd, 0, os.SEEK_SET)
    digest = hashlib.sha256()
    while True:
        leases.check()
        chunk = os.read(fd, min(HASH_CHUNK_BYTES, budget[0] + 1))
        if not chunk:
            leases.check()
            return digest.hexdigest()
        if len(chunk) > budget[0]:
            raise DeletionError("HASH_LIMIT_EXCEEDED")
        budget[0] -= len(chunk)
        digest.update(chunk)


def preview(paths):
    leases = ReadLeases()
    opened = []
    try:
        leases.start()
        for path in paths_checked(paths):
            entry = {"parent": open_parent(path), "held": None}
            opened.append(entry)
            entry["held"] = os.open(path.rsplit("/", 1)[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=entry["parent"])
            leases.acquire(entry["held"])
            entry["item"] = identity(path, entry["parent"], os.fstat(entry["held"]))
        if sum(entry["item"]["size"] for entry in opened) * 2 > MAX_HASH_BYTES:
            raise DeletionError("HASH_LIMIT_EXCEEDED")
        budget = [MAX_HASH_BYTES]
        for entry in opened:
            item = entry["item"]
            digest = hash_content(entry["held"], leases, budget)
            if identity(item["path"], entry["parent"], os.fstat(entry["held"])) != item or identity(item["path"], entry["parent"]) != item:
                raise DeletionError("CANDIDATE_CHANGED")
            item["sha256"] = digest
        return {"mode": "preview", "items": [entry["item"] for entry in opened]}
    finally:
        leases.close()
        for entry in opened:
            if entry["held"] is not None:
                os.close(entry["held"])
            os.close(entry["parent"])


def run(request):
    if not isinstance(request, dict):
        raise DeletionError("INVALID_REQUEST")
    mode = request.get("mode")
    if mode == "preview":
        return preview(request.get("paths"))
    if mode != "execute" or not isinstance(request.get("items"), list):
        raise ValueError("invalid operation")
    items = request["items"]
    paths_checked([item.get("path") for item in items])
    opened, deleted, retained = [], [], []
    leases = ReadLeases()
    def capture_matches(entry):
        verify_quarantine(entry)
        actual = identity(entry["item"]["path"], entry["parent"],
                          os.stat("candidate", dir_fd=entry["quarantine_fd"], follow_symlinks=False))
        # rename legitimately changes ctime. The original inode is held open,
        # preventing reuse; compare its identity plus every other frozen field.
        return actual["identity"][:-1] == entry["item"]["identity"][:-1]
    try:
        leases.start()
        # No write if any candidate changed before execution.
        for item in items:
            digest = item.get("sha256")
            if not isinstance(digest, str) or len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
                raise ValueError("frozen SHA-256 required; preview and confirm again")
            fd = open_parent(item["path"])
            entry = {"item": item, "parent": fd, "held": None, "quarantine_fd": None,
                     "quarantine_name": None, "captured": False}
            opened.append(entry)
            entry["held"] = os.open(item["path"].rsplit("/", 1)[1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            leases.acquire(entry["held"])
            if identity(item["path"], fd, os.fstat(entry["held"])) != metadata(item):
                raise DeletionError("CANDIDATE_CHANGED")
        if len(set((e["item"]["identity"][2], e["item"]["identity"][3]) for e in opened)) != len(opened):
            raise ValueError("multiple candidate paths name the same inode")
        if sum(entry["item"]["size"] for entry in opened) * 2 > MAX_HASH_BYTES:
            raise DeletionError("HASH_LIMIT_EXCEEDED")
        budget = [MAX_HASH_BYTES]
        for entry in opened:
            if hash_content(entry["held"], leases, budget) != entry["item"]["sha256"]:
                raise DeletionError("CANDIDATE_CHANGED")
        for entry in opened:
            leases.check()
            item, fd = entry["item"], entry["parent"]
            if identity(item["path"], fd) != metadata(item) or identity(item["path"], fd, os.fstat(entry["held"])) != metadata(item):
                raise DeletionError("CANDIDATE_CHANGED")
            qname = ".opsark-delete-" + uuid.uuid4().hex
            with leases.mutation():
                os.mkdir(qname, 0o700, dir_fd=fd)
                entry["quarantine_name"] = qname
                created = os.stat(qname, dir_fd=fd, follow_symlinks=False)
                entry["quarantine_identity"] = (created.st_dev, created.st_ino)
                entry["quarantine_fd"] = os.open(qname, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            verify_quarantine(entry)
            entry["quarantine_path"] = item["path"].rsplit("/", 1)[0] + "/" + qname + "/candidate"
            # Flush a recovery location before the first move, including when
            # the process is killed before it can return its final receipt.
            print("OPSARK_DELETE_CAPTURE " + json.dumps({"original": item["path"],
                  "quarantine": entry["quarantine_path"]}, ensure_ascii=True), file=sys.stderr, flush=True)
            with leases.mutation():
                verify_quarantine(entry)
                os.rename(item["path"].rsplit("/", 1)[1], "candidate", src_dir_fd=fd, dst_dir_fd=entry["quarantine_fd"])
                entry["captured"] = True
            if not capture_matches(entry):
                raise DeletionError("CANDIDATE_CHANGED")
            if hash_content(entry["held"], leases, budget) != item["sha256"]:
                raise DeletionError("CANDIDATE_CHANGED")
        # Public path replacement cannot change the object now owned by this
        # private directory. Never unlink a public candidate name.
        for entry in opened:
            leases.check()
            if not capture_matches(entry):
                raise DeletionError("CANDIDATE_CHANGED")
            with leases.mutation():
                verify_quarantine(entry)
                os.unlink("candidate", dir_fd=entry["quarantine_fd"])
                entry["captured"] = False
                item = entry["item"]
                deleted.append(item["path"])
        return {"mode": mode, "deleted": deleted}
    except Exception as error:
        # Keep leases while restoring names. Further SIGIO notifications must
        # not interrupt restoration or cause another content deletion.
        leases.cleaning_up = True
        for entry in reversed(opened):
            if not entry["captured"]:
                continue
            try:
                verify_quarantine(entry, check_name=False)
                # link is an atomic no-replace operation. It cannot overwrite
                # a new public entry; symlinks are restored without following.
                os.link("candidate", entry["item"]["path"].rsplit("/", 1)[1], src_dir_fd=entry["quarantine_fd"],
                        dst_dir_fd=entry["parent"], follow_symlinks=False)
                os.unlink("candidate", dir_fd=entry["quarantine_fd"])
                entry["captured"] = False
            except Exception:
                retained.append({"original": entry["item"]["path"], "quarantine": entry["quarantine_path"]})
        print(json.dumps({"mode": mode, "deleted": deleted, "retained": retained, "complete": False,
                          "reason": safe_error(error)}, ensure_ascii=True), flush=True)
        raise
    finally:
        leases.close()
        for entry in opened:
            if entry["quarantine_name"] and not entry["captured"] and entry["quarantine_fd"] is not None:
                # Only our still-named private inode, only if empty. Never
                # remove a replacement directory placed at its public name.
                try:
                    verify_quarantine(entry)
                    os.rmdir(entry["quarantine_name"], dir_fd=entry["parent"])
                except (OSError, ValueError):
                    pass
            for key in ("held", "quarantine_fd"):
                if entry[key] is not None:
                    os.close(entry[key])
            os.close(entry["parent"])


if __name__ == "__main__":
    try:
        if sys.version_info < (3, 6):
            raise DeletionError("UNSUPPORTED_ENVIRONMENT")
        print(json.dumps(run(json.loads(sys.argv[1])), ensure_ascii=True))
    except Exception as error:
        # No arbitrary file contents or credentials are included.
        print("OPSARK_DELETE_ERROR " + json.dumps(safe_error(error), ensure_ascii=True), file=sys.stderr, flush=True)
        print("EXACT_FILE_DELETION_FAILED: " + type(error).__name__, file=sys.stderr)
        sys.exit(1)
