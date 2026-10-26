<script setup lang="ts">
import { computed } from "vue";
import type { OpsTask } from "@/types";
import { taskTerminalEvidenceSummary } from "@/features/agent/taskTerminalEvidence";
const props = defineProps<{ task: OpsTask }>();
const terminal = computed(() => taskTerminalEvidenceSummary(props.task));
const observations = computed(() => (props.task.observationWindows ?? []).slice(-5).reverse());
const visible = computed(() => observations.value.length || props.task.terminalEvidence || ["completed", "failed", "cancelled"].includes(props.task.status));
const time = (value?: string | number) => value === undefined ? "尚无记录" : new Date(value).toLocaleString("zh-CN");
const duration = (value?: number) => value === undefined ? "尚无记录" : `${(value / 1000).toFixed(2)} 秒`;
const stateText: Record<string, string> = { preparing: "准备中", observing: "观察中", matched: "已探测到期望状态", window_elapsed: "观察窗口到期",
  absolute_deadline: "绝对截止已到", cancelled: "观察已取消", unsupported: "缺少探测能力", invalid: "探测证据不完整", probe_timeout: "单次探测未按时返回", interrupted: "运行中断，结束时间未知" };
</script>

<template>
  <details v-if="visible" class="task-execution-timing">
    <summary>观察与结束记录</summary>
    <p>任务结束记录：{{ time(terminal.terminalAt) }}。此时间与远端命令退出、模型用量分别记录。</p>
    <template v-if="terminal.cancelRequestedAt">
      <p>取消请求：{{ time(terminal.cancelRequestedAt) }}</p>
      <p v-if="terminal.remoteState === 'exit_recorded'">原命令退出回执已保存：退出码 {{ terminal.exitCode }}，记录时间 {{ time(terminal.exitRecordedAt) }}。这不单独证明所有子进程均已退出。</p>
      <p v-else-if="terminal.remoteState === 'not_dispatched'">原命令已确认未派发。</p>
      <p v-else-if="terminal.remoteState === 'no_active_execution_recorded'">取消时没有登记活动命令；无法据此推断其他远程进程状态。</p>
      <p v-else>原远端命令退出仍待核对，取消请求不等于退出确认。</p>
    </template>
    <p v-if="terminal.modelRequestsWithMissingUsage">{{ terminal.modelRequestsWithMissingUsage }} 个模型请求尚未报告用量；不会计为零成本。</p>
    <article v-for="record in observations" :key="record.binding.executionId">
      <strong>{{ stateText[record.state] ?? record.state }}</strong>
      <span v-if="record.binding.roundId !== task.currentRoundId">（较早轮次）</span>
      <p>准备开始：{{ time(record.preparationStartedAt) }}；首次有效探测：{{ time(record.firstValidProbeAt) }}</p>
      <p>准备耗时：{{ duration(record.preparationElapsedMs) }}；实际观察：{{ duration(record.observationElapsedMs) }}；结束记录：{{ time(record.finishedAt) }}</p>
      <p>有效样本 {{ record.samples.filter(sample => sample.status === 'valid' && !sample.late).length }} 个；最大采样间隙 {{ duration(record.maxSampleGapMs) }}；{{ record.windowSatisfied ? '观察时长及末尾采样满足窗口' : '未完成整个采样窗口' }}。按间隔采样不证明期间连续可用或不可用。</p>
      <p v-if="record.persistenceError" role="alert">{{ record.persistenceError }}</p>
    </article>
  </details>
</template>

<style scoped>
.task-execution-timing { margin-top: 10px; font-size: 12px; line-height: 1.65; color: var(--text-secondary); }
summary { cursor: pointer; }
p { margin: 6px 0; }
article { margin-top: 10px; padding-top: 8px; border-top: 1px solid var(--border-color); }
</style>
