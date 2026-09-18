<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Cloud, CloudUpload, LoaderCircle, Plus, RotateCcw, Save, Search, Sparkles, Trash2, TriangleAlert, WandSparkles, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useRouter } from "vue-router";
import { useOpsStore } from "@/stores/ops";
import ParameterSelect, { type ParameterSelectOption } from "@/components/ParameterSelect.vue";
import { validateSkillDefinition } from "@/features/skills/skillValidation";
import {
  SKILL_CATEGORY_IDS,
  type GeneratedSkillDraft,
  type SkillCategory,
} from "@/features/skills/types";
import { createRuntimeModel } from "@/features/agent/modelRuntime";
import { backend, modelServiceError } from "@/services/backend";
import ConfirmActionDialog from "@/components/ConfirmActionDialog.vue";
import { useActionConfirmation } from "@/components/useActionConfirmation";
import { localizeCoreText } from "@/features/preferences/coreText";
import { useAccountStore } from "@/features/account/accountStore";
import { useOfficialCatalogStore } from "@/features/account/officialCatalogStore";
import { formatCredits } from "@/features/account/credits";
import { useSkillAutoSyncStore } from "@/features/skills/skillAutoSync";
const { confirmationMessage, confirmAction, resolveConfirmation } = useActionConfirmation();

const store = useOpsStore();
const account = useAccountStore();
const officialCatalog = useOfficialCatalogStore();
const skillSync = useSkillAutoSyncStore();
const router = useRouter();
defineProps<{ standalone?: boolean }>();
const { t, locale } = useI18n();
const query = ref("");
const categoryFilter = ref<SkillCategory | "all">("all");
const selectedSkillId = ref(store.skills.find(skill => !skill.builtIn)?.id ?? "");
const authoringRequirement = ref("");
const authoringModelId = ref(store.availableModels[0]?.id ?? store.enabledModels[0]?.id ?? "");
const authoringBusy = ref(false);
const authoringAction = ref<"generate" | "optimize">();
const authoringError = ref("");
const preview = ref<GeneratedSkillDraft>();
const previewTargetId = ref("");
const saveState = ref<"idle" | "saving" | "saved" | "error">("idle");
const savedFingerprints = ref<Record<string, string>>({});
const categoryOptions = computed(() => SKILL_CATEGORY_IDS.map((category) => ({
  value: category,
  label: t(`skills.categories.${category}`),
})));
const categoryFilterOptions = computed(() => [
  { value: "all", label: t("skills.allCategories") },
  ...categoryOptions.value,
]);
const modelOptions = computed<ParameterSelectOption[]>(() => [...store.enabledModels.map((model) => {
  const availability = store.modelAvailability[model.id];
  const available = availability?.status === "available";
  const status = availability?.status === "checking"
    ? t("skills.aiModelChecking")
    : availability?.status === "unavailable"
      ? t("skills.aiModelUnavailable")
      : availability?.status === "available" ? "" : t("skills.aiModelUnchecked");
  return {
    value: model.id,
    label: model.source === "official" && account.current
      ? `${model.name} · ${model.model} · 剩余 ${formatCredits(account.current.balance.available)} 积分${status ? ` · ${status}` : ""}`
      : `${model.name} · ${model.model}${status ? ` · ${status}` : ""}`,
    disabled: !available,
  };
}), ...(!account.current ? officialCatalog.models.map(model => ({
  value: `__official_login__:${model.id}`,
  label: `${model.name} · 登录后使用官方模型 · 点击登录`,
  action: true,
})) : [])]);
const hasAuthoringModel = computed(() => modelOptions.value.some(option => !option.disabled && !option.action));
const authoringNeedsAccount = computed(() => /(?:401|Unauthorized|请登录 OpsArk|重新登录|余额|额度)/i.test(authoringError.value));
const authoringErrorMessage = computed(() => {
  if (/(?:401|Unauthorized|请登录 OpsArk|重新登录)/i.test(authoringError.value)) return "登录状态已失效，请重新登录后再试。";
  return authoringError.value.replace(/^Skill 生成接口返回\s*/i, "");
});

const filteredSkills = computed(() => {
  const keyword = query.value.trim().toLocaleLowerCase();
  return store.skills.filter((skill) => {
    if (skill.builtIn) return false;
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
const skillFingerprint = (skill: NonNullable<typeof selectedSkill.value>) => JSON.stringify({
  name: skill.name,
  category: skill.category,
  description: skill.description,
  matchRules: skill.matchRules,
  instructions: skill.instructions,
  enabled: skill.enabled,
});
for (const skill of store.skills.filter(skill => !skill.builtIn)) savedFingerprints.value[skill.id] = skillFingerprint(skill);
const hasUnsavedChanges = computed(() => Boolean(selectedSkill.value
  && savedFingerprints.value[selectedSkill.value.id] !== skillFingerprint(selectedSkill.value)));
const hasSkillContent = computed(() => {
  const skill = selectedSkill.value;
  return Boolean(skill && [skill.name, skill.description, skill.instructions, ...skill.matchRules]
    .some(value => value.trim()));
});
function formatLocalDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return new Intl.DateTimeFormat(locale.value.startsWith("zh") ? "zh-CN" : locale.value, {
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

watch(modelOptions, (options) => {
  if (!options.some(option => option.value === authoringModelId.value && !option.disabled && !option.action)) {
    authoringModelId.value = options.find(option => !option.disabled && !option.action)?.value ?? "";
  }
}, { immediate: true });
onMounted(() => { if (import.meta.env.MODE !== "test") void officialCatalog.refresh(); });
function handleAuthoringModelAction(value: string) {
  if (value.startsWith("__official_login__:")) void router.push("/account");
}
watch(selectedSkillId, () => {
  preview.value = undefined;
  previewTargetId.value = "";
  authoringError.value = "";
  saveState.value = "idle";
  const skill = selectedSkill.value;
  if (skill && savedFingerprints.value[skill.id] === undefined) savedFingerprints.value[skill.id] = skillFingerprint(skill);
});

function fieldError(field: string) {
  const message = validationIssues.value.find((issue) => issue.field === field)?.message;
  if (message === "此字段不能为空") return t("skills.required");
  if (message?.startsWith("正则表达式无效")) return t("skills.invalidRegex");
  const count = message?.match(/\d+/)?.[0];
  return count ? t("skills.maxChars", { count }) : message;
}

function actionableAuthoringError(error: unknown) {
  if (modelServiceError(error)) return true;
  return /(?:余额|额度|密钥|api\s*key|认证|未授权|unauthorized|\b401\b|模型不存在|model not found)/i
    .test(error instanceof Error ? error.message : String(error));
}

function addSkill() {
  const skill = store.addSkill();
  query.value = "";
  categoryFilter.value = "all";
  authoringRequirement.value = "";
  // A new Skill must be saved locally before cloud synchronization is enabled.
  savedFingerprints.value[skill.id] = "";
  selectedSkillId.value = skill.id;
}

function saveSkill() {
  const skill = selectedSkill.value;
  if (!skill || skill.builtIn || !hasUnsavedChanges.value || validationIssues.value.length || saveState.value === "saving") return;
  saveState.value = "saving";
  try {
    skill.updatedAt = new Date().toISOString();
    store.saveSkill(skill.id);
    const saved = store.skills.find(item => item.id === skill.id);
    if (saved) savedFingerprints.value[skill.id] = skillFingerprint(saved);
    saveState.value = "saved";
    window.setTimeout(() => { if (saveState.value === "saved") saveState.value = "idle"; }, 1800);
  } catch {
    saveState.value = "error";
  }
}

async function removeSkill() {
  const skill = selectedSkill.value;
  if (!skill || skill.builtIn || !await confirmAction(t("skills.removeConfirm", { name: skill.name }))) return;
  store.removeSkill(skill.id);
  delete savedFingerprints.value[skill.id];
  query.value = "";
  selectedSkillId.value = store.skills.find(item => !item.builtIn)?.id ?? "";
}

function updateCategoryFilter(value: string) {
  categoryFilter.value = value as SkillCategory | "all";
}

function updateSelectedCategory(value: string) {
  if (selectedSkill.value) selectedSkill.value.category = value as SkillCategory;
}

async function authorSkill(mode: "generate" | "optimize") {
  const target = selectedSkill.value;
  const suppliedRequirement = authoringRequirement.value.trim();
  if (!target || authoringBusy.value || (mode === "generate" && !suppliedRequirement)
    || (mode === "optimize" && !hasSkillContent.value)) return;
  const requirement = suppliedRequirement
    || "请在保留当前 Skill 原意的基础上，优化结构、表达清晰度、处理阶段、失败条件和验收标准。";
  authoringBusy.value = true;
  authoringAction.value = mode;
  authoringError.value = "";
  preview.value = undefined;
  const targetId = target.id;
  try {
    await store.hydrateCredentials();
    const model = store.models.find(item => item.id === authoringModelId.value && item.enabled);
    const runtime = createRuntimeModel(model, model ? store.modelApiKeys[model.id] : undefined, "");
    if (!runtime) throw new Error(model ? `“${model.name}”缺少可用凭据，请先在大模型配置中保存并检查。` : "请选择可用模型。");
    const current: GeneratedSkillDraft = {
      name: target.name,
      category: target.category,
      description: target.description,
      matchRules: [...target.matchRules],
      instructions: target.instructions,
    };
    let generated: GeneratedSkillDraft | undefined;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const candidate = await backend.generateSkill(requirement, mode, runtime, mode === "optimize" ? current : undefined);
        const issues = validateSkillDefinition({ ...target, ...candidate });
        if (issues.length) throw new Error(`生成内容未通过校验：${issues[0]!.message}`);
        generated = candidate;
        break;
      } catch (error) {
        lastError = error;
        if (actionableAuthoringError(error)) break;
      }
    }
    if (!generated) {
      // Transient model/provider failures are retried silently. Only structured
      // account conditions such as insufficient balance are shown to the user.
      if (!actionableAuthoringError(lastError)) return;
      throw lastError;
    }
    if (selectedSkill.value?.id !== targetId) return;
    preview.value = generated;
    previewTargetId.value = targetId;
  } catch (error) {
    if (selectedSkill.value?.id === targetId) {
      authoringError.value = error instanceof Error ? error.message : String(error);
      if (/(?:401|Unauthorized|请登录 OpsArk|重新登录)/i.test(authoringError.value)) account.expireSession();
    }
  } finally {
    authoringBusy.value = false;
    authoringAction.value = undefined;
  }
}

function applyPreview() {
  const target = selectedSkill.value;
  const generated = preview.value;
  if (!target || !generated || target.id !== previewTargetId.value) return;
  target.name = generated.name;
  target.category = generated.category;
  target.description = generated.description;
  target.matchRules = [...generated.matchRules];
  target.instructions = generated.instructions;
  preview.value = undefined;
  previewTargetId.value = "";
}

function closePreview() {
  preview.value = undefined;
  previewTargetId.value = "";
}
</script>

<template>
  <ConfirmActionDialog :message="confirmationMessage" :title="t('skills.removeTitle')" :confirm-label="t('skills.removeConfirmAction')" @result="resolveConfirmation" />
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
        <ParameterSelect
          :model-value="categoryFilter"
          class="skill-category-select"
          size="small"
          :options="categoryFilterOptions"
          :ariaLabel="t('skills.categoryFilter')"
          @update:model-value="updateCategoryFilter"
        />
        <button class="skill-add-button" type="button" @click="addSkill">
          <Plus :size="13" />{{ t("skills.add") }}
        </button>
        <div class="tool-list-scroll">
          <template v-for="group in filteredSkillGroups" :key="group.category">
            <p class="skill-category-heading">{{ t(`skills.categories.${group.category}`) }}<span>{{ group.skills.length }}</span></p>
            <button
              v-for="skill in group.skills"
              :key="skill.id"
              type="button"
              class="tool-list-item"
              :class="{ active: selectedSkill?.id === skill.id }"
              :aria-pressed="selectedSkill?.id === skill.id"
              @click="selectedSkillId = skill.id"
            >
              <span><strong>{{ skill.name || "未命名 Skill" }}</strong><small>{{ skill.id }}</small></span>
              <i :class="{ enabled: skill.enabled }"></i>
            </button>
          </template>
          <p v-if="!filteredSkills.length" class="tool-empty">{{ t("skills.empty") }}</p>
        </div>
      </aside>

      <div v-if="selectedSkill" class="tool-editor">
        <div class="tool-editor-head">
          <div>
            <span class="skill-id-line"><strong>{{ selectedSkill.id }}</strong><button v-if="account.current" type="button" class="skill-cloud-state" :class="{ editing: hasUnsavedChanges, pending: !hasUnsavedChanges && !skillSync.isSynced(selectedSkill.id), synced: !hasUnsavedChanges && skillSync.isSynced(selectedSkill.id) }" :disabled="skillSync.busy || hasUnsavedChanges || skillSync.isSynced(selectedSkill.id)" :aria-label="hasUnsavedChanges ? '请先保存 Skill' : skillSync.isSynced(selectedSkill.id) ? '已同步到云端' : '同步此 Skill'" @click="skillSync.syncSkill(selectedSkill.id)"><Cloud v-if="skillSync.isSynced(selectedSkill.id) && !hasUnsavedChanges" :size="14"/><CloudUpload v-else :size="14"/></button></span>
            <small>{{ selectedSkill.builtIn ? t("skills.builtInVersion", { version: selectedSkill.version }) : t("skills.localVersion", { date: formatLocalDate(selectedSkill.updatedAt) }) }}</small>
          </div>
          <label class="toggle" :title="t('skills.toggle')">
            <input v-model="selectedSkill.enabled" type="checkbox" /><i></i>
          </label>
        </div>
        <p v-if="!selectedSkill.enabled" class="tool-disabled-hint">{{ t("skills.disabledHint") }}</p>
        <div class="skill-top-grid">
          <div class="skill-basic-fields">
            <label class="tool-field">
              <span>{{ t("skills.name") }}</span>
              <input v-model="selectedSkill.name" maxlength="80" placeholder="新建 Skill" />
              <small v-if="fieldError('name')" class="field-error">{{ fieldError("name") }}</small>
            </label>
            <div class="tool-field">
              <span>{{ t("skills.category") }}</span>
              <ParameterSelect
                :model-value="selectedSkill.category"
                class="skill-editor-category-select"
                size="small"
                :options="categoryOptions"
                :ariaLabel="t('skills.category')"
                @update:model-value="updateSelectedCategory"
              />
              <small class="tool-field-hint">{{ t("skills.categoryHint") }}</small>
            </div>
            <label class="tool-field">
              <span>{{ t("skills.description") }}</span>
              <textarea v-model="selectedSkill.description" rows="5" maxlength="1000" placeholder="说明这个 Skill 负责处理的业务场景。"></textarea>
              <small v-if="fieldError('description')" class="field-error">{{ fieldError("description") }}</small>
            </label>
          </div>
          <section class="skill-authoring" aria-labelledby="skill-authoring-title">
            <div class="skill-authoring-title">
              <span class="skill-authoring-icon"><WandSparkles :size="16" /></span>
              <div><strong id="skill-authoring-title">{{ t("skills.aiTitle") }}</strong><div class="skill-authoring-guide"><span><b>生成</b> 填写需求</span><span><b>优化</b> 使用左侧表单，可补充要求</span></div></div>
            </div>
            <label class="tool-field skill-authoring-prompt">
              <span>{{ t("skills.aiRequirement") }}</span>
              <textarea v-model="authoringRequirement" rows="4" maxlength="8000" :placeholder="t('skills.aiRequirementPlaceholder')"></textarea>
            </label>
            <div class="skill-authoring-controls">
              <label class="tool-field skill-authoring-model">
                <span>{{ t("skills.aiModel") }}</span>
                <ParameterSelect v-model="authoringModelId" size="small" :options="modelOptions" :ariaLabel="t('skills.aiModel')" :placeholder="t('skills.aiNoModel')" @option-action="handleAuthoringModelAction" />
              </label>
              <div class="skill-authoring-actions">
                <button class="button secondary" type="button" :disabled="authoringBusy || !authoringRequirement.trim() || !authoringModelId" @click="authorSkill('generate')">
                  <LoaderCircle v-if="authoringAction === 'generate'" class="spin" :size="14" /><Sparkles v-else :size="14" />{{ authoringAction === 'generate' ? t("skills.aiGenerating") : t("skills.aiGenerate") }}
                </button>
                <button class="button primary" type="button" :disabled="authoringBusy || !hasSkillContent || !authoringModelId" @click="authorSkill('optimize')">
                  <LoaderCircle v-if="authoringAction === 'optimize'" class="spin" :size="14" /><WandSparkles v-else :size="14" />{{ authoringAction === 'optimize' ? t("skills.aiGenerating") : t("skills.aiOptimize") }}
                </button>
              </div>
            </div>
            <p v-if="!hasAuthoringModel" class="tool-field-hint">{{ t("skills.aiModelHint") }}</p>
            <div v-if="authoringError" class="skill-authoring-error" role="alert"><TriangleAlert :size="17"/><div><strong>{{ authoringNeedsAccount ? "账号状态异常" : "暂时无法完成" }}</strong><p>{{ authoringErrorMessage }}</p></div><button v-if="authoringNeedsAccount" class="button secondary" type="button" @click="router.push('/account')">前往账号</button></div>
          </section>
        </div>
        <label class="tool-field">
          <span>{{ t("skills.matchRules") }}</span>
          <textarea v-model="rulesText" rows="4" spellcheck="false"></textarea>
          <small class="tool-field-hint">{{ t("skills.matchRulesHint") }}</small>
          <small v-if="fieldError('matchRules')" class="field-error">{{ fieldError("matchRules") }}</small>
        </label>
        <label class="tool-field">
          <span>{{ t("skills.instructions") }}</span>
          <textarea v-model="selectedSkill.instructions" rows="12" maxlength="8000" placeholder="用自然语言说明目标、处理阶段、关键判断、失败处理和最终验收要求。"></textarea>
          <small class="tool-field-hint">{{ t("skills.instructionsHint") }}</small>
          <small v-if="fieldError('instructions')" class="field-error">{{ fieldError("instructions") }}</small>
        </label>
        <div class="tool-editor-actions skill-editor-dock">
          <button v-if="selectedSkill.builtIn" class="button secondary" type="button" @click="store.resetSkill(selectedSkill.id)">
            <RotateCcw :size="14" />{{ t("skills.reset") }}
          </button>
          <template v-else>
            <button class="button secondary skill-remove-button" type="button" @click="removeSkill">
              <Trash2 :size="14" />{{ t("skills.remove") }}
            </button>
            <span v-if="saveState === 'error'" class="skill-save-error" role="alert">{{ t("settings.saveFailed", { reason: localizeCoreText(store.skillSaveError) || t("settings.invalidSettings") }) }}</span>
            <button class="button primary skill-save-button" type="button" :disabled="!hasUnsavedChanges || validationIssues.length > 0 || saveState === 'saving'" @click="saveSkill">
              <Save :size="14" />{{ saveState === "saved" ? t("settings.saved") : t("common.save") }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </section>
  <Teleport to="body">
    <div v-if="preview" class="modal-backdrop skill-preview-backdrop" @click.self="closePreview">
      <section class="modal-card skill-preview" role="dialog" aria-modal="true" :aria-label="t('skills.aiPreviewTitle')" @keydown.esc.prevent="closePreview">
        <header><div><span>{{ t("skills.aiPreviewEyebrow") }}</span><h2>{{ t("skills.aiPreviewTitle") }}</h2><p>{{ t("skills.aiPreviewHint") }}</p></div><button type="button" class="icon-button" :aria-label="t('common.close')" @click="closePreview"><X :size="17" /></button></header>
        <div class="skill-preview-grid">
          <div><small>{{ t("skills.name") }}</small><strong>{{ preview.name }}</strong></div>
          <div><small>{{ t("skills.category") }}</small><strong>{{ t(`skills.categories.${preview.category}`) }}</strong></div>
        </div>
        <div class="skill-preview-section"><small>{{ t("skills.description") }}</small><p>{{ preview.description }}</p></div>
        <div class="skill-preview-section"><small>{{ t("skills.matchRules") }}</small><div class="skill-preview-tags"><span v-for="rule in preview.matchRules" :key="rule">{{ rule }}</span><em v-if="!preview.matchRules.length">{{ t("skills.aiNoHints") }}</em></div></div>
        <div class="skill-preview-section"><small>{{ t("skills.instructions") }}</small><pre>{{ preview.instructions }}</pre></div>
        <footer><button class="button secondary" type="button" @click="closePreview">{{ t("common.cancel") }}</button><button class="button primary" type="button" @click="applyPreview">{{ t("skills.aiApply") }}</button></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.skill-category-select{margin-bottom:8px}.skill-editor-category-select{width:100%}
.skill-id-line{display:flex;align-items:center;gap:8px}.skill-cloud-state{display:grid;place-items:center;width:24px;height:24px;padding:0;border:1px solid var(--border);border-radius:6px;background:transparent;color:var(--muted);cursor:pointer}.skill-cloud-state.pending{border-color:color-mix(in srgb,#e7b84b 55%,var(--border));color:#e7b84b;background:color-mix(in srgb,#e7b84b 10%,transparent)}.skill-cloud-state.synced{border-color:color-mix(in srgb,var(--green) 45%,var(--border));color:var(--green);background:color-mix(in srgb,var(--green) 9%,transparent)}.skill-cloud-state.editing{color:var(--dim);background:var(--surface-input)}.skill-cloud-state:disabled{cursor:not-allowed}.skill-cloud-state.synced:disabled{opacity:1}
.skill-top-grid{display:grid;grid-template-columns:minmax(190px,.68fr) minmax(0,1.32fr);gap:14px;align-items:start}.skill-basic-fields{min-width:0}.skill-basic-fields>.tool-field:first-child{margin-top:4px}
.skill-authoring{margin:4px 0 22px;padding:18px;border:1px solid color-mix(in srgb,var(--accent) 28%,var(--border));border-radius:10px;background:color-mix(in srgb,var(--accent) 5%,var(--panel))}
.skill-authoring-title{display:flex;gap:11px;align-items:flex-start}.skill-authoring-title>div{display:flex;flex-direction:column;gap:7px}.skill-authoring-title strong{font-size:14px}.skill-authoring-guide{display:flex;gap:7px;flex-wrap:wrap}.skill-authoring-guide span{padding:4px 7px;border:1px solid var(--border-soft);border-radius:5px;background:var(--panel);color:var(--muted);font-size:10px}.skill-authoring-guide b{color:var(--text);font-weight:600}
.skill-authoring-icon{display:grid;place-items:center;width:30px;height:30px;border-radius:8px;color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}
.skill-authoring-prompt{margin-top:15px}.skill-authoring-controls{display:flex;align-items:flex-end;gap:14px}.skill-authoring-model{flex:1;margin:0}.skill-authoring-actions{display:flex;gap:8px;padding-bottom:1px}.spin{animation:skill-spin 1s linear infinite}@keyframes skill-spin{to{transform:rotate(360deg)}}
.skill-authoring-error{display:grid;grid-template-columns:18px minmax(0,1fr) auto;align-items:start;gap:10px;margin-top:13px;padding:11px 12px;border:1px solid color-mix(in srgb,var(--red) 30%,var(--border));border-radius:7px;background:color-mix(in srgb,var(--red) 7%,var(--panel));color:var(--red)}.skill-authoring-error>div{display:grid;gap:3px}.skill-authoring-error strong{font-size:11px}.skill-authoring-error p{margin:0;color:var(--muted);font-size:11px;line-height:1.5}.skill-authoring-error .button{min-height:29px;padding:5px 9px;font-size:10px}
.skill-editor-dock{position:sticky;z-index:12;bottom:-20px;margin:24px -8px -20px -18px;padding:14px 18px calc(14px + env(safe-area-inset-bottom));align-items:center;justify-content:space-between;gap:12px;border-top:1px solid color-mix(in srgb,var(--border) 82%,transparent);background:color-mix(in srgb,var(--panel) 76%,transparent);box-shadow:0 -14px 30px color-mix(in srgb,var(--bg) 42%,transparent);backdrop-filter:blur(16px) saturate(135%);-webkit-backdrop-filter:blur(16px) saturate(135%)}.skill-editor-dock .skill-save-button{margin-left:auto}.skill-save-error{min-width:0;color:var(--red);font-size:10px;line-height:1.4;text-align:center}.skill-editor-dock .button:disabled{cursor:not-allowed;opacity:.42}
.skill-preview-backdrop{z-index:2100}.skill-preview{width:min(760px,calc(100vw - 40px));padding:0;overflow:hidden}.skill-preview header{display:flex;justify-content:space-between;gap:20px;padding:22px 24px 18px;border-bottom:1px solid var(--border)}.skill-preview header span{font-size:10px;letter-spacing:.12em;color:var(--accent)}.skill-preview h2{margin:5px 0 4px;font-size:19px}.skill-preview header p{margin:0;color:var(--muted);font-size:12px}.skill-preview-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:20px 24px 0}.skill-preview-grid>div,.skill-preview-section{padding:14px;border:1px solid var(--border);border-radius:8px;background:var(--panel)}.skill-preview-grid small,.skill-preview-section>small{display:block;margin-bottom:8px;color:var(--muted);font-size:11px}.skill-preview-grid strong{font-size:14px}.skill-preview-section{margin:12px 24px 0}.skill-preview-section p,.skill-preview-section pre{margin:0;color:var(--text);font:inherit;font-size:13px;line-height:1.75;white-space:pre-wrap}.skill-preview-section pre{max-height:250px;overflow:auto}.skill-preview-tags{display:flex;gap:7px;flex-wrap:wrap}.skill-preview-tags span{padding:5px 8px;border-radius:5px;background:var(--surface-input);font-size:12px}.skill-preview-tags em{color:var(--muted);font-size:12px;font-style:normal}.skill-preview footer{display:flex;justify-content:flex-end;gap:10px;padding:18px 24px 22px}
@media(max-width:720px){.skill-top-grid{grid-template-columns:1fr}.skill-authoring-controls{align-items:stretch;flex-direction:column}.skill-authoring-actions{width:100%}.skill-authoring-actions .button{flex:1}.skill-preview-grid{grid-template-columns:1fr}}
</style>
