"""Bundled read-only probe, sent over the existing managed SSH executor.

Python 3.8+ / POSIX. No shell evaluation, installation, elevation or remote files.
The controller validates input first; the script is not a public command API.
"""
import datetime
import heapq
import json
import os
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

    def command(args, kind, subject):
        executable = shutil.which(args[0])
        if not executable:
            skip(subject, "unsupported")
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
            result["items"].append(dict(kind=kind, subject=subject,
                                        text=output.decode("utf-8", "replace"), exitCode=code))
            result["matchedEntries"] += 1
            if code != 0:
                # Keep the real exit code; never infer permission/success from a pipeline.
                skip(subject, "error")
                result["status"] = "error"
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
            if output and not any(item.get("subject") == subject for item in result["items"]):
                result["items"].append(dict(kind=kind, subject=subject,
                                            text=output.decode("utf-8", "replace"), exitCode=process.returncode))
                result["matchedEntries"] += 1

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

    if sys.version_info < (3, 8) or not hasattr(os, "O_NOFOLLOW"):
        missing = []
        if sys.version_info < (3, 8):
            missing.append(dict(path="python3>=3.8 (actual %s)" % ".".join(map(str, sys.version_info[:3])), reason="unsupported"))
        if not hasattr(os, "O_NOFOLLOW"):
            missing.append(dict(path="POSIX os.O_NOFOLLOW", reason="unsupported"))
        result.update(status="unsupported", coverageComplete=False, truncated=True,
                      skippedCount=len(missing), skipped=missing,
                      finishedAt=datetime.datetime.now(datetime.timezone.utc).isoformat())
        return result
    previous = {}
    for signum in (signal.SIGALRM, signal.SIGTERM, signal.SIGINT):
        previous[signum] = signal.signal(signum, stop)
    signal.setitimer(signal.ITIMER_REAL, request["timeoutSeconds"])
    try:
        if tool == "files.find_large" or (tool == "disk.inspect" and request["check"] == "directory"):
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
                command(["systemctl", "show", "--no-pager", "--property=Id,LoadState,ActiveState,SubState,MainPID,Result,ExecMainStatus,ActiveEnterTimestamp", "--", service], "service", service)
            elif check == "logs":
                command(["journalctl", "--no-pager", "--quiet", "--unit=" + service, "--lines=" + str(request["logLines"]), "--since=" + str(request["sinceMinutes"]) + " minutes ago", "--output=short-iso"], "logs", service)
            elif check == "ports":
                command(["ss", "-lntup"], "ports", "server:listening")
            elif check == "health":
                url = request["url"]
                opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
                try:
                    response = opener.open(urllib.request.Request(url, method="GET", headers={"User-Agent": "Opsark-readonly-probe/1"}), timeout=max(0.001, deadline - time.monotonic()))
                except urllib.error.HTTPError as error:
                    response = error
                with response:
                    result["items"].append(dict(kind="health", subject=url, httpStatus=response.code))
                    result["matchedEntries"] = 1
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
    except (OSError, ValueError, urllib.error.URLError):
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
    print("OPSARK_RESULT " + json.dumps(run(payload["toolId"], payload["request"]), ensure_ascii=True), flush=True)
