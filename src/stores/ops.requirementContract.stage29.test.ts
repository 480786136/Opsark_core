import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { backend, ModelInvocationError } from "@/services/backend";
import { useConnectionStore } from "@/features/connection/connectionStore";
import { createTaskModelBudget, taskBudgetRegistration } from "@/features/agent/taskModelBudget";
import { useOpsStore } from "./ops";
const issue={code:"MODEL_REQUIREMENT_INVALID",stage:"requirement_contract",origin:"core" as const,retryable:false,jsonPointer:"/constraints/environmentPolicy",keyword:"enum",message:"约束字段非法"};
describe("第二十九批：真实需求提交链的语义失败归档（无真实模型）", () => {
 beforeEach(async () => {
  vi.useFakeTimers();vi.restoreAllMocks();localStorage.clear();Reflect.deleteProperty(window,"__TAURI_INTERNALS__");setActivePinia(createPinia());
  const store=useOpsStore();store.servers=[{id:"server",name:"fixture",host:"fixture.invalid",port:22,username:"fixture",group:"test",status:"offline",environment:[],createdAt:"2026-10-24",info:{os:"fixture",kernel:"fixture",cpu:"fixture",cores:1,memoryGb:1,diskGb:1,uptime:"fixture"}}];
  store.models=[{id:"model",name:"fixture",model:"fixture",provider:"fixture",endpoint:"https://fixture.invalid",enabled:true,hasApiKey:true}];store.modelApiKeys.model="fixture";
  vi.spyOn(backend,"loadCredential").mockResolvedValue(null);vi.spyOn(backend,"saveCredential").mockResolvedValue();vi.spyOn(backend,"checkSshConnection").mockResolvedValue();vi.spyOn(backend,"configureTaskCapabilities").mockResolvedValue();
  vi.spyOn(backend,"executeCommand").mockRejectedValue(new Error("禁止远端执行"));vi.spyOn(backend,"generatePlan").mockRejectedValue(new Error("禁止自动重规划"));
  vi.spyOn(backend,"processRequirement").mockRejectedValue(new ModelInvocationError("invalid",undefined,issue));
  await useConnectionStore().connect("server",{host:"fixture.invalid",port:22,username:"fixture",password:"fixture"});
 });
 afterEach(()=>{const store=useOpsStore();store.tasks.forEach(t=>{t.cancelRequested=true;});store.stopConnectionMonitor();store.persist(true);store.$dispose();vi.clearAllTimers();vi.useRealTimers();vi.restoreAllMocks();});
 it("具体首因进入暂停与持久快照，候选及旧批准不生效",async()=>{
  const store=useOpsStore();const task=store.createTask("server","observe","model",createTaskModelBudget(250000,250000));
  await store.submitRequirement("server","修改指定测试配置，执行前确认","observe","model","",task.id);
  const current=store.tasks.find(t=>t.id===task.id)!;
  expect(current.status).toBe("planning_failed");expect(current.plan).toEqual([]);expect(current.planApproval).toBeUndefined();
  expect(current.modelPlanningBlocker?.error).toMatchObject(issue);expect(current.pauseReason).toContain("constraints.environmentPolicy");
  expect(current.pauseReason).not.toContain("尚未就绪");expect(current.requirementLifecycle?.revision).toBe(0);
  const saved=JSON.parse(JSON.stringify(current));expect(saved.modelPlanningBlocker.error.jsonPointer).toBe("/constraints/environmentPolicy");
  expect(backend.processRequirement).toHaveBeenCalledOnce();expect(backend.generatePlan).not.toHaveBeenCalled();expect(backend.executeCommand).not.toHaveBeenCalled();
 });
 it("两级25万和同一任务身份不因语义失败重置，无后台重试",async()=>{
  const store=useOpsStore();const task=store.createTask("server","observe","model",createTaskModelBudget(250000,250000));const round=task.currentRoundId;
  await store.submitRequirement("server","修改前确认","observe","model","",task.id);
  const context=vi.mocked(backend.processRequirement).mock.calls[0][1].context;
  expect(taskBudgetRegistration(context)).toEqual({taskId:task.id,roundId:round,maxTaskTokens:250000,maxRoundTokens:250000,safetyReserveTokens:0});
  expect(store.tasks.find(t=>t.id===task.id)?.modelTokenBudget).toMatchObject({maxTaskTokens:250000,maxRoundTokens:250000});
  await vi.advanceTimersByTimeAsync(10000);expect(backend.processRequirement).toHaveBeenCalledOnce();expect(backend.generatePlan).not.toHaveBeenCalled();
 });
 it("持久记录重新加载仍保留具体语义首因，不触发自动模型请求",async()=>{
  const store=useOpsStore();const task=store.createTask("server","observe","model",createTaskModelBudget(250000,250000));task.status="planning_failed";
  store.recordModelPlanningBlocker(task,issue);task.pauseReason="旧泛化提示";store.persist(true);store.stopConnectionMonitor();store.$dispose();
  setActivePinia(createPinia());const restored=useOpsStore().tasks.find(t=>t.id===task.id)!;
  expect(restored.pauseReason).toContain("constraints.environmentPolicy");expect(restored.modelPlanningBlocker?.error).toMatchObject(issue);
  expect(restored.status).toBe("planning_failed");expect(backend.processRequirement).not.toHaveBeenCalled();expect(backend.generatePlan).not.toHaveBeenCalled();expect(backend.executeCommand).not.toHaveBeenCalled();
 });

});
