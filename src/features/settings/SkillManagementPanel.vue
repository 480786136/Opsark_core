<script setup lang="ts">
import { computed, ref } from "vue";
import { Plus, RotateCcw, Search, Sparkles, Trash2 } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import { validateSkillDefinition } from "@/features/skills/skillValidation";
import {
  SKILL_CATEGORY_IDS,
  SKILL_EFFECT_IDS,
  SKILL_OPERATION_IDS,
  type SkillCategory,
  type SkillEffect,
  type SkillOperation,
} from "@/features/skills/types";

const store = useOpsStore();
defineProps<{ standalone?: boolean }>();
const { t } = useI18n();
const query = ref("");
const categoryFilter = ref<SkillCategory | "all">("all");
const selectedSkillId = ref(store.skills[0]?.id ?? "");

const filteredSkills = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  return store.skills.filter((skill) => {
    if (categoryFilter.value !== "all" && skill.category !== categoryFilter.value) return false;
    if (!keyword) return true;
    return `${skill.name}\n${skill.id}\n${skill.description}\n${skill.matchRules.join("\n")}`
      .toLocaleLowerCase().includes(keyword);
  });
});

const filteredSkillGroups = computed(() => SKILL_CATEGORY_IDS
  .map((category) => ({
    category,
    skills: filteredSkills.value.filter((skill) => skill.category === category),
  }))
  .filter((group) => group.skills.length));

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
  if (message === "至少需要一项能力边界") return t("skills.capabilityRequired");
  if (message?.startsWith("正则表达式无效")) return t("skills.invalidRegex");
  const count = message?.match(/\d+/)?.[0];
  return count ? t("skills.maxChars", { count }) : message;
}

function hasCapability(operation: SkillOperation, effect: SkillEffect) {
  return selectedSkill.value?.capabilities.some((item) =>
    item.operation === operation && item.effect === effect,
  ) ?? false;
}

function toggleCapability(operation: SkillOperation, effect: SkillEffect, enabled: boolean) {
  if (!selectedSkill.value) return;
  selectedSkill.value.capabilities = enabled
    ? [...selectedSkill.value.capabilities, { operation, effect }]
    : selectedSkill.value.capabilities.filter((item) =>
      item.operation !== operation || item.effect !== effect,
    );
}

function addSkill() {
  const skill = store.addSkill();
  query.value = "";
  categoryFilter.value = "all";
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
        <select v-model="categoryFilter" class="skill-category-filter" :aria-label="t('skills.categoryFilter')">
          <option value="all">{{ t("skills.allCategories") }}</option>
          <option v-for="category in SKILL_CATEGORY_IDS" :key="category" :value="category">
            {{ t(`skills.categories.${category}`) }}
          </option>
        </select>
        <button class="skill-add-button" type="button" @click="addSkill">
          <Plus :size="13" />{{ t("skills.add") }}
        </button>
        <template v-for="group in filteredSkillGroups" :key="group.category">
          <p class="skill-category-heading">{{ t(`skills.categories.${group.category}`) }}<span>{{ group.skills.length }}</span></p>
          <button
            v-for="skill in group.skills"
            :key="skill.id"
            type="button"
            class="tool-list-item"
            :class="{ active: selectedSkill?.id === skill.id }"
            @click="selectedSkillId = skill.id"
          >
            <span><strong>{{ skill.name }}</strong><small>{{ skill.id }}</small></span>
            <i :class="{ enabled: skill.enabled }"></i>
          </button>
        </template>
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
          <span>{{ t("skills.category") }}</span>
          <select v-model="selectedSkill.category">
            <option v-for="category in SKILL_CATEGORY_IDS" :key="category" :value="category">
              {{ t(`skills.categories.${category}`) }}
            </option>
          </select>
          <small class="tool-field-hint">{{ t("skills.categoryHint") }}</small>
        </label>
        <label class="tool-field">
          <span>{{ t("skills.description") }}</span>
          <textarea v-model="selectedSkill.description" rows="3" maxlength="1000"></textarea>
          <small v-if="fieldError('description')" class="field-error">{{ fieldError("description") }}</small>
        </label>
        <fieldset class="tool-field skill-capability-field">
          <legend>{{ t("skills.capabilities") }}</legend>
          <small class="tool-field-hint">{{ t("skills.capabilitiesHint") }}</small>
          <div class="skill-capability-grid">
            <div class="skill-capability-head"></div>
            <strong v-for="effect in SKILL_EFFECT_IDS" :key="effect">
              {{ t(`skills.effects.${effect}`) }}
            </strong>
            <template v-for="operation in SKILL_OPERATION_IDS" :key="operation">
              <span>{{ t(`skills.operations.${operation}`) }}</span>
              <label v-for="effect in SKILL_EFFECT_IDS" :key="`${operation}-${effect}`">
                <input
                  type="checkbox"
                  :checked="hasCapability(operation, effect)"
                  @change="toggleCapability(operation, effect, ($event.target as HTMLInputElement).checked)"
                />
              </label>
            </template>
          </div>
          <small v-if="fieldError('capabilities')" class="field-error">{{ fieldError("capabilities") }}</small>
        </fieldset>
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
