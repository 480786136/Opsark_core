// Optional sibling-service contract smoke. Node 22+ with --experimental-strip-types.
// Uses only synthetic data and an isolated temporary SQLite database; no live credentials.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildKnowledgeRecord, serializeRecord } from "../src/features/knowledge/record.ts";

const task = {
  id: "core-contract-smoke", title: "服务检查", rootGoal: "检查服务 password=synthetic-secret",
  status: "completed", updatedAt: "2026-09-07T01:00:00Z",
  plan: [{ title: "检查运行状态", command: "systemctl status demo", result: {
    executionStatus: "success", observationStatus: "complete", exitCode: 0,
    facts: { private: "not-for-upload" },
  } }],
};
const body = serializeRecord(buildKnowledgeRecord(task, "placeholder", 1, [], true));
const sibling = fileURLToPath(new URL("../../Opsark_knowledge/", import.meta.url));
const python = process.env.OPSARK_KNOWLEDGE_PYTHON || fileURLToPath(new URL(
  process.platform === "win32" ? "../../Opsark_knowledge/.venv/Scripts/python.exe" : "../../Opsark_knowledge/.venv/bin/python", import.meta.url));
const script = `
import sys, json, tempfile
from fastapi.testclient import TestClient
from sqlalchemy.orm import sessionmaker
from knowledge.main import app
from knowledge.db import Base, get_db, make_engine
from knowledge.config import settings
from knowledge.schemas import RecordInput
payload = json.loads(sys.stdin.buffer.read().decode("utf-8"))
RecordInput.model_validate(payload)
with tempfile.TemporaryDirectory(prefix="opsark-core-contract-") as directory:
    engine = make_engine("sqlite:///" + directory + "/test.db")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    def db():
        with factory() as session:
            yield session
    app.dependency_overrides[get_db] = db
    settings().knowledge_service_token = "synthetic-service-token-" + "x" * 40
    settings().embedding_base_url = ""
    try:
        with TestClient(app) as client:
            service = {"Authorization": "Bearer " + settings().knowledge_service_token}
            created = client.post("/internal/v1/knowledge-bases", headers=service, json={"name":"Core smoke"})
            assert created.status_code == 201, created.status_code
            kb = created.json()["id"]
            key = client.post("/internal/v1/knowledge-keys", headers=service, json={"name":"smoke", "installation_id":"core-smoke", "knowledge_base_ids":[kb], "scopes":["records:write","records:read","knowledge:read"]})
            assert key.status_code == 201, key.status_code
            auth = {"Authorization":"Bearer " + key.json()["api_key"]}
            assert client.get("/api/v1/knowledge/bases", headers=auth).status_code == 200
            payload["knowledge_base_id"] = kb
            body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            headers = {**auth, "Idempotency-Key":"core-smoke-v1", "Content-Type":"application/json"}
            first = client.post("/api/v1/records", headers=headers, content=body)
            assert first.status_code == 202, first.text
            again = client.post("/api/v1/records", headers=headers, content=body)
            assert again.status_code == 202 and again.json()["duplicate"]
            assert again.json()["record_id"] == first.json()["record_id"]
            status = client.get("/api/v1/records/" + first.json()["record_id"], headers=auth)
            assert status.status_code == 200, status.status_code
            print("PASS: core DTO, redaction, authorized bases, upload, idempotent retry, record status")
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
`;
process.stdout.write(execFileSync(python, ["-c", script], { cwd: sibling, input: body, encoding: "utf8" }));
