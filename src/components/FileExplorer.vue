<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileCode2,
  Folder,
  FolderOpen,
  FolderInput,
  FolderPlus,
  LoaderCircle,
  Pencil,
  RefreshCw,
  TriangleAlert,
  Trash2,
  Upload,
  X,
} from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { getCurrentWebview, type DragDropEvent } from "@tauri-apps/api/webview";
import type { Event as TauriEvent, UnlistenFn } from "@tauri-apps/api/event";
import {
  moveFileSelection,
  sortRemoteFiles,
  updateFileSelection,
  type FileSelectionState,
  type FileSortKey,
  type FileSortState,
} from "@/features/files/fileWorkspace";
import { useFileWorkspaceStore } from "@/features/files/fileWorkspaceStore";
import { localizeFileMutationAudit, type FileMutationResult } from "@/features/files/fileMutationResult";
import {
  buildRemoteBreadcrumbs,
  joinRemotePath,
  normalizeRemotePath,
  parentRemotePath,
  validateRemoteEntryName,
} from "@/features/files/remotePath";
import TransferQueuePanel from "@/features/files/TransferQueuePanel.vue";
import { useTransferQueueStore } from "@/features/files/transferQueueStore";
import { useOpsStore } from "@/stores/ops";
import { backend, isTauri } from "@/services/backend";
import type { FileEntry } from "@/types";
import { useWorkspaceLinkStore } from "@/features/workspace/workspaceLinkStore";
import { isConnectionTransportFailure } from "@/features/connection/connectionStore";

type FileAction = "create" | "rename" | "delete" | "overwrite" | "uploadRename";
interface FileDialogState {
  type: FileAction;
  value: string;
  entry?: FileEntry;
  file?: File;
}

const FILE_COLUMNS_STORAGE_KEY = "opsark.fileColumns.v2";

const props = defineProps<{ serverId: string }>();
const emit = defineEmits<{ edit: [entry: FileEntry] }>();
const store = useOpsStore();
const transferQueue = useTransferQueueStore();
const fileWorkspace = useFileWorkspaceStore();
const workspaceLinks = useWorkspaceLinkStore();
const { t, locale } = useI18n();
const fileInput = ref<HTMLInputElement>();
const nameInput = ref<HTMLInputElement>();
const pathInput = ref<HTMLInputElement>();
const fileList = ref<HTMLElement>();
const filePanel = ref<HTMLElement>();
const editingPath = ref(false);
const pathDraft = ref("");
const columnWidths = ref({ name: 160, size: 52, modified: 74 });
const selection = ref<FileSelectionState>({ selectedPaths: [], anchorPath: "" });
const sort = ref<FileSortState>({ key: "name", direction: "asc" });
const contextMenu = ref<{ x: number; y: number; entry: FileEntry }>();
const dialog = ref<FileDialogState>();
const dialogError = ref("");
const operationError = ref("");
const operationPending = ref(false);
const deletingPath = ref("");
const transferQueueOpen = ref(false);
const uploadDragDepth = ref(0);
const showOfflineCache = ref(false);
let disposed = false;
let nativeDropUnlisten: UnlistenFn | undefined;
fileWorkspace.hydrate();
fileWorkspace.ensureServer(props.serverId);

const fileState = computed(() => fileWorkspace.serverWorkspaces[props.serverId]);
const currentPath = computed(() => fileState.value.currentPath);
const breadcrumbs = computed(() => buildRemoteBreadcrumbs(currentPath.value));
const isLive = computed(() => store.isServerConnected(props.serverId));
const hasSnapshot = computed(() => Boolean(fileState.value.lastSuccessAt));
const directoryStateMessage = computed(() => {
  const status = store.serverConnection(props.serverId).status;
  const label = status === "suspect" ? t("files.connectionPending")
    : isLive.value ? (fileState.value.loading ? t("files.refreshingDirectory") : t("files.refreshFailedStale"))
    : status === "connecting" || status === "reconnecting" ? t("files.connectingDirectory")
    : t("files.offlineCache");
  if (!hasSnapshot.value) return isLive.value
    ? t("files.readingDirectory")
    : t("files.waitingForDirectoryConnection", { status: label });
  const date = new Date(fileState.value.lastSuccessAt!);
  const updated = Number.isNaN(date.getTime()) ? t("files.unknownTime") : date.toLocaleString(locale.value);
  return t("files.directoryLastUpdated", { status: label, time: updated });
});
const showFiles = computed(() => hasSnapshot.value && (isLive.value || showOfflineCache.value));
const draggingUpload = computed(() => isLive.value && !operationPending.value && uploadDragDepth.value > 0);
const sortedFiles = computed(() => sortRemoteFiles(fileState.value.files, sort.value));
const selectedSet = computed(() => new Set(selection.value.selectedPaths));
const serverTransferCount = computed(() => transferQueue.tasks.filter(({ serverId }) => serverId === props.serverId).length);
const directoryErrorMessage = computed(() => fileState.value.errorCode
  ? t(`files.directoryError.${fileState.value.errorCode}`, {
    path: fileState.value.lastSuccessfulPath,
  })
  : "");
const fileTableStyle = computed(() => ({
  "--file-name-column": `${columnWidths.value.name}px`,
  "--file-size-column": `${columnWidths.value.size}px`,
  "--file-modified-column": `${columnWidths.value.modified}px`,
}));

function beginPathEdit() {
  if (!isLive.value || operationPending.value) return;
  pathDraft.value = currentPath.value;
  editingPath.value = true;
  void nextTick(() => pathInput.value?.select());
}

function cancelPathEdit() {
  editingPath.value = false;
  pathDraft.value = currentPath.value;
}

function submitPath() {
  if (operationPending.value) return;
  const target = normalizeRemotePath(pathDraft.value.trim() || "/");
  editingPath.value = false;
  if (target !== currentPath.value) void loadDirectory(target);
}

function startColumnResize(column: "name" | "size" | "modified", event: PointerEvent) {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = columnWidths.value[column];
  const limits = column === "name" ? [110, 520] : column === "size" ? [42, 130] : [58, 190];
  const onMove = (moveEvent: PointerEvent) => {
    columnWidths.value = {
      ...columnWidths.value,
      [column]: Math.min(limits[1], Math.max(limits[0], startWidth + moveEvent.clientX - startX)),
    };
  };
  const onEnd = () => {
    localStorage.setItem(FILE_COLUMNS_STORAGE_KEY, JSON.stringify(columnWidths.value));
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onEnd);
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onEnd);
}

async function loadDirectory(path: string) {
  if (disposed) return;
  const serverId = props.serverId;
  const connection = store.getRuntimeConnection(props.serverId);
  if (!isLive.value || !connection) {
    fileWorkspace.markDirectoryError(props.serverId, "disconnected", path);
    return undefined;
  }
  const result = await fileWorkspace.loadDirectory(props.serverId, connection, path);
  if (!result.ok) {
    // 请求已过期时，新请求负责更新界面，不能回写错误状态。
    if (result.stale) return;
    reportTransportFailure(result.error, serverId);
    store.addLog({
      category: "system",
      level: "error",
      title: t("files.audit.readDirectoryFailed"),
      detail: String(result.error),
      serverId,
    });
    return result;
  }
  selection.value = { selectedPaths: [], anchorPath: "" };
  return result;
}

function openCurrentPathInTerminal() {
  if (!isLive.value || operationPending.value) return;
  workspaceLinks.requestTerminalPath(props.serverId, currentPath.value);
}

function openDirectory(path: string) {
  if (operationPending.value) return;
  void loadDirectory(path);
}

function refreshDirectory(path: string) {
  if (!operationPending.value) void loadDirectory(path);
}

function toggleSort(key: FileSortKey) {
  sort.value = sort.value.key === key
    ? { key, direction: sort.value.direction === "asc" ? "desc" : "asc" }
    : { key, direction: "asc" };
}

function selectEntry(entry: FileEntry, event: MouseEvent) {
  if (operationPending.value) return;
  selection.value = updateFileSelection(
    selection.value,
    sortedFiles.value.map(({ path }) => path),
    entry.path,
    { toggle: event.metaKey || event.ctrlKey, range: event.shiftKey },
  );
}

function focusSelectedRow(path: string) {
  const index = sortedFiles.value.findIndex((entry) => entry.path === path);
  void nextTick(() => fileList.value?.querySelector<HTMLElement>(`[data-file-index="${index}"]`)?.scrollIntoView({ block: "nearest" }));
}

function handleListKeydown(event: KeyboardEvent) {
  if (operationPending.value) return;
  const paths = sortedFiles.value.map(({ path }) => path);
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
    event.preventDefault();
    selection.value = { selectedPaths: paths, anchorPath: paths[0] ?? "" };
    return;
  }
  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    event.preventDefault();
    const nextPath = moveFileSelection(selection.value.anchorPath, paths, event.key === "ArrowUp" ? -1 : 1);
    if (!nextPath) return;
    selection.value = { selectedPaths: [nextPath], anchorPath: nextPath };
    focusSelectedRow(nextPath);
    return;
  }
  if (event.key === "Enter" && selection.value.selectedPaths.length === 1) {
    const entry = sortedFiles.value.find(({ path }) => path === selection.value.selectedPaths[0]);
    if (entry?.kind === "directory") openDirectory(entry.path);
  }
}

function openContextMenu(entry: FileEntry, event: MouseEvent) {
  if (operationPending.value) return;
  if (!selectedSet.value.has(entry.path)) {
    selection.value = { selectedPaths: [entry.path], anchorPath: entry.path };
  }
  contextMenu.value = {
    x: Math.min(event.clientX, window.innerWidth - 155),
    y: Math.min(event.clientY, window.innerHeight - 170),
    entry,
  };
}

async function copyPath(entry: FileEntry) {
  await navigator.clipboard.writeText(entry.path);
  contextMenu.value = undefined;
}

function closeContextMenu() {
  contextMenu.value = undefined;
}

function goUp() {
  openDirectory(parentRemotePath(currentPath.value));
}

function openEntry(entry: FileEntry) {
  if (operationPending.value) return;
  if (entry.kind === "directory") openDirectory(entry.path);
  else if (isLive.value) emit("edit", entry);
}

function openDialog(type: FileAction, entry?: FileEntry, file?: File) {
  if (!isLive.value || disposed || operationPending.value) return;
  dialogError.value = "";
  dialog.value = {
    type,
    entry,
    file,
    value: type === "rename" ? entry?.name ?? "" : "",
  };
  if (type === "create" || type === "rename") {
    void nextTick(() => nameInput.value?.select());
  }
}

function closeDialog() {
  if (!operationPending.value) dialog.value = undefined;
}

function translatedNameError(value: string) {
  const error = validateRemoteEntryName(value);
  return error ? t(`files.name${error[0].toUpperCase()}${error.slice(1)}`) : "";
}

async function queueUpload(file: File, remoteName = file.name) {
  if (deletingPath.value) return;
  if (!isLive.value || disposed) throw new Error(t("workspace.connectServer"));
  const serverId = props.serverId;
  const generation = store.serverConnection(serverId).generation;
  const connection = store.getRuntimeConnection(props.serverId);
  if (!connection) throw new Error(t("workspace.connectServer"));
  const targetDirectory = currentPath.value;
  const remotePath = joinRemotePath(targetDirectory, remoteName);
  const data = new Uint8Array(await file.arrayBuffer());
  if (deletingPath.value) return;
  if (disposed || serverId !== props.serverId || !isLive.value
    || generation !== store.serverConnection(serverId).generation) throw new Error(t("workspace.connectServer"));
  transferQueue.enqueueUpload(props.serverId, connection, remoteName, remotePath, data, () => {
    store.addLog({
      category: "command",
      level: "success",
      title: t("files.audit.uploadFile"),
      detail: `${remotePath} · ${data.byteLength} bytes`,
      serverId: props.serverId,
    });
    if (currentPath.value === targetDirectory) void loadDirectory(targetDirectory);
  });
  transferQueueOpen.value = true;
}

async function submitDialog() {
  const state = dialog.value;
  if (!state || !isLive.value || disposed || operationPending.value) return;
  const serverId = props.serverId;
  const generation = store.serverConnection(serverId).generation;
  dialogError.value = "";
  if (state.type === "create" || state.type === "rename" || state.type === "uploadRename") {
    dialogError.value = translatedNameError(state.value);
    if (dialogError.value) return;
  }

  operationPending.value = true;
  deletingPath.value = state.type === "delete" ? state.entry?.path ?? "" : "";
  closeContextMenu();
  uploadDragDepth.value = 0;
  try {
    const connection = store.getRuntimeConnection(props.serverId);
    if (!connection) throw new Error(t("workspace.connectServer"));
    if (state.type === "create") {
      const path = joinRemotePath(currentPath.value, state.value.trim());
      recordFileMutation(await fileWorkspace.createDirectory(props.serverId, connection, path));
    } else if (state.type === "rename" && state.entry) {
      const toPath = joinRemotePath(currentPath.value, state.value.trim());
      recordFileMutation(await fileWorkspace.renameEntry(
        props.serverId,
        connection,
        state.entry.path,
        toPath,
      ));
    } else if (state.type === "delete" && state.entry) {
      recordFileMutation(await fileWorkspace.deleteEntry(props.serverId, connection, state.entry));
    } else if (state.type === "overwrite" && state.file) {
      await queueUpload(state.file);
    } else if (state.type === "uploadRename" && state.file) {
      await queueUpload(state.file, state.value.trim());
    }
    if (!disposed && serverId === props.serverId && dialog.value === state) dialog.value = undefined;
  } catch (error) {
    if (!disposed && serverId === props.serverId && generation === store.serverConnection(serverId).generation) {
      if (dialog.value === state) dialogError.value = String(error);
      reportTransportFailure(error, serverId);
    }
  } finally {
    deletingPath.value = "";
    operationPending.value = false;
  }
}

function recordFileMutation(result: FileMutationResult) {
  store.addLog(localizeFileMutationAudit(result.audit, t));
  if (!result.refresh.ok && !result.refresh.stale) reportTransportFailure(result.refresh.error, result.audit.serverId);
}

function reportTransportFailure(error: unknown, serverId = props.serverId) {
  if (isConnectionTransportFailure(String(error))) store.reportConnectionFailure(serverId, String(error));
}

function chooseUpload() {
  if (isLive.value && !disposed && !operationPending.value) fileInput.value?.click();
}

async function handleUpload(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  await uploadFiles(files);
}

async function uploadFiles(files: File[]) {
  if (!isLive.value || !files.length || operationPending.value) return;
  operationError.value = "";
  const existingNames = new Set(fileState.value.files.map(({ name }) => name));
  let conflictingFile: File | undefined;
  let oversized = false;
  for (const file of files) {
    if (operationPending.value) return;
    if (file.size > 20 * 1024 * 1024) {
      oversized = true;
      continue;
    }
    if (existingNames.has(file.name)) {
      conflictingFile ??= file;
      continue;
    }
    try {
      await queueUpload(file);
      existingNames.add(file.name);
    } catch (error) {
      operationError.value = String(error);
    }
  }
  if (oversized) operationError.value = t("files.uploadLimit");
  if (conflictingFile) openDialog("overwrite", undefined, conflictingFile);
}

function isFileDrag(event: DragEvent) {
  return [...(event.dataTransfer?.types ?? [])].includes("Files");
}

function handleUploadDragEnter(event: DragEvent) {
  if (!isLive.value || operationPending.value || !isFileDrag(event)) return;
  uploadDragDepth.value += 1;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleUploadDragOver(event: DragEvent) {
  if (!isLive.value || operationPending.value || !isFileDrag(event)) return;
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

function handleUploadDragLeave(event: DragEvent) {
  if (!isFileDrag(event)) return;
  uploadDragDepth.value = Math.max(0, uploadDragDepth.value - 1);
}

function handleUploadDrop(event: DragEvent) {
  uploadDragDepth.value = 0;
  if (!isLive.value || operationPending.value) return;
  void uploadFiles([...(event.dataTransfer?.files ?? [])]);
}

function isNativeDropInsidePanel(event: Extract<DragDropEvent, { position: unknown }>) {
  const rect = filePanel.value?.getBoundingClientRect();
  if (!rect) return false;
  const scale = window.devicePixelRatio || 1;
  const x = event.position.x / scale;
  const y = event.position.y / scale;
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function localFileName(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "upload";
}

async function uploadNativePaths(paths: string[]) {
  if (!isLive.value || disposed || operationPending.value) return;
  const files: File[] = [];
  operationError.value = "";
  for (const path of paths) {
    if (operationPending.value) return;
    try {
      const data = await backend.readLocalFileForUpload(path);
      files.push(new File([data], localFileName(path)));
    } catch (error) {
      operationError.value = String(error);
    }
  }
  await uploadFiles(files);
}

function handleNativeDragDrop({ payload: event }: TauriEvent<DragDropEvent>) {
  if (!isLive.value || operationPending.value) {
    uploadDragDepth.value = 0;
    return;
  }
  if (event.type === "leave") {
    uploadDragDepth.value = 0;
    return;
  }
  const inside = isNativeDropInsidePanel(event);
  uploadDragDepth.value = inside && event.type !== "drop" ? 1 : 0;
  if (inside && event.type === "drop") void uploadNativePaths(event.paths);
}

async function download(entry: FileEntry) {
  if (!isLive.value || disposed || operationPending.value) return;
  operationError.value = "";
  try {
    const connection = store.getRuntimeConnection(props.serverId);
    if (!connection) throw new Error(t("workspace.connectServer"));
    transferQueue.enqueueDownload(props.serverId, connection, entry.name, entry.path, (data) => {
      const url = URL.createObjectURL(new Blob([data]));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = entry.name;
      anchor.click();
      URL.revokeObjectURL(url);
      store.addLog({
        category: "command",
        level: "info",
        title: t("files.audit.downloadFile"),
        detail: `${entry.path} · ${data.byteLength} bytes`,
        serverId: props.serverId,
      });
    });
    transferQueueOpen.value = true;
  } catch (error) {
    operationError.value = String(error);
  }
}

function dialogTitle(state: FileDialogState) {
  if (state.type === "create") return t("files.newFolder");
  if (state.type === "rename") return t("files.rename");
  if (state.type === "delete") return t("files.deleteTitle");
  if (state.type === "uploadRename") return t("files.renameUpload");
  return t("files.overwriteTitle");
}

function beginUploadRename() {
  if (!dialog.value?.file || operationPending.value) return;
  const file = dialog.value.file;
  const dotIndex = file.name.lastIndexOf(".");
  const suffix = dotIndex > 0 ? file.name.slice(dotIndex) : "";
  const base = dotIndex > 0 ? file.name.slice(0, dotIndex) : file.name;
  dialog.value = { type: "uploadRename", file, value: `${base}-copy${suffix}` };
  dialogError.value = "";
  void nextTick(() => nameInput.value?.select());
}

watch(() => fileState.value.files, (files) => {
  const available = new Set(files.map(({ path }) => path));
  const selectedPaths = selection.value.selectedPaths.filter((path) => available.has(path));
  selection.value = {
    selectedPaths,
    anchorPath: available.has(selection.value.anchorPath) ? selection.value.anchorPath : selectedPaths[0] ?? "",
  };
});

watch([isLive, () => store.serverConnection(props.serverId).generation], ([live]) => {
  showOfflineCache.value = false;
  dialog.value = undefined;
  contextMenu.value = undefined;
  uploadDragDepth.value = 0;
  editingPath.value = false;
  if (!live) fileWorkspace.markServerOffline(props.serverId);
  else void loadDirectory(currentPath.value);
}, { flush: "sync" });

watch(
  [() => workspaceLinks.sftpPathRequests[props.serverId], operationPending],
  async ([request, pending]) => {
    if (!request || pending) return;
    const result = await loadDirectory(request.path);
    if (result?.ok) workspaceLinks.consumeSftpPath(props.serverId, request.id);
  },
  { immediate: true },
);

onMounted(() => {
  try {
    const saved = JSON.parse(localStorage.getItem(FILE_COLUMNS_STORAGE_KEY) ?? "null");
    if (saved && [saved.name, saved.size, saved.modified].every(Number.isFinite)) {
      columnWidths.value = saved;
    }
  } catch { /* 使用默认列宽。 */ }
  document.addEventListener("pointerdown", closeContextMenu);
  if (isLive.value) void loadDirectory(currentPath.value);
});
onMounted(async () => {
  if (isTauri()) {
    nativeDropUnlisten = await getCurrentWebview().onDragDropEvent(handleNativeDragDrop);
    if (disposed) nativeDropUnlisten();
  }
});
onBeforeUnmount(() => {
  disposed = true;
  fileWorkspace.markServerOffline(props.serverId);
  document.removeEventListener("pointerdown", closeContextMenu);
  nativeDropUnlisten?.();
});
</script>

<template>
  <section
    ref="filePanel"
    class="work-panel file-panel"
    :aria-busy="operationPending"
    @dragenter.prevent="handleUploadDragEnter"
    @dragover.prevent="handleUploadDragOver"
    @dragleave.prevent="handleUploadDragLeave"
    @drop.prevent="handleUploadDrop"
  >
    <header class="panel-header">
      <div class="file-panel-title"><span class="eyebrow">SFTP</span><strong>{{ t("files.title") }}</strong></div>
      <div class="header-actions">
        <button type="button" :title="t('files.upload')" :disabled="!isLive || operationPending" @click="chooseUpload"><Upload :size="15" /></button>
        <button type="button" :title="t('files.newFolder')" :disabled="!isLive || operationPending" @click="openDialog('create')"><FolderPlus :size="15" /></button>
        <button type="button" :title="t('files.openInTerminal')" :disabled="!isLive || operationPending" @click="openCurrentPathInTerminal"><FolderInput :size="15" /></button>
        <button type="button" :title="t('common.refresh')" :disabled="!isLive || operationPending" @click="refreshDirectory(currentPath)"><RefreshCw :class="{ spin: fileState.loading }" :size="15" /></button>
        <button type="button" :title="t('files.transfers')" :class="{ active: transferQueueOpen }" @click="transferQueueOpen = !transferQueueOpen">
          <ArrowUpDown :size="15" /><i v-if="serverTransferCount">{{ serverTransferCount }}</i>
        </button>
        <input ref="fileInput" class="hidden-file-input" type="file" multiple :disabled="operationPending" @change="handleUpload" />
      </div>
    </header>
    <div v-if="draggingUpload" class="file-upload-dropzone" role="status">
      <Upload :size="28" />
      <strong>{{ t("files.dropToUpload") }}</strong>
      <small>{{ currentPath }}</small>
    </div>
    <nav class="path-bar" :aria-label="t('files.title')">
      <button type="button" :title="t('files.goUp')" :disabled="!isLive || operationPending || currentPath === '/'" @click="goUp"><ChevronLeft :size="14" /></button>
      <form v-if="editingPath" class="path-editor" @submit.prevent="submitPath">
        <input ref="pathInput" v-model="pathDraft" :disabled="operationPending" :aria-label="t('files.path')" spellcheck="false" @keydown.esc.prevent="cancelPathEdit" @blur="submitPath" />
      </form>
      <template v-for="(item, index) in editingPath ? [] : breadcrumbs" :key="item.path">
        <ChevronRight v-if="index" :size="12" />
        <button type="button" :disabled="!isLive || operationPending" :class="{ current: index === breadcrumbs.length - 1 }" :title="item.path" @click="openDirectory(item.path)">{{ item.label }}</button>
      </template>
      <button v-if="!editingPath" type="button" class="path-empty-editor" :disabled="!isLive || operationPending" :title="t('files.editPath')" :aria-label="t('files.editPath')" @click="beginPathEdit" />
    </nav>
    <div v-if="!isLive || fileState.stale || fileState.loading" class="file-directory-state" role="status">
      <TriangleAlert :size="14" />
      <span>{{ directoryStateMessage }}</span>
      <button v-if="!isLive && hasSnapshot" type="button" @click="showOfflineCache = !showOfflineCache">{{ showOfflineCache ? t('files.hideOfflineCache') : t('files.showOfflineCache') }}</button>
    </div>
    <div v-if="deletingPath && !dialog" class="file-delete-progress" role="status">
      <LoaderCircle class="spin" :size="15" aria-hidden="true" />
      <span>{{ t("files.deleting") }} {{ deletingPath }}</span>
    </div>
    <div class="file-table-viewport" :style="fileTableStyle">
    <div class="file-table-head">
      <button type="button" :title="t('files.sortBy', { column: t('files.name') })" @click="toggleSort('name')">
        {{ t("files.name") }}<component :is="sort.direction === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'name'" :size="10" /><i class="file-column-resizer" @pointerdown.stop="startColumnResize('name', $event)" />
      </button>
      <button type="button" :title="t('files.sortBy', { column: t('files.size') })" @click="toggleSort('size')">
        {{ t("files.size") }}<component :is="sort.direction === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'size'" :size="10" /><i class="file-column-resizer" @pointerdown.stop="startColumnResize('size', $event)" />
      </button>
      <button type="button" :title="t('files.sortBy', { column: t('files.modified') })" @click="toggleSort('modified')">
        {{ t("files.modified") }}<component :is="sort.direction === 'asc' ? ArrowUp : ArrowDown" v-if="sort.key === 'modified'" :size="10" /><i class="file-column-resizer" @pointerdown.stop="startColumnResize('modified', $event)" />
      </button><i />
    </div>
    <div ref="fileList" class="file-list" tabindex="0" role="listbox" :aria-multiselectable="true" @keydown="handleListKeydown">
      <div v-if="fileState.loading" class="file-loading"><LoaderCircle class="spin" :size="17" />{{ t("files.loading") }}</div>
      <div v-else-if="!showFiles" class="file-empty"><Folder :size="22" /><span>{{ fileState.errorCode ? directoryErrorMessage : isLive ? t('files.loading') : t('workspace.connectServer') }}</span></div>
      <template v-else>
        <button v-if="currentPath !== '/'" class="file-row file-parent-row" type="button" :disabled="!isLive || operationPending" :title="t('files.goUp')" @dblclick="goUp">
          <span class="file-primary"><Folder :size="16" /><span class="file-name">..</span></span>
          <small>—</small><small>—</small>
        </button>
        <div v-if="!fileState.files.length" class="file-empty"><Folder :size="22" /><span>{{ t("files.empty") }}</span></div>
        <div
          v-for="(file, index) in sortedFiles"
          v-else
          :key="file.path"
          :data-file-index="index"
          :class="['file-row-wrap', { selected: selectedSet.has(file.path) }]"
          role="option"
          :aria-selected="selectedSet.has(file.path)"
          :aria-disabled="operationPending"
          @click="selectEntry(file, $event)"
          @dblclick="openEntry(file)"
          @contextmenu.prevent="openContextMenu(file, $event)"
        >
          <button class="file-row" type="button" :disabled="operationPending">
            <span class="file-primary"><component :is="file.kind === 'directory' ? Folder : FileCode2" :size="16" /><span class="file-name">{{ file.name }}</span></span>
            <small>{{ file.size }}</small><small>{{ file.modified }}</small>
          </button>
          <div v-if="isLive" class="file-actions">
            <button v-if="file.kind === 'file'" type="button" :disabled="operationPending" :title="t('files.download')" @click.stop="download(file)"><Download :size="12" /></button>
          </div>
        </div>
      </template>
    </div>
    </div>
    <div v-if="fileState.errorCode" class="file-directory-state" role="alert">
      <TriangleAlert :size="14" />
      <span>{{ directoryErrorMessage }}</span>
      <button v-if="isLive" type="button" :disabled="operationPending" @click="refreshDirectory(fileState.failedPath || currentPath)">{{ t("common.retry") }}</button>
    </div>
    <p v-if="operationError" class="file-operation-error">{{ operationError }}</p>
    <TransferQueuePanel v-if="transferQueueOpen" :server-id="serverId" @close="transferQueueOpen = false" />
    <div class="panel-footnote">
      <span>{{ t("files.items", { count: fileState.files.length }) }}<template v-if="!isLive"> · {{ t("files.preparing") }}</template></span>
      <strong v-if="selection.selectedPaths.length">{{ t("files.selected", { count: selection.selectedPaths.length }) }}</strong>
    </div>

    <Teleport to="body">
      <Transition name="context-menu">
        <div v-if="contextMenu" class="file-context-menu" :style="{ left: `${contextMenu.x}px`, top: `${contextMenu.y}px` }" @pointerdown.stop>
          <button v-if="contextMenu.entry.kind === 'directory'" type="button" :disabled="!isLive || operationPending" @click="openDirectory(contextMenu.entry.path); closeContextMenu()"><FolderOpen :size="13" />{{ t("files.open") }}</button>
          <button v-else type="button" :disabled="!isLive || operationPending" @click="download(contextMenu.entry); closeContextMenu()"><Download :size="13" />{{ t("files.download") }}</button>
          <button v-if="contextMenu.entry.kind === 'file'" type="button" :disabled="!isLive || operationPending" @click="openEntry(contextMenu.entry); closeContextMenu()"><FileCode2 :size="13" />{{ t("files.edit") }}</button>
          <button type="button" @click="copyPath(contextMenu.entry)"><Copy :size="13" />{{ t("files.copyPath") }}</button>
          <hr />
          <button type="button" :disabled="!isLive || operationPending" @click="openDialog('rename', contextMenu.entry); closeContextMenu()"><Pencil :size="13" />{{ t("files.rename") }}</button>
          <button type="button" class="danger" :disabled="!isLive || operationPending" @click="openDialog('delete', contextMenu.entry); closeContextMenu()"><Trash2 :size="13" />{{ t("files.remove") }}</button>
        </div>
      </Transition>
    </Teleport>

    <div v-if="dialog" class="file-dialog-backdrop" @click.self="closeDialog">
      <form class="file-dialog" :aria-busy="operationPending" @submit.prevent="submitDialog">
        <header><strong>{{ dialogTitle(dialog) }}</strong><button type="button" :disabled="operationPending" :title="t('common.close')" @click="closeDialog"><X :size="15" /></button></header>
        <label v-if="dialog.type === 'create' || dialog.type === 'rename' || dialog.type === 'uploadRename'">
          {{ dialog.type === "create" ? t("files.newFolderName") : t("files.renameTo") }}
          <input ref="nameInput" v-model="dialog.value" :disabled="operationPending" autocomplete="off" />
        </label>
        <p v-else>{{ dialog.type === "delete" ? t("files.deleteHint", { path: dialog.entry?.path }) : t("files.overwriteHint", { name: dialog.file?.name }) }}</p>
        <span v-if="dialogError" class="file-dialog-error" role="alert">{{ dialogError }}</span>
        <footer v-if="dialog.type === 'overwrite'">
          <button class="button secondary" type="button" :disabled="operationPending" @click="closeDialog">{{ t("files.skip") }}</button>
          <button class="button secondary" type="button" :disabled="operationPending" @click="beginUploadRename">{{ t("files.renameUpload") }}</button>
          <button class="button primary" type="submit" :disabled="operationPending || !isLive">{{ t("files.overwrite") }}</button>
        </footer>
        <footer v-else>
          <button class="button secondary" type="button" :disabled="operationPending" @click="closeDialog">{{ t("common.cancel") }}</button>
          <button class="button primary" type="submit" :disabled="operationPending || !isLive">
            <template v-if="deletingPath"><LoaderCircle class="spin" :size="14" aria-hidden="true" /><span role="status">{{ t("files.deleting") }}</span></template>
            <template v-else>{{ dialog.type === "create" ? t("common.create") : dialog.type === "rename" ? t("common.save") : t("common.confirm") }}</template>
          </button>
        </footer>
      </form>
    </div>
  </section>
</template>

<style scoped>
.file-delete-progress { display: flex; align-items: center; gap: 7px; padding: 9px; color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }
.file-delete-progress svg { flex-shrink: 0; }
</style>
