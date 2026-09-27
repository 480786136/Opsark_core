<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import type { ExecutionTargetRef } from "@/types";

const props = defineProps<{ targets?: readonly ExecutionTargetRef[] }>();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const roles: Record<ExecutionTargetRef["role"], [string, string]> = {
  execution: ["执行目标", "Execution target"], source: ["来源", "Source"], target: ["目的地", "Destination"],
  lookup: ["查询目标", "Lookup target"], connection: ["连接目标", "Connection target"], interaction: ["交互目标", "Interaction target"],
};
function endpoint(target: ExecutionTargetRef) {
  const host = target.host.includes(":") && !target.host.startsWith("[") ? `[${target.host}]` : target.host;
  const username = target.username?.includes("${secret.")
    ? (zh.value ? "已确认账户" : "Confirmed account") : target.username;
  return `${username ? `${username}@` : ""}${host}:${target.port}`;
}
</script>

<template>
  <div v-if="props.targets?.length" class="prepared-targets" :aria-label="zh ? '执行目标与范围' : 'Execution targets and scope'">
    <div v-for="(target, index) in props.targets" :key="index" class="prepared-target">
      <span class="target-role">{{ roles[target.role][zh ? 0 : 1] }}</span>
      <span class="target-identity">{{ endpoint(target) }}</span>
      <span v-if="target.path" class="target-path">{{ target.path }}</span>
      <span v-if="target.overwrite !== undefined" class="target-overwrite">
        {{ target.overwrite ? (zh ? '允许覆盖' : 'Overwrite allowed') : (zh ? '不覆盖已有文件' : 'Preserve existing files') }}
      </span>
      <span v-if="target.agentSession?.cwd" class="target-path">
        {{ zh ? '工作目录' : 'Working directory' }}: {{ target.agentSession.cwd }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.prepared-targets { display: grid; gap: 5px; padding: 0 12px 10px 38px; font-size: 12px; line-height: 1.5; }
.prepared-target { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; row-gap: 2px; }
.target-role { color: var(--text-muted, #64748b); }
.target-identity, .target-path { font-family: var(--font-mono, monospace); overflow-wrap: anywhere; }
.target-overwrite { color: var(--text-muted, #64748b); }
</style>
