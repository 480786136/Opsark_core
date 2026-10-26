import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { buildTaskDecisionSnapshot } from "./taskDecisionSnapshot";
import { archiveToolEvidence } from "./evidenceArchive";

const fixturePath = process.env.OPSARK_STAGE15_REPLAY_FIXTURE;
describe.skipIf(!fixturePath)("第020次冻结证据的离线回放", () => {
  it("原请求第三、四次均可见已有完整数值和原归档；未发生重采也满足原预算下限", async () => {
    const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
    const results = [];
    for (const sample of fixture.samples) {
      const task = sample.task;
      const save = vi.fn().mockResolvedValue("a".repeat(64));
      for (const phase of task.phaseHistory ?? []) {
        for (const step of phase.plan) await archiveToolEvidence(task, step, save, text => text, { roundId: phase.roundId });
      }
      for (const step of task.plan) await archiveToolEvidence(task, step, save, text => text);
      const snapshot = buildTaskDecisionSnapshot(task, undefined, true);
      const text = JSON.stringify(snapshot);
      for (const line of ["MemTotal:        7990060 kB", "MemAvailable:   6006372 kB", "SwapTotal:      2097148 kB", "SwapFree:       2097148 kB"]) {
        // Whitespace is checked against the original source, rather than fabricated metrics.
        const [name, ...rest] = line.split(/\s+/u);
        const expression = new RegExp(`${name}\\s+${rest.join("\\s+")}`, "u");
        expect(text.replace(/\\n/gu, "\n")).toMatch(expression);
      }
      const original = [...(task.phaseHistory ?? []).flatMap(phase => phase.plan), ...task.plan]
        .find(step => step.output?.length === 2746);
      expect(original).toBeDefined();
      expect(text).toContain(JSON.stringify(original.output).slice(1, -1));
      expect(text).toContain('"readTool":"evidence.read"');
      expect(text).not.toContain("补充关键内存证据");
      const context = { ...sample.context, baseSnapshot: snapshot };
      // The frozen native wire already references taskGoal from baseSnapshot.
      // Restore only that existing reference after proving exact equality with
      // the recursively expanded original goal. Do not double-send the goal or
      // pretend an uncompressed reconstruction is the actual native wire.
      const root = sample.context;
      const paths = new Set(root.contextReferences.paths);
      const expand = (value, path) => {
        if (!value || typeof value !== "object") return value;
        if (paths.has(path) && "contextRef" in value) {
          const pointer = value.contextRef;
          const target = pointer.slice(2).split("/").reduce((v, key) => v[key], root);
          return expand(target, pointer);
        }
        if (Array.isArray(value)) return value.map((v, i) => expand(v, `${path}/${i}`));
        return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expand(v, `${path}/${k}`)]));
      };
      expect(snapshot.taskRequirements).toEqual(expand(root.taskGoal, "#/taskGoal"));
      const projectedContext = { ...context, baseSnapshot: { ...snapshot,
        taskRequirements: { contextRef: "#/taskGoal" } } };
      const request = structuredClone(sample.request);
      request.messages[request.messages.length - 1].content = sample.prefix + JSON.stringify(projectedContext) + sample.suffix;
      const wireBytes = new TextEncoder().encode(JSON.stringify(request)).length;
      // Actual prior known usage: original third call before final disk sample,
      // original fourth call before redundant memory collection.
      const used = sample.previousKnownUsage;
      const available = 250000 - used;
      const requiredAtOriginalFloor = wireBytes + 1024 + 5000;
      expect(requiredAtOriginalFloor).toBeLessThanOrEqual(available);
      results.push({ 请求序号: sample.requestIndex, 原wire字节: sample.originalWireBytes, 保守重建wire字节: wireBytes,
        已知实际使用Token: used, 可用额度: available, 原输出下限: 5000, 原下限所需预留: requiredAtOriginalFloor,
        模型调用: 0, 远端执行: 0, 原正文完整可达: true, 真实归档接口调用数: 0, 模拟归档保存数: save.mock.calls.length,
        说明: "这是既有wire替换快照后的保守离线重建，未再native去重；UTF8字节不是实际Token，不预测模型必然完成。" });
    }
    const out = process.env.OPSARK_STAGE15_REPLAY_RESULT;
    if (out) writeFileSync(out, JSON.stringify({ 结果: results }, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
  });
});
