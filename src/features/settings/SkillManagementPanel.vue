<script setup lang="ts">
import { computed, ref } from "vue";
import { Plus, RotateCcw, Search, Sparkles, Trash2 } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import { validateSkillDefinition } from "@/features/skills/skillValidation";

const store = useOpsStore();
defineProps<{ standalone?: boolean }>();
const { t } = useI18n();
const query = ref("");
const selectedSkillId = ref(store.skills[0]?.id ?? "");

const filteredSkills = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  if (!keyword) return store.skills;
  return store.skills.filter((skill) =>
    `${skill.name}\n${skill.id}\n${skill.description}\n${skill.matchRules.join("\n")}`
      .toLocaleLowerCase().includes(keyword),
  );
});

const selectedSkill = computed(() =>
  filteredSkills.value.find((skill) => skill.id === selectedSkillId.value) ?? filteredSkills.value[0],
);
const rulesText = computed({
  get: () => selectedSkill.value?.matchRules.join("\n") ?? "",
  set: (value: string) => {
    if (selectedSkill.value) selectedSkill.value.matchRules = value.split(/\r?\n/);
  },
});
const validationIssues = computed(() => selectedSkill.value ? validateSkillDefinition(selectedSkill.value) : []);

function fieldError(field: string) {
  const message = validationIssues.value.find((issue) => issue.field === field)?.message;
  if (message === "此字段不能为空") return t("skills.required");
  if (message?.startsWith("正则表达式无效")) return t("skills.invalidRegex");
  const count = message?.match(/\d+/)?.[0];
  return count ? t("skills.maxChars", { count }) : message;
}

function addSkill() {
  const skill = store.addSkill();
  query.value = "";
  selectedSkillId.value = skill.id;
}

function removeSkill() {
  const skill = selectedSkill.value;
  if (!skill || skill.builtIn || !window.confirm(t("skills.removeConfirm", { name: skill.name }))) return;
  store.removeSkill(skill.id);
  query.value = "";
  selectedSkillId.value = store.skills[0]?.id ?? "";
}
</script>

<template>
  <section class="settings-card skill-management-card">
    <div v-if="!standalone" class="settings-title">
      <Sparkles :size="18" />
      <div><h2>{{ t("skills.title") }}</h2><p>{{ t("skills.subtitle") }}</p></div>
    </div>
    <div class="tool-management-layout">
      <aside class="tool-list-panel">
        <label class="tool-search">
          <Search :size="14" />
          <input v-model="query" type="search" :placeholder="t('skills.searchPlaceholder')" />
        </label>
        <button class="skill-add-button" type="button" @click="addSkill">
          <Plus :size="13" />{{ t("skills.add") }}
        </button>
        <button
          v-for="skill in filteredSkills"
          :key="skill.id"
          type="button"
          class="tool-list-item"
          :class="{ active: selectedSkill?.id === skill.id }"
          @click="selectedSkillId = skill.id"
        >
          <span><strong>{{ skill.name }}</strong><small>{{ skill.id }}</small></span>
          <i :class="{ enabled: skill.enabled }"></i>
        </button>
        <p v-if="!filteredSkills.length" class="tool-empty">{{ t("skills.empty") }}</p>
      </aside>

      <div v-if="selectedSkill" class="tool-editor">
        <div class="tool-editor-head">
          <div>
            <strong>{{ selectedSkill.id }}</strong>
            <small>{{ selectedSkill.builtIn ? t("skills.builtInVersion", { version: selectedSkill.version }) : t("skills.customVersion", { version: selectedSkill.version }) }}</small>
          </div>
          <label class="toggle" :title="t('skills.toggle')">
            <input v-model="selectedSkill.enabled" type="checkbox" /><i></i>
          </label>
        </div>
        <p v-if="!selectedSkill.enabled" class="tool-disabled-hint">{{ t("skills.disabledHint") }}</p>
        <label class="tool-field">
          <span>{{ t("skills.name") }}</span>
          <input v-model="selectedSkill.name" maxlength="80" />
          <small v-if="fieldError('name')" class="field-error">{{ fieldError("name") }}</small>
        </label>
        <label class="tool-field">
          <span>{{ t("skills.description") }}</span>
          <textarea v-model="selectedSkill.description" rows="3" maxlength="1000"></textarea>
          <small v-if="fieldError('description')" class="field-error">{{ fieldError("description") }}</small>
        </label>
        <label class="tool-field">
          <span>{{ t("skills.matchRules") }}</span>
          <textarea v-model="rulesText" rows="4" spellcheck="false"></textarea>
          <small class="tool-field-hint">{{ t("skills.matchRulesHint") }}</small>
          <small v-if="fieldError('matchRules')" class="field-error">{{ fieldError("matchRules") }}</small>
        </label>
        <label class="tool-field">
          <span>{{ t("skills.instructions") }}</span>
          <textarea v-model="selectedSkill.instructions" rows="12" maxlength="8000"></textarea>
          <small class="tool-field-hint">{{ t("skills.instructionsHint") }}</small>
          <small v-if="fieldError('instructions')" class="field-error">{{ fieldError("instructions") }}</small>
        </label>
        <div class="tool-editor-actions">
          <button v-if="selectedSkill.builtIn" class="button secondary" type="button" @click="store.resetSkill(selectedSkill.id)">
            <RotateCcw :size="14" />{{ t("skills.reset") }}
          </button>
          <button v-else class="button secondary skill-remove-button" type="button" @click="removeSkill">
            <Trash2 :size="14" />{{ t("skills.remove") }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
