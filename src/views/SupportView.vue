<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { ArrowUpRight, Check, Copy, ImagePlus, Mail, MessageCircle, RefreshCw, Send, X } from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";
import { useAccountStore } from "@/features/account/accountStore";
import { cloudRequest } from "@/features/account/cloudClient";
import { useUpdateStore } from "@/features/support/updateStore";
import { collectTaskLogs, redactSupportText, taskDiagnostic } from "@/features/support/diagnostics";
import { imageSource, readFeedbackImages, type FeedbackImage } from "@/features/support/images";
import ConfirmActionDialog from "@/components/ConfirmActionDialog.vue";
import { useActionConfirmation } from "@/components/useActionConfirmation";

const { confirmationMessage, confirmAction, resolveConfirmation } = useActionConfirmation();
const confirmationTitle = ref("温馨提示"), confirmationLabel = ref("确认并提交");
const ops = useOpsStore(), account = useAccountStore(), updates = useUpdateStore();
const owner = computed(() => account.current?.user.id);
const title = ref(""), message = ref(""), contact = ref(""), taskId = ref("");
const images = ref<FeedbackImage[]>([]), fileInput = ref<HTMLInputElement>();
const busy = ref(false), imageBusy = ref(false), error = ref(""), notice = ref(""), progress = ref("");
const copied = ref(""), contactError = ref("");
const selectedTask = computed(() => ops.tasks.find(t => t.id === taskId.value));
const secrets = () => Object.fromEntries([ops.modelApiKeys, ops.serverPasswords, ops.secretValues]
  .flatMap((group, index) => Object.entries(group).map(([key, value]) => [`${index}:${key}`, value])));
interface Payload { title: string; message: string; contact: string; category: "general" | "task"; core_version: string;
  diagnostic: ReturnType<typeof taskDiagnostic> | null; task_logs: string; images: FeedbackImage[]; mutation_id: string; consent: true }
interface Ticket { id: string; status: string; created_at: number; expires_at: number;
  content?: { title: string; message: string; contact?: string; images?: FeedbackImage[]; replies: { message: string; created_at: number }[] } | null }
const tickets = ref<Ticket[]>([]), detail = ref<Ticket | null>(null), loadedTickets = ref(false);
let pending: Payload | null = null;
watch([title, message, contact, taskId, images, owner], () => { pending = null; });
watch(owner, () => { resolveConfirmation(false); tickets.value = []; detail.value = null; loadedTickets.value = false; });
onMounted(() => { void updates.check(); });
async function run(fn: () => Promise<void>) {
  if (busy.value || imageBusy.value) return;
  busy.value = true; error.value = ""; notice.value = "";
  try { await fn(); } catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { busy.value = false; progress.value = ""; }
}
async function addImages(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files || []);
  if (!files.length) return;
  imageBusy.value = true; error.value = "";
  try { images.value = [...images.value, ...await readFeedbackImages(files, images.value.length)]; }
  catch (e) { error.value = e instanceof Error ? e.message : String(e); }
  finally { imageBusy.value = false; input.value = ""; }
}
async function copyContact(value: string, key: string) {
  contactError.value = "";
  try { await navigator.clipboard.writeText(value); copied.value = key; }
  catch { contactError.value = "复制失败，请选中联系方式手动复制。"; }
}
function identity() { if (!owner.value) throw new Error("请登录后查看账号下的历史反馈"); return owner.value; }
function assertOwner(id: string | undefined) { if (owner.value !== id) throw new Error("账号已切换，请重新操作"); }
async function refreshTickets() {
  const id = identity(); const result = await cloudRequest<Ticket[]>("feedback_list", undefined, id);
  assertOwner(id); tickets.value = result; loadedTickets.value = true;
}
async function submit() {
  if (!title.value.trim() || !message.value.trim()) throw new Error("请填写标题和问题描述");
  const id = owner.value, task = selectedTask.value;
  if (taskId.value && !task) throw new Error("关联任务已不存在，请重新选择");
  if (task) {
    confirmationTitle.value = "温馨提示"; confirmationLabel.value = "确认并提交";
    if (!await confirmAction(`为帮助我们定位问题，本次反馈将附上「${task.title}」的全部任务日志，包括运行记录、命令输出及模型交互内容。已知密码和密钥会自动脱敏。\n\n这些资料仅用于分析和处理您反馈的问题，不会自动加入知识库，保存 ${updates.info?.feedback_retention_days || 30} 天后清理。感谢您的信任与支持。\n\n是否确认提交？`)) return;
  }
  assertOwner(id);
  if (!pending) {
    progress.value = task ? "正在收集完整任务日志…" : "正在准备反馈…";
    const taskLogs = task ? await collectTaskLogs(task, ops.logs, ops.developerLogs, secrets()) : "";
    assertOwner(id);
    pending = { title: redactSupportText(title.value.trim(), secrets()), message: redactSupportText(message.value.trim(), secrets()),
      contact: contact.value.trim(), category: task ? "task" : "general", core_version: updates.currentVersion,
      diagnostic: task ? taskDiagnostic(task) : null, task_logs: taskLogs, images: images.value.map(image => ({ ...image })),
      mutation_id: crypto.randomUUID(), consent: true };
  }
  // Retain the exact payload after a network failure so retries stay idempotent, including live logs.
  const submission = pending;
  progress.value = "正在提交反馈…";
  const result = await cloudRequest<{ id: string }>("feedback_create", submission, id);
  title.value = ""; message.value = ""; taskId.value = ""; images.value = []; pending = null;
  notice.value = `反馈已提交，工单编号 ${result.id}。${submission.contact ? '我们会通过您留下的联系方式跟进。' : '感谢您帮助 OpsArk 改进。'}`;
  if (id && owner.value === id) {
    try { await refreshTickets(); } catch { /* Submission succeeded; list refresh must not turn it into a failure. */ }
  }
}
async function readTicket(ticket: Ticket) {
  const id = identity(); const result = await cloudRequest<Ticket>("feedback_read", { id: ticket.id }, id);
  assertOwner(id); detail.value = result;
}
async function removeTicket(ticket: Ticket) {
  const id = identity(); confirmationTitle.value = "删除反馈正文"; confirmationLabel.value = "确认删除";
  if (!await confirmAction("删除这条反馈保存的正文、联系方式、图片、日志与回复？此操作不可恢复，工单元数据会保留。")) return;
  assertOwner(id); await cloudRequest("feedback_delete", { id: ticket.id }, id); assertOwner(id);
  detail.value = null; await refreshTickets();
}
const statusLabels: Record<string, string> = { open: "待处理", in_progress: "处理中", resolved: "已解决", deleted: "已删除", expired: "已过期" };
</script>

<template>
  <ConfirmActionDialog :message="confirmationMessage" :title="confirmationTitle" :confirm-label="confirmationLabel" @result="resolveConfirmation" />
  <div class="page management-page support-page">
    <header class="page-header"><div><span class="eyebrow">SUPPORT / OPSARK</span><h1>联系、反馈与更新</h1><p>把遇到的问题告诉我们，一起让 OpsArk 更好用。</p></div><span class="support-version">v{{ updates.currentVersion }}</span></header>
    <div class="support-layout">
      <div class="feedback-column">
        <section class="support-card feedback-card" aria-labelledby="feedback-heading">
          <div class="card-heading"><div><h2 id="feedback-heading">问题反馈</h2><p>使用遇到问题，或有新的想法，都可以在这里告诉我们。</p></div><span class="quiet-badge">无需登录</span></div>
          <form @submit.prevent="run(submit)">
            <fieldset :disabled="busy || imageBusy">
              <label for="feedback-title">标题 <span class="required-mark">*</span></label>
              <input id="feedback-title" v-model="title" placeholder="简要描述您遇到的问题或建议" maxlength="120" required />
              <div class="label-line"><label for="feedback-message">问题描述 <span class="required-mark">*</span></label><span>{{ message.length }} / 4000</span></div>
              <textarea id="feedback-message" v-model="message" rows="6" placeholder="您在进行什么操作？遇到了什么情况？期待的结果是什么？" maxlength="4000" required />
              <div class="field-pair">
                <div><label for="feedback-task">关联任务 <span class="optional">选填</span></label><select id="feedback-task" v-model="taskId"><option value="">不关联任务</option><option v-for="task in ops.tasks" :key="task.id" :value="task.id">{{ task.title }} · {{ task.status }}</option></select></div>
                <div><label for="feedback-contact">您的联系方式 <span class="optional">选填</span></label><input id="feedback-contact" v-model="contact" placeholder="邮箱、微信或手机号，方便我们回复" maxlength="254" /></div>
              </div>
              <p v-if="selectedTask" class="task-attachment-note"><Check :size="15" /> 已关联任务，提交时自动附上全部日志，并请您确认。</p>
              <div class="label-line attachment-label"><label for="feedback-images">问题截图 <span class="optional">选填</span></label><span>{{ images.length }} / 3</span></div>
              <input id="feedback-images" ref="fileInput" class="file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="上传问题截图" @change="addImages" />
              <div class="image-list">
                <figure v-for="(image, index) in images" :key="index" class="image-preview"><img :src="imageSource(image)" :alt="`问题截图：${image.name}`" /><figcaption :title="image.name">{{ image.name }}</figcaption><button type="button" :aria-label="`移除图片 ${index + 1}`" @click="images = images.filter((_, i) => i !== index)"><X :size="14" /></button></figure>
                <button v-if="images.length < 3" type="button" class="image-add" @click="fileInput?.click()"><ImagePlus :size="22" /><span>{{ imageBusy ? '读取中…' : '添加图片' }}</span></button>
              </div>
              <p class="field-help">可上传 1–3 张 PNG、JPG 或 WebP 图片，每张不超过 5 MB。</p>
              <div class="submit-row"><p>反馈资料仅用于问题分析与处理。</p><button class="button primary submit-feedback" type="submit"><Send :size="15" />{{ progress || (busy ? '等待确认…' : '提交反馈') }}</button></div>
            </fieldset>
          </form>
          <p v-if="error" class="feedback-message support-error" role="alert">{{ error }}</p><p v-if="notice" class="feedback-message success-message" role="status">{{ notice }}</p>
        </section>
        <section v-if="owner" class="support-card history-card">
          <div class="card-heading"><h2>我的反馈</h2><button class="button secondary" :disabled="busy" @click="run(refreshTickets)"><RefreshCw :size="14" />刷新</button></div>
          <p v-if="!tickets.length">{{ loadedTickets ? '还没有反馈记录。' : '点击刷新查看当前账号的反馈与支持回复。' }}</p>
          <div v-for="ticket in tickets" :key="ticket.id" class="ticket-row"><div><span>{{ statusLabels[ticket.status] || ticket.status }}</span><p>{{ new Date(ticket.created_at * 1000).toLocaleString() }} · {{ ticket.id.slice(0, 12) }}</p></div><button class="text-button" :disabled="busy" @click="run(() => readTicket(ticket))">查看回复</button><button class="text-button" :disabled="busy || ['deleted', 'expired'].includes(ticket.status)" @click="run(() => removeTicket(ticket))">删除正文</button></div>
          <article v-if="detail" class="ticket-detail"><template v-if="detail.content"><h3>{{ detail.content.title }}</h3><pre>{{ detail.content.message }}</pre><div class="ticket-images"><img v-for="(img, index) in detail.content.images" :key="index" :src="imageSource(img)" :alt="img.name" /></div><h4>支持回复</h4><p v-if="!detail.content.replies.length">暂无回复</p><pre v-for="(reply, index) in detail.content.replies" :key="index">{{ reply.message }}</pre></template><p v-else>内容已删除或过期。</p></article>
        </section>
      </div>
      <aside class="support-sidebar">
        <section class="support-card contact-card" aria-labelledby="contact-heading">
          <div class="card-heading"><h2 id="contact-heading">联系我们</h2><MessageCircle :size="20" class="heading-icon" /></div><p>也欢迎直接联系，交流使用体验与产品建议。</p>
          <div class="contact-item"><MessageCircle :size="18" /><div><span>微信</span><strong>{{ updates.contact.support_wechat }}</strong></div><button class="icon-button" :aria-label="copied === 'wechat' ? '微信已复制' : '复制微信'" @click="copyContact(updates.contact.support_wechat, 'wechat')"><Check v-if="copied === 'wechat'" :size="16" /><Copy v-else :size="16" /></button></div>
          <div class="contact-item"><Mail :size="18" /><div><span>邮箱</span><strong>{{ updates.contact.support_email }}</strong></div><button class="icon-button" :aria-label="copied === 'email' ? '邮箱已复制' : '复制邮箱'" @click="copyContact(updates.contact.support_email, 'email')"><Check v-if="copied === 'email'" :size="16" /><Copy v-else :size="16" /></button></div>
          <p v-if="copied" class="copy-notice" role="status">{{ copied === 'wechat' ? '微信号' : '邮箱地址' }}已复制</p><p v-if="contactError" class="support-error" role="alert">{{ contactError }}</p>
          <div class="developer-row"><span>开发者</span><strong>{{ updates.contact.developer_name }}</strong></div>
          <button v-if="updates.contact.support_url" class="text-button support-link" :disabled="busy" @click="run(async () => { await cloudRequest('open_support'); })">官方联系页面<ArrowUpRight :size="15" /></button>
        </section>
        <section class="support-card system-card" aria-labelledby="system-heading">
          <div class="card-heading"><h2 id="system-heading">版本与系统</h2><span class="system-dot" /></div>
          <div class="installed-version"><span>OpsArk</span><strong>v{{ updates.currentVersion }}</strong><small>当前安装版本</small></div>
          <dl class="system-facts"><div><dt>官方 Skill</dt><dd>{{ updates.contentVersions.skills ? `v${updates.contentVersions.skills}` : '安装包内置' }}</dd></div><div><dt>工具配置</dt><dd>{{ updates.contentVersions.tools ? `v${updates.contentVersions.tools}` : '安装包内置' }}</dd></div></dl>
          <button class="button secondary check-update" :disabled="updates.busy" @click="updates.check()"><RefreshCw :size="15" :class="{ spinning: updates.busy }" />{{ updates.busy ? '检查中…' : '检查更新' }}</button>
          <p v-if="updates.error" class="support-error" role="alert">{{ updates.error }}</p><p v-if="updates.contentError" class="support-error" role="alert">{{ updates.contentError }}</p><p v-if="updates.contentNotice" role="status">{{ updates.contentNotice }}</p>
          <p v-if="updates.info?.update_required" class="support-error">官方云功能需要 {{ updates.info.min_cloud_version }} 或更高版本。本地功能与自带模型仍可使用。</p>
          <div v-if="updates.info?.latest" class="release-info"><span class="quiet-badge">发现新版本</span><h3>v{{ updates.info.latest.version }}</h3><p>{{ updates.info.latest.platform }} / {{ updates.info.latest.arch }}</p><pre>{{ updates.info.latest.notes }}</pre><p>点击下载将在系统浏览器打开官网下载页面。</p><div class="support-actions"><button class="button primary" :disabled="updates.busy" @click="updates.download()">前往下载<ArrowUpRight :size="14" /></button><button class="text-button" @click="updates.later()">稍后提醒</button></div></div><p v-else-if="updates.info" class="update-current"><Check :size="14" />当前已是适用于此设备的最新版本</p>
        </section>
        <p class="sidebar-footnote">每一次反馈，都是 OpsArk 进步的起点。</p>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.support-page{overflow:auto}.support-page .page-header{align-items:center;margin-bottom:26px}.support-version{color:var(--muted);font:12px/1.4 'DM Mono',monospace;border:1px solid var(--border);border-radius:6px;padding:7px 10px}.support-layout{display:grid;grid-template-columns:minmax(0,1fr) 330px;gap:24px;max-width:1320px;margin:0 auto;align-items:start}.feedback-column,.support-sidebar{display:grid;gap:20px;min-width:0}.support-card{min-width:0;background:var(--panel);border:1px solid var(--border-soft);border-radius:14px;padding:26px}.card-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:22px}.card-heading h2{margin:0;font-size:17px;font-weight:600;letter-spacing:-.3px}.support-card p{font-size:12px;color:var(--muted);line-height:1.8;overflow-wrap:anywhere}.card-heading p{margin:8px 0 0}.quiet-badge{flex-shrink:0;color:var(--accent);background:var(--accent-soft);padding:5px 8px;border-radius:5px;font-size:11px}.feedback-card fieldset{border:0;margin:0;padding:0;min-width:0}.feedback-card label{display:block;font-size:12px;font-weight:500;margin-bottom:9px}.required-mark{color:var(--accent);margin-left:3px}.optional{color:var(--dim);font-size:11px;font-weight:400;margin-left:5px}.feedback-card input:not([type=file]),.feedback-card textarea,.feedback-card select{display:block;width:100%;min-width:0;border:1px solid var(--border);background:var(--bg);color:var(--text);padding:12px;border-radius:7px;font:inherit;font-size:12px;transition:border-color .18s,box-shadow .18s}.feedback-card input::placeholder,.feedback-card textarea::placeholder{color:var(--dim)}.feedback-card input:focus-visible,.feedback-card textarea:focus-visible,.feedback-card select:focus-visible{outline:2px solid var(--accent-border);outline-offset:2px;border-color:var(--accent)}.feedback-card textarea{resize:vertical;min-height:145px;line-height:1.8}.label-line{display:flex;align-items:center;justify-content:space-between;margin-top:22px}.label-line>span{font-size:10px;color:var(--dim);font-variant-numeric:tabular-nums}.field-pair{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px}.field-pair>div{min-width:0}.feedback-card .task-attachment-note{display:flex;align-items:flex-start;gap:7px;color:var(--accent);margin:12px 0 0}.task-attachment-note svg{flex:none;margin-top:3px}.file-input{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}.image-list{display:flex;flex-wrap:wrap;gap:12px}.image-add,.image-preview{width:112px;height:96px;border-radius:8px;position:relative;margin:0;overflow:hidden}.image-add{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:9px;border:1px dashed var(--border);background:var(--bg);color:var(--muted);font-size:11px;cursor:pointer;transition:background .18s,border-color .18s}.image-add:hover{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}.image-preview{background:var(--bg);border:1px solid var(--border)}.image-preview img{width:100%;height:70px;object-fit:contain}.image-preview figcaption{font-size:10px;padding:3px 6px;white-space:nowrap;text-overflow:ellipsis;overflow:hidden;color:var(--muted)}.image-preview button{position:absolute;right:4px;top:4px;display:grid;place-items:center;width:22px;height:22px;border:1px solid var(--border);background:var(--panel);color:var(--text);border-radius:5px;cursor:pointer}.field-help{margin:9px 0 0}.submit-row{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-top:26px;border-top:1px solid var(--border-soft);padding-top:20px}.submit-row p{margin:0;font-size:11px}.submit-feedback{min-height:39px;flex-shrink:0}.feedback-message{padding:12px 14px;border-radius:7px;background:var(--panel-2);margin:18px 0 0;white-space:pre-wrap}.support-card .support-error{color:var(--red)}.support-card .success-message{color:var(--accent)}.support-sidebar .support-card{padding:23px}.support-sidebar .card-heading{margin-bottom:14px}.heading-icon{color:var(--dim)}.contact-item{display:flex;align-items:center;gap:12px;padding:18px 0;border-bottom:1px solid var(--border-soft);min-width:0}.contact-item>svg{color:var(--muted);flex:none}.contact-item>div{flex:1;min-width:0}.contact-item span{display:block;font-size:11px;color:var(--dim);margin-bottom:5px}.contact-item strong{font-size:13px;font-weight:500;overflow-wrap:anywhere;user-select:text}.icon-button{display:grid;place-items:center;flex:none;width:29px;height:29px;color:var(--muted);background:transparent;border:0;border-radius:5px;cursor:pointer;transition:background .18s,color .18s}.icon-button:hover{background:var(--hover);color:var(--text)}.developer-row{display:flex;justify-content:space-between;padding-top:19px;font-size:12px}.developer-row span{color:var(--muted)}.developer-row strong{font-weight:500}.text-button{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:0;background:transparent;color:var(--muted);font:inherit;font-size:12px;padding:5px 0;cursor:pointer}.text-button:hover{color:var(--accent)}.support-link{margin-top:18px}.system-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}.installed-version{padding:10px 0 22px;display:grid;gap:8px}.installed-version>span{font-size:12px;font-weight:500;color:var(--muted)}.installed-version strong{font:500 29px/1.2 'DM Mono',monospace;letter-spacing:-1px}.installed-version small{font-size:11px;color:var(--dim)}.system-facts{border-top:1px solid var(--border-soft);padding-top:7px;margin:0 0 17px}.system-facts>div{display:flex;justify-content:space-between;gap:12px;padding:8px 0;font-size:12px}.system-facts dt{color:var(--muted)}.system-facts dd{margin:0;font-variant-numeric:tabular-nums}.check-update{width:100%;justify-content:center}.release-info{border-top:1px solid var(--border-soft);margin-top:20px;padding-top:20px}.release-info h3{font-size:19px;margin:12px 0 4px}.support-card pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg);padding:14px;border-radius:7px;font-size:12px;line-height:1.8;max-height:350px;overflow:auto}.support-actions{display:flex;align-items:center;gap:18px}.update-current{display:flex;gap:6px;align-items:center}.sidebar-footnote{text-align:center;margin:0;color:var(--dim);font-size:11px;line-height:1.7}.ticket-row{display:flex;align-items:center;gap:16px;padding:14px 0;border-bottom:1px solid var(--border-soft)}.ticket-row>div{flex:1;min-width:0;font-size:12px}.ticket-row p{font-size:11px;margin:5px 0 0}.ticket-detail{padding-top:14px}.ticket-images{display:flex;gap:10px;flex-wrap:wrap}.ticket-images img{max-width:150px;max-height:140px;object-fit:contain}.support-page button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}.support-page button:disabled{opacity:.5;cursor:not-allowed}.support-page button:not(:disabled):active{transform:translateY(1px)}.spinning{animation:spin 1.3s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.spinning{animation:none}}@media(max-width:1100px){.support-layout{grid-template-columns:minmax(0,1fr) 290px;gap:18px}.support-card{padding:22px}.field-pair{grid-template-columns:1fr}.support-sidebar .support-card{padding:20px}}@media(max-width:820px){.support-layout{grid-template-columns:1fr}.support-sidebar{grid-template-columns:repeat(2,minmax(0,1fr));align-items:start}.sidebar-footnote{grid-column:1/-1}.field-pair{grid-template-columns:1fr 1fr}}@media(max-width:560px){.support-sidebar,.field-pair{grid-template-columns:1fr}.card-heading{align-items:flex-start}.submit-row{align-items:flex-start;flex-direction:column}.submit-feedback{width:100%;justify-content:center}}
</style>
