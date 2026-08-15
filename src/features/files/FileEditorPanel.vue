<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { AlertTriangle, FileCode2, LoaderCircle, Save, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { backend } from "@/services/backend";
import { useOpsStore } from "@/stores/ops";
import type { FileEntry } from "@/types";
import { decodeTextFile, encodeTextFile, type LineEnding, type TextFileError } from "./fileEditor";

const props = defineProps<{ serverId: string; entry: FileEntry }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const { t } = useI18n();
const store = useOpsStore();
const content = ref("");
const originalContent = ref("");
const lineEnding = ref<LineEnding>("LF");
const originalLineEnding = ref<LineEnding>("LF");
const hasBom = ref(false);
const loading = ref(true);
const saving = ref(false);
const error = ref("");
const discardVisible = ref(false);
const savedVisible = ref(false);
let savedTimer: number | undefined;

const dirty = computed(() => content.value !== originalContent.value || lineEnding.value !== originalLineEnding.value);

function translatedDecodeError(value: TextFileError) {
  if (value === "too_large") return t("files.editorTooLarge");
  if (value === "binary") return t("files.editorBinary");
  return t("files.editorInvalidUtf8");
}

async function loadFile() {
  const connection = store.getRuntimeConnection(props.serverId);
  if (!connection) {
    error.value = t("workspace.connectServer");
    loading.value = false;
    return;
  }
  try {
    const decoded = decodeTextFile(await backend.readSftpFile(connection, props.entry.path));
    if (typeof decoded === "string") {
      error.value = translatedDecodeError(decoded);
      return;
    }
    content.value = decoded.content;
    originalContent.value = decoded.content;
    lineEnding.value = decoded.lineEnding;
    originalLineEnding.value = decoded.lineEnding;
    hasBom.value = decoded.hasBom;
  } catch (loadError) {
    error.value = String(loadError);
  } finally {
    loading.value = false;
  }
}

async function saveFile() {
  if (!dirty.value || saving.value || error.value) return;
  const connection = store.getRuntimeConnection(props.serverId);
  if (!connection) return;
  saving.value = true;
  try {
    const data = encodeTextFile(content.value, lineEnding.value, hasBom.value);
    await backend.writeSftpFile(connection, props.entry.path, data);
    originalContent.value = content.value;
    originalLineEnding.value = lineEnding.value;
    savedVisible.value = true;
    if (savedTimer !== undefined) window.clearTimeout(savedTimer);
    savedTimer = window.setTimeout(() => (savedVisible.value = false), 1_600);
    store.addLog({
      category: "command",
      level: "success",
      title: "SFTP 保存文本文件",
      detail: `${props.entry.path} · ${data.byteLength} bytes`,
      serverId: props.serverId,
    });
    emit("saved");
  } catch (saveError) {
    error.value = String(saveError);
  } finally {
    saving.value = false;
  }
}

function requestClose() {
  if (dirty.value) discardVisible.value = true;
  else emit("close");
}

function handleKeydown(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveFile();
  } else if (event.key === "Escape") {
    requestClose();
  }
}

onMounted(() => {
  window.addEventListener("keydown", handleKeydown);
  void loadFile();
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", handleKeydown);
  if (savedTimer !== undefined) window.clearTimeout(savedTimer);
});
</script>

<template>
  <section class="file-editor-panel">
    <header class="file-editor-toolbar">
      <div><FileCode2 :size="16" /><span><strong>{{ entry.name }}</strong><small>{{ entry.path }}</small></span></div>
      <div class="file-editor-meta">
        <label>{{ t("files.encoding") }}<span>UTF-8</span></label>
        <label>{{ t("files.lineEnding") }}
          <select v-model="lineEnding">
            <option value="LF">LF</option><option value="CRLF">CRLF</option><option value="CR">CR</option>
            <option v-if="lineEnding === 'Mixed'" value="Mixed">Mixed</option><option v-if="lineEnding === 'None'" value="None">None</option>
          </select>
        </label>
        <label>{{ t("files.bom") }}<span>{{ hasBom ? "Yes" : "No" }}</span></label>
      </div>
      <span :class="['editor-save-state', { dirty, saved: savedVisible }]">{{ saving ? t("files.saving") : savedVisible ? t("files.saved") : dirty ? t("files.unsaved") : "" }}</span>
      <button class="icon-button" type="button" :title="t('common.save')" :disabled="!dirty || saving || Boolean(error)" @click="saveFile"><LoaderCircle v-if="saving" class="spin" :size="15" /><Save v-else :size="15" /></button>
      <button class="icon-button" type="button" :title="t('common.close')" @click="requestClose"><X :size="16" /></button>
    </header>
    <div v-if="loading" class="file-editor-state"><LoaderCircle class="spin" :size="19" />{{ t("files.loading") }}</div>
    <div v-else-if="error" class="file-editor-state error"><AlertTriangle :size="20" /><p>{{ error }}</p></div>
    <textarea v-else v-model="content" class="file-editor-textarea" spellcheck="false" :aria-label="t('files.editorTitle')" />

    <div v-if="discardVisible" class="editor-discard-backdrop" @click.self="discardVisible = false">
      <section>
        <header><AlertTriangle :size="17" /><strong>{{ t("files.discardTitle") }}</strong></header>
        <p>{{ t("files.discardHint", { name: entry.name }) }}</p>
        <footer><button class="button secondary" type="button" @click="discardVisible = false">{{ t("common.cancel") }}</button><button class="button primary" type="button" @click="emit('close')">{{ t("files.discard") }}</button></footer>
      </section>
    </div>
  </section>
</template>
