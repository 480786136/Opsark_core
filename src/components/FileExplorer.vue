<script setup lang="ts">
import { computed, ref } from "vue";
import { ChevronLeft, ChevronRight, Download, FileCode2, Folder, FolderPlus, LoaderCircle, MoreHorizontal, Pencil, RefreshCw, Trash2, Upload } from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";
import type { FileEntry } from "@/types";

const props = defineProps<{ serverId: string }>();
const store = useOpsStore();
const currentPath = computed(() => store.remoteFilePath);
const isLive = computed(() => store.connectedServerIds.includes(props.serverId));
const fileInput = ref<HTMLInputElement>();

function joinPath(name: string) {
  return currentPath.value === "/" ? `/${name}` : `${currentPath.value}/${name}`;
}

function openDirectory(path: string) {
  if (isLive.value) void store.loadRemoteFiles(props.serverId, path);
  else store.remoteFilePath = path;
}

function goUp() {
  if (currentPath.value === "/") return;
  const parent = currentPath.value.split("/").slice(0, -1).join("/") || "/";
  openDirectory(parent);
}

async function createDirectory() {
  const name = window.prompt("新目录名称");
  if (!name?.trim()) return;
  if (name.includes("/")) return window.alert("目录名称不能包含 /");
  try {
    await store.createRemoteDirectory(props.serverId, joinPath(name.trim()));
  } catch (error) {
    window.alert(String(error));
  }
}

async function renameEntry(entry: FileEntry) {
  const name = window.prompt("重命名为", entry.name);
  if (!name?.trim() || name === entry.name) return;
  if (name.includes("/")) return window.alert("名称不能包含 /");
  try {
    await store.renameRemoteEntry(props.serverId, entry.path, joinPath(name.trim()));
  } catch (error) {
    window.alert(String(error));
  }
}

async function deleteEntry(entry: FileEntry) {
  if (!window.confirm(`确定删除 ${entry.path}？${entry.kind === "directory" ? "目录必须为空。" : ""}`)) return;
  try {
    await store.deleteRemoteEntry(props.serverId, entry);
  } catch (error) {
    window.alert(String(error));
  }
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) return window.alert("首版上传限制为 20 MB");
  if (store.files.some((entry) => entry.name === file.name) && !window.confirm(`${file.name} 已存在，确定覆盖？`)) return;
  try {
    await store.uploadRemoteFile(props.serverId, joinPath(file.name), new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    window.alert(String(error));
  }
}

async function download(entry: FileEntry) {
  try {
    const data = await store.downloadRemoteFile(props.serverId, entry);
    const url = URL.createObjectURL(new Blob([data]));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = entry.name;
    anchor.click();
    URL.revokeObjectURL(url);
  } catch (error) {
    window.alert(String(error));
  }
}
</script>

<template>
  <section class="work-panel file-panel">
    <header class="panel-header">
      <div>
        <span class="eyebrow">SFTP</span>
        <strong>远程文件</strong>
      </div>
      <div class="header-actions">
        <button title="上传文件" :disabled="!isLive" @click="fileInput?.click()"><Upload :size="15" /></button>
        <button title="新建目录" :disabled="!isLive" @click="createDirectory"><FolderPlus :size="15" /></button>
        <button title="刷新" @click="isLive && store.loadRemoteFiles(serverId, currentPath)"><RefreshCw :class="{ spin: store.filesLoading }" :size="15" /></button>
        <button title="更多"><MoreHorizontal :size="16" /></button>
        <input ref="fileInput" class="hidden-file-input" type="file" @change="upload" />
      </div>
    </header>
    <div class="path-bar">
      <button :disabled="currentPath === '/'" @click="goUp"><ChevronLeft :size="13" /></button>
      <span>root</span><ChevronRight :size="13" /><span>{{ currentPath }}</span>
    </div>
    <div class="file-list">
      <div v-if="store.filesLoading" class="file-loading"><LoaderCircle class="spin" :size="17" />读取远程目录…</div>
      <div v-for="file in store.files" v-else :key="file.path" class="file-row-wrap">
        <button class="file-row" @dblclick="file.kind === 'directory' && openDirectory(file.path)">
          <component :is="file.kind === 'directory' ? Folder : FileCode2" :size="16" />
          <span class="file-name">{{ file.name }}</span>
          <small>{{ file.size }}</small>
        </button>
        <div v-if="isLive" class="file-actions">
          <button v-if="file.kind === 'file'" title="下载" @click="download(file)"><Download :size="12" /></button>
          <button title="重命名" @click="renameEntry(file)"><Pencil :size="12" /></button>
          <button title="删除" @click="deleteEntry(file)"><Trash2 :size="12" /></button>
        </div>
      </div>
    </div>
    <div class="panel-footnote">{{ store.files.length }} 个项目 · {{ isLive ? "真实 SFTP" : "演示适配器" }}</div>
  </section>
</template>
