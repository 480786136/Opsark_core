<script setup lang="ts">
import { onBeforeUnmount, onDeactivated, onMounted, ref } from "vue";
import { Bot, Check, Columns3, FolderTree, SquareTerminal } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import {
  useWorkspaceLayoutStore,
  type WorkspaceLayoutPreset,
  type WorkspacePanel,
} from "./workspaceLayoutStore";

const { t, locale } = useI18n();
const panelLabel = (panel: WorkspacePanel) => locale.value.startsWith("zh") ? ({ files: "文件", terminal: "终端", agent: "AI 助手" })[panel] : ({ files: "Files", terminal: "Terminal", agent: "AI assistant" })[panel];
const layout = useWorkspaceLayoutStore();
const root = ref<HTMLElement>();
const menuOpen = ref(false);
onDeactivated(() => { menuOpen.value = false; });

const presetOptions: Array<{ id: WorkspaceLayoutPreset; labelKey: string }> = [
  { id: "shell", labelKey: "workspace.layoutShell" },
  { id: "balanced", labelKey: "workspace.layoutBalanced" },
  { id: "files", labelKey: "workspace.layoutFiles" },
  { id: "agent", labelKey: "workspace.layoutAgent" },
];
const focusOptions = [
  { id: "files" as const, icon: FolderTree, labelKey: "workspace.focusFiles" },
  { id: "terminal" as const, icon: SquareTerminal, labelKey: "workspace.focusTerminal" },
  { id: "agent" as const, icon: Bot, labelKey: "workspace.focusAgent" },
];

function applyPreset(preset: WorkspaceLayoutPreset) {
  layout.applyPreset(preset);
  menuOpen.value = false;
}

function toggleFocus(panel: WorkspacePanel) {
  layout.togglePanel(panel);
  menuOpen.value = false;
}

function closeFromOutside(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node)) menuOpen.value = false;
}

onMounted(() => document.addEventListener("pointerdown", closeFromOutside));
onBeforeUnmount(() => document.removeEventListener("pointerdown", closeFromOutside));
</script>

<template>
  <div ref="root" class="workspace-layout-controls">
    <button
      :class="['workspace-layout-button', { active: menuOpen }]"
      type="button"
      :title="t('workspace.layout')"
      :aria-label="t('workspace.layout')"
      :aria-expanded="menuOpen"
      @click="menuOpen = !menuOpen"
    >
      <Columns3 :size="15" />
    </button>
    <div class="workspace-focus-controls" role="group" :aria-label="t('workspace.focusMode')">
      <button
        v-for="item in focusOptions"
        :key="item.id"
        :class="{ active: layout.visiblePanels[item.id] }"
        type="button"
        :title="panelLabel(item.id)"
        :aria-label="panelLabel(item.id)"
        :aria-pressed="layout.visiblePanels[item.id]"
        @click="toggleFocus(item.id)"
      >
        <component :is="item.icon" :size="14" />
      </button>
    </div>
    <Transition name="layout-menu">
      <div v-if="menuOpen" class="workspace-layout-menu">
        <strong>{{ t("workspace.layoutPreset") }}</strong>
        <button
          v-for="option in presetOptions"
          :key="option.id"
          type="button"
          :class="{ active: layout.preset === option.id }"
          @click="applyPreset(option.id)"
        >
          <span>{{ t(option.labelKey) }}</span>
          <Check v-if="layout.preset === option.id" :size="13" />
        </button>
      </div>
    </Transition>
  </div>
</template>
