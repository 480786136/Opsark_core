<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { BookOpen } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useKnowledgeStore } from "./knowledgeStore";
import { readKnowledgeCitation } from "./service";
import { retrievalMatchesConfig } from "./retrieval";
import type { KnowledgeDocumentVersion, KnowledgeHit } from "./types";

const props = defineProps<{ taskId: string }>();
const { t } = useI18n();
const knowledge = useKnowledgeStore();
const entry = computed(() => {
  const value = knowledge.retrievals[props.taskId];
  return value && retrievalMatchesConfig(value, knowledge.config) ? value : undefined;
});
const selected = ref<KnowledgeHit>();
const source = ref<KnowledgeDocumentVersion>();
const error = ref("");
const loading = ref(false);
let generation = 0;
watch(() => [props.taskId, entry.value?.requestId, knowledge.config.endpoint, knowledge.config.credentialId, knowledge.config.searchEnabled], () => {
  generation += 1; selected.value = undefined; source.value = undefined; error.value = ""; loading.value = false;
});
const excerpt = computed(() => {
  if (!source.value || !selected.value) return "";
  const start = selected.value.citation.line_start;
  const end = selected.value.citation.line_end;
  return source.value.content.split("\n").slice(Math.max(0, start - 3), Math.min(end + 2, start + 199))
    .map((line, index) => `${Math.max(1, start - 2) + index}  ${line}`).join("\n").slice(0, 16000);
});
async function readSource(hit: KnowledgeHit) {
  const current = ++generation;
  const destination = { ...knowledge.config };
  selected.value = hit; source.value = undefined; error.value = ""; loading.value = true;
  try {
    const document = await readKnowledgeCitation(destination, hit);
    if (generation === current && entry.value && retrievalMatchesConfig(entry.value, knowledge.config)) source.value = document;
  } catch (reason) {
    if (generation === current) error.value = reason instanceof Error ? reason.message : t("knowledge.referencesUnavailable");
  } finally { if (generation === current) loading.value = false; }
}
</script>

<template>
  <details v-if="entry" class="knowledge-references" :open="entry.status !== 'ready' || !entry.result?.hits.length">
    <summary><BookOpen :size="14" /> {{ t('knowledge.referencesTitle') }}<span v-if="entry.result"> · {{ entry.result.hits.length }} · {{ t(entry.result.retrieval_mode === 'hybrid' ? 'knowledge.hybridSearch' : 'knowledge.keywordOnly') }}</span></summary>
    <p v-if="entry.status === 'searching'" role="status">{{ t('knowledge.referencesSearching') }}</p>
    <p v-else-if="entry.status === 'unavailable'" role="status">{{ t('knowledge.referencesUnavailable') }}</p>
    <template v-else>
      <p>{{ t(entry.result?.hits.length ? 'knowledge.referencesNotice' : 'knowledge.referencesEmpty') }}</p>
      <article v-for="hit in entry.result?.hits" :key="hit.chunk_id">
        <strong>[{{ hit.citation.label }}] {{ hit.title }}</strong>
        <small>{{ t('knowledge.citationLocation', { version: hit.document_version, start: hit.citation.line_start, end: hit.citation.line_end }) }}</small>
        <pre>{{ hit.content }}</pre>
        <button class="button secondary" type="button" :disabled="loading" @click="readSource(hit)">{{ t('knowledge.readCitation') }}</button>
      </article>
      <p v-if="entry.result?.truncated">{{ t('knowledge.referencesTruncated') }}</p>
    </template>
    <section v-if="selected" :aria-label="t('knowledge.citationTitle')">
      <p v-if="loading" role="status">{{ t('knowledge.citationLoading') }}</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <template v-if="source"><strong>{{ source.title }}</strong><small>{{ t('knowledge.citationLocation', { version: source.version, start: selected.citation.line_start, end: selected.citation.line_end }) }}</small><pre tabindex="0">{{ excerpt }}</pre></template>
    </section>
  </details>
</template>

<style scoped>
.knowledge-references{border:1px solid var(--border);border-radius:8px;margin:8px 0 16px;padding:10px 12px;font-size:12px;color:var(--text)}
summary{cursor:pointer;line-height:1.7}summary svg{vertical-align:middle}summary span,p,small{color:var(--muted)}p{line-height:1.7}article,section{padding:12px 0;border-top:1px solid var(--border-soft)}small{display:block;margin-top:5px}strong{overflow-wrap:anywhere}pre{max-height:260px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);padding:12px;line-height:1.7;font-size:12px}button{font-size:12px}[role=alert]{color:var(--red)}
</style>
