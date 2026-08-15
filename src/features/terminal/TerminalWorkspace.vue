<script setup lang="ts">
import { computed, ref } from "vue";
import { Bot, Plus, TerminalSquare, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import TerminalPanel from "@/components/TerminalPanel.vue";
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
const notice = ref("");

sessionsStore.ensureWorkspace(props.serverId);

const sessions = computed(() => sessionsStore.sessionsByServer[props.serverId] ?? []);
const activeSessionId = computed(() => sessionsStore.activeSessionByServer[props.serverId]);
const server = computed(() => ops.servers.find(({ id }) => id === props.serverId));

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
</script>

<template>
  <section class="work-panel terminal-workspace terminal-tab-workspace">
    <header class="terminal-tabs-bar">
      <div class="terminal-tab-list" role="tablist">
        <div
          v-for="(session, index) in sessions"
          :key="session.id"
          :class="['terminal-workspace-tab', { active: activeSessionId === session.id }]"
          role="presentation"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="activeSessionId === session.id"
            :title="terminalTitle(index)"
            @click="sessionsStore.activateSession(serverId, session.id)"
          >
            <Bot
              v-if="session.panes[0]?.agentTaskId"
              :size="13"
              :class="['terminal-agent-mark', { running: isAgentBusy(session.panes[0].agentTaskId) }]"
            />
            <TerminalSquare v-else :size="13" />
            <span>{{ terminalTitle(index) }}</span>
          </button>
          <button
            type="button"
            class="terminal-tab-close"
            :title="t('terminal.closeTab')"
            @click.stop="closeTerminal(session.id)"
          ><X :size="12" /></button>
        </div>
      </div>
      <button type="button" class="terminal-add-tab" :title="t('terminal.newTab')" @click="addTerminal"><Plus :size="15" /></button>
    </header>

    <TerminalPanel
      v-for="session in sessions"
      v-show="activeSessionId === session.id"
      :key="session.id"
      :server-id="serverId"
      :session-id="session.panes[0].id"
      :agent-task-id="session.panes[0].agentTaskId"
      :active="workspaceActive && activeSessionId === session.id"
      @activate="sessionsStore.activateSession(serverId, session.id)"
      @status-change="sessionsStore.setPaneStatus(session.panes[0].id, $event)"
    />

    <Transition name="status-fade"><span v-if="notice" class="terminal-workspace-notice">{{ notice }}</span></Transition>
  </section>
</template>
