"""Fixed single-GET delivery observation. Python 3.8+, POSIX, no commands/writes.

URL authority controls Host/SNI/certificate checks; an optional IP only selects
the socket destination. No proxy, redirect, HTTP retry, credentials or TLS bypass.
JSONL correlation is a finite observation of an explicitly declared local file,
not authentication of that file's backend origin.
"""
import datetime
import hashlib
import http.client
import ipaddress
import json
import os
import re
import signal
import socket
import ssl
import stat
import sys
import time
import urllib.parse

LIMITATIONS = ["single_get_no_redirect_or_retry", "observer_host_only", "content_encoded_entity_bytes",
               "same_host_declared_log_only", "log_source_not_authenticated", "non_atomic_log_window", "finite_window_not_permanent_absence"]
MAX_OUTPUT = 262144
MARKER = "OPSARK_HTTP_DELIVERY "


class Stop(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha(value):
    return hashlib.sha256(value).hexdigest()


def check(deadline):
    left = deadline - time.monotonic()
    if left <= 0:
        raise Stop("timeout")
    return left


def clean_target(value):
    if not isinstance(value, str) or not value.startswith("/") or value.startswith("//") or len(value) > 4096 or re.search(r"[^\x21-\x7e]|[\\#]", value) or re.search(r"%(?![0-9a-fA-F]{2})", value):
        raise ValueError("invalid_request_target")


def target_for(request, binding):
    url = request["url"]
    if not isinstance(url, str) or len(url) > 4096 or re.search(r"[^\x21-\x7e]|[\\#]", url) or re.search(r"%(?![0-9a-fA-F]{2})", url):
        raise ValueError("invalid_url")
    match = re.fullmatch(r"(https?)://([^/?#]+)(.*)", url)
    if not match or "@" in match[2] or "%" in match[2]:
        raise ValueError("invalid_authority")
    parsed = urllib.parse.urlsplit(url)
    hostname = parsed.hostname
    if not hostname or len(hostname) > 255:
        raise ValueError("invalid_hostname")
    if ":" in hostname:
        ipaddress.IPv6Address(hostname)
        authority_host = "[" + hostname.lower() + "]"
    else:
        if not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", hostname) or any(not part or len(part) > 63 or part.startswith("-") or part.endswith("-") for part in hostname.split(".")):
            raise ValueError("invalid_hostname")
        if re.fullmatch(r"[0-9.]+", hostname):
            ipaddress.IPv4Address(hostname)
        authority_host = hostname.lower()
    explicit = match[2][len(authority_host):]
    if explicit and not re.fullmatch(r":[1-9][0-9]{0,4}", explicit):
        raise ValueError("invalid_port")
    port = int(explicit[1:]) if explicit else (443 if match[1] == "https" else 80)
    if port > 65535:
        raise ValueError("invalid_port")
    destination = request.get("connectAddress", hostname)
    if "connectAddress" in request:
        ipaddress.ip_address(destination)
    target = match[3] or "/"
    if target.startswith("?"):
        target = "/" + target
    clean_target(target)
    spec = request.get("backendObservation")
    if spec:
        clean_target(spec["expectedRequestTarget"])
        for key in ["probeIdPointer", "requestTargetPointer"] + (["authorityPointer"] if "authorityPointer" in spec else []):
            pointer_parts(spec[key])
        if ("authorityPointer" in spec) != ("expectedAuthority" in spec):
            raise ValueError("invalid_authority_mapping")
        if not 50 <= spec["windowMs"] <= 10000 or not 1024 <= spec["maxLogBytes"] <= 1048576:
            raise ValueError("invalid_log_limits")
        field = spec["injection"]
        if field["kind"] == "query":
            if not re.fullmatch(r"[A-Za-z][A-Za-z0-9_.-]{0,63}", field["name"]):
                raise ValueError("invalid_query_field")
            target = injected_target(target, field["name"], binding["probeId"])
            injected_target(spec["expectedRequestTarget"], field["name"], binding["probeId"])
        elif field["kind"] != "header" or field["name"].lower() not in ["x-request-id", "x-correlation-id", "x-opsark-probe-id"]:
            raise ValueError("unsupported_probe_header")
    return dict(scheme=match[1], hostname=hostname.lower(), authority=authority_host + explicit, port=port,
                connectAddress=destination, requestTarget=target, method="GET", tlsVerified=False)


def injected_target(target, field, probe_id):
    query = target.partition("?")[2]
    if any(urllib.parse.unquote_plus(part.partition("=")[0]) == field for part in query.split("&")):
        raise ValueError("probe_parameter_already_present")
    return target + ("&" if "?" in target else "?") + field + "=" + probe_id


def pointer_parts(pointer):
    if not isinstance(pointer, str) or not pointer.startswith("/") or len(pointer) > 256 or re.search(r"[\x00-\x1f\x7f]|~(?![01])", pointer):
        raise ValueError("invalid_pointer")
    parts = pointer[1:].split("/")
    if len(parts) > 8:
        raise ValueError("pointer_depth")
    return [part.replace("~1", "/").replace("~0", "~") for part in parts]


def pointer_get(value, pointer):
    for part in pointer_parts(pointer):
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and re.fullmatch(r"0|[1-9][0-9]*", part) and int(part) < len(value):
            value = value[int(part)]
        else:
            raise ValueError("mapping_unavailable")
    return value


def duplicate_keys(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("duplicate_json_key")
        value[key] = item
    return value


def exact_open(path):
    parts = path.split("/")[1:]
    if not path.startswith("/") or not parts or any(part in ["", ".", ".."] for part in parts):
        raise ValueError("invalid_log_path")
    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for part in parts[:-1]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)
            os.close(parent)
            parent = child
        descriptor = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            os.close(descriptor)
            raise ValueError("log_not_regular")
        return descriptor
    finally:
        os.close(parent)


def pread(descriptor, size, offset, deadline):
    blocks = []
    while size:
        check(deadline)
        block = os.pread(descriptor, min(size, 65536), offset)
        if not block:
            break
        blocks.append(block)
        offset += len(block)
        size -= len(block)
    return b"".join(blocks)


def initial_correlation(spec, binding):
    expected = spec["expectedRequestTarget"]
    if spec["injection"]["kind"] == "query":
        expected = injected_target(expected, spec["injection"]["name"], binding["probeId"])
    return dict(status="unknown", reason="not_observed_yet", sourceVerified=False, path=spec["path"], expectedRequestTarget=expected,
                probeId=binding["probeId"], windowMs=spec["windowMs"], observedMs=0, coverageComplete=False,
                matchedCount=0, parsedRecords=0, readBytes=0, matchedOffsets=[], consistency="inode_offset_and_bytes_rechecked")


def prepare_log(spec, result, deadline):
    descriptor = exact_open(spec["path"])
    try:
        info = os.fstat(descriptor)
        result.update(device=str(info.st_dev), inode=str(info.st_ino), startOffset=info.st_size, endOffset=info.st_size)
        anchor_at = max(0, info.st_size - 4096)
        anchor = pread(descriptor, info.st_size - anchor_at, anchor_at, deadline)
        if len(anchor) != info.st_size - anchor_at or anchor and not anchor.endswith(b"\n"):
            raise ValueError("baseline_partial_line")
        return descriptor, info, anchor_at, anchor
    except BaseException:
        os.close(descriptor)
        raise


def observe_log(spec, result, baseline, deadline):
    descriptor, original, anchor_at, anchor = baseline
    started = time.monotonic()
    end = started + spec["windowMs"] / 1000.0
    content = b""
    try:
        while True:
            check(deadline)
            current_fd = exact_open(spec["path"])
            try:
                current = os.fstat(current_fd)
            finally:
                os.close(current_fd)
            if (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
                raise ValueError("log_rotated")
            if current.st_size < original.st_size + len(content):
                raise ValueError("log_truncated")
            available = current.st_size - original.st_size
            if available > spec["maxLogBytes"]:
                raise ValueError("log_byte_limit")
            content = pread(descriptor, available, original.st_size, deadline)
            result.update(endOffset=original.st_size + len(content), readBytes=len(content))
            if len(content) != available:
                raise ValueError("log_changed")
            if time.monotonic() >= end:
                break
            time.sleep(min(0.025, end - time.monotonic(), check(deadline)))
        if pread(descriptor, len(anchor), anchor_at, deadline) != anchor or pread(descriptor, len(content), original.st_size, deadline) != content:
            raise ValueError("log_changed")
        final_fd = exact_open(spec["path"])
        try:
            final = os.fstat(final_fd)
        finally:
            os.close(final_fd)
        if (final.st_dev, final.st_ino) != (original.st_dev, original.st_ino):
            raise ValueError("log_rotated")
        if final.st_size < result["endOffset"]:
            raise ValueError("log_truncated")
        if content and not content.endswith(b"\n"):
            raise ValueError("partial_line")
        offset = original.st_size
        for part in content.split(b"\n")[:-1]:
            line = part + b"\n"
            check(deadline)
            if len(line) > 65536:
                raise ValueError("line_limit")
            if result["parsedRecords"] >= 10000:
                raise ValueError("record_limit")
            record = json.loads(line.decode("utf-8", "strict"), object_pairs_hook=duplicate_keys,
                                parse_constant=lambda value: (_ for _ in ()).throw(ValueError("invalid_json_number")))
            if not isinstance(record, dict):
                raise ValueError("invalid_record")
            probe_id = pointer_get(record, spec["probeIdPointer"])
            path = pointer_get(record, spec["requestTargetPointer"])
            if not isinstance(path, str) or not (isinstance(probe_id, str) or isinstance(probe_id, list) and all(isinstance(item, str) for item in probe_id)):
                raise ValueError("mapping_type")
            matching = probe_id == result["probeId"] or probe_id == [result["probeId"]]
            authority = pointer_get(record, spec["authorityPointer"]) if "authorityPointer" in spec else None
            if "authorityPointer" in spec and not isinstance(authority, str):
                raise ValueError("mapping_type")
            if matching:
                if path != result["expectedRequestTarget"] or "authorityPointer" in spec and authority != spec["expectedAuthority"]:
                    raise ValueError("request_mismatch")
                if result["matchedCount"] >= 8:
                    raise ValueError("match_limit")
                result["matchedOffsets"].append(offset)
                result["matchedCount"] += 1
            result["parsedRecords"] += 1
            offset += len(line)
        if result["matchedCount"] > 1:
            raise ValueError("multiple_probe_records")
        result.update(status="matched" if result["matchedCount"] else "not_observed", reason="window_complete", coverageComplete=True)
    finally:
        result["observedMs"] = min(60000, int((time.monotonic() - started) * 1000))


def secure_context():
    # create_default_context can write SSLKEYLOGFILE or load env-selected CAs;
    # this fixed probe neither writes key logs nor lets environment replace trust.
    keys = ["SSLKEYLOGFILE", "SSL_CERT_FILE", "SSL_CERT_DIR"]
    saved = {key: os.environ.pop(key) for key in keys if key in os.environ}
    try:
        return ssl.create_default_context()
    finally:
        os.environ.update(saved)


def request_once(request, binding, target, deadline):
    raw = socket.create_connection((target["connectAddress"], target["port"]), timeout=check(deadline))
    connection = None
    try:
        if target["scheme"] == "https":
            context = secure_context()
            if not context.check_hostname or context.verify_mode != ssl.CERT_REQUIRED:
                raise ValueError("tls_verification_required")
            raw.settimeout(check(deadline))
            raw = context.wrap_socket(raw, server_hostname=target["hostname"])
            target.update(tlsVerified=True, tlsServerName=target["hostname"])
        peer = raw.getpeername()
        target.update(peerAddress=peer[0], peerPort=peer[1])
        connection = http.client.HTTPConnection(target["hostname"], target["port"], timeout=check(deadline))
        connection.sock = raw
        headers = {"Host": target["authority"], "Accept-Encoding": "identity", "Connection": "close", "User-Agent": "Opsark-Delivery-Probe/1"}
        spec = request.get("backendObservation")
        if spec and spec["injection"]["kind"] == "header":
            headers[spec["injection"]["name"]] = binding["probeId"]
        raw.settimeout(check(deadline))
        connection.request("GET", target["requestTarget"], headers=headers)
        raw.settimeout(check(deadline))
        response = connection.getresponse()
        selected = {}
        header_bytes = 0
        framing = {}
        for name, value in response.getheaders():
            name = name.lower()
            header_bytes += len(name) + len(value)
            if header_bytes > 32768:
                raise ValueError("response_header_limit")
            if name in ["content-length", "transfer-encoding"]:
                if name in framing:
                    raise ValueError("ambiguous_response_framing")
                framing[name] = value
            if name in ["content-type", "content-encoding", "content-length"]:
                if name in selected or len(value) > (32 if name == "content-length" else 1024):
                    raise ValueError("response_header_limit")
                selected[name] = value
        if "transfer-encoding" in framing and (framing["transfer-encoding"].lower() != "chunked" or "content-length" in framing):
            raise ValueError("ambiguous_response_framing")
        if "content-length" in framing and not re.fullmatch(r"[0-9]+", framing["content-length"]):
            raise ValueError("ambiguous_response_framing")
        body = dict(mode=request["bodyMode"], readBytes=0, eof=False, complete=request["bodyMode"] == "none", encoding="not_requested")
        result = dict(httpStatus=response.status, headers=selected, body=body, status="complete", reason="status_only" if request["bodyMode"] == "none" else "entity_complete")
        if request["bodyMode"] == "none":
            return result
        chunks = []
        remaining = request["maxBodyBytes"] + 1
        while remaining:
            if response.isclosed():
                body["eof"] = True
                break
            raw.settimeout(check(deadline))
            chunk = response.read(min(16384, remaining))
            if not chunk:
                body["eof"] = True
                break
            chunks.append(chunk)
            remaining -= len(chunk)
            body["readBytes"] += len(chunk)
        content = b"".join(chunks)
        body["encoding"] = "identity" if selected.get("content-encoding", "identity").lower().strip() in ["", "identity"] else "unsupported"
        reason = None
        if body["readBytes"] > request["maxBodyBytes"]:
            reason = "body_limit"
        elif not body["eof"]:
            reason = "body_incomplete"
        elif response.length not in [None, 0]:
            reason = "body_incomplete"
        elif body["encoding"] == "unsupported":
            reason = "content_encoding_unsupported"
        elif request["bodyMode"] == "utf8":
            try:
                body["text"] = content.decode("utf-8", "strict")
            except UnicodeDecodeError:
                body["encoding"] = "invalid_utf8"
                reason = "invalid_utf8"
        if reason:
            result.update(status="partial", reason=reason)
        else:
            body.update(complete=True, sha256=sha(content))
        return result
    finally:
        if connection:
            connection.close()
        raw.close()


def reason_for(error):
    if isinstance(error, Stop):
        return str(error)
    if isinstance(error, ssl.SSLCertVerificationError):
        return "tls_verification_failed"
    if isinstance(error, ssl.SSLError):
        return "tls_error"
    if isinstance(error, (socket.timeout, TimeoutError)):
        return "timeout"
    if isinstance(error, PermissionError):
        return "permission_denied"
    if isinstance(error, FileNotFoundError):
        return "log_missing"
    if isinstance(error, (UnicodeError, json.JSONDecodeError)):
        return "invalid_jsonl"
    if isinstance(error, ValueError) and re.fullmatch(r"[a-z_]+", str(error)):
        return str(error)
    if isinstance(error, http.client.HTTPException):
        return "http_protocol_error"
    return "io_error"


def run(request, binding):
    if set(binding) != {"executionId", "probeId", "requestDigest"} or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", binding["executionId"]) or not re.fullmatch(r"opsark-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}", binding["probeId"]) or binding["requestDigest"] != sha(canonical(request).encode("utf-8")):
        raise ValueError("binding_mismatch")
    if not 1 <= request["timeoutSeconds"] <= 60 or not 1 <= request["maxBodyBytes"] <= 131072 or request["bodyMode"] not in ["none", "sha256", "utf8"]:
        raise ValueError("invalid_limits")
    target = target_for(request, binding)
    started = time.monotonic()
    deadline = started + request["timeoutSeconds"]
    result = dict(request=request, binding=binding, target=target, response=None, correlation=None, status="error", coverageComplete=False,
                  sampledAt=now(), finishedAt=None, elapsedMs=0, reason="not_completed", limitations=LIMITATIONS)
    baseline = None
    spec = request.get("backendObservation")
    if spec:
        result["correlation"] = initial_correlation(spec, binding)
    previous = {}
    try:
        # Production enters on the dedicated process main thread; alarm also
        # bounds DNS resolution and reads, independently of socket timeouts.
        for number, reason in [(signal.SIGALRM, "timeout"), (signal.SIGTERM, "cancelled"), (signal.SIGINT, "cancelled")]:
            previous[number] = signal.signal(number, lambda _a, _b, reason=reason: (_ for _ in ()).throw(Stop(reason)))
        signal.setitimer(signal.ITIMER_REAL, request["timeoutSeconds"])
        if spec:
            try:
                baseline = prepare_log(spec, result["correlation"], deadline)
            except Stop:
                raise
            except Exception as error:
                result["correlation"]["reason"] = reason_for(error)
        result["response"] = request_once(request, binding, target, deadline)
        if baseline:
            try:
                observe_log(spec, result["correlation"], baseline, deadline)
            except Stop:
                raise
            except Exception as error:
                result["correlation"].update(status="unknown", coverageComplete=False, reason=reason_for(error))
        complete = result["response"]["status"] == "complete" and (not spec or result["correlation"]["coverageComplete"])
        result.update(status="complete" if complete else "partial", coverageComplete=complete,
                      reason="requested_scope_complete" if complete else result["correlation"]["reason"] if spec and not result["correlation"]["coverageComplete"] else result["response"]["reason"])
    except Exception as error:
        reason = reason_for(error)
        result.update(status=reason if reason in ["timeout", "cancelled"] else "error", reason=reason)
        if result["correlation"]:
            result["correlation"].update(status="unknown", coverageComplete=False, reason=reason)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for number, handler in previous.items():
            signal.signal(number, handler)
        if baseline:
            os.close(baseline[0])
        result.update(finishedAt=now(), elapsedMs=min(60001, int((time.monotonic() - started) * 1000)))
    return result


def serialize(result):
    wire = MARKER + json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    if len(wire.encode("utf-8")) + 1 > MAX_OUTPUT:
        result.update(status="partial", coverageComplete=False, reason="output_limit")
        if result.get("response"):
            result["response"].update(status="partial", reason="output_limit")
            result["response"]["body"].pop("text", None)
            result["response"]["body"].pop("sha256", None)
            result["response"]["body"]["complete"] = False
        wire = MARKER + json.dumps(result, ensure_ascii=False, separators=(",", ":"))
    if len(wire.encode("utf-8")) + 1 > MAX_OUTPUT:
        raise ValueError("output_limit")
    return wire


if __name__ == "__main__":
    payload = json.loads(sys.argv[1], object_pairs_hook=duplicate_keys)
    print(serialize(run(payload["request"], payload["binding"])), flush=True)
