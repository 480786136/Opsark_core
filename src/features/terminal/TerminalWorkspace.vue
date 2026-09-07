<script setup lang="ts">
import { computed, ref, watchEffect } from "vue";
import { Bot, Plus, TerminalSquare, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import TerminalPanel from "@/components/TerminalPanel.vue";
import AgentTerminalPanel from "./AgentTerminalPanel.vue";
import { useAgentTerminalStore } from "./agentTerminalStore";
import { useOpsStore } from "@/stores/ops";
import {
  MAX_SESSIONS_PER_SERVER,
  useTerminalSessionStore,
} from "./terminalSessionStore";

const props = withDefaults(defineProps<{ serverId: string; workspaceActive?: boolean }>(), {
  workspaceActive: true,
});
const { t } = useI18n();
const ops = useOpsStore();
const sessionsStore = useTerminalSessionStore();
const agentTerminals = useAgentTerminalStore();
const notice = ref("");

sessionsStore.ensureWorkspace(props.serverId);

const sessions = computed(() => sessionsStore.sessionsByServer[props.serverId] ?? []);
const activeSessionId = computed(() => sessionsStore.activeSessionByServer[props.serverId]);
const server = computed(() => ops.servers.find(({ id }) => id === props.serverId));
const agentTasks = computed(() => ops.tasks.filter((task) => (
  (task.executionTargetServerId ?? task.serverId) === props.serverId
  && Boolean(task.agentSessionId)
  && !agentTerminals.isTaskHidden(props.serverId, task.id)
)));
const activeAgentTaskId = computed(() => agentTerminals.activeTaskByServer[props.serverId]);

watchEffect(() => agentTasks.value.forEach((task) => agentTerminals.restoreHistoricalTask(task)));

function terminalTitle(index: number) {
  if (!server.value) return `${t("terminal.shell")} · ${index + 1}`;
  return `${t("terminal.shell")} · ${server.value.username}@${server.value.host} · ${index + 1}`;
}

function isAgentBusy(taskId?: string) {
  const task = ops.tasks.find(({ id }) => id === taskId);
  return Boolean(task && ["planning", "running", "validating"].includes(task.status));
}

function addTerminal() {
  if (sessions.value.length >= MAX_SESSIONS_PER_SERVER || !sessionsStore.addSession(props.serverId)) {
    notice.value = t("terminal.maxTabs");
    window.setTimeout(() => (notice.value = ""), 2_000);
  }
}

function closeTerminal(sessionId: string) {
  sessionsStore.removeSession(props.serverId, sessionId);
}

function activateShell(sessionId: string) {
  agentTerminals.activateTask(props.serverId, undefined);
  sessionsStore.activateSession(props.serverId, sessionId);
}

function activateAgent(taskId: string) {
  agentTerminals.activateTask(props.serverId, taskId);
}

function closeAgentTerminal(taskId: string) {
  const wasActive = activeAgentTaskId.value === taskId;
  agentTerminals.dismissTask(props.serverId, taskId);
  if (wasActive && activeSessionId.value) {
    sessionsStore.activateSession(props.serverId, activeSessionId.value);
  }
}
</script>

<template>
  <section class="work-panel terminal-workspace terminal-tab-workspace">
    <header class="terminal-tabs-bar">
      <div class="terminal-tab-list" role="tablist">
        <div
          v-for="(session, index) in sessions"
          :key="session.id"
          :class="['terminal-workspace-tab', { active: !activeAgentTaskId && activeSessionId === session.id }]"
          role="presentation"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="!activeAgentTaskId && activeSessionId === session.id"
            :title="terminalTitle(index)"
            @click="activateShell(session.id)"
          >
            <TerminalSquare :size="13" />
            <span>{{ terminalTitle(index) }}</span>
          </button>
          <button
            type="button"
            class="terminal-tab-close"
            :title="t('terminal.closeTab')"
            @click.stop="closeTerminal(session.id)"
          ><X :size="12" /></button>
        </div>
        <div
          v-for="task in agentTasks"
          :key="`agent-${task.id}`"
          :class="['terminal-workspace-tab', 'agent-sandbox-tab', { active: activeAgentTaskId === task.id }]"
          role="presentation"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="activeAgentTaskId === task.id"
            :title="`Agent · ${task.title}`"
            @click="activateAgent(task.id)"
          >
            <Bot :size="13" :class="['terminal-agent-mark', { running: isAgentBusy(task.id) }]" />
            <span>Agent · {{ task.title }}</span>
          </button>
          <button type="button" class="terminal-tab-close" title="关闭 Agent 终端" @click.stop="closeAgentTerminal(task.id)"><X :size="12" /></button>
        </div>
      </div>
      <button type="button" class="terminal-add-tab" :title="t('terminal.newTab')" @click="addTerminal"><Plus :size="15" /></button>
    </header>

    <TerminalPanel
      v-for="session in sessions"
      v-show="!activeAgentTaskId && activeSessionId === session.id"
      :key="session.id"
      :server-id="serverId"
      :session-id="session.panes[0].id"
      :active="workspaceActive && activeSessionId === session.id"
      @activate="sessionsStore.activateSession(serverId, session.id)"
      @status-change="sessionsStore.setPaneStatus(session.panes[0].id, $event)"
    />

    <AgentTerminalPanel
      v-for="task in agentTasks"
      v-show="activeAgentTaskId === task.id"
      :key="`agent-panel-${task.id}`"
      :task-id="task.id"
      :active="workspaceActive && activeAgentTaskId === task.id"
    />

    <Transition name="status-fade"><span v-if="notice" class="terminal-workspace-notice">{{ notice }}</span></Transition>
  </section>
</template>
