<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { backend } from "@/services/backend";
const props = defineProps<{ taskId: string; evidenceRefs: string[] }>();
const { locale } = useI18n();
const en = computed(() => locale.value.startsWith("en"));
const busy = ref(false), error = ref(""), raw = ref(""), selected = ref("");
const metadata = ref<Record<string, unknown>>(), nextOffset = ref<number>();
let generation = 0;
function reset() { generation++; busy.value = false; error.value = ""; raw.value = ""; selected.value = ""; metadata.value = undefined; nextOffset.value = undefined; }
watch(() => JSON.stringify([props.taskId, props.evidenceRefs]), reset);
onBeforeUnmount(() => { generation++; });
const output = computed(() => {
  let value: unknown;
  try { value = JSON.parse(raw.value); } catch { return raw.value; }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.toolId === "string" && record.success === true && record.data !== undefined) value = record.data;
    else if (typeof record.output === "string") return record.output;
  }
  if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).tree === "string" && (value as { tree: string }).tree.length > 0) {
    const data = value as Record<string, unknown>;
    return String(data.tree) + (data.truncated === true ? (en.value ? "\n[Result truncated]" : "\n[结果已截断]") : "")
      + (Array.isArray(data.warnings) && data.warnings.length ? "\n" + data.warnings.join("\n") : "");
  }
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
});
async function read(id: string, append = false) {
  if (busy.value) return;
  const offset = append ? nextOffset.value : 0;
  if (offset === undefined) return;
  if (!append) { reset(); selected.value = id; }
  const current = generation;
  busy.value = true; error.value = "";
  try {
    const result = await backend.readTaskEvidence(props.taskId, id, offset, 8000);
    if (current !== generation) return;
    if (typeof result.text !== "string") throw new Error("Invalid saved evidence content");
    raw.value += result.text; metadata.value = result;
    nextOffset.value = typeof result.nextOffset === "number" && result.nextOffset > offset ? result.nextOffset : undefined;
  } catch { if (current === generation) error.value = en.value ? "Could not read saved evidence." : "暂时无法读取已保存证据。"; }
  finally { if (current === generation) busy.value = false; }
}
</script>
<template>
  <div class="saved-evidence-viewer">
    <button v-for="id in evidenceRefs" :key="id" type="button" class="button secondary" :disabled="busy" @click="read(id)">{{ en ? 'View saved evidence' : '查看已保存证据' }}</button>
    <p v-if="busy" role="status">{{ en ? 'Loading…' : '读取中…' }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="metadata">
      <p class="saved-evidence-note">{{ en ? 'Saved output from this execution.' : '以下为该次执行保存的输出。' }}</p>
      <pre class="saved-evidence-output">{{ output }}</pre>
      <button v-if="nextOffset !== undefined" type="button" class="button secondary" :disabled="busy" @click="read(selected, true)">{{ en ? 'Read more' : '继续读取' }}</button>
      <details class="saved-evidence-metadata"><summary>{{ en ? 'Technical details' : '技术详情' }}</summary><pre>{{ JSON.stringify(metadata, null, 2) }}</pre></details>
    </template>
  </div>
</template>
<style scoped>
.saved-evidence-viewer { width: 100%; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 320px; overflow: auto; }
.saved-evidence-note, details { font-size: 12px; }
</style>
