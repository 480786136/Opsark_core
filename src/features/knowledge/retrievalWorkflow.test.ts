// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import { useKnowledgeStore } from "./knowledgeStore";
import { searchKnowledge } from "./service";
import type { KnowledgeSearchResult } from "./types";

vi.mock("./service", async original => ({ ...await original<typeof import("./service")>(), searchKnowledge: vi.fn() }));
const result = (): KnowledgeSearchResult => ({ retrieval_mode: "keyword_only", index_version: "idx", hits: [{ chunk_id: "chunk", document_id: "doc", document_version: 2,
  knowledge_base_id: "kb", title: "服务诊断", content: "检查配置文件和错误日志", rank: 1,
  citation: { label: "K1", line_start: 1, line_end: 2, source_record_ids: [], document_url: "/api/v1/knowledge/documents/doc/versions/2" },
}], truncated: false, warnings: [] });
beforeEach(() => {
  localStorage.clear(); setActivePinia(createPinia()); vi.clearAllMocks();
  const ops = useOpsStore();
  ops.models = [{ id: "model", name: "Fixture", provider: "Test", model: "fixture", endpoint: "https://model.example.invalid", enabled: true, hasApiKey: true }];
  ops.modelApiKeys.model = "private-model-key";
  vi.spyOn(ops, "getRuntimeConnection").mockReturnValue({ host: "example.invalid", port: 22, username: "test", password: "test-password" });
  vi.spyOn(ops, "hydrateCredentials").mockResolvedValue();
  vi.spyOn(ops, "ensureTaskAgentSession").mockResolvedValue(undefined);
  vi.spyOn(backend, "configureTaskCapabilities").mockResolvedValue();
  vi.spyOn(backend, "processRequirement").mockResolvedValue({ intent: "answer", relation: "side_question", answer: "参考 [K1]，仍需核对当前环境。", plan: [] });
  vi.spyOn(backend, "executeCommand").mockRejectedValue(new Error("test must not execute"));
  const knowledge = useKnowledgeStore(); knowledge.hydrate();
  knowledge.config = { ...knowledge.config, hasApiKey: true, searchEnabled: true, knowledgeBaseId: "kb" };
});
afterEach(() => { vi.restoreAllMocks(); });

it("retrieves before the actual requirement model request and leaves execution permission unchanged", async () => {
  const ops = useOpsStore(); vi.mocked(searchKnowledge).mockResolvedValue(result());
  await ops.submitRequirement("server", "排查服务 private-model-key", "observe", "model");
  expect(searchKnowledge).toHaveBeenCalledOnce();
  expect(vi.mocked(searchKnowledge).mock.calls[0][1]).not.toContain("private-model-key");
  expect(backend.processRequirement).toHaveBeenCalledOnce();
  const context = JSON.parse(vi.mocked(backend.processRequirement).mock.calls[0][1]!.context!);
  expect(context.knowledgeReferences).toMatchObject({ trust: "untrusted_reference", references: [{ label: "K1", version: 2 }] });
  expect(context.permission).toBe("observe"); expect(ops.activeTask?.permission).toBe("observe");
  expect(backend.executeCommand).not.toHaveBeenCalled();
  expect(useKnowledgeStore().entries).toEqual([]);
});

it("does not start a model call when the user cancels while retrieval is pending", async () => {
  const ops = useOpsStore(); let finish!: (value: KnowledgeSearchResult) => void;
  vi.mocked(searchKnowledge).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const pending = ops.submitRequirement("server", "排查服务", "safe", "model");
  await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
  const task = ops.activeTask!; task.cancelRequested = true; task.workflowEpoch = (task.workflowEpoch ?? 0) + 1;
  finish(result()); await pending;
  expect(backend.processRequirement).not.toHaveBeenCalled();
  expect(useKnowledgeStore().retrievals[task.id]).toBeUndefined();
  expect(task.requirementProcessing).toBe(false);
});
