"""B03 local POSIX process fixtures; NOT a real PostgreSQL compatibility test."""
import ast
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
location = Path(__file__).resolve().parents[1] / "src/features/tools/postgres_inspection_probe.py"
spec = importlib.util.spec_from_file_location("postgres_inspection_probe", location)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


def request(**patch):
    value = {"clientPath": "/opt/pg/bin/psql", "transport": "socket", "host": "/run/pg", "port": 15432,
             "database": "orders", "auth": "socket_identity", "username": "reader", "tables": [{"schema": "public", "name": "orders"}]}
    value.update(patch)
    return probe.validate_request(value)


def identity(**patch):
    value = {"database": "orders", "sessionUser": "reader", "currentUser": "reader", "port": 15432, "serverAddress": None,
             "tls": False, "serverVersionNum": 160004, "readOnly": True, "isolation": "repeatable read", "snapshot": "3:3:", "observedAt": "2026-10-12T00:00:00.000Z"}
    value.update(patch)
    return value


def column(**patch):
    value = {"record": "column", "name": "id", "type": "integer", "typeNamespace": "pg_catalog", "typeName": "int4", "typeKind": "b",
             "nullable": False, "default": None, "identity": "", "generated": "", "collation": None}
    value.update(patch)
    return value


def rows(*payloads):
    return [{"record": "row", "bytes": len(value.encode("utf-8")), "payload": value} for value in payloads]


class ControlledSession:
    instances = []
    connection = identity()
    relation = {"oid": "16400", "kind": "r", "partition": False, "rowSecurity": False, "accessMethod": "heap", "inherited": False}
    metadata = [{"record": "locked", "oid": "16400", "held": True}, column(),
                {"record": "constraint", "name": "orders_pkey", "type": "p", "definition": "PRIMARY KEY (id)", "validated": True, "deferrable": False, "initiallyDeferred": False},
                {"record": "index", "name": "orders_pkey", "definition": "CREATE UNIQUE INDEX orders_pkey ON public.orders USING btree (id)", "unique": True, "primary": True, "valid": True, "ready": True}]
    data = rows('{"id":1}', '{"id":2}')
    definition_safe = True

    def __init__(self, req, username, password, home):
        self.request, self.read_bytes, self.queries, self.closed, self.finished = req, 0, [], False, False
        self.instances.append(self)
        self.home = home
        if os.stat(home).st_mode & 0o777 != 0o700:
            raise AssertionError("private HOME not 0700")

    def query(self, sql):
        self.queries.append(sql)
        if "'serverVersionNum'" in sql:
            result = [self.connection]
        elif "'accessMethod'" in sql:
            result = [] if self.relation is None else [self.relation]
        elif "'record','locked'" in sql:
            result = self.metadata
        elif "'record','type'" in sql:
            result = [{"record": "type", "namespace": row["typeNamespace"], "name": row["typeName"], "kind": row["typeKind"]} for row in self.metadata if row.get("record") == "column"] + [{"record": "definitionSafety", "safe": self.definition_safe}]
        elif "'record','row'" in sql:
            result = self.data
        else:
            raise AssertionError("unexpected query")
        self.read_bytes += len(json.dumps(result).encode())
        return copy.deepcopy(result)

    def finish(self):
        self.finished = True

    def close(self):
        self.closed = True


FAKE_CLIENT = r'''#!/usr/bin/python3
import json, os, pathlib, re, sys, time
root=pathlib.Path(__file__).parent
config=json.loads((root/'fixture.json').read_text())
with (root/'calls.jsonl').open('a') as f:
 f.write(json.dumps({'args':sys.argv[1:],'environment':dict(os.environ)})+'\n')
phase=''
for line in sys.stdin:
 phase+=line
 match=re.search(r"'opsarkEnd', '([0-9a-f]+:[0-9]+)'",line)
 if not match: continue
 with (root/'queries.jsonl').open('a') as f: f.write(json.dumps(phase)+'\n')
 if config.get('sleep'): time.sleep(config['sleep'])
 if config.get('failure'):
  print('FATAL private-password-do-not-disclose',file=sys.stderr,flush=True); sys.exit(3)
 if config.get('huge'):
  print('x'*200000,flush=True); time.sleep(5); sys.exit(3)
 if "'serverVersionNum'" in phase: result=[config['identity']]
 elif "'accessMethod'" in phase: result=[config['relation']]
 elif "'record','locked'" in phase: result=config['metadata']
 elif "'record','type'" in phase: result=[{'record':'type','namespace':row['typeNamespace'],'name':row['typeName'],'kind':row['typeKind']} for row in config['metadata'] if row.get('record')=='column']+[{'record':'definitionSafety','safe':True}]
 elif "'record','row'" in phase: result=config['rows']
 elif 'ROLLBACK;' in phase: result=[]
 else: sys.exit(4)
 for row in result: print(json.dumps(row,ensure_ascii=False),flush=True)
 print(json.dumps({'opsarkEnd':match.group(1)}),flush=True)
 phase=''
'''


class PostgresInspectionTests(unittest.TestCase):
    def setUp(self):
        ControlledSession.instances = []

    def test_python36_syntax(self):
        ast.parse(location.read_text(), feature_version=(3, 6))

    def test_one_connection_readonly_snapshot_and_full_content_not_just_count(self):
        result = probe.inspect(request(), "reader", session_factory=ControlledSession)
        self.assertEqual(result["status"], "complete")
        instance = ControlledSession.instances[0]
        self.assertEqual(len(ControlledSession.instances), 1)
        self.assertTrue(instance.closed and instance.finished)
        self.assertFalse(os.path.exists(instance.home))
        begin = instance.queries[0]
        self.assertIn("ISOLATION LEVEL REPEATABLE READ READ ONLY", begin)
        self.assertLess(begin.index("LOCK TABLE ONLY"), begin.index("SELECT pg_catalog.json_build_object"))
        self.assertIn("row_security=off", begin)
        digest = hashlib.sha256()
        for value in (b'{"id":1}', b'{"id":2}'):
            digest.update(struct.pack(">Q", len(value)))
            digest.update(value)
        table = result["tables"][0]
        self.assertEqual(table["dataSha256"], digest.hexdigest())
        self.assertEqual(table["rowCount"], 2)
        self.assertTrue(table["constraints"] and table["indexes"] and table["columns"])
        self.assertNotIn('"id":1', probe.canonical(result))

    def test_equal_row_counts_with_different_values_change_digest(self):
        first = probe.inspect(request(), "reader", session_factory=ControlledSession)
        class Changed(ControlledSession):
            data = rows('{"id":1}', '{"id":3}')
        second = probe.inspect(request(), "reader", session_factory=Changed)
        self.assertEqual(first["tables"][0]["rowCount"], second["tables"][0]["rowCount"])
        self.assertNotEqual(first["tables"][0]["dataSha256"], second["tables"][0]["dataSha256"])

    def test_duplicates_nulls_and_chinese_are_retained_in_content(self):
        class Values(ControlledSession):
            data = rows('{"id":null,"value":"中 文"}', '{"id":null,"value":"中 文"}')
        result = probe.inspect(request(), "reader", session_factory=Values)
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["tables"][0]["rowCount"], 2)
        self.assertEqual(result["tables"][0]["dataBytes"], 2 * len(Values.data[0]["payload"].encode()))

    def test_empty_table_has_real_empty_content_digest(self):
        class Empty(ControlledSession):
            data = []
        result = probe.inspect(request(), "reader", session_factory=Empty)
        self.assertEqual(result["tables"][0]["dataSha256"], hashlib.sha256(b"").hexdigest())
        self.assertEqual(result["tables"][0]["rowCount"], 0)

    def test_metadata_change_changes_structure_digest(self):
        class Changed(ControlledSession):
            metadata = copy.deepcopy(ControlledSession.metadata)
            metadata[1]["nullable"] = True
        first = probe.inspect(request(), "reader", session_factory=ControlledSession)
        second = probe.inspect(request(), "reader", session_factory=Changed)
        self.assertEqual(first["tables"][0]["dataSha256"], second["tables"][0]["dataSha256"])
        self.assertNotEqual(first["tables"][0]["structureSha256"], second["tables"][0]["structureSha256"])

    def test_row_limit_never_publishes_complete_digest(self):
        result = probe.inspect(request(maxRowsPerTable=1), "reader", session_factory=ControlledSession)
        self.assertEqual(result["status"], "partial")
        self.assertIsNone(result["tables"][0]["dataSha256"])
        self.assertIsNone(result["tables"][0]["rowCount"])
        self.assertEqual(result["tables"][0]["reason"], "row_limit")

    def test_oversize_row_is_unknown_not_empty(self):
        class Oversize(ControlledSession):
            data = [{"record": "row", "bytes": 65537, "payload": None}]
        result = probe.inspect(request(), "reader", session_factory=Oversize)
        self.assertEqual(result["tables"][0]["reason"], "row_byte_limit")
        self.assertIsNone(result["tables"][0]["dataSha256"])

    def test_custom_types_are_rejected_before_any_data_query(self):
        class Custom(ControlledSession):
            metadata = [{"record": "locked", "oid": "16400", "held": True}, column(typeNamespace="public", typeName="secret_output")]
        result = probe.inspect(request(), "reader", session_factory=Custom)
        self.assertEqual(result["tables"][0]["reason"], "column_type_or_expression_unsupported")
        self.assertFalse(any("'record','row'" in sql for sql in Custom.instances[-1].queries))
        self.assertFalse(any("pg_get_expr" in sql for sql in Custom.instances[-1].queries))

    def test_custom_definition_dependencies_are_rejected_before_deparsing(self):
        class CustomDefinition(ControlledSession):
            definition_safe = False
        result = probe.inspect(request(), "reader", session_factory=CustomDefinition)
        self.assertEqual(result["tables"][0]["status"], "unsupported")
        self.assertFalse(any("pg_get_expr" in sql for sql in CustomDefinition.instances[-1].queries))

    def test_views_partitions_inheritance_rls_and_foreign_tables_are_not_read(self):
        for patch in ({"kind": "v"}, {"kind": "f"}, {"partition": True}, {"inherited": True}, {"rowSecurity": True}, {"accessMethod": "custom"}):
            with self.subTest(patch=patch):
                class Unsupported(ControlledSession):
                    relation = dict(ControlledSession.relation, **patch)
                result = probe.inspect(request(), "reader", session_factory=Unsupported)
                self.assertEqual(result["tables"][0]["status"], "unsupported")
                self.assertFalse(any("'record','row'" in sql for sql in Unsupported.instances[-1].queries))

    def test_schema_or_lock_identity_change_fails_closed(self):
        class Changed(ControlledSession):
            metadata = [{"record": "locked", "oid": "17000", "held": True}, column()]
        result = probe.inspect(request(), "reader", session_factory=Changed)
        self.assertEqual(result["reason"], "relation_changed")
        self.assertFalse(result["coverageComplete"])

    def test_connection_account_database_port_tls_and_actual_ip_are_checked(self):
        for patch in ({"database": "other"}, {"currentUser": "other"}, {"sessionUser": "other"}, {"port": 5432}, {"readOnly": False}, {"isolation": "read committed"}):
            with self.subTest(patch=patch):
                with self.assertRaises(probe.InspectionError):
                    probe.verify_connection([identity(**patch)], request(), "reader")
        tcp = request()
        tcp.update(transport="tcp", host="192.0.2.1", auth="password", usernameSecretKey="PG_USER", passwordSecretKey="PG_PASS", sslRootCertPath="/etc/ca.crt")
        tcp.pop("username")
        tcp = probe.validate_request(tcp)
        for patch in ({"tls": False, "serverAddress": "192.0.2.1"}, {"tls": True, "serverAddress": "192.0.2.2"}):
            with self.assertRaises(probe.InspectionError):
                probe.verify_connection([identity(**patch)], tcp, "reader")
        self.assertEqual(probe.verify_connection([identity(tls=True, serverAddress="192.0.2.1")], tcp, "reader")["serverAddress"], "192.0.2.1")

    def test_sql_quotes_identifiers_and_never_accepts_user_sql_or_metacommands(self):
        table = {"schema": "public", "name": '中"表;DROP TABLE nope;--'}
        req = request(tables=[table])
        self.assertIn('"中""表;DROP TABLE nope;--"', probe.data_sql(table, 1))
        self.assertIn("pg_catalog.row_to_json", probe.data_sql(table, 1))
        for patch in ({"sql": "DELETE FROM orders"}, {"tables": [{"schema": "public", "name": "a\\gexec"}]}, {"database": "host=other"}, {"host": "/run/../other"}, {"tables": [{"schema": "public", "name": "a\n\\connect evil"}]}):
            with self.subTest(patch=patch), self.assertRaises(probe.InspectionError):
                request(**patch)
        self.assertEqual(req["tables"], [table])

    def test_environment_drops_inherited_targets_rc_passfile_and_tls_downgrade(self):
        raw = request()
        env = probe.session_environment(raw, "reader", "", "/private")
        self.assertNotIn("PGPASSWORD", env)
        self.assertNotIn("PGHOSTADDR", env)
        self.assertNotIn("PGSERVICE", env)
        self.assertEqual(env["PGPASSFILE"], "/dev/null")
        self.assertEqual(env["PGSSLCERT"], "/private/no-client.crt")
        raw.update(transport="tcp", host="db.example", auth="password", usernameSecretKey="PG_USER", passwordSecretKey="PG_PASS", sslRootCertPath="/etc/ca.crt")
        raw.pop("username")
        env = probe.session_environment(probe.validate_request(raw), "reader", "opaque", "/private")
        self.assertEqual(env["PGSSLMODE"], "verify-full")
        self.assertEqual(env["PGGSSENCMODE"], "disable")
        self.assertEqual(env["PGSSLROOTCERT"], "/etc/ca.crt")

    def test_receipt_size_limit_preserves_unknown_instead_of_truncated_success(self):
        class HugeMetadata(ControlledSession):
            metadata = [{"record": "locked", "oid": "16400", "held": True}, column()] + [
                {"record": "constraint", "name": "c" + str(i), "type": "c", "definition": "x" * 2000, "validated": True, "deferrable": False, "initiallyDeferred": False} for i in range(150)]
        result = probe.inspect(request(), "reader", session_factory=HugeMetadata)
        self.assertEqual(result["reason"], "result_byte_limit")
        self.assertFalse(result["coverageComplete"])
        self.assertEqual(result["tables"], [])

    def fixture(self, root, **patch):
        client = Path(root) / "psql"
        client.write_text(FAKE_CLIENT)
        client.chmod(0o700)
        config = {"identity": identity(), "relation": ControlledSession.relation, "metadata": ControlledSession.metadata, "rows": ControlledSession.data}
        config.update(patch)
        (Path(root) / "fixture.json").write_text(json.dumps(config))
        return request(clientPath=str(client))

    def test_real_child_process_protocol_uses_single_client_and_no_inherited_target(self):
        with tempfile.TemporaryDirectory(prefix="opsark-postgres-test-") as root:
            req = self.fixture(root)
            result = probe.inspect(req, "reader")
            self.assertEqual(result["status"], "complete", result)
            calls = [json.loads(line) for line in (Path(root) / "calls.jsonl").read_text().splitlines()]
            self.assertEqual(len(calls), 1)
            self.assertIn("-X", calls[0]["args"])
            self.assertIn("-w", calls[0]["args"])
            self.assertEqual(calls[0]["environment"]["PGPASSFILE"], "/dev/null")
            self.assertNotIn("PGHOST", calls[0]["environment"])
            self.assertFalse(Path(calls[0]["environment"]["HOME"]).exists())

    def test_real_child_timeout_is_bounded_and_killed(self):
        with tempfile.TemporaryDirectory(prefix="opsark-postgres-test-") as root:
            req = self.fixture(root, sleep=8)
            req["timeoutSeconds"] = 1
            start = time.monotonic()
            result = probe.inspect(req, "reader")
            self.assertEqual(result["status"], "timeout")
            self.assertLess(time.monotonic() - start, 3)
            self.assertFalse(result["connectionVerified"])

    def test_real_child_byte_budget_is_bounded_and_never_hashes_partial_payload(self):
        with tempfile.TemporaryDirectory(prefix="opsark-postgres-test-") as root:
            req = self.fixture(root, huge=True)
            req["maxDataBytes"] = 1024
            result = probe.inspect(req, "reader")
            self.assertEqual(result["reason"], "data_byte_limit")
            self.assertEqual(result["readBytes"], 1024)
            self.assertFalse(result["coverageComplete"])

    def test_cli_failure_preserves_error_without_raw_diagnostics(self):
        with tempfile.TemporaryDirectory(prefix="opsark-postgres-test-") as root:
            req = self.fixture(root, failure=True)
            completed = subprocess.run([sys.executable, "-I", "-B", str(location), json.dumps(req), "reader", ""], capture_output=True, text=True, timeout=3)
            self.assertEqual(completed.returncode, 0)
            self.assertNotIn("private-password", completed.stdout + completed.stderr)
            result = json.loads(completed.stdout.removeprefix("OPSARK_POSTGRES_RESULT "))
            self.assertEqual(result["status"], "error")
            self.assertEqual(result["reason"], "client_or_query_failed")
            self.assertFalse(result["coverageComplete"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
