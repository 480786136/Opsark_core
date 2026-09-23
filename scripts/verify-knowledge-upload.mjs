// Optional sibling-service contract smoke. Uses the application's own Vite TS/alias resolver.
// Uses only synthetic data and an isolated temporary SQLite database; no live credentials.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "vite";

// An unbound HTTP server prevents Vite from opening its default HMR port.
const loader = await createServer({ root: fileURLToPath(new URL("..", import.meta.url)), server: { middlewareMode: true, hmr: { server: createHttpServer() } }, appType: "custom" });
let buildKnowledgeRecord, serializeRecord, parseKnowledgeSearch;
try {
  ({ buildKnowledgeRecord, serializeRecord } = await loader.ssrLoadModule("/src/features/knowledge/record.ts"));
  ({ parseKnowledgeSearch } = await loader.ssrLoadModule("/src/features/knowledge/service.ts"));
}
finally { await loader.close(); }

const task = {
  id: "core-contract-smoke", title: "服务检查", rootGoal: "检查服务 password=synthetic-secret",
  status: "completed", updatedAt: "2026-09-07T01:00:00Z",
  plan: [{ id: "check-step", title: "检查运行状态", command: "systemctl status demo", expected: "active", status: "completed", result: {
    executionStatus: "success", observationStatus: "matched", exitCode: 0,
    facts: { private: "not-for-upload" }, evidenceIds: ["main", "validation"],
  }, evidence: [
    { id: "main", source: "main", type: "command-output", facts: {}, rawOutput: "active", scope: { targetId: "smoke-server", shell: "bash", scope: "isolated_exec", persistence: "command", doesNotProve: [] } },
    { id: "validation", source: "validation", type: "command", facts: { passed: true, exitCode: 0 }, rawOutput: "active" },
  ] }],
};
const body = serializeRecord(buildKnowledgeRecord(task, "placeholder", 1, [], true, { id: "smoke-server", info: { os: "Ubuntu 24.04" }, environment: ["nginx 1.26.2"] }));
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
from knowledge.processing import run_once
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
            assert run_once(factory), "source job not processed"
            docs = client.get("/internal/v1/documents", headers=service)
            assert docs.status_code == 200 and len(docs.json()) == 1, docs.text
            doc = docs.json()[0]
            query = {"query":"服务", "knowledge_base_ids":[kb], "top_k":5, "max_content_chars":6000}
            assert client.post("/api/v1/knowledge/search", headers=auth, json=query).json()["hits"] == []
            published = client.post("/internal/v1/documents/" + doc["id"] + "/publish", headers=service, json={"revision":doc["revision"]})
            assert published.status_code == 202, published.text
            assert run_once(factory), "publish job not processed"
            searched = client.post("/api/v1/knowledge/search", headers=auth, json=query)
            assert searched.status_code == 200 and searched.json()["hits"], searched.text
            hit = searched.json()["hits"][0]
            cited = client.get(hit["citation"]["document_url"], headers=auth)
            assert cited.status_code == 200, cited.text
            assert cited.json()["version"] == hit["document_version"]
            assert cited.json()["context"]["runtime"]["os"] == "Ubuntu 24.04"
            assert "synthetic-secret" not in cited.text
            unpublished = client.post("/internal/v1/documents/" + doc["id"] + "/unpublish", headers=service)
            assert unpublished.status_code == 200, unpublished.text
            assert client.post("/api/v1/knowledge/search", headers=auth, json=query).json()["hits"] == []
            assert client.get(hit["citation"]["document_url"], headers=auth).status_code == 410
            print(json.dumps({"base":kb,"search":searched.json()}, ensure_ascii=False))
    finally:
        app.dependency_overrides.clear()
        engine.dispose()
`;
const result = JSON.parse(execFileSync(python, ["-c", script], { cwd: sibling, input: body, encoding: "utf8" }));
parseKnowledgeSearch(result.search, result.base);
process.stdout.write("PASS: Core DTO + redaction + stable evidence + upload/idempotency + Worker draft + publish/index + typed search + versioned citation + unpublish\n");
