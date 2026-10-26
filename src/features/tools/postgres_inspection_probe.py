"""Bounded PostgreSQL evidence, one connection and one read-only snapshot.

No user SQL is accepted. Raw rows, credentials and PostgreSQL diagnostics are
never written to the public result. Python 3.6+ / POSIX; PostgreSQL 12+.
"""
import hashlib
import ipaddress
import json
import os
import re
import selectors
import signal
import struct
import subprocess
import sys
import tempfile
import time

LIMITATIONS = ["single_database_snapshot", "explicit_ordinary_heap_tables_only", "builtin_scalar_types_only",
               "logical_json_content_not_physical_backup", "no_sequences_triggers_privileges_or_extensions",
               "not_cross_database_atomic", "not_restore_acceptance"]
BUILTIN_TYPES = {"bool", "bytea", "int2", "int4", "int8", "float4", "float8", "numeric", "text", "varchar", "bpchar",
                 "uuid", "date", "time", "timetz", "timestamp", "timestamptz", "interval", "json", "jsonb",
                 "inet", "cidr", "macaddr", "macaddr8", "money", "bit", "varbit", "name"}
MAX_RESULT_BYTES = 262144


class InspectionError(Exception):
    def __init__(self, code, status="error"):
        self.code, self.status = code, status
        super().__init__(code)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def valid_identifier(value):
    return isinstance(value, str) and 0 < len(value.encode("utf-8")) <= 63 and not re.search(r"[\x00-\x1f\x7f\\]", value) and "${secret." not in value


def valid_path(value):
    return isinstance(value, str) and value.startswith("/") and 1 < len(value) <= 4096 and not re.search(r"[\x00-\x1f\x7f\\`$*?\[\]]", value) and not any(part in (".", "..") for part in value.split("/")) and "//" not in value


def validate_request(value):
    if not isinstance(value, dict):
        raise InspectionError("invalid_request")
    request = dict(value)
    allowed = {"clientPath", "transport", "host", "port", "database", "auth", "usernameSecretKey", "passwordSecretKey", "username", "sslRootCertPath", "tables", "timeoutSeconds", "maxRowsPerTable", "maxDataBytes"}
    if set(request) - allowed:
        raise InspectionError("invalid_request")
    for key, default, lower, upper in [("timeoutSeconds", 30, 1, 120), ("maxRowsPerTable", 1000, 1, 10000), ("maxDataBytes", 1048576, 1024, 16777216), ("port", None, 1, 65535)]:
        if default is not None:
            request.setdefault(key, default)
        if type(request.get(key)) is not int or not lower <= request[key] <= upper:
            raise InspectionError("invalid_request")
    if not valid_path(request.get("clientPath")) or not request["clientPath"].endswith("/psql") or not valid_identifier(request.get("database")) or "=" in request["database"] or re.match(r"postgres(?:ql)?:", request["database"], re.I):
        raise InspectionError("invalid_request")
    if request.get("transport") == "socket":
        if not valid_path(request.get("host")) or "sslRootCertPath" in request:
            raise InspectionError("invalid_request")
    elif request.get("transport") == "tcp":
        if not isinstance(request.get("host"), str) or not re.fullmatch(r"[A-Za-z0-9_.:-]+", request["host"]) or request["host"].startswith("-") or not valid_path(request.get("sslRootCertPath")):
            raise InspectionError("invalid_request")
    else:
        raise InspectionError("invalid_request")
    if request.get("auth") == "password":
        if any(not isinstance(request.get(key), str) or not re.fullmatch(r"[A-Z][A-Z0-9_]{0,79}", request[key]) for key in ("usernameSecretKey", "passwordSecretKey")) or request["usernameSecretKey"] == request["passwordSecretKey"] or "username" in request:
            raise InspectionError("invalid_request")
    elif request.get("auth") == "socket_identity":
        if request["transport"] != "socket" or not valid_identifier(request.get("username")) or "usernameSecretKey" in request or "passwordSecretKey" in request:
            raise InspectionError("invalid_request")
    else:
        raise InspectionError("invalid_request")
    tables = request.get("tables")
    if not isinstance(tables, list) or not 1 <= len(tables) <= 8 or any(not isinstance(table, dict) or set(table) != {"schema", "name"} or not all(valid_identifier(table[key]) for key in ("schema", "name")) for table in tables) or len({canonical(table) for table in tables}) != len(tables):
        raise InspectionError("invalid_request")
    return request


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def identifier(value):
    return '"' + value.replace('"', '""') + '"'


def session_environment(request, username, password, private_home):
    # Deliberate allowlist: no inherited PGHOSTADDR/PGSERVICE/PGOPTIONS, loader
    # injection, proxy, psqlrc, pgpass, certificate or key settings.
    env = {"PATH": os.defpath, "HOME": private_home, "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8",
           "PGCLIENTENCODING": "UTF8", "PGAPPNAME": "opsark-readonly-inspection", "PGCONNECT_TIMEOUT": str(request["timeoutSeconds"]),
           "PGPASSFILE": "/dev/null", "PGSERVICEFILE": "/dev/null", "PGSYSCONFDIR": private_home,
           "PGSSLCERT": private_home + "/no-client.crt", "PGSSLKEY": private_home + "/no-client.key",
           "PGSSLCRL": private_home + "/no-root.crl", "PGSSLCRLDIR": private_home,
           "PGGSSENCMODE": "disable", "PGSSLMODE": "verify-full" if request["transport"] == "tcp" else "disable"}
    if request["transport"] == "tcp":
        env["PGSSLROOTCERT"] = request["sslRootCertPath"]
    if request["auth"] == "password":
        env["PGPASSWORD"] = password
    return env


class PsqlSession:
    """Small fixed-query pipe protocol; total bytes and deadline cover every phase."""
    def __init__(self, request, username, password, private_home):
        self.request = request
        self.deadline = time.monotonic() + request["timeoutSeconds"]
        self.read_bytes = 0
        self.sequence = 0
        self.failure_code = "client_or_query_failed"
        self.buffers = {"out": b"", "err": b""}
        self.selector = selectors.DefaultSelector()
        self.process = None
        self.token = os.urandom(16).hex()
        args = [request["clientPath"], "-X", "-w", "-A", "-t", "-q", "-h", request["host"], "-p", str(request["port"]),
                "-U", username, "-d", request["database"], "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-v", "FETCH_COUNT=100", "-P", "pager=off", "-f", "-"]
        try:
            self.process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            env=session_environment(request, username, password, private_home), start_new_session=True)
            for stream, name in [(self.process.stdout, "out"), (self.process.stderr, "err")]:
                os.set_blocking(stream.fileno(), False) if hasattr(os, "set_blocking") else None
                self.selector.register(stream, selectors.EVENT_READ, name)
        except OSError:
            self.close()
            raise InspectionError("client_unavailable", "unsupported")

    def query(self, sql):
        if self.process is None or time.monotonic() >= self.deadline:
            raise InspectionError("deadline_exceeded", "timeout")
        self.sequence += 1
        marker = self.token + ":" + str(self.sequence)
        # All caller SQL is Core-generated. Request identifiers exclude line
        # controls and backslashes, so they cannot become psql metacommands.
        suffix = "SELECT pg_catalog.json_build_object('opsarkEnd', " + literal(marker) + ")::text;\n"
        try:
            self.process.stdin.write((sql + "\n" + suffix).encode("utf-8"))
            self.process.stdin.flush()
        except (OSError, BrokenPipeError):
            raise InspectionError(self.failure_code)
        rows = []
        while True:
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise InspectionError("deadline_exceeded", "timeout")
            events = self.selector.select(min(remaining, 0.25))
            for key, _ in events:
                byte_budget = self.request["maxDataBytes"] - self.read_bytes
                if byte_budget <= 0:
                    raise InspectionError("data_byte_limit", "partial")
                chunk = os.read(key.fileobj.fileno(), min(65536, byte_budget))
                if not chunk:
                    self.selector.unregister(key.fileobj)
                    continue
                self.read_bytes += len(chunk)
                name = key.data
                if name == "err":
                    # SQLSTATE-only diagnostics can still include account/host
                    # values from startup failures. Never return raw text.
                    self.buffers["err"] = (self.buffers["err"] + chunk)[-4096:]
                    state = re.search(rb"(?:ERROR|FATAL):\s+([A-Z0-9]{5})(?:\s|$)", self.buffers["err"])
                    if state:
                        self.failure_code = {b"42501": "permission_denied", b"42P01": "relation_missing", b"57014": "query_cancelled", b"55P03": "lock_timeout",
                                             b"28P01": "authentication_rejected", b"28000": "authentication_rejected", b"3D000": "database_missing"}.get(state.group(1), "client_or_query_failed")
                    continue
                self.buffers[name] += chunk
                while b"\n" in self.buffers[name]:
                    line, self.buffers[name] = self.buffers[name].split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        row = json.loads(line.decode("utf-8"))
                    except (UnicodeError, ValueError):
                        raise InspectionError("invalid_client_receipt")
                    if not isinstance(row, dict):
                        raise InspectionError("invalid_client_receipt")
                    if row == {"opsarkEnd": marker}:
                        if self.buffers[name].strip():
                            raise InspectionError("unexpected_client_receipt")
                        return rows
                    if "opsarkEnd" in row:
                        raise InspectionError("unexpected_client_receipt")
                    rows.append(row)
            if not self.selector.get_map():
                raise InspectionError(self.failure_code)

    def finish(self):
        self.query("ROLLBACK;")
        self.process.stdin.close()
        try:
            code = self.process.wait(timeout=max(0.001, self.deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise InspectionError("deadline_exceeded", "timeout")
        if code != 0:
            raise InspectionError(self.failure_code)

    def close(self):
        if self.process is not None:
            if self.process.poll() is None:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                self.process.wait()
            for stream in (self.process.stdin, self.process.stdout, self.process.stderr):
                if stream:
                    try:
                        stream.close()
                    except OSError:
                        pass
        self.selector.close()


def connection_sql(timeout_seconds, tables):
    locks = "\n".join("LOCK TABLE ONLY " + identifier(table["schema"]) + "." + identifier(table["name"]) + " IN ACCESS SHARE MODE;" for table in tables)
    return """BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path=pg_catalog; SET LOCAL standard_conforming_strings=on;
SET LOCAL statement_timeout=%d; SET LOCAL lock_timeout=%d;
SET LOCAL row_security=off; SET LOCAL TimeZone='UTC'; SET LOCAL DateStyle='ISO,YMD';
SET LOCAL IntervalStyle='iso_8601'; SET LOCAL extra_float_digits=3; SET LOCAL bytea_output='hex';
%s
SELECT pg_catalog.json_build_object('database', current_database(), 'sessionUser', session_user, 'currentUser', current_user,
 'port', current_setting('port')::int, 'serverAddress', pg_catalog.host(inet_server_addr()),
 'tls', COALESCE((SELECT ssl FROM pg_catalog.pg_stat_ssl WHERE pid=pg_backend_pid()), false),
 'serverVersionNum', current_setting('server_version_num')::int, 'readOnly', current_setting('transaction_read_only')='on',
 'isolation', current_setting('transaction_isolation'), 'snapshot', txid_current_snapshot()::text,
 'observedAt', to_char(clock_timestamp(), 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text;""" % (timeout_seconds * 1000, min(timeout_seconds * 1000, 5000), locks)


def verify_connection(rows, request, username):
    if len(rows) != 1:
        raise InspectionError("connection_identity_unknown")
    connection = rows[0]
    if type(connection.get("serverVersionNum")) is not int or connection["serverVersionNum"] < 120000:
        raise InspectionError("postgres_version_unsupported", "unsupported")
    if connection.get("database") != request["database"] or connection.get("sessionUser") != username or connection.get("currentUser") != username or connection.get("port") != request["port"] or connection.get("readOnly") is not True or connection.get("isolation") != "repeatable read" or not connection.get("snapshot") or not connection.get("observedAt"):
        raise InspectionError("connection_identity_mismatch")
    if request["transport"] == "socket":
        if connection.get("serverAddress") is not None or connection.get("tls") is not False:
            raise InspectionError("connection_identity_mismatch")
    else:
        if not connection.get("serverAddress") or connection.get("tls") is not True:
            raise InspectionError("tls_or_endpoint_mismatch")
        try:
            expected_ip = ipaddress.ip_address(request["host"])
        except ValueError:
            expected_ip = None
        try:
            actual_ip = ipaddress.ip_address(connection["serverAddress"])
        except ValueError:
            raise InspectionError("tls_or_endpoint_mismatch")
        if expected_ip is not None and actual_ip != expected_ip:
            raise InspectionError("tls_or_endpoint_mismatch")
    connection.update({"requestedHost": request["host"], "transport": request["transport"]})
    return connection


def relation_sql(table):
    return """SELECT pg_catalog.json_build_object('oid', c.oid::text, 'kind', c.relkind, 'partition', c.relispartition,
 'rowSecurity', c.relrowsecurity OR c.relforcerowsecurity, 'accessMethod', a.amname,
 'inherited', EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid))::text
 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 LEFT JOIN pg_catalog.pg_am a ON a.oid=c.relam WHERE n.nspname=%s AND c.relname=%s;""" % (literal(table["schema"]), literal(table["name"]))


def metadata_sql(table, oid):
    qualified = identifier(table["schema"]) + "." + identifier(table["name"])
    return """LOCK TABLE ONLY %s IN ACCESS SHARE MODE;
SELECT pg_catalog.json_build_object('record','locked', 'oid', pg_catalog.to_regclass(%s)::oid::text,
 'held', EXISTS(SELECT 1 FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND relation=%s::oid AND mode='AccessShareLock' AND granted))::text;
SELECT pg_catalog.json_build_object('record','column', 'name', a.attname, 'type', pg_catalog.format_type(a.atttypid,a.atttypmod),
 'typeNamespace',tn.nspname,'typeName',t.typname,'typeKind',t.typtype,
 'nullable',NOT a.attnotnull,'default',pg_catalog.pg_get_expr(d.adbin,d.adrelid), 'identity',a.attidentity,'generated',a.attgenerated,
 'collation',CASE WHEN a.attcollation=0 THEN NULL ELSE cn.nspname || '.' || co.collname END)::text
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace
 LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
 LEFT JOIN pg_catalog.pg_collation co ON co.oid=a.attcollation LEFT JOIN pg_catalog.pg_namespace cn ON cn.oid=co.collnamespace
 WHERE a.attrelid=%s::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 257;
SELECT pg_catalog.json_build_object('record','constraint','name',conname,'type',contype,
 'definition',pg_catalog.pg_get_constraintdef(oid,false),'validated',convalidated,'deferrable',condeferrable,'initiallyDeferred',condeferred)::text
 FROM pg_catalog.pg_constraint WHERE conrelid=%s::oid ORDER BY conname COLLATE "C" LIMIT 257;
SELECT pg_catalog.json_build_object('record','index','name',c.relname,'definition',pg_catalog.pg_get_indexdef(i.indexrelid),
 'unique',i.indisunique,'primary',i.indisprimary,'valid',i.indisvalid,'ready',i.indisready)::text
 FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indexrelid WHERE i.indrelid=%s::oid ORDER BY c.relname COLLATE "C" LIMIT 257;""" % (qualified, literal(qualified), oid, oid, oid, oid)


def type_safety_sql(oid):
    # Inspect dependency identifiers before invoking deparsers: a constant of a
    # custom type inside a default/index expression can have an opaque output
    # function even when the table's visible columns are built-in scalars.
    return """SELECT pg_catalog.json_build_object('record','type','namespace',n.nspname,'name',t.typname,'kind',t.typtype)::text
 FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
 WHERE a.attrelid=%s::oid AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum LIMIT 257;
SELECT pg_catalog.json_build_object('record','definitionSafety','safe',NOT EXISTS(
 SELECT 1 FROM pg_catalog.pg_depend d WHERE (
 (d.classid='pg_catalog.pg_attrdef'::regclass AND d.objid IN (SELECT oid FROM pg_catalog.pg_attrdef WHERE adrelid=%s::oid)) OR
 (d.classid='pg_catalog.pg_constraint'::regclass AND d.objid IN (SELECT oid FROM pg_catalog.pg_constraint WHERE conrelid=%s::oid)) OR
 (d.classid='pg_catalog.pg_class'::regclass AND d.objid IN (SELECT indexrelid FROM pg_catalog.pg_index WHERE indrelid=%s::oid))) AND (
 (d.refclassid='pg_catalog.pg_type'::regclass AND EXISTS(SELECT 1 FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE t.oid=d.refobjid AND n.nspname<>'pg_catalog')) OR
 (d.refclassid='pg_catalog.pg_proc'::regclass AND EXISTS(SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE p.oid=d.refobjid AND n.nspname<>'pg_catalog'))
 )))::text;""" % (oid, oid, oid, oid)


def data_sql(table, max_rows):
    qualified = identifier(table["schema"]) + "." + identifier(table["name"])
    # PostgreSQL row JSON text, bytewise ordering and fixed session output
    # settings. Keep duplicate rows; each row is separately length-prefixed by
    # the Python hasher. A per-row cap prevents huge values entering stdout.
    return """SELECT pg_catalog.json_build_object('record','row','bytes',pg_catalog.octet_length(s.payload),
 'payload',CASE WHEN pg_catalog.octet_length(s.payload)<=65536 THEN s.payload ELSE NULL END)::text
 FROM (SELECT pg_catalog.row_to_json(t)::text AS payload FROM ONLY %s t) s
 ORDER BY s.payload COLLATE "C" LIMIT %d;""" % (qualified, max_rows + 1)


def empty_table(table):
    return dict(table, status="unknown", reason="not_observed", rowCount=None, dataSha256=None, dataBytes=0,
                columns=[], constraints=[], indexes=[], structureSha256=None)


def inspect_table(session, table):
    result = empty_table(table)
    relations = session.query(relation_sql(table))
    if not relations:
        result.update(status="missing", reason="table_missing")
        return result
    if len(relations) != 1:
        raise InspectionError("relation_identity_unknown")
    relation = relations[0]
    oid = relation.get("oid")
    if not isinstance(oid, str) or not re.fullmatch(r"[0-9]+", oid):
        raise InspectionError("relation_identity_unknown")
    if relation.get("kind") != "r" or relation.get("partition") is not False or relation.get("rowSecurity") is not False or relation.get("inherited") is not False or relation.get("accessMethod") != "heap":
        result.update(status="unsupported", reason="relation_kind_or_row_security_unsupported")
        return result
    safety = session.query(type_safety_sql(oid))
    types = [row for row in safety if row.get("record") == "type"]
    definitions = [row for row in safety if row.get("record") == "definitionSafety"]
    if not types or len(types) > 256 or len(safety) != len(types) + 1 or definitions != [{"record": "definitionSafety", "safe": True}] or any(row.get("namespace") != "pg_catalog" or row.get("kind") != "b" or row.get("name") not in BUILTIN_TYPES for row in types):
        result.update(status="unsupported", reason="column_type_or_expression_unsupported")
        return result
    metadata = session.query(metadata_sql(table, oid))
    if not metadata or metadata[0] != {"record": "locked", "oid": oid, "held": True}:
        raise InspectionError("relation_changed")
    groups = {"column": [], "constraint": [], "index": []}
    for row in metadata[1:]:
        kind = row.pop("record", None)
        if kind not in groups:
            raise InspectionError("invalid_metadata_receipt")
        groups[kind].append(row)
    if not groups["column"] or any(len(group) > 256 for group in groups.values()):
        result.update(status="partial", reason="metadata_limit_or_empty_columns")
        return result
    if any(row.get("typeNamespace") != "pg_catalog" or row.get("typeKind") != "b" or row.get("typeName") not in BUILTIN_TYPES for row in groups["column"]):
        result.update(status="unsupported", reason="column_type_unsupported")
        return result
    for row in groups["column"]:
        for key in ("typeNamespace", "typeName", "typeKind"):
            row.pop(key)
    result.update(columns=groups["column"], constraints=groups["constraint"], indexes=groups["index"])
    rows = session.query(data_sql(table, session.request["maxRowsPerTable"]))
    if len(rows) > session.request["maxRowsPerTable"]:
        result.update(status="partial", reason="row_limit")
        return result
    digest = hashlib.sha256()
    prior = None
    total = 0
    for row in rows:
        if row.get("record") != "row" or type(row.get("bytes")) is not int or row["bytes"] < 0:
            raise InspectionError("invalid_data_receipt")
        if row["bytes"] > 65536:
            result.update(status="partial", reason="row_byte_limit")
            return result
        if not isinstance(row.get("payload"), str):
            raise InspectionError("invalid_data_receipt")
        payload = row["payload"].encode("utf-8")
        if len(payload) != row["bytes"] or (prior is not None and payload < prior):
            raise InspectionError("invalid_data_receipt")
        try:
            if not isinstance(json.loads(row["payload"]), dict):
                raise ValueError()
        except ValueError:
            raise InspectionError("invalid_data_receipt")
        digest.update(struct.pack(">Q", len(payload)))
        digest.update(payload)
        total += len(payload)
        prior = payload
    structure = {key: result[key] for key in ("columns", "constraints", "indexes")}
    result.update(status="complete", reason="", rowCount=len(rows), dataBytes=total, dataSha256=digest.hexdigest(),
                  structureSha256=hashlib.sha256(canonical(structure).encode("utf-8")).hexdigest())
    return result


def inspect(value, username, password="", session_factory=PsqlSession):
    request = validate_request(value)
    if not isinstance(username, str) or not username or len(username.encode("utf-8")) > 63 or re.search(r"[\x00-\x1f\x7f]", username) or not isinstance(password, str) or "\x00" in password or (request["auth"] == "password" and not password) or (request["auth"] == "socket_identity" and (username != request["username"] or password)):
        raise InspectionError("private_credentials_invalid")
    started = time.monotonic()
    result = {"version": 1, "request": request, "status": "error", "reason": "not_observed", "coverageComplete": False, "truncated": True,
              "connectionVerified": False, "connection": None, "tables": [], "snapshotScope": "single_database", "limitations": list(LIMITATIONS), "readBytes": 0, "elapsedMs": 0}
    session = None
    try:
        with tempfile.TemporaryDirectory(prefix="opsark-postgres-") as private_home:
            os.chmod(private_home, 0o700)
            try:
                session = session_factory(request, username, password, private_home)
                result["connection"] = verify_connection(session.query(connection_sql(request["timeoutSeconds"], request["tables"])), request, username)
                result["connectionVerified"] = True
                for table in request["tables"]:
                    result["tables"].append(inspect_table(session, table))
                session.finish()
                complete = all(table["status"] == "complete" for table in result["tables"])
                result.update(status="complete" if complete else "partial", reason="" if complete else "table_evidence_incomplete", coverageComplete=complete, truncated=not complete)
            finally:
                if session is not None:
                    result["readBytes"] = session.read_bytes
                    session.close()
    except InspectionError as error:
        result.update(status=error.status, reason=error.code)
    except (OSError, ValueError, TypeError, KeyError):
        result.update(status="error", reason="inspection_failed")
    result["elapsedMs"] = max(0, int((time.monotonic() - started) * 1000))
    if len(("OPSARK_POSTGRES_RESULT " + canonical(result)).encode("utf-8")) > MAX_RESULT_BYTES:
        result.update(status="partial", reason="result_byte_limit", coverageComplete=False, truncated=True, tables=[])
    return result


def main():
    try:
        if len(sys.argv) != 4:
            raise InspectionError("invalid_request")
        result = inspect(json.loads(sys.argv[1]), sys.argv[2], sys.argv[3])
        print("OPSARK_POSTGRES_RESULT " + canonical(result))
    except (InspectionError, ValueError, OSError, TypeError):
        # Invalid invocation cannot echo an unvalidated request or private args.
        print("OPSARK_POSTGRES_ERROR invalid_request", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
