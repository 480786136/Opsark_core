"""Fixed Linux/systemd read-only observation. Never executes user commands.

Only declared entry bytes are hashed. Process argv is used privately to project
an entry binding; neither argv nor environment is returned. Hash != loaded code.
"""
import datetime
import errno
import hashlib
import ipaddress
import json
import os
import re
import selectors
import shutil
import signal
import socket
import stat
import struct
import subprocess
import sys
import time

LIMITATIONS = ["sampled_non_atomic", "single_local_systemd_manager", "single_unambiguous_tcp_listener",
              "declared_entry_disk_hash_not_loaded_code", "process_argv_binding_not_memory_attestation",
              "no_business_http_probe", "inventory_sample_not_continuity_proof"]
UNIT_KEYS = ["Id", "LoadState", "ActiveState", "SubState", "MainPID", "ExecMainStartTimestampMonotonic", "InvocationID"]
RUNTIME_KEYS = UNIT_KEYS + ["Type", "ControlGroup", "TriggeredBy"]
MAX_PIDS = 8192
MAX_FDS = 65536


class Incomplete(Exception):
    pass


class Deadline(Incomplete):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def read_bytes(path, limit):
    with open(path, "rb", buffering=0) as handle:
        data = handle.read(limit + 1)
    if len(data) > limit:
        raise Incomplete("read_limit")
    return data


def read_text(path, limit=65536):
    return read_bytes(path, limit).decode("utf-8", "strict")


def exact_path(path):
    return isinstance(path, str) and path.startswith("/") and len(path) <= 4096 and not re.search(r"[\x00-\x1f\x7f]", path) and (path == "/" or all(part not in ("", ".", "..") for part in path[1:].split("/")))


def validate_request(value):
    required = {"unit", "listenAddress", "listenPort", "releasePath", "entryPath", "inspectOtherServices", "maxProcesses", "maxServices", "maxEntryBytes", "timeoutSeconds"}
    if not isinstance(value, dict) or set(value) != required:
        raise Incomplete("invalid_request")
    if not re.fullmatch(r"[A-Za-z0-9_.@:-]+\.service", value["unit"]) or len(value["unit"]) > 255:
        raise Incomplete("invalid_unit")
    address = ipaddress.ip_address(value["listenAddress"])
    if address.is_unspecified or address.is_multicast or "%" in value["listenAddress"]:
        raise Incomplete("invalid_address")
    if not exact_path(value["releasePath"]) or value["releasePath"] == "/" or not exact_path(value["entryPath"]):
        raise Incomplete("invalid_path")
    if not value["entryPath"].startswith(value["releasePath"] + "/"):
        raise Incomplete("entry_outside_declared_release")
    for key, bounds in {"listenPort": (1, 65535), "maxProcesses": (1, 128), "maxServices": (1, 512), "maxEntryBytes": (1, 67108864), "timeoutSeconds": (1, 120)}.items():
        if type(value[key]) is not int or not bounds[0] <= value[key] <= bounds[1]:
            raise Incomplete("invalid_limit")
    if type(value["inspectOtherServices"]) is not bool:
        raise Incomplete("invalid_inventory_request")


def file_identity(info):
    return dict(device=str(info.st_dev), inode=str(info.st_ino), mode="%04o" % stat.S_IMODE(info.st_mode), sizeBytes=info.st_size,
                mtimeNs=str(info.st_mtime_ns), ctimeNs=str(info.st_ctime_ns))


def path_chain(path):
    """Bounded explicit symlink chain; callers compare two complete samples.

    Open final entry O_NOFOLLOW, then compare descriptor identity to this chain.
    Intermediate rename races are detected by re-resolving the entire chain.
    """
    remaining = path.split("/")[1:]
    current, chain, links = "/", [], 0
    root = os.lstat("/")
    chain.append(dict(path="/", kind="directory", identity=file_identity(root), linkTarget=None))
    while remaining:
        if len(chain) >= 256:
            raise Incomplete("path_chain_limit")
        part = remaining.pop(0)
        current = os.path.join(current, part)
        info = os.lstat(current)
        target = os.readlink(current) if stat.S_ISLNK(info.st_mode) else None
        kind = "symlink" if target is not None else "directory" if stat.S_ISDIR(info.st_mode) else "file" if stat.S_ISREG(info.st_mode) else "other"
        if kind == "other":
            raise Incomplete("path_special_file")
        chain.append(dict(path=current, kind=kind, identity=file_identity(info), linkTarget=target))
        if target is not None:
            links += 1
            if links > 16 or re.search(r"[\x00-\x1f\x7f]", target) or len(target) > 4096:
                raise Incomplete("path_link_limit_or_encoding")
            resolved = os.path.normpath(target if target.startswith("/") else os.path.join(os.path.dirname(current), target))
            remaining = resolved.split("/")[1:] + remaining
            current = "/"
        elif remaining and kind != "directory":
            raise Incomplete("path_parent_not_directory")
    return dict(path=path, resolvedPath=current, chain=chain)


def inspect_entry(request):
    release, entry = path_chain(request["releasePath"]), path_chain(request["entryPath"])
    if release["chain"][-1]["kind"] != "directory" or entry["chain"][-1]["kind"] != "file":
        raise Incomplete("release_or_entry_type")
    if not entry["resolvedPath"].startswith(release["resolvedPath"].rstrip("/") + "/"):
        raise Incomplete("resolved_entry_outside_release")
    fd = os.open(entry["resolvedPath"], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        identity = file_identity(info)
        if not stat.S_ISREG(info.st_mode) or info.st_size > request["maxEntryBytes"] or identity != entry["chain"][-1]["identity"]:
            raise Incomplete("entry_limit_or_identity")
        digest, count = hashlib.sha256(), 0
        while True:
            chunk = os.read(fd, min(65536, request["maxEntryBytes"] - count + 1))
            if not chunk:
                break
            count += len(chunk)
            if count > request["maxEntryBytes"]:
                raise Incomplete("entry_read_limit")
            digest.update(chunk)
        if count != info.st_size or file_identity(os.fstat(fd)) != identity:
            raise Incomplete("entry_changed_during_read")
    finally:
        os.close(fd)
    if path_chain(request["releasePath"]) != release or path_chain(request["entryPath"]) != entry:
        raise Incomplete("entry_path_changed")
    return dict(release=release, entry=entry, diskSha256=digest.hexdigest(), identity=identity, stable=True, loadedCodeVerified=False)


def run_systemctl(arguments, timeout, output_limit=262144):
    executable = shutil.which("systemctl")
    if not executable:
        raise Incomplete("systemctl_unavailable")
    environment = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "SYSTEMD_PAGER": "", "SYSTEMD_COLORS": "0"}
    process = subprocess.Popen([executable, "--system", "--no-pager", "--no-ask-password"] + arguments,
                               stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=environment)
    selector, content, total = selectors.DefaultSelector(), {"out": bytearray(), "err": bytearray()}, 0
    try:
        selector.register(process.stdout, selectors.EVENT_READ, "out")
        selector.register(process.stderr, selectors.EVENT_READ, "err")
        end = time.monotonic() + timeout
        while selector.get_map():
            remaining = end - time.monotonic()
            if remaining <= 0:
                raise Deadline("systemctl_timeout")
            for key, _ in selector.select(min(remaining, 0.1)):
                chunk = os.read(key.fileobj.fileno(), 65536)
                if not chunk:
                    selector.unregister(key.fileobj)
                else:
                    total += len(chunk)
                    if total > output_limit:
                        raise Incomplete("systemctl_output_limit")
                    content[key.data].extend(chunk)
        if process.wait(timeout=max(0.01, end - time.monotonic())) != 0:
            raise Incomplete("systemctl_query_failed")
        return bytes(content["out"]).decode("utf-8", "strict")
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        selector.close()
        process.stdout.close()
        process.stderr.close()


def property_blocks(text):
    blocks = []
    for block in text.strip().split("\n\n"):
        if not block.strip():
            continue
        fields = {}
        for line in block.splitlines():
            key, sep, value = line.partition("=")
            if not sep or key in fields:
                raise Incomplete("systemctl_properties_malformed")
            fields[key] = value
        blocks.append(fields)
    return blocks


def project_service(fields):
    if any(key not in fields for key in UNIT_KEYS):
        raise Incomplete("service_identity_property_missing")
    if not re.fullmatch(r"[0-9]+", fields["MainPID"]) or not re.fullmatch(r"[0-9]+", fields["ExecMainStartTimestampMonotonic"]) or not re.fullmatch(r"(?:[a-f0-9]{32})?", fields["InvocationID"]):
        raise Incomplete("service_identity_property_invalid")
    if not fields["Id"].endswith(".service") or len(fields["Id"]) > 255 or any(not fields[key] or len(fields[key]) > 64 for key in ("LoadState", "ActiveState", "SubState")):
        raise Incomplete("service_identity_property_invalid")
    pid = int(fields["MainPID"])
    if pid > 4194304 or pid > 0 and (fields["ExecMainStartTimestampMonotonic"] == "0" or not fields["InvocationID"]):
        raise Incomplete("service_start_identity_missing")
    return dict(name=fields["Id"], loadState=fields["LoadState"], activeState=fields["ActiveState"], subState=fields["SubState"], mainPid=pid,
                execMainStartTimestampMonotonic=fields["ExecMainStartTimestampMonotonic"], invocationId=fields["InvocationID"])


def read_unit(request):
    blocks = property_blocks(run_systemctl(["show", "--property=" + ",".join(RUNTIME_KEYS), "--", request["unit"]], request["timeoutSeconds"]))
    if len(blocks) != 1:
        raise Incomplete("unit_response_ambiguous")
    fields = blocks[0]
    unit = project_service(fields)
    if any(key not in fields for key in RUNTIME_KEYS):
        raise Incomplete("unit_runtime_property_missing")
    unit.update(serviceType=fields["Type"], controlGroup=fields["ControlGroup"])
    if unit["name"] != request["unit"] or unit["loadState"] != "loaded" or unit["activeState"] != "active" or unit["subState"] != "running" or unit["mainPid"] <= 0:
        raise Incomplete("unit_not_exact_active_running")
    if unit["serviceType"] not in ("simple", "exec") or fields["TriggeredBy"]:
        raise Incomplete("unit_type_or_socket_activation_unsupported")
    if not exact_path(unit["controlGroup"]) or unit["controlGroup"] == "/":
        raise Incomplete("unit_cgroup_invalid")
    return unit


def inventory(request):
    text = run_systemctl(["list-units", "--type=service", "--all", "--plain", "--no-legend", "--full"], request["timeoutSeconds"])
    names = []
    for line in text.splitlines():
        parts = line.split()
        if len(parts) < 4 or not re.fullmatch(r"[A-Za-z0-9_.@:\\-]+\.service", parts[0]):
            raise Incomplete("inventory_list_malformed")
        if parts[1] != "loaded":
            continue
        names.append(parts[0])
        if len(names) > request["maxServices"]:
            raise Incomplete("inventory_service_limit")
    if not names or len(names) != len(set(names)):
        raise Incomplete("inventory_list_empty_or_duplicate")
    rows = [project_service(fields) for fields in property_blocks(run_systemctl(["show", "--property=" + ",".join(UNIT_KEYS), "--"] + sorted(names), request["timeoutSeconds"]))]
    if sorted(row["name"] for row in rows) != sorted(names) or any(row["loadState"] != "loaded" for row in rows):
        raise Incomplete("inventory_identity_or_load_state")
    return sorted(rows, key=lambda row: row["name"])


def local_address(address):
    import fcntl
    requested = ipaddress.ip_address(address)
    found = set()
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as descriptor:
        interfaces = socket.if_nameindex()
        if len(interfaces) > 256:
            raise Incomplete("interface_limit")
        for _, name in interfaces:
            try:
                response = fcntl.ioctl(descriptor.fileno(), 0x8915, struct.pack("256s", name.encode("utf-8")[:15]))
                found.add(ipaddress.ip_address(socket.inet_ntop(socket.AF_INET, response[20:24])))
            except OSError as error:
                if error.errno not in (errno.EADDRNOTAVAIL, errno.ENODEV):
                    raise Incomplete("local_interface_unreadable")
    ipv6 = "/proc/net/if_inet6"
    if os.path.exists(ipv6):
        for line in read_text(ipv6, 65536).splitlines():
            parts = line.split()
            if len(parts) != 6:
                raise Incomplete("local_ipv6_malformed")
            found.add(ipaddress.ip_address(bytes.fromhex(parts[0])))
    if len(found) > 512 or requested not in found:
        raise Incomplete("requested_address_not_local")
    return sorted(str(item) for item in found)


def proc_start(pid):
    text = read_text("/proc/%d/stat" % pid, 8192)
    end = text.rfind(")")
    fields = text[end + 2:].split()
    if end < 1 or len(fields) < 20 or not fields[1].isdigit() or not fields[19].isdigit():
        raise Incomplete("process_stat_invalid")
    return int(fields[1]), fields[19]


def namespaces(pid):
    return tuple(os.readlink("/proc/%s/ns/%s" % (pid, name)) for name in ("net", "mnt", "pid"))


def cgroup_pids(control_group, maximum):
    v2 = os.path.isfile("/sys/fs/cgroup/cgroup.controllers")
    root = "/sys/fs/cgroup" if v2 else "/sys/fs/cgroup/systemd"
    path = root + control_group
    if os.path.realpath(path) != path:
        raise Incomplete("cgroup_path_aliased")
    queue, members, directories = [(path, 0)], set(), 0
    while queue:
        current, depth = queue.pop()
        directories += 1
        if directories > 128 or depth > 16:
            raise Incomplete("cgroup_tree_limit")
        for item in read_text(current + "/cgroup.procs", 131072).splitlines():
            if not item.isdigit():
                raise Incomplete("cgroup_members_malformed")
            members.add(int(item))
            if len(members) > maximum:
                raise Incomplete("cgroup_process_limit")
        with os.scandir(current) as items:
            for item in items:
                if item.is_symlink():
                    raise Incomplete("cgroup_child_link")
                if item.is_dir(follow_symlinks=False):
                    queue.append((item.path, depth + 1))
    return sorted(members)


def process_cgroup(pid, control_group):
    matches = []
    v2 = os.path.isfile("/sys/fs/cgroup/cgroup.controllers")
    for line in read_text("/proc/%d/cgroup" % pid).splitlines():
        parts = line.split(":", 2)
        if len(parts) != 3:
            raise Incomplete("process_cgroup_malformed")
        if v2 and parts[0] == "0" and parts[1] == "" or not v2 and "name=systemd" in parts[1].split(","):
            matches.append(parts[2])
    if len(matches) != 1:
        raise Incomplete("process_cgroup_unresolved")
    return matches[0] == control_group or matches[0].startswith(control_group + "/")


def entry_binding(pid, executable, cwd, entry):
    unknown = dict(kind="unknown", matchedEntryPath=None, complete=False)
    actual = entry["entry"]["resolvedPath"]
    exe_info = os.stat("/proc/%d/exe" % pid)
    if str(exe_info.st_dev) == entry["identity"]["device"] and str(exe_info.st_ino) == entry["identity"]["inode"]:
        return dict(kind="native_executable", matchedEntryPath=actual, complete=True)
    if not re.fullmatch(r"python(?:[0-9]+(?:\.[0-9]+)*)?", os.path.basename(executable)):
        return unknown
    args = [part.decode("utf-8", "strict") for part in read_bytes("/proc/%d/cmdline" % pid, 65536).split(b"\0") if part]
    if not args:
        return unknown

    def module_matches(value):
        match = re.fullmatch(r"([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*):([A-Za-z_]\w*)", value, flags=re.ASCII)
        if not match:
            return False
        candidate = os.path.join(cwd, match.group(1).replace(".", "/") + ".py")
        return os.path.realpath(candidate) == actual

    # Gunicorn's standard setproctitle representation. Only exact fixed module
    # titles are projected; arbitrary expressions/factories remain unknown.
    title = re.fullmatch(r"gunicorn: (?:master|worker) \[([^\[\]]+)\]", args[0]) if len(args) == 1 else None
    if title and module_matches(title.group(1)):
        return dict(kind="gunicorn_module", matchedEntryPath=actual, complete=True)
    offset = 1
    while offset < len(args) and args[offset] in ("-u", "-B", "-s", "-S", "-E", "-I", "-O", "-OO"):
        offset += 1
    if offset < len(args) and args[offset] == "--":
        offset += 1
    if offset >= len(args):
        return unknown
    script = args[offset]
    if not script.startswith("-") and os.path.realpath(os.path.join(cwd, script)) == actual:
        return dict(kind="python_script", matchedEntryPath=actual, complete=True)
    gunicorn = False
    if script == "-m" and offset + 1 < len(args) and args[offset + 1] == "gunicorn":
        offset += 2
        gunicorn = True
    elif os.path.basename(script) == "gunicorn" and not script.startswith("-"):
        offset += 1
        gunicorn = True
    if not gunicorn:
        return unknown
    option_values = {"-b", "--bind", "-w", "--workers", "-k", "--worker-class", "--threads", "-t", "--timeout", "--graceful-timeout", "--keep-alive", "--access-logfile", "--error-logfile", "--log-level", "--worker-tmp-dir", "--max-requests", "--max-requests-jitter", "--chdir"}
    option_flags = {"--preload", "--capture-output", "--enable-stdio-inheritance"}
    modules = []
    while offset < len(args):
        value = args[offset]
        if value in option_values:
            offset += 2
        elif value.split("=", 1)[0] in option_values and "=" in value:
            offset += 1
        elif value in option_flags:
            offset += 1
        elif value.startswith("-"):
            return unknown
        else:
            modules.append(value)
            offset += 1
    if len(modules) == 1 and module_matches(modules[0]):
        return dict(kind="gunicorn_module", matchedEntryPath=actual, complete=True)
    return unknown


def sockets_for(request):
    wanted = ipaddress.ip_address(request["listenAddress"])
    result = []
    for family, path in (("ipv4", "/proc/net/tcp"), ("ipv6", "/proc/net/tcp6")):
        if not os.path.exists(path):
            if family == "ipv6" and wanted.version == 4:
                continue
            raise Incomplete("socket_table_unavailable")
        lines = read_text(path, 2097152).splitlines()
        if not lines or "local_address" not in lines[0]:
            raise Incomplete("socket_table_malformed")
        for line in lines[1:]:
            fields = line.split()
            if len(fields) < 10:
                raise Incomplete("socket_table_malformed")
            if fields[3] != "0A":
                continue
            encoded, port = fields[1].split(":")
            if int(port, 16) != request["listenPort"]:
                continue
            raw = bytes.fromhex(encoded)
            if sys.byteorder == "little":
                raw = b"".join(raw[index:index + 4][::-1] for index in range(0, len(raw), 4))
            address = ipaddress.ip_address(raw)
            # Cross-family wildcard (IPv6 dual stack) cannot be disambiguated
            # from /proc/net alone: retain it, causing unsupported ambiguity.
            if address == wanted or address.is_unspecified and (address.version == wanted.version or address.version == 6):
                result.append(dict(family=family, address=str(address), port=int(port, 16), inode=fields[9], holderPids=[]))
                if len(result) > 128:
                    raise Incomplete("socket_count_limit")
    if len(result) != 1:
        raise Incomplete("socket_missing_or_ambiguous")
    if ipaddress.ip_address(result[0]["address"]).version != wanted.version:
        raise Incomplete("cross_family_listener_unknown")
    return result


def socket_holders(sockets, members):
    inodes = {item["inode"]: item for item in sockets}
    pids = sorted(int(name) for name in os.listdir("/proc") if name.isdigit())
    if len(pids) > MAX_PIDS:
        raise Incomplete("global_process_limit")
    descriptors = 0
    for pid in pids:
        try:
            _, start = proc_start(pid)
            with os.scandir("/proc/%d/fd" % pid) as files:
                for file in files:
                    descriptors += 1
                    if descriptors > MAX_FDS:
                        raise Incomplete("global_fd_limit")
                    try:
                        target = os.readlink(file.path)
                    except FileNotFoundError:
                        # Own descriptor enumeration includes the scandir fd;
                        # concurrent FD closure elsewhere prevents full binding.
                        if pid == os.getpid():
                            continue
                        raise Incomplete("fd_changed_during_scan")
                    match = re.fullmatch(r"socket:\[([0-9]+)\]", target)
                    if match and match.group(1) in inodes:
                        item = inodes[match.group(1)]
                        if pid not in item["holderPids"]:
                            item["holderPids"].append(pid)
            if proc_start(pid)[1] != start:
                raise Incomplete("global_pid_identity_changed")
        except (FileNotFoundError, ProcessLookupError):
            raise Incomplete("global_process_changed_during_scan")
    for item in sockets:
        item["holderPids"].sort()
        if not item["holderPids"] or any(pid not in members for pid in item["holderPids"]):
            raise Incomplete("socket_owner_outside_unit_or_unknown")
    return sockets


def snapshot(request, entry):
    boot = read_text("/proc/sys/kernel/random/boot_id", 64).strip()
    if not re.fullmatch(r"[a-f0-9-]{36}", boot):
        raise Incomplete("boot_identity_invalid")
    manager_ns, collector_ns = namespaces(1), namespaces("self")
    if manager_ns != collector_ns:
        raise Incomplete("collector_manager_namespace_mismatch")
    # hidepid can make global ownership enumeration incomplete without errors.
    mounts = read_text("/proc/self/mountinfo", 262144)
    if re.search(r"(?:[, ])hidepid=(?!0(?:[, ]|$))", mounts):
        raise Incomplete("proc_visibility_restricted")
    local_addresses = local_address(request["listenAddress"])
    unit = read_unit(request)
    members = cgroup_pids(unit["controlGroup"], request["maxProcesses"])
    if unit["mainPid"] not in members:
        raise Incomplete("main_pid_outside_cgroup")
    processes = []
    for pid in members:
        parent, started = proc_start(pid)
        if namespaces(pid) != collector_ns or not process_cgroup(pid, unit["controlGroup"]):
            raise Incomplete("process_namespace_or_cgroup_mismatch")
        executable, cwd = os.readlink("/proc/%d/exe" % pid), os.readlink("/proc/%d/cwd" % pid)
        if not exact_path(executable) or not exact_path(cwd) or executable.endswith(" (deleted)") or cwd.endswith(" (deleted)"):
            raise Incomplete("process_path_deleted_or_invalid")
        binding = entry_binding(pid, executable, cwd, entry)
        if not binding["complete"]:
            raise Incomplete("process_entry_binding_unknown")
        if proc_start(pid) != (parent, started):
            raise Incomplete("process_identity_changed")
        processes.append(dict(bootId=boot, pid=pid, parentPid=parent, startTicks=started, executable=executable, cwd=cwd, entryBinding=binding))
    sockets = socket_holders(sockets_for(request), members)
    if cgroup_pids(unit["controlGroup"], request["maxProcesses"]) != members or read_unit(request) != unit:
        raise Incomplete("unit_members_changed")
    for process in processes:
        if proc_start(process["pid"])[1] != process["startTicks"]:
            raise Incomplete("process_identity_changed")
    return dict(bootId=boot, unit=unit, processes=processes, sockets=sockets, networkNamespace=collector_ns[0], mountNamespace=collector_ns[1], pidNamespace=collector_ns[2], localAddresses=local_addresses, coverageComplete=True)


def blank(request):
    return dict(request=request, status="partial", coverageComplete=False, runtimeBindingComplete=False, unit=None, before=None, after=None, entry=None,
                otherServices=dict(scope="all_loaded_services", status="unknown" if request["inspectOtherServices"] else "not_requested", complete=False, before=[], after=[], stable=False, issues=[]),
                issues=[], sampledAt=None, finishedAt=None, elapsedMs=0, consistency="sampled_non_atomic", limitations=LIMITATIONS)


def safe_reason(error):
    if isinstance(error, Incomplete):
        return str(error)
    if isinstance(error, PermissionError):
        return "permission_denied"
    if isinstance(error, (FileNotFoundError, ProcessLookupError)):
        return "resource_missing_or_changed"
    if isinstance(error, UnicodeError):
        return "invalid_utf8"
    return "observation_failed_" + type(error).__name__


def collect(request):
    validate_request(request)
    request = dict(request)
    result, started = blank(request), time.monotonic()
    result["sampledAt"] = now()

    def expired(_signum, _frame):
        raise Deadline("total_timeout")

    old = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, request["timeoutSeconds"])
    try:
        if not sys.platform.startswith("linux") or not shutil.which("systemctl"):
            result.update(status="unsupported", sampledAt=None)
            result["issues"].append("linux_systemd_unavailable")
            return result
        if request["inspectOtherServices"]:
            try:
                result["otherServices"]["before"] = inventory(request)
            except Deadline:
                raise
            except Exception as error:
                result["otherServices"]["issues"].append(safe_reason(error))
        try:
            first_entry = inspect_entry(request)
            result["entry"] = first_entry
            result["before"] = snapshot(request, first_entry)
            result["unit"] = result["before"]["unit"]
            last_entry = inspect_entry(request)
            result["after"] = snapshot(request, last_entry)
            if first_entry != last_entry:
                result["entry"]["stable"] = False
                raise Incomplete("entry_changed_between_samples")
            if result["before"] != result["after"]:
                raise Incomplete("runtime_changed_between_samples")
            result["runtimeBindingComplete"] = True
        except Deadline:
            raise
        except Exception as error:
            result["issues"].append(safe_reason(error))
        if request["inspectOtherServices"]:
            services = result["otherServices"]
            try:
                services["after"] = inventory(request)
                if services["issues"] or not services["before"] or services["before"] != services["after"]:
                    raise Incomplete("inventory_changed_or_incomplete")
                services.update(status="complete", complete=True, stable=True)
            except Deadline:
                raise
            except Exception as error:
                services["issues"].append(safe_reason(error))
        result["coverageComplete"] = result["runtimeBindingComplete"] and (not request["inspectOtherServices"] or result["otherServices"]["complete"])
        result["status"] = "complete" if result["coverageComplete"] else "partial"
    except Deadline as error:
        result["status"] = "timeout"
        result["coverageComplete"] = False
        result["runtimeBindingComplete"] = False
        result["issues"].append(safe_reason(error))
        if request["inspectOtherServices"] and not result["otherServices"]["complete"]:
            result["otherServices"]["issues"].append("total_timeout")
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)
        result["finishedAt"] = now() if result["sampledAt"] else None
        result["elapsedMs"] = int((time.monotonic() - started) * 1000)
    return result


def main():
    request = json.loads(sys.argv[1])
    result = collect(request)
    encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
    if len(encoded.encode("utf-8")) + 32 > 1048576:
        result = blank(request)
        result.update(sampledAt=now(), finishedAt=now(), issues=["output_limit"])
        encoded = json.dumps(result, ensure_ascii=True, separators=(",", ":"))
    print("OPSARK_APPLICATION_RUNTIME " + encoded)


if __name__ == "__main__":
    main()
