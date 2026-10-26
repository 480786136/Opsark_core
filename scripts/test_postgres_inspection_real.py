"""B03 real local PostgreSQL test. Official Ubuntu packages are extracted only.

No dpkg install, service registration, existing database or business server is
used. All database writes below are test fixtures under one owned /tmp root.
"""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import pwd
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest

sys.dont_write_bytecode = True
location = Path(__file__).resolve().parents[1] / "src/features/tools/postgres_inspection_probe.py"
spec = importlib.util.spec_from_file_location("postgres_inspection_probe_real", location)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
fixture = None


def call(args, **kwargs):
    result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180, **kwargs)
    if result.returncode:
        raise RuntimeError("command failed: " + args[0] + "\n" + result.stdout)
    return result.stdout


class LocalPostgres:
    def __init__(self):
        self.root = Path(tempfile.mkdtemp(prefix="opsark-b03-real-", dir="/tmp"))
        self.process = None
        self.log = None
        self.nobody = pwd.getpwnam("nobody")
        self.root.chmod(0o755)
        self.packages = self.root / "packages"
        self.packages.mkdir()
        self.extract = self.root / "runtime"
        self.extract.mkdir()
        self.socket = self.root / "socket"
        self.socket.mkdir(mode=0o700)
        self.data = self.root / "data"
        self.data.mkdir(mode=0o700)
        for path in (self.socket, self.data):
            os.chown(path, self.nobody.pw_uid, self.nobody.pw_gid)

    def setup(self):
        print("临时根目录: " + str(self.root), flush=True)
        print("仅下载/解包官方Ubuntu发行包，不执行系统安装脚本", flush=True)
        packages = ["postgresql-14", "postgresql-client-14", "libpq5"]
        print(call(["apt-get", "download"] + packages, cwd=str(self.packages)), flush=True)
        for package in sorted(self.packages.glob("*.deb")):
            print("发行包SHA256 " + package.name + " " + hashlib.sha256(package.read_bytes()).hexdigest(), flush=True)
            call(["dpkg-deb", "-x", str(package), str(self.extract)])
        self.binaries = self.extract / "usr/lib/postgresql/14/bin"
        self.library = self.extract / "usr/lib/x86_64-linux-gnu"
        self.loader = "/lib64/ld-linux-x86-64.so.2"
        # The explicitly approved test client wrapper sets only the unpacked
        # library search path. Production probe still receives no inherited env.
        self.client_dir = self.root / "client"
        self.client_dir.mkdir()
        self.client = self.client_dir / "psql"
        self.client.write_text("#!/bin/sh\nexec " + " ".join("'" + arg.replace("'", "'\"'\"'") + "'" for arg in [self.loader, "--library-path", str(self.library), str(self.binaries / "psql")]) + ' "$@"\n')
        self.client.chmod(0o755)
        print(call([str(self.client), "--version"]), flush=True)
        init = ["/usr/sbin/runuser", "-u", "nobody", "--", self.loader, "--library-path", str(self.library), str(self.binaries / "initdb"),
                "-D", str(self.data), "-L", str(self.extract / "usr/share/postgresql/14"), "-A", "trust", "-U", "fixture_admin", "--no-locale", "--encoding=UTF8"]
        print(call(init), flush=True)
        with socket.socket() as endpoint:
            endpoint.bind(("127.0.0.1", 0))
            self.port = endpoint.getsockname()[1]
        cert_dir = self.root / "tls"
        cert_dir.mkdir(mode=0o700)
        self.certificate = cert_dir / "server.crt"
        key = cert_dir / "server.key"
        call(["openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-days", "1", "-subj", "/CN=localhost",
              "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost", "-out", str(self.certificate), "-keyout", str(key)])
        for path in (cert_dir, self.certificate, key):
            os.chown(path, self.nobody.pw_uid, self.nobody.pw_gid)
        key.chmod(0o600)
        (self.data / "pg_hba.conf").write_text("local all all trust\nhost all all 127.0.0.1/32 scram-sha-256\n")
        self.log = (self.root / "server.log").open("w+")
        args = ["/usr/sbin/runuser", "-u", "nobody", "--", self.loader, "--library-path", str(self.library), str(self.binaries / "postgres"),
                "-D", str(self.data), "-k", str(self.socket), "-p", str(self.port), "-h", "127.0.0.1", "-c", "jit=off",
                "-c", "ssl=on", "-c", "ssl_cert_file=" + str(self.certificate), "-c", "ssl_key_file=" + str(key),
                "-c", "dynamic_library_path=" + str(self.extract / "usr/lib/postgresql/14/lib")]
        self.process = subprocess.Popen(args, stdout=self.log, stderr=self.log)
        for _ in range(80):
            if (self.socket / (".s.PGSQL." + str(self.port))).exists():
                break
            if self.process.poll() is not None:
                self.log.flush()
                raise RuntimeError((self.root / "server.log").read_text())
            time.sleep(0.1)
        else:
            raise RuntimeError("local PostgreSQL readiness timeout")
        self.sql("CREATE ROLE fixture_reader LOGIN PASSWORD 'test-database-only'; CREATE ROLE fixture_denied LOGIN;")
        self.sql("CREATE DATABASE evidence;")
        self.sql("CREATE TABLE public.orders (id integer PRIMARY KEY, name text NOT NULL, payload json, price numeric CHECK(price>=0));"
                 "CREATE INDEX orders_name ON public.orders(name);"
                 "INSERT INTO public.orders VALUES (1,'中 文','{\"a\":1,\"a\":2}',12.30),(2,'quoted '' row','{\"a\":null}',0);"
                 "CREATE TABLE public.empty_table (id integer NOT NULL);"
                 "CREATE TYPE public.custom_kind AS ENUM ('a','b'); CREATE TABLE public.custom_table(kind public.custom_kind);"
                 "CREATE TABLE public.opaque_default(name text DEFAULT ('a'::public.custom_kind)::text);"
                 "CREATE VIEW public.view_orders AS SELECT * FROM public.orders;"
                 "CREATE TABLE public.rls_table(id integer); ALTER TABLE public.rls_table ENABLE ROW LEVEL SECURITY;"
                 "GRANT SELECT ON ALL TABLES IN SCHEMA public TO fixture_reader;", "evidence")

    def sql(self, sql, database="postgres", user="fixture_admin", success=True):
        args = [str(self.client), "-X", "-w", "-h", str(self.socket), "-p", str(self.port), "-U", user, "-d", database, "-v", "ON_ERROR_STOP=1", "-Atc", sql]
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=10, env={"PATH": os.defpath, "PGPASSFILE": "/dev/null"})
        if success and result.returncode:
            raise RuntimeError(result.stderr)
        return result

    def request(self, names=None, **patch):
        value = {"clientPath": str(self.client), "transport": "socket", "host": str(self.socket), "port": self.port, "database": "evidence", "auth": "socket_identity", "username": "fixture_reader",
                 "tables": [{"schema": "public", "name": name} for name in (names or ["orders"])], "timeoutSeconds": 5}
        value.update(patch)
        return probe.validate_request(value)

    def close(self):
        if self.process is not None and self.process.poll() is None:
            # pg_ctl targets this exact private data directory and waits for stop.
            stop = ["/usr/sbin/runuser", "-u", "nobody", "--", self.loader, "--library-path", str(self.library), str(self.binaries / "pg_ctl"), "-D", str(self.data), "-m", "fast", "-w", "stop"]
            print(call(stop), flush=True)
            self.process.wait(timeout=10)
        if self.log:
            self.log.close()
        root = self.root.resolve()
        if root.parent != Path("/tmp") or not root.name.startswith("opsark-b03-real-") or self.root.is_symlink():
            raise RuntimeError("refusing cleanup outside owned temporary root")
        shutil.rmtree(str(root))
        print("已停止专有PostgreSQL且清理临时根: " + str(root) + "; 存在=" + str(root.exists()), flush=True)


class RealPostgresTests(unittest.TestCase):
    def test_real_contents_columns_constraints_indexes_empty_table(self):
        result = probe.inspect(fixture.request(["orders", "empty_table"]), "fixture_reader")
        self.assertEqual(result["status"], "complete", result)
        self.assertEqual([table["rowCount"] for table in result["tables"]], [2, 0])
        self.assertEqual(len(result["tables"][0]["columns"]), 4)
        self.assertEqual(len(result["tables"][0]["constraints"]), 2)
        self.assertEqual(len(result["tables"][0]["indexes"]), 2)
        self.assertEqual(result["tables"][1]["dataSha256"], hashlib.sha256(b"").hexdigest())
        self.assertTrue(result["connectionVerified"])
        self.assertEqual(result["connection"]["database"], "evidence")
        self.assertEqual(result["connection"]["sessionUser"], "fixture_reader")

    def test_equal_count_changed_content_and_restore_changes_digest(self):
        before = probe.inspect(fixture.request(), "fixture_reader")
        try:
            fixture.sql("UPDATE public.orders SET name='changed' WHERE id=1", "evidence")
            after = probe.inspect(fixture.request(), "fixture_reader")
            self.assertEqual(before["status"], "complete", before)
            self.assertEqual(after["status"], "complete", after)
            self.assertEqual(before["tables"][0]["rowCount"], after["tables"][0]["rowCount"])
            self.assertNotEqual(before["tables"][0]["dataSha256"], after["tables"][0]["dataSha256"])
        finally:
            fixture.sql("UPDATE public.orders SET name='中 文' WHERE id=1", "evidence")
        restored = probe.inspect(fixture.request(), "fixture_reader")
        self.assertEqual(before["tables"][0]["dataSha256"], restored["tables"][0]["dataSha256"])

    def test_missing_permission_and_limit_remain_unknown(self):
        for req in [fixture.request(["does_not_exist"]), fixture.request(username="fixture_denied"), fixture.request(maxRowsPerTable=1)]:
            with self.subTest(request=req):
                result = probe.inspect(req, req["username"])
                self.assertNotEqual(result["status"], "complete")
                self.assertFalse(result["coverageComplete"])
                self.assertTrue(all(table["dataSha256"] is None for table in result["tables"]))

    def test_custom_type_view_and_rls_never_complete(self):
        for name in ("custom_table", "opaque_default", "view_orders", "rls_table"):
            with self.subTest(table=name):
                result = probe.inspect(fixture.request([name]), "fixture_reader")
                self.assertFalse(result["coverageComplete"], result)

    def test_real_tcp_tls_full_verification_and_password_identity(self):
        req = fixture.request()
        req.update(transport="tcp", host="localhost", auth="password", usernameSecretKey="FIXTURE_USER", passwordSecretKey="FIXTURE_PASSWORD", sslRootCertPath=str(fixture.certificate))
        req.pop("username")
        result = probe.inspect(req, "fixture_reader", "test-database-only")
        if result["status"] != "complete":
            with tempfile.TemporaryDirectory(prefix="opsark-b03-tls-diagnostic-") as home:
                diagnostic = subprocess.run([str(fixture.client), "-X", "-w", "-Atq", "-h", "localhost", "-p", str(fixture.port), "-U", "fixture_reader", "-d", "evidence", "-c", probe.connection_sql(5, req["tables"])],
                                            capture_output=True, text=True, timeout=5, env=probe.session_environment(req, "fixture_reader", "test-database-only", home))
                print("受控TLS失败诊断（仅本机夹具）: " + (diagnostic.stdout + diagnostic.stderr).replace("test-database-only", "[已脱敏]"), flush=True)
        self.assertEqual(result["status"], "complete", result)
        self.assertTrue(result["connection"]["tls"])
        self.assertEqual(result["connection"]["serverAddress"], "127.0.0.1")
        self.assertEqual(result["connection"]["sessionUser"], "fixture_reader")

    def test_bad_ca_and_wrong_password_do_not_fallback_or_complete(self):
        req = fixture.request()
        req.update(transport="tcp", host="localhost", auth="password", usernameSecretKey="FIXTURE_USER", passwordSecretKey="FIXTURE_PASSWORD", sslRootCertPath=str(fixture.certificate))
        req.pop("username")
        for password, certificate in [("wrong-fixture-password", str(fixture.certificate)), ("test-database-only", str(fixture.root / "missing-ca.crt"))]:
            with self.subTest(certificate=certificate):
                result = probe.inspect(dict(req, sslRootCertPath=certificate), "fixture_reader", password)
                self.assertFalse(result["connectionVerified"], result)
                self.assertFalse(result["coverageComplete"])
                self.assertNotIn(password, probe.canonical(result))

    def test_database_rejects_writes_in_real_readonly_transaction(self):
        result = fixture.sql("BEGIN READ ONLY; INSERT INTO public.orders VALUES(100,'forbidden',NULL,1); COMMIT;", "evidence", success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("read-only transaction", result.stderr)
        self.assertEqual(fixture.sql("SELECT count(*) FROM public.orders WHERE id=100", "evidence").stdout.strip(), "0")


if __name__ == "__main__":
    fixture = LocalPostgres()
    try:
        fixture.setup()
        result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(RealPostgresTests))
        exit_code = 0 if result.wasSuccessful() else 1
    finally:
        fixture.close()
    sys.exit(exit_code)
