<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, Copy, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";

defineProps<{ mac: boolean }>();
const { locale } = useI18n();
const maximized = ref(false);
const focused = ref(true);
const failure = ref("");
let disposed = false;
const cleanup: (() => void)[] = [];
async function action(kind: "minimize" | "toggleMaximize" | "close") {
  try { failure.value = ""; await getCurrentWindow()[kind](); }
  catch { failure.value = locale.value.startsWith("zh") ? "窗口操作失败，请重试" : "Window action failed. Please retry."; }
}
onMounted(async () => {
  const window = getCurrentWindow();
  const register = (stop: () => void) => { if (disposed) stop(); else cleanup.push(stop); };
  try {
    maximized.value = await window.isMaximized();
    focused.value = await window.isFocused();
    register(await window.onResized(async () => { try { maximized.value = await window.isMaximized(); } catch { /* Window may be closing. */ } }));
    register(await window.onFocusChanged(event => { focused.value = event.payload; }));
  } catch { /* Native controls remain available even when state tracking fails. */ }
});
onBeforeUnmount(() => { disposed = true; cleanup.forEach(stop => stop()); });
</script>

<template>
  <header :class="['window-titlebar', { mac, inactive: !focused }]">
    <div class="window-drag-zone" data-tauri-drag-region>
      <span class="window-brand" data-tauri-drag-region>Opsark</span><span class="window-caption" data-tauri-drag-region>{{ locale.startsWith('zh') ? '智能运维控制台' : 'Operations Console' }}</span>
    </div>
    <span v-if="failure" class="window-error" role="alert">{{ failure }}</span>
    <div v-if="!mac" class="window-buttons">
      <button :aria-label="locale.startsWith('zh') ? '最小化窗口' : 'Minimize window'" :title="locale.startsWith('zh') ? '最小化' : 'Minimize'" @click="action('minimize')"><Minus :size="14"/></button>
      <button :aria-label="locale.startsWith('zh') ? (maximized ? '还原窗口' : '最大化窗口') : (maximized ? 'Restore window' : 'Maximize window')" :title="locale.startsWith('zh') ? (maximized ? '还原' : '最大化') : (maximized ? 'Restore' : 'Maximize')" @click="action('toggleMaximize')"><Copy v-if="maximized" :size="12"/><Square v-else :size="12"/></button>
      <button class="window-close" :aria-label="locale.startsWith('zh') ? '关闭窗口' : 'Close window'" :title="locale.startsWith('zh') ? '关闭' : 'Close'" @click="action('close')"><X :size="16"/></button>
    </div>
  </header>
</template>

<style scoped>
.window-titlebar{position:fixed;top:0;left:0;right:0;height:36px;z-index:30000;display:flex;align-items:center;background:var(--chrome);color:var(--text);border-bottom:1px solid var(--border-soft);user-select:none}.window-drag-zone{height:100%;flex:1;min-width:0;display:flex;align-items:center;gap:12px;padding-left:18px}.window-brand{font-size:12px;font-weight:600;letter-spacing:.3px}.window-caption{font-size:11px;color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.mac .window-drag-zone{padding-left:88px}.inactive .window-brand,.inactive .window-buttons{opacity:.6}.window-buttons{display:flex;align-self:stretch}.window-buttons button{display:grid;place-items:center;width:46px;border:0;background:transparent;color:var(--text);border-radius:0;cursor:default}.window-buttons button:hover{background:var(--hover)}.window-buttons button:focus-visible{outline:2px solid var(--accent);outline-offset:-3px}.window-buttons .window-close:hover{background:#c42b1c;color:#fff}.window-error{font-size:11px;color:var(--red);padding:0 12px}
</style>
