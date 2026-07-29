<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  ClipboardCheck,
  Clock3,
  History,
  KeyRound,
  ListTree,
  LoaderCircle,
  MessageSquarePlus,
  Play,
  Quote,
  Send,
  ShieldAlert,
  Square,
  Sparkles,
  TerminalSquare,
} from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";
import type { PermissionLevel, PlanStep } from "@/types";
import ModelSettingsModal from "@/components/ModelSettingsModal.vue";

const props = defineProps<{ serverId: string }>();
const store = useOpsStore();
const input = ref("");
const permission = ref<PermissionLevel>("safe");
const modelId = ref("");
const automationEnabled = ref(false);
const checkingModels = ref(false);
const showModelSettings = ref(false);
const showTasks = ref(true);
const expandedSteps = ref<string[]>([]);
const expandedRounds = ref<string[]>([]);
const expandedRecords = ref<string[]>([]);
const terminalReference = ref("");
const secretInput = ref("");
const timeline = ref<HTMLElement>();

const serverTasks = computed(() => store.tasks.filter((task) => task.serverId === props.serverId));
const task = computed(() => store.activeTask?.serverId === props.serverId ? store.activeTask : undefined);
const pendingApproval = computed(() => task.value?.plan.find((step) => step.status === "awaiting_approval"));
const pendingSecretRequest = computed(() =>
  store.pendingSecret?.taskId === task.value?.id ? store.pendingSecret : undefined,
);
const isBusy = computed(() => task.value && ["planning", "running", "validating"].includes(task.value.status));
const currentConversationMessages = computed(() => {
  if (!task.value) return [];
  const start = task.value.messages
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "user" && message.kind === "message")?.index ?? 0;
  return task.value.messages.slice(start).filter((message) => message.kind === "message");
});
const currentRecords = computed(() => {
  if (!task.value) return [];
  const start = task.value.messages
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "user" && message.kind === "message")?.index ?? -1;
  return task.value.messages.slice(start + 1).filter((message) => message.kind === "event");
});

watch(
  () => [task.value?.messages.length, task.value?.plan.length, task.value?.status],
  async () => {
    await nextTick();
    timeline.value?.scrollTo({ top: timeline.value.scrollHeight, behavior: "smooth" });
  },
);

function toggleStep(id: string) {
  expandedSteps.value = expandedSteps.value.includes(id)
    ? expandedSteps.value.filter((item) => item !== id)
    : [...expandedSteps.value, id];
}

async function submit() {
  const value = input.value.trim();
  if (!value || !automationEnabled.value || isBusy.value || !modelId.value) return;
  showTasks.value = false;
  input.value = "";
  await store.submitRequirement(props.serverId, value, permission.value, modelId.value, terminalReference.value);
  terminalReference.value = "";
}

function selectFirstAvailableModel() {
  if (!store.availableModels.some((model) => model.id === modelId.value)) {
    modelId.value = store.availableModels[0]?.id ?? "";
  }
}

async function enableAutomation() {
  automationEnabled.value = true;
  checkingModels.value = true;
  await store.refreshModelAvailability();
  selectFirstAvailableModel();
  checkingModels.value = false;
}

function handleModelSelection(event: Event) {
  const value = (event.target as HTMLSelectElement).value;
  if (value !== "__manage_models__") return;
  showModelSettings.value = true;
  selectFirstAvailableModel();
}

function modelOptionText(modelIdValue: string, name: string) {
  const availability = store.modelAvailability[modelIdValue];
  if (availability?.status === "available") return `${name} · 可用`;
  if (availability?.status === "checking") return `${name} · 检查中`;
  return `${name} · ${availability?.reason ?? "不可用"}`;
}

function handleModelsSaved() {
  selectFirstAvailableModel();
}

function referenceTerminal() {
  terminalReference.value = store.terminalLines.slice(-14).join("\n");
}

function riskText(step: PlanStep) {
  return step.risk === "low" ? "低风险" : step.risk === "medium" ? "中风险" : "高风险";
}

function statusText(status?: string) {
  const labels: Record<string, string> = {
    draft: "草稿",
    planning: "正在规划",
    awaiting_plan_approval: "等待批准计划",
    running: "正在执行",
    awaiting_step_approval: "等待步骤确认",
    awaiting_input: "等待输入",
    validating: "正在校验",
    needs_adjustment: "需要调整",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return status ? labels[status] ?? status : "";
}

function messageAuthor(role: "user" | "assistant" | "system") {
  return role === "user" ? "你" : role === "assistant" ? "Opsark" : "执行记录";
}

function toggleRound(id: string) {
  expandedRounds.value = expandedRounds.value.includes(id)
    ? expandedRounds.value.filter((item) => item !== id)
    : [...expandedRounds.value, id];
}

function toggleRecords(id: string) {
  expandedRecords.value = expandedRecords.value.includes(id)
    ? expandedRecords.value.filter((item) => item !== id)
    : [...expandedRecords.value, id];
}
</script>

<template>
  <section class="work-panel agent-panel">
    <header class="agent-header">
      <div class="agent-title"><Bot :size="18" /><strong>智能需求处理</strong><span class="beta">CORE</span></div>
      <button class="text-icon-button" @click="showTasks = !showTasks"><History :size="15" />任务</button>
    </header>

    <div v-if="!automationEnabled" class="agent-welcome">
      <div class="agent-orb"><Bot :size="28" /></div>
      <h2>开启智能运维</h2>
      <p>系统将采集服务器环境，为需求生成可审查、可验证的执行计划。</p>
      <div class="context-list">
        <span><Check :size="14" />系统与软件环境</span>
        <span><Check :size="14" />实时资源指标</span>
        <span><Check :size="14" />安全工具与变量元数据</span>
      </div>
      <button class="button primary wide" @click="enableAutomation"><Play :size="15" />开启智能运维</button>
      <small>{{ store.connectedServerIds.includes(serverId) ? "已连接真实 SSH；所有变更仍受授权与风险规则约束" : "未连接 SSH 时使用安全演示执行器，不会修改真实服务器" }}</small>
    </div>

    <template v-else>
      <div v-if="showTasks && serverTasks.length" class="task-strip">
        <button
          v-for="item in serverTasks"
          :key="item.id"
          :class="{ active: item.id === task?.id }"
          @click="store.selectTask(item.id); showTasks = false"
        >
          <span :class="['task-status-mini', item.status]"></span>
          <span><strong>{{ item.title }}</strong><small>{{ (item.planHistory?.length ?? 0) + (item.plan.length ? 1 : 0) }} 轮 · {{ statusText(item.status) }}</small></span>
        </button>
        <button class="new-task" @click="store.activeTaskId = null; showTasks = false"><MessageSquarePlus :size="14" />新任务</button>
      </div>

      <div ref="timeline" class="agent-timeline">
        <div v-if="!task" class="empty-agent">
          <div class="mini-orb"><Bot :size="22" /></div>
          <h3>今天想处理什么？</h3>
          <p>描述目标即可。我会先给出计划，不会直接执行。</p>
          <button @click="input = '检查服务器当前运行状态并给出优化建议'">检查系统状态</button>
          <button @click="input = '检查 Nginx 配置并安全重新加载服务'">检查 Nginx</button>
          <button @click="input = '分析磁盘空间占用并给出清理方案'">分析磁盘空间</button>
        </div>

        <template v-else>
          <template v-for="round in task.planHistory ?? []" :key="round.id">
            <div class="task-message user message user-aligned">
              <div class="message-body">
                <div class="message-meta">
                  <strong>你</strong>
                  <time>{{ new Date(round.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</time>
                </div>
                <p>{{ round.requirement }}</p>
              </div>
            </div>
            <div class="task-message assistant message">
              <div class="message-avatar"><Bot :size="15" /></div>
              <div class="message-body">
                <div class="message-meta">
                  <strong>Opsark</strong>
                  <time>{{ new Date(round.response?.createdAt ?? round.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</time>
                </div>
                <p>{{ round.response?.content ?? `已生成 ${round.plan.length} 个执行步骤。` }}</p>
              </div>
            </div>

            <div class="plan-card archived-plan">
              <button class="plan-card-head archived-head" @click="toggleRound(round.id)">
                <span>
                  <ClipboardCheck :size="15" />
                  <span><strong>历史执行计划</strong><small>{{ round.requirement }}</small></span>
                </span>
                <span>
                  <span class="history-time">{{ new Date(round.completedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</span>
                  <span :class="['task-state-pill', round.status]">{{ statusText(round.status) }}</span>
                  <ChevronDown v-if="expandedRounds.includes(round.id)" :size="15" />
                  <ChevronRight v-else :size="15" />
                </span>
              </button>
              <template v-if="expandedRounds.includes(round.id)">
                <div class="steps">
                  <div v-for="(step, index) in round.plan" :key="step.id" :class="['plan-step', step.status]">
                    <button class="step-main" @click="toggleStep(`history-${round.id}-${step.id}`)">
                      <span class="step-icon"><CheckCircle2 v-if="step.status === 'completed'" :size="17" /><Circle v-else :size="17" /></span>
                      <span class="step-copy"><strong>{{ index + 1 }}. {{ step.title }}</strong><small>{{ step.description }}</small></span>
                      <span :class="['risk-tag', step.risk]">{{ riskText(step) }}</span>
                      <ChevronDown v-if="expandedSteps.includes(`history-${round.id}-${step.id}`)" :size="15" />
                      <ChevronRight v-else :size="15" />
                    </button>
                    <div v-if="expandedSteps.includes(`history-${round.id}-${step.id}`)" class="step-detail">
                      <label>执行命令</label><code>{{ step.command }}</code>
                      <label>期望 / 校验</label><p>{{ step.expected }} · {{ step.validation }}</p>
                      <template v-if="step.review"><label>结果复核</label><p class="review-result">{{ step.review.summary }}（{{ step.review.reason }}）</p></template>
                    </div>
                  </div>
                </div>
              </template>
            </div>

            <div v-if="round.records?.length || round.plan.some((step) => step.output)" class="plan-card execution-record-card">
              <button class="plan-card-head archived-head" @click="toggleRecords(round.id)">
                <span><ListTree :size="15" /><span><strong>历史执行记录</strong><small>{{ round.records?.length ?? 0 }} 条过程记录</small></span></span>
                <span><ChevronDown v-if="expandedRecords.includes(round.id)" :size="15" /><ChevronRight v-else :size="15" /></span>
              </button>
              <div v-if="expandedRecords.includes(round.id)" class="execution-record-body">
                <div v-for="record in round.records ?? []" :key="record.id" class="execution-event-row">
                  <time>{{ new Date(record.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</time>
                  <span>{{ record.content }}</span>
                </div>
                <div v-for="step in round.plan.filter((item) => item.output)" :key="`output-${step.id}`" class="execution-output">
                  <strong>{{ step.title }}</strong><code>{{ step.command }}</code><pre>{{ step.output }}</pre>
                  <p v-if="step.review" class="execution-review">结果复核 · {{ step.review.summary }}（{{ step.review.reason }}）</p>
                </div>
              </div>
            </div>

            <div v-if="round.summary" class="summary-card archived-summary">
              <div class="summary-card-icon"><Sparkles :size="17" /></div>
              <div><span>本轮结果总结</span><p>{{ round.summary }}</p></div>
            </div>
          </template>

          <div
            v-for="message in currentConversationMessages"
            :key="message.id"
            :class="['task-message', message.role, message.kind, { 'user-aligned': message.role === 'user' }]"
          >
            <div v-if="message.role !== 'user'" class="message-avatar">
              <Bot v-if="message.role === 'assistant'" :size="15" />
              <TerminalSquare v-else :size="15" />
            </div>
            <div class="message-body">
              <div class="message-meta">
                <strong>{{ messageAuthor(message.role) }}</strong>
                <time>{{ new Date(message.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</time>
              </div>
              <p>{{ message.content }}</p>
            </div>
          </div>

          <div v-if="task.plan.length" class="plan-card">
            <div class="plan-card-head">
              <span><strong>当前执行计划</strong><small>{{ task.plan.filter((s) => ["completed", "skipped"].includes(s.status)).length }}/{{ task.plan.length }} 已处理</small></span>
              <span :class="['task-state-pill', task.status]">
                <LoaderCircle v-if="isBusy" class="spin" :size="13" />
                <Clock3 v-else-if="task.status.includes('awaiting')" :size="13" />
                <CheckCircle2 v-else-if="task.status === 'completed'" :size="13" />
                {{ statusText(task.status) }}
              </span>
            </div>
            <div class="steps">
              <div v-for="(step, index) in task.plan" :key="step.id" :class="['plan-step', step.status]">
                <button class="step-main" @click="toggleStep(step.id)">
                  <span class="step-icon">
                    <CheckCircle2 v-if="step.status === 'completed'" :size="17" />
                    <LoaderCircle v-else-if="['running', 'validating'].includes(step.status)" class="spin" :size="17" />
                    <ShieldAlert v-else-if="step.status === 'awaiting_approval'" :size="17" />
                    <KeyRound v-else-if="step.status === 'awaiting_input'" :size="17" />
                    <Circle v-else :size="17" />
                  </span>
                  <span class="step-copy"><strong>{{ index + 1 }}. {{ step.title }}</strong><small>{{ step.description }}</small></span>
                  <span :class="['risk-tag', step.risk]">{{ riskText(step) }}</span>
                  <ChevronDown v-if="expandedSteps.includes(step.id)" :size="15" />
                  <ChevronRight v-else :size="15" />
                </button>
                <div v-if="expandedSteps.includes(step.id)" class="step-detail">
                  <label>将执行</label><code>{{ step.command }}</code>
                  <label>期望 / 校验</label><p>{{ step.expected }} · {{ step.validation }}</p>
                  <template v-if="step.output"><label>执行输出</label><pre>{{ step.output }}</pre></template>
                  <template v-if="step.review"><label>结果复核</label><p class="review-result">{{ step.review.summary }}（{{ step.review.reason }}）</p></template>
                </div>
              </div>
            </div>
            <div v-if="task.status === 'awaiting_plan_approval'" class="approval-bar">
              <button class="button secondary" @click="store.rejectTask(task.id)"><Square :size="13" />取消</button>
              <button class="button primary" @click="store.approvePlan(task.id)"><Play :size="13" />批准并执行</button>
            </div>
            <div v-else-if="pendingApproval" class="approval-bar warning">
              <span><ShieldAlert :size="15" />此步骤需要确认</span>
              <button class="button secondary" @click="store.rejectTask(task.id)">停止</button>
              <button class="button primary" @click="store.approveStep(task.id, pendingApproval.id)">执行此步骤</button>
            </div>
            <form v-else-if="pendingSecretRequest" class="secret-input-bar" @submit.prevent="store.provideSecret(secretInput); secretInput = ''">
              <span><KeyRound :size="14" />{{ pendingSecretRequest.key }}</span>
              <input v-model="secretInput" type="password" autocomplete="off" placeholder="输入敏感值（仅本次会话）" autofocus />
              <button class="button primary" type="submit" :disabled="!secretInput">安全提交</button>
            </form>
            <div v-else-if="task.status === 'needs_adjustment'" class="approval-bar warning">
              <span><ShieldAlert :size="15" />校验未通过，任务已暂停</span>
              <button class="button secondary" @click="store.rejectTask(task.id)">结束任务</button>
              <button class="button primary" @click="store.adjustTask(task.id)">生成调整计划</button>
            </div>
          </div>

          <div v-if="currentRecords.length || task.plan.some((step) => step.output)" class="plan-card execution-record-card">
            <button class="plan-card-head archived-head" @click="toggleRecords('current')">
              <span><ListTree :size="15" /><span><strong>执行记录</strong><small>{{ currentRecords.length }} 条过程记录 · 下拉查看命令输出</small></span></span>
              <span><ChevronDown v-if="expandedRecords.includes('current')" :size="15" /><ChevronRight v-else :size="15" /></span>
            </button>
            <div v-if="expandedRecords.includes('current')" class="execution-record-body">
              <div v-for="record in currentRecords" :key="record.id" class="execution-event-row">
                <time>{{ new Date(record.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) }}</time>
                <span>{{ record.content }}</span>
              </div>
              <div v-for="step in task.plan.filter((item) => item.output)" :key="`current-output-${step.id}`" class="execution-output">
                <strong>{{ step.title }}</strong><code>{{ step.command }}</code><pre>{{ step.output }}</pre>
                <p v-if="step.review" class="execution-review">结果复核 · {{ step.review.summary }}（{{ step.review.reason }}）</p>
              </div>
            </div>
          </div>

          <div v-if="task.summary" class="summary-card">
            <div class="summary-card-icon"><Sparkles :size="17" /></div>
            <div><span>本轮结果总结</span><p>{{ task.summary }}</p></div>
          </div>
        </template>
      </div>

      <form class="composer" @submit.prevent="submit">
        <div v-if="terminalReference" class="context-chip">
          <Quote :size="12" /><span>已引用终端最近 {{ terminalReference.split('\n').length }} 行</span>
          <button type="button" @click="terminalReference = ''">×</button>
        </div>
        <textarea
          v-model="input"
          :disabled="Boolean(isBusy)"
          rows="3"
          :placeholder="task ? '继续补充需求或提出下一项操作；当前任务会保留上下文…' : '描述运维需求，Enter 换行…'"
        ></textarea>
        <div class="composer-tools">
          <button class="context-button" type="button" title="引用终端最近输出" @click="referenceTerminal"><Quote :size="13" />终端</button>
          <select v-model="modelId" title="模型" :class="{ 'model-select-empty': !modelId }" @change="handleModelSelection">
            <option v-if="checkingModels" value="" disabled>正在检查模型可用性…</option>
            <option v-else-if="!store.availableModels.length" value="" disabled>没有可用模型</option>
            <option
              v-for="model in store.models"
              :key="model.id"
              :value="model.id"
              :disabled="store.modelAvailability[model.id]?.status !== 'available'"
            >{{ modelOptionText(model.id, model.name) }}</option>
            <option value="__manage_models__">管理模型…</option>
          </select>
          <select v-model="permission" title="授权等级">
            <option value="observe">逐步确认</option>
            <option value="safe">安全模式</option>
            <option value="autonomous">自动执行</option>
          </select>
          <button class="send-button" type="submit" :disabled="!input.trim() || Boolean(isBusy) || !modelId"><Send :size="16" /></button>
        </div>
      </form>
    </template>
    <ModelSettingsModal
      :open="showModelSettings"
      @close="showModelSettings = false"
      @saved="handleModelsSaved"
    />
  </section>
</template>
