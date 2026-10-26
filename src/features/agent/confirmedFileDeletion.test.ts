import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpsTask, PlanStep, ServerProfile } from "@/types";
import { assertDeletionTarget, createDeletionPreview, currentDeletionAuthorization,
  decideDeletion, deletionAuthorizationContext, deletionAuthorizedStep, deletionCaptureReader, deletionConfirmation,
  deletionTarget, invalidateDeletionConfirmation, revokeUnusedDeletionAuthorizations, validateDeletionPaths } from "./confirmedFileDeletion";
import type { DeletionFile } from "./confirmedFileDeletion";

const now = new Date("2026-10-12T10:00:00.000Z").getTime();
function fixture(policy: NonNullable<OpsTask["executionConstraints"]>["changePolicy"] = "confirm_changes") {
  const task: OpsTask = { id: "task", title: "精确清理", rootGoal: "预览三份文件并在确认后删除", serverId: "server", modelId: "model",
    currentRoundId: "round", status: "awaiting_input", permission: "managed", plan: [], messages: [], createdAt: "now", updatedAt: "now",
    executionConstraints: { changePolicy: policy, environmentPolicy: "preserve", failurePolicy: "strict", prohibitedActions: [], userDirectives: [], requiredConditions: [] },
    requirementLifecycle: { version: 1, revision: 2, items: [], focus: { roundId: "round", requirementIds: [] } } };
  const server = { id: "server", name: "测试主机", host: "host.test", port: 22, username: "user" } as ServerProfile;
  const paths = ["/var/fixture/中文 空格'引号", "/var/fixture/line\nbreak", "/var/fixture/third"];
  const files: DeletionFile[] = paths.map((path, index) => ({ path, size: 3, sha256: "a".repeat(64),
    identity: ["1", "2", "1", String(100 + index), "33188", "1", "3", "1791800000123456789", "1791800000123456789"] }));
  const preview = createDeletionPreview(task, server, "preview-one", paths, JSON.stringify({ mode: "preview", items: files }));
  const step: PlanStep = { id: "delete-step", kind: "change", title: "删除已确认文件", description: "使用专用许可", command: "", expected: "准确清理已确认文件",
    validation: "", risk: "medium", status: "pending", action: { type: "tool", toolId: "files.delete_confirmed", arguments: { authorizationId: preview.id } } };
  return { task, server, paths, files, preview, step };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe("精确删除许可的预览、绑定和单次使用", () => {
  it("隔离恢复标记跨分片与特殊路径可精确读取，重复标记不重复登记", () => {
    const { files, preview } = fixture();
    const record = vi.fn();
    const read = deletionCaptureReader(files, record);
    const location = { original: files[1].path,
      quarantine: `/var/fixture/.opsark-delete-${"a".repeat(32)}/candidate` };
    const marker = `OPSARK_DELETE_CAPTURE ${JSON.stringify(location)}\n`;
    read(marker.slice(0, 8));
    read(marker.slice(8, 41));
    read(marker.slice(41, -1));
    expect(record).not.toHaveBeenCalled();
    read("\n");
    read(marker);
    expect(record.mock.calls).toEqual([[location]]);
    expect(preview.state).toBe("preview"); // 恢复位置不是执行成功或授权证据。
  });

  it("伪造目标、越界隔离位置与超长标记均拒绝，随后合法标记仍能读取", () => {
    const { files } = fixture();
    const record = vi.fn();
    const read = deletionCaptureReader(files, record);
    const valid = { original: files[0].path,
      quarantine: `/var/fixture/.opsark-delete-${"b".repeat(32)}/candidate` };
    for (const location of [
      { ...valid, original: "/var/fixture/unlisted" },
      { ...valid, quarantine: `/other/.opsark-delete-${"b".repeat(32)}/candidate` },
      { ...valid, quarantine: `${valid.quarantine}/../foreign` },
      { ...valid, quarantine: `${valid.quarantine}\n` },
      { ...valid, quarantine: `/var/fixture/.opsark-delete-${"g".repeat(32)}/candidate` },
    ]) read(`OPSARK_DELETE_CAPTURE ${JSON.stringify(location)}\n`);
    read("OPSARK_DELETE_CAPTURE " + "x".repeat(65500));
    read("x".repeat(100));
    read(`\nOPSARK_DELETE_CAPTURE ${JSON.stringify(valid)}\n`);
    expect(record.mock.calls).toEqual([[valid]]);
  });

  it("显示全部真实路径与大小，预览本身不能执行删除", () => {
    const { task, paths, preview, step } = fixture();
    const confirmation = deletionConfirmation(task, preview.id);
    for (const path of paths) expect(confirmation.description).toContain(JSON.stringify(path));
    expect(confirmation.description).toContain("仅删除上述 3 个文件");
    expect(confirmation.fields[0].options?.map(option => option.value)).toEqual(["confirm", "reject"]);
    expect(preview.items[0].identity[7]).toBe("1791800000123456789");
    expect(deletionAuthorizedStep(task, step)).toBe(false);
    expect(currentDeletionAuthorization(task, preview.id)).toBe(preview);
  });

  it("明确确认只授权专用工具，普通Shell及其他工具无法借用", () => {
    const { task, preview, step } = fixture();
    decideDeletion(task, preview.id, "confirm");
    expect(deletionAuthorizedStep(task, step)).toBe(true);
    expect(deletionAuthorizedStep(task, { ...step, action: { type: "shell", command: "rm /var/fixture/*" } })).toBe(false);
    expect(deletionAuthorizedStep(task, { ...step, action: { type: "tool", toolId: "files.read_content", arguments: { authorizationId: preview.id } } })).toBe(false);
    expect(deletionAuthorizedStep(task, { ...step, action: { type: "tool", toolId: "files.delete_confirmed", arguments: { authorizationId: "other" } } })).toBe(false);
    expect(() => decideDeletion(task, preview.id, "confirm")).toThrow();
  });

  it("拒绝后无许可，迟到的确认与相同预览重复提交不能改回批准", () => {
    const { task, preview, step } = fixture();
    decideDeletion(task, preview.id, "reject");
    expect(preview.state).toBe("rejected");
    expect(deletionAuthorizedStep(task, step)).toBe(false);
    expect(() => decideDeletion(task, preview.id, "confirm")).toThrow();
    expect(() => deletionConfirmation(task, preview.id)).toThrow();
  });

  it.each(["", "yes", "confirmed", "用户已经同意", "confirm "])("非精确选项 %j 不产生许可", decision => {
    const { task, preview, step } = fixture();
    expect(() => decideDeletion(task, preview.id, decision)).toThrow();
    expect(preview.state).toBe("preview");
    expect(deletionAuthorizedStep(task, step)).toBe(false);
  });

  it.each(["read_only", undefined] as const)("永久只读或未声明权限 %j 不接受确认", policy => {
    const { task, preview, step } = fixture("read_only");
    if (policy === undefined) task.executionConstraints = undefined;
    expect(() => deletionConfirmation(task, preview.id)).toThrow();
    expect(() => decideDeletion(task, preview.id, "confirm")).toThrow();
    expect(deletionAuthorizedStep(task, step)).toBe(false);
  });

  it.each(["confirm_changes", "requested_changes_only", "allow_necessary_changes"] as const)("策略 %s 仍要求独立确认", policy => {
    const { task, preview, step } = fixture(policy);
    expect(deletionAuthorizedStep(task, step)).toBe(false);
    decideDeletion(task, preview.id, "confirm");
    expect(deletionAuthorizedStep(task, step)).toBe(true);
  });

  it("十分钟边界准确失效，过期后的旧表单不能确认", () => {
    const { task, preview, step } = fixture();
    vi.setSystemTime(preview.expiresAt - 1);
    expect(currentDeletionAuthorization(task, preview.id)).toBe(preview);
    vi.setSystemTime(preview.expiresAt);
    expect(() => currentDeletionAuthorization(task, preview.id)).toThrow();
    expect(() => decideDeletion(task, preview.id, "confirm")).toThrow();
    expect(deletionAuthorizedStep(task, step)).toBe(false);
    expect(deletionAuthorizationContext(task).items[0].active).toBe(false);
  });

  const changes: Array<[string, (task: OpsTask) => void]> = [
    ["任务", task => { task.id = "other-task"; }],
    ["需求revision", task => { task.requirementLifecycle!.revision += 1; }],
    ["轮次", task => { task.currentRoundId = "other-round"; }],
    ["目标", task => { task.rootGoal = "删除其他目录"; }],
    ["目标服务器", task => { task.executionTargetServerId = "other-server"; }],
    ["新增禁止条件", task => { task.executionConstraints!.prohibitedActions.push("不得删除"); }],
    ["新需求待理解", task => { task.pendingRequirements = [{ id: "pending", sourceMessageId: "pending", content: "先别删", baseRevision: 2, state: "pending", receivedAt: "now" }]; }],
    ["取消", task => { task.cancelRequested = true; }],
  ];
  it.each(changes)("%s 变化后旧许可失效", (_name, change) => {
    const { task, preview, step } = fixture();
    decideDeletion(task, preview.id, "confirm");
    change(task);
    expect(() => currentDeletionAuthorization(task, preview.id)).toThrow();
    expect(deletionAuthorizedStep(task, step)).toBe(false);
  });

  it.each([{ id: "other" }, { host: "other.test" }, { port: 2222 }, { username: "root" }])("相同服务器档案的端点身份改变 %j 不可执行", change => {
    const { task, server, preview, step } = fixture();
    decideDeletion(task, preview.id, "confirm");
    expect(() => assertDeletionTarget(preview, { ...server, ...change })).toThrow();
    step.executionIntent = { semantic: { targets: [{ role: "execution", ...deletionTarget({ ...server, ...change }) }] } } as PlanStep["executionIntent"];
    expect(deletionAuthorizedStep(task, step)).toBe(false);
  });

  it("摘要覆盖清单、身份和有效期，不能追加新文件或修改冻结快照", () => {
    for (const modify of [
      (item: ReturnType<typeof fixture>["preview"]) => item.items.push({ ...item.items[0], path: "/var/fixture/new" }),
      (item: ReturnType<typeof fixture>["preview"]) => { item.items[0].identity[3] = "999"; },
      (item: ReturnType<typeof fixture>["preview"]) => { item.items[0].sha256 = "b".repeat(64); },
      (item: ReturnType<typeof fixture>["preview"]) => { item.expiresAt += 1000; },
      (item: ReturnType<typeof fixture>["preview"]) => { item.target.username = "root"; },
      (item: ReturnType<typeof fixture>["preview"]) => { item.version = 99 as 1; },
    ]) {
      const { task, preview, step } = fixture();
      decideDeletion(task, preview.id, "confirm");
      modify(preview);
      expect(() => currentDeletionAuthorization(task, preview.id)).toThrow();
      expect(deletionAuthorizedStep(task, step)).toBe(false);
    }
  });

  it("同一previewId不能重复创建，损坏持久化中的重名许可不能任选一条", () => {
    const { task, server, paths, files, preview } = fixture();
    expect(() => createDeletionPreview(task, server, preview.id, paths, JSON.stringify({ mode: "preview", items: files }))).toThrow();
    expect(task.fileDeletionAuthorizations).toHaveLength(1);
    task.fileDeletionAuthorizations!.push(structuredClone(preview));
    expect(() => currentDeletionAuthorization(task, preview.id)).toThrow();
  });

  it("持久化后仍绑定同一任务，其他任务不能挪用确认", () => {
    const { task, preview, step } = fixture();
    decideDeletion(task, preview.id, "confirm");
    const restored = JSON.parse(JSON.stringify(task)) as OpsTask;
    expect(deletionAuthorizedStep(restored, step)).toBe(true);
    restored.id = "unrelated-task";
    expect(deletionAuthorizedStep(restored, step)).toBe(false);
  });

  it.each(["completed", "unknown", "revoked", "rejected"] as const)("许可进入 %s 后不能重新派发", state => {
    const { task, preview, step } = fixture();
    decideDeletion(task, preview.id, "confirm");
    preview.state = state;
    expect(deletionAuthorizedStep(task, step)).toBe(false);
    expect(() => decideDeletion(task, preview.id, "confirm")).toThrow();
  });

  it("已派发许可仅允许同executionId同step检查，不能转成另一执行或重启重放", () => {
    const { task, preview, step } = fixture();
    decideDeletion(task, preview.id, "confirm");
    preview.state = "executing";
    preview.executionId = "execution";
    preview.stepId = step.id;
    task.currentExecutionId = "execution";
    expect(deletionAuthorizedStep(task, step)).toBe(true);
    expect(deletionAuthorizedStep(task, { ...step, id: "new-step" })).toBe(false);
    task.currentExecutionId = "new-execution";
    expect(deletionAuthorizedStep(task, step)).toBe(false);
    task.currentExecutionId = undefined;
    expect(deletionAuthorizedStep(task, step)).toBe(false);
    expect(() => decideDeletion(task, preview.id, "confirm")).toThrow();
  });

  it("失效确认使任务回到需调整态，旧成功摘要不能继续显示", () => {
    const { task, preview, step } = fixture();
    decideDeletion(task, preview.id, "confirm");
    task.summary = "旧目标已完成";
    invalidateDeletionConfirmation(task, step, preview.id, "预览已失效");
    expect(preview.state).toBe("revoked");
    expect(deletionAuthorizedStep(task, step)).toBe(false);
    expect(step.status).toBe("failed");
    expect(task.status).toBe("needs_adjustment");
    expect(task.summary).toBeUndefined();
    expect(task.pauseReason).toBe("预览已失效");
  });

  it("撤销未使用许可不能抹掉正在执行、未知结果及历史完成状态", () => {
    const { task, preview } = fixture();
    const states = ["preview", "approved", "executing", "unknown", "completed", "rejected"] as const;
    task.fileDeletionAuthorizations = states.map((state, index) => ({ ...structuredClone(preview), id: `grant-${index}`, state }));
    revokeUnusedDeletionAuthorizations(task);
    expect(task.fileDeletionAuthorizations.map(item => item.state)).toEqual(["revoked", "revoked", "executing", "unknown", "completed", "rejected"]);
  });

  it("上下文只把当前批准许可标为可用，预览、拒绝及执行中记录不宣称可派发", () => {
    const { task, preview } = fixture();
    expect(deletionAuthorizationContext(task).items[0]).toMatchObject({ active: false, canConfirm: true });
    decideDeletion(task, preview.id, "confirm");
    expect(deletionAuthorizationContext(task).items[0]).toMatchObject({ active: true, canConfirm: false });
    preview.state = "executing";
    expect(deletionAuthorizationContext(task).items[0]).toMatchObject({ active: false, canConfirm: false });
    preview.state = "rejected";
    expect(deletionAuthorizationContext(task).items[0]).toMatchObject({ active: false, canConfirm: false });
    const context = JSON.stringify(deletionAuthorizationContext(task));
    expect(context).not.toContain(preview.items[0].path);
    expect(context).not.toContain(preview.items[0].identity[7]);
  });

  it("远端预览结果必须精确匹配顺序与路径，不接受缩短、换文件或虚假类型", () => {
    for (const change of [
      (files: DeletionFile[]) => files.slice(0, 2),
      (files: DeletionFile[]) => files.reverse(),
      (files: DeletionFile[]) => [{ ...files[0], path: "/var/fixture/other" }, ...files.slice(1)],
      (files: DeletionFile[]) => [{ ...files[0], identity: ["1"] }, ...files.slice(1)],
      (files: DeletionFile[]) => [{ ...files[0], sha256: "A".repeat(64) }, ...files.slice(1)],
      (files: DeletionFile[]) => [{ ...files[0], sha256: "a".repeat(63) }, ...files.slice(1)],
      (files: DeletionFile[]) => { const result = structuredClone(files); delete (result[0] as Partial<DeletionFile>).sha256; return result; },
      (files: DeletionFile[]) => [{ ...files[0], size: Number.MAX_SAFE_INTEGER + 1 }, ...files.slice(1)],
    ]) {
      const { task, server, paths, files } = fixture();
      expect(() => createDeletionPreview(task, server, "bad-preview", paths,
        JSON.stringify({ mode: "preview", items: change(structuredClone(files)) }))).toThrow();
      expect(task.fileDeletionAuthorizations).toHaveLength(1);
    }
  });

  it("路径校验保留中文与POSIX特殊字节，同时拒绝跳转、重复和超字节上限", () => {
    expect(() => validateDeletionPaths(["/tmp/中文 空格'\"\n\t\\*?"])).not.toThrow();
    for (const paths of [[], ["relative"], ["/tmp/../x"], ["/tmp//x"], ["/tmp/./x"], ["/tmp/"], ["/tmp/a\0b"],
      ["/tmp/same", "/tmp/same"], ["/" + "中".repeat(1400)], Array.from({ length: 101 }, (_, index) => `/tmp/${index}`)]) {
      expect(() => validateDeletionPaths(paths)).toThrow();
    }
  });
});
