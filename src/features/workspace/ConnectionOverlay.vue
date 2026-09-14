<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Eye, KeyRound, RefreshCw, Settings2, SquareTerminal, Wifi, WifiOff } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";

const props = withDefaults(defineProps<{ serverId: string; active?: boolean }>(), { active: true });
const emit = defineEmits<{ readonlyChange: [value: boolean]; viewHistory: []; configure: [] }>();
const ops = useOpsStore();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const server = computed(() => ops.servers.find(item => item.id === props.serverId));
const connection = computed(() => ops.serverConnection(props.serverId));
const connected = computed(() => ops.isServerConnected(props.serverId));
const activeRequest = computed(() => ["connecting", "reconnecting", "suspect"].includes(connection.value.status));
const submitting = ref(false);
const busy = computed(() => submitting.value || activeRequest.value);
const readOnly = ref(false);
const editingCredentials = ref(false);
const password = ref("");
const submittedPassword = ref<string>();
const remember = ref(true);
const formError = ref("");
const panel = ref<HTMLElement>();
const passwordInput = ref<HTMLInputElement>();
const clock = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
const elapsed = computed(() => connection.value.startedAt
  ? Math.max(0, Math.floor((clock.value - connection.value.startedAt) / 1000)) : 0);
const heading = computed(() => ({
  idle: zh.value ? "等待连接服务器" : "Connect to this server",
  connecting: zh.value ? "正在连接服务器" : "Connecting to the server",
  connected: zh.value ? "SSH 已连接" : "SSH connected",
  suspect: zh.value ? "正在确认连接" : "Checking the connection",
  reconnecting: zh.value ? "正在重新连接" : "Reconnecting to the server",
  manual: zh.value ? "连接已中断" : "Connection interrupted",
  auth_failed: zh.value ? "身份验证失败" : "Authentication failed",
  disconnected: zh.value ? "服务器已断开" : "Server disconnected",
})[connection.value.status]);
const description = computed(() => {
  if (activeRequest.value) return connection.value.phase || (zh.value ? "等待 SSH 连接验证结果" : "Waiting for SSH verification");
  if (connection.value.status === "auth_failed") return zh.value ? "请检查连接账号和密码后重试。" : "Check your username and password, then try again.";
  if (connection.value.status === "manual") return zh.value ? "自动恢复已停止，请手动重新连接。" : "Automatic recovery has stopped. Reconnect when ready.";
  return zh.value ? "连接成功后可操作远程文件、终端和智能任务。" : "Connect to work with remote files, terminals, and tasks.";
});
const error = computed(() => formError.value || connection.value.error || "");

function stopClock() {
  if (timer !== undefined) clearInterval(timer);
  timer = undefined;
}
watch(() => props.active && activeRequest.value, running => {
  stopClock();
  if (running) {
    clock.value = Date.now();
    timer = setInterval(() => { clock.value = Date.now(); }, 1000);
  }
}, { immediate: true });
onBeforeUnmount(stopClock);

watch(connected, value => {
  if (!value) return;
  if (password.value === submittedPassword.value) password.value = "";
  submittedPassword.value = undefined;
  formError.value = "";
  editingCredentials.value = false;
  readOnly.value = false;
  emit("readonlyChange", false);
});
watch(() => connection.value.status, status => {
  if (status === "auth_failed") editingCredentials.value = true;
  if (["connecting", "reconnecting", "suspect"].includes(status)) formError.value = "";
}, { immediate: true });
watch(() => props.active && !connected.value, async (visible, previous) => {
  if (!visible || previous) return;
  await nextTick();
  panel.value?.focus({ preventScroll: true });
}, { immediate: true });

async function editCredentials() {
  readOnly.value = false;
  emit("readonlyChange", false);
  editingCredentials.value = true;
  await nextTick();
  passwordInput.value?.focus();
}

async function reconnect() {
  if (busy.value) return;
  submitting.value = true;
  formError.value = "";
  let needsCredentials = false;
  try {
    const success = await ops.reconnectServer(props.serverId);
    needsCredentials = !success && !ops.serverPasswords[props.serverId];
  } catch {
    formError.value = zh.value ? "连接未完成，请重试或修改连接信息。" : "Connection did not complete. Retry or edit your connection.";
  } finally { submitting.value = false; }
  if (needsCredentials) await editCredentials();
}

async function submitCredentials() {
  if (!password.value || busy.value) return;
  submitting.value = true;
  formError.value = "";
  submittedPassword.value = password.value;
  try {
    const success = await ops.connectServer(props.serverId, password.value, remember.value);
    if (success) {
      if (password.value === submittedPassword.value) password.value = "";
      submittedPassword.value = undefined;
      editingCredentials.value = false;
    } else {
      formError.value = connection.value.error ? "" : (zh.value ? "连接失败，请检查密码或服务器配置后重试。" : "Connection failed. Check your password or server settings.");
    }
  } catch {
    formError.value = zh.value ? "连接未完成，请重试。" : "Connection did not complete. Please retry.";
  } finally { submitting.value = false; }
  if (error.value) {
    await nextTick();
    passwordInput.value?.focus();
  }
}

function viewHistory() {
  readOnly.value = true;
  emit("readonlyChange", true);
  emit("viewHistory");
}
function expand() {
  readOnly.value = false;
  emit("readonlyChange", false);
  void nextTick(() => panel.value?.focus({ preventScroll: true }));
}
defineExpose({ serverId: props.serverId, reconnect });
</script>

<template>
  <section
    v-if="server && !connected"
    v-show="active"
    ref="panel"
    :class="['connection-overlay', { 'is-busy': busy, 'is-readonly': readOnly, 'has-error': error, 'is-hidden': !active }]"
    :data-connection-status="connection.status"
    :aria-label="heading"
    tabindex="-1"
  >
    <div class="connection-surface">
      <div class="connection-signal" aria-hidden="true"><i></i><span><Wifi v-if="busy" :size="23"/><WifiOff v-else :size="23"/></span><i></i></div>
      <div class="connection-copy">
        <div class="connection-eyebrow"><SquareTerminal :size="12"/>{{ readOnly ? (zh ? '只读历史' : 'Read-only history') : 'SSH' }}</div>
        <h2 role="status" aria-live="polite">{{ heading }}</h2>
        <p class="connection-target">{{ server.username }}@{{ server.host }}<span>:{{ server.port }}</span></p>
        <p class="connection-description">{{ description }}</p>
        <div v-if="connection.attempt > 0 || (activeRequest && connection.startedAt)" class="connection-timing">
          <span v-if="connection.attempt > 0">{{ zh ? `尝试 ${connection.attempt} 次` : `Attempt ${connection.attempt}` }}</span>
          <span v-if="activeRequest && connection.startedAt">{{ zh ? `已用时 ${elapsed} 秒` : `${elapsed}s elapsed` }}</span>
        </div>
        <p v-if="error" :id="`connection-error-${serverId}`" class="connection-error" role="alert">{{ error }}</p>
      </div>

      <form v-if="editingCredentials && !readOnly" class="connection-credentials" @submit.prevent="submitCredentials">
        <label :for="`connection-password-${serverId}`">{{ zh ? 'SSH 密码' : 'SSH password' }}</label>
        <input :id="`connection-password-${serverId}`" ref="passwordInput" v-model="password" type="password" autocomplete="current-password" :disabled="busy" :aria-invalid="Boolean(error)" :aria-describedby="error ? `connection-error-${serverId}` : undefined" :placeholder="zh ? '输入服务器密码' : 'Enter the server password'"/>
        <label class="connection-remember"><input v-model="remember" type="checkbox" :disabled="busy"/>{{ zh ? '验证成功后保存到系统钥匙串' : 'Save in the system keychain after verification' }}</label>
        <div class="connection-form-actions">
          <button class="connection-primary" type="submit" :disabled="!password || busy"><KeyRound :size="14"/>{{ busy ? (zh ? '正在验证连接' : 'Verifying connection') : (zh ? '验证并连接' : 'Verify and connect') }}</button>
          <button type="button" :disabled="busy" @click="editingCredentials = false">{{ zh ? '收起' : 'Hide' }}</button>
        </div>
      </form>

      <div class="connection-actions">
        <button v-if="!editingCredentials || readOnly" class="connection-primary" type="button" :disabled="busy" @click="reconnect"><RefreshCw :size="14"/>{{ busy ? (zh ? '正在连接' : 'Connecting') : (zh ? '重新连接' : 'Reconnect') }}</button>
        <button v-if="!editingCredentials || readOnly" type="button" :disabled="busy" @click="editCredentials"><KeyRound :size="14"/>{{ zh ? '修改凭据' : 'Edit credentials' }}</button>
        <button v-if="!readOnly" type="button" :disabled="busy" @click="emit('configure')"><Settings2 :size="14"/>{{ zh ? '服务器配置' : 'Server settings' }}</button>
        <button v-if="!readOnly" class="connection-history" type="button" @click="viewHistory"><Eye :size="14"/>{{ zh ? '查看终端历史' : 'View terminal history' }}</button>
        <button v-else type="button" @click="expand">{{ zh ? '连接详情' : 'Connection details' }}</button>
      </div>
      <p v-if="!readOnly" class="connection-footnote">{{ zh ? '终端历史、任务记录和草稿已保留。' : 'Terminal history, tasks, and drafts are preserved.' }}</p>
    </div>
  </section>
</template>

<style scoped>
.connection-overlay{position:absolute;inset:0;z-index:5;display:grid;place-items:center;overflow:auto;padding:24px;background:rgba(10,15,20,.85);backdrop-filter:blur(3px);color:var(--text);outline:none}
.connection-surface{width:min(100%,480px);padding:26px 30px 24px;border:1px solid color-mix(in srgb,var(--accent) 15%,var(--border));border-radius:8px;background:var(--panel,#151a20);box-shadow:0 18px 56px #070d1470,inset 0 1px 0 #e0f4ff08}
.connection-signal{display:flex;align-items:center;gap:12px;margin-bottom:23px;color:var(--muted)}
.connection-signal>i{height:1px;flex:1;background:var(--border);position:relative;overflow:hidden}.connection-signal>span{display:grid;place-items:center;width:49px;height:49px;border:1px solid var(--border);border-radius:8px}.is-busy .connection-signal{color:var(--accent)}.is-busy .connection-signal>span{border-color:color-mix(in srgb,var(--accent) 40%,var(--border));animation:connection-breathe 2.4s ease-in-out infinite}.is-busy .connection-signal>i:after{content:"";position:absolute;inset:0;background:var(--accent);transform:translateX(-100%);animation:connection-trace 2s ease-in-out infinite}
.connection-eyebrow{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:10px;letter-spacing:.06em}.connection-copy h2{margin:9px 0 8px;font-size:21px;font-weight:600;letter-spacing:-.03em;line-height:1.3}.connection-target{margin:0;font-size:12px;font-family:var(--font-mono,monospace);overflow-wrap:anywhere}.connection-target span{color:var(--muted)}.connection-description{margin:15px 0 0;color:var(--muted);font-size:12px;line-height:1.65;text-wrap:pretty}.connection-timing{display:flex;gap:16px;margin-top:9px;color:var(--muted);font-size:11px;font-variant-numeric:tabular-nums}.connection-error{margin:13px 0 0;padding:9px 11px;border-left:2px solid var(--orange,#dba766);background:color-mix(in srgb,var(--orange,#dba766) 7%,transparent);color:var(--text);font-size:12px;line-height:1.6;overflow-wrap:anywhere;max-height:130px;overflow:auto}
.connection-actions,.connection-form-actions{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin-top:20px}.connection-overlay button{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:32px;border:1px solid transparent;border-radius:4px;padding:6px 9px;background:transparent;color:var(--muted);font:inherit;font-size:11px;cursor:pointer;transition:background .18s,color .18s,transform .18s}.connection-overlay button:hover:enabled{background:var(--hover);color:var(--text)}.connection-overlay button:active:enabled{transform:translateY(1px)}.connection-overlay button:disabled{opacity:.5;cursor:default}.connection-overlay .connection-primary{background:var(--accent-soft);color:var(--accent);border-color:color-mix(in srgb,var(--accent) 25%,var(--border));font-weight:600}.connection-overlay .connection-primary:hover:enabled{background:color-mix(in srgb,var(--accent) 18%,var(--panel))}.connection-history{margin-left:-2px}.connection-footnote{margin:18px 0 0;border-top:1px solid var(--border);padding-top:14px;font-size:10px;color:var(--muted);line-height:1.6}
.connection-credentials{display:grid;gap:8px;margin-top:19px;padding-top:17px;border-top:1px solid var(--border)}.connection-credentials>label{font-size:11px;color:var(--muted)}.connection-credentials>input{width:100%;min-height:36px;padding:7px 10px;border:1px solid var(--border);border-radius:4px;background:var(--bg);color:var(--text);font:inherit;font-size:12px}.connection-credentials>input[aria-invalid=true]{border-color:var(--orange,#dba766)}.connection-remember{display:flex;align-items:center;gap:7px;line-height:1.5}.connection-remember input{accent-color:var(--accent)}.connection-form-actions{margin-top:4px}.connection-credentials+.connection-actions{margin-top:8px}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
.connection-overlay.is-readonly{position:relative;inset:auto;flex:0 0 auto;display:block;padding:0;background:var(--panel);backdrop-filter:none;border-bottom:1px solid var(--border);max-height:45%;}.is-readonly .connection-surface{display:flex;align-items:center;gap:16px;width:100%;padding:10px 15px;border:0;border-radius:0;box-shadow:none}.is-readonly .connection-signal{display:none}.is-readonly .connection-copy{flex:1;min-width:0}.is-readonly .connection-eyebrow{display:inline-flex;font-size:10px}.is-readonly h2{display:inline;margin-left:9px;font-size:12px;letter-spacing:0}.is-readonly .connection-target{display:none}.is-readonly .connection-description{margin-top:3px;font-size:11px}.is-readonly .connection-timing{display:inline-flex;margin-top:4px;font-size:10px}.is-readonly .connection-error{margin-top:5px;padding:0;border:0;background:none;font-size:11px;max-height:60px;color:var(--orange,#dba766)}.is-readonly .connection-actions{flex:0 1 auto;justify-content:flex-end;margin:0;gap:3px}.is-hidden *{animation-play-state:paused!important}
@keyframes connection-trace{to{transform:translateX(100%)}}@keyframes connection-breathe{50%{opacity:.45}}@media(prefers-reduced-motion:reduce){.connection-overlay *,.connection-overlay *:after{animation:none!important;transition:none!important}}@media(max-width:620px){.connection-overlay{padding:12px}.connection-surface{padding:20px}.is-readonly .connection-surface{flex-wrap:wrap;gap:7px;padding:10px}.is-readonly .connection-copy{flex-basis:100%}.is-readonly .connection-actions{justify-content:flex-start}.connection-copy h2{font-size:18px}.is-readonly .connection-copy h2{font-size:12px}}@media(max-height:600px){.connection-overlay:not(.is-readonly){place-items:start center;padding:12px}.connection-signal{margin-bottom:12px}.connection-signal>span{width:36px;height:36px}.connection-surface{padding:18px 22px}}
</style>
