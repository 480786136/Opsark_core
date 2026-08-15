<script setup lang="ts">
import { computed, ref } from "vue";
import { RotateCcw, Search, Wrench } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import { validateToolDefinition } from "@/features/tools/toolValidation";

const store = useOpsStore();
const { t } = useI18n();
const query = ref("");
const selectedToolId = ref(store.tools[0]?.id ?? "");

const filteredTools = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  if (!keyword) return store.tools;
  return store.tools.filter((tool) =>
    `${tool.name}\n${tool.id}\n${tool.description}`.toLocaleLowerCase().includes(keyword),
  );
});

const selectedTool = computed(() =>
  filteredTools.value.find((tool) => tool.id === selectedToolId.value) ?? filteredTools.value[0],
);

const validationIssues = computed(() => selectedTool.value
  ? validateToolDefinition(selectedTool.value)
  : [],
);

function fieldError(field: string) {
  const message = validationIssues.value.find((issue) => issue.field === field)?.message;
  if (message === "此字段不能为空") return t("tools.required");
  const count = message?.match(/\d+/)?.[0];
  return count ? t("tools.maxChars", { count }) : message;
}
</script>

<template>
  <section class="settings-card tool-management-card">
    <div class="settings-title">
      <Wrench :size="18" />
      <div>
        <h2>{{ t("tools.title") }}</h2>
        <p>{{ t("tools.subtitle") }}</p>
      </div>
    </div>
    <div class="tool-management-layout">
      <aside class="tool-list-panel">
        <label class="tool-search">
          <Search :size="14" />
          <input v-model="query" type="search" :placeholder="t('tools.searchPlaceholder')" />
        </label>
        <button
          v-for="tool in filteredTools"
          :key="tool.id"
          type="button"
          class="tool-list-item"
          :class="{ active: selectedTool?.id === tool.id }"
          @click="selectedToolId = tool.id"
        >
          <span><strong>{{ tool.name }}</strong><small>{{ tool.id }}</small></span>
          <i :class="{ enabled: tool.enabled }"></i>
        </button>
        <p v-if="!filteredTools.length" class="tool-empty">{{ t("tools.empty") }}</p>
      </aside>

      <div v-if="selectedTool" class="tool-editor">
        <div class="tool-editor-head">
          <div><strong>{{ selectedTool.id }}</strong><small>{{ t("tools.builtInVersion", { version: selectedTool.version }) }}</small></div>
          <label class="toggle" :title="t('tools.toggle')">
            <input v-model="selectedTool.enabled" type="checkbox" /><i></i>
          </label>
        </div>
        <p v-if="!selectedTool.enabled" class="tool-disabled-hint">{{ t("tools.disabledHint") }}</p>
        <label class="tool-field">
          <span>{{ t("tools.name") }}</span>
          <input v-model="selectedTool.name" maxlength="80" />
          <small v-if="fieldError('name')" class="field-error">{{ fieldError("name") }}</small>
        </label>
        <label class="tool-field">
          <span>{{ t("tools.description") }}</span>
          <textarea v-model="selectedTool.description" rows="3" maxlength="1000"></textarea>
          <small v-if="fieldError('description')" class="field-error">{{ fieldError("description") }}</small>
        </label>
        <label class="tool-field">
          <span>{{ t("tools.usage") }}</span>
          <textarea v-model="selectedTool.usageInstructions" rows="4" maxlength="2000"></textarea>
          <small v-if="fieldError('usageInstructions')" class="field-error">{{ fieldError("usageInstructions") }}</small>
        </label>
        <label class="tool-field">
          <span>{{ t("tools.output") }}</span>
          <textarea v-model="selectedTool.outputDescription" rows="3" maxlength="1000"></textarea>
          <small v-if="fieldError('outputDescription')" class="field-error">{{ fieldError("outputDescription") }}</small>
        </label>
        <label class="tool-field">
          <span>{{ t("tools.schema") }}</span>
          <pre>{{ JSON.stringify(selectedTool.inputSchema, null, 2) }}</pre>
        </label>
        <div class="tool-editor-actions">
          <button class="button secondary" type="button" @click="store.resetTool(selectedTool.id)">
            <RotateCcw :size="14" />{{ t("tools.reset") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
