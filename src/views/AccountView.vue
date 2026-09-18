<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { useAccountStore } from "@/features/account/accountStore";
import { cloudRequest } from "@/features/account/cloudClient";
import { formatCredits, tokensToCredits } from "@/features/account/credits";
import ContactPopover from "@/components/ContactPopover.vue";

const account = useAccountStore();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const mode = ref<"login" | "register">("login");
const email = ref("");
const password = ref("");
const githubEnabled = ref(false);
const hasReserved = computed(() => (account.current?.balance.reserved || 0) > 0);
const availableCredits = computed(() => tokensToCredits(account.current?.balance.available ?? 0));
const contactOpen = ref(false);

onMounted(async () => {
  await account.initialize();
  try { githubEnabled.value = (await cloudRequest<{ enabled: boolean }>("github_config")).enabled; }
  catch { /* GitHub is an optional sign-in method. */ }
});

async function submit() {
  await account.authenticate(mode.value, email.value, password.value);
  password.value = "";
}
</script>

<template>
  <div class="page management-page account-page">
    <header class="page-header account-header">
      <div><span class="eyebrow">OPSARK CLOUD</span><h1>{{ zh ? '账号与积分' : 'Account & credits' }}</h1><p>{{ zh ? '统一管理官方模型积分、登录方式与个人 Skill 同步。' : 'Manage official model credits, sign-in methods, and personal Skill sync.' }}</p></div>
      <span v-if="account.current" class="service-state"><i />{{ zh ? '云服务已连接' : 'Cloud connected' }}</span>
    </header>

    <div class="account-shell">
      <p v-if="account.error" class="account-message error" role="alert">{{ account.error }}</p>
      <p v-if="account.notice" class="account-message" role="status">{{ account.notice }}</p>
      <p v-if="!account.config.configured" class="account-message muted">{{ account.config.message || (zh ? '正在初始化账号服务…' : 'Initializing account service…') }}</p>

      <template v-else-if="account.current">
        <section class="account-overview" aria-labelledby="account-overview-title">
          <div class="identity-block"><span class="section-kicker">{{ zh ? '当前账号' : 'Current account' }}</span><h2 id="account-overview-title">{{ account.current.user.email }}</h2><div class="identity-meta"><span>{{ zh ? '个人账号' : 'Personal account' }}</span><span v-if="account.current.githubLinked" class="verified-mark"><i />GitHub {{ zh ? '已绑定' : 'linked' }}</span></div></div>
          <div class="balance-block"><span class="section-kicker">{{ zh ? '可用积分' : 'Available credits' }}</span><div class="balance-value"><strong>{{ formatCredits(account.current.balance.available) }}</strong><span>{{ zh ? '积分' : 'credits' }}</span></div><p v-if="availableCredits < 10" class="low-credit-note">{{ zh ? '还想继续体验？可以联系开发者。' : 'Want to keep exploring? Contact the developer.' }} <button type="button" @click="contactOpen = true">{{ zh ? '联系我们' : 'Contact us' }}</button></p></div>
          <div v-if="hasReserved" class="reserved-block"><span>{{ zh ? '待结算预留' : 'Reserved for settlement' }}</span><strong>{{ formatCredits(account.current.balance.reserved) }} {{ zh ? '积分' : 'credits' }}</strong></div>
        </section>

        <div class="account-grid">
          <section class="account-panel models-panel">
            <div class="panel-heading"><div><span class="section-kicker">{{ zh ? '服务权益' : 'Entitlements' }}</span><h2>{{ zh ? '官方模型' : 'Official models' }}</h2></div><span class="count-mark">{{ account.current.models.length }}</span></div>
            <ul v-if="account.current.models.length" class="model-list"><li v-for="model in account.current.models" :key="model.id"><i /><span>{{ model.name || model.id }}</span><small>{{ zh ? '可用' : 'Ready' }}</small></li></ul>
            <div v-else class="empty-state"><strong>{{ zh ? '暂无已开放模型' : 'No models enabled' }}</strong><p>{{ zh ? '管理员开放模型后会自动出现在这里；自带模型不受影响。' : 'Models appear here when enabled by an administrator. Your own models remain available.' }}</p><RouterLink to="/models">{{ zh ? '管理自带模型' : 'Manage own models' }}</RouterLink></div>
            <p v-if="account.current.model_warning" class="panel-warning" role="alert">{{ account.current.model_warning }}</p>
          </section>

          <section class="account-panel access-panel">
            <div class="panel-heading"><div><span class="section-kicker">{{ zh ? '账号安全' : 'Account access' }}</span><h2>{{ zh ? '登录方式' : 'Sign-in methods' }}</h2></div></div>
            <div class="access-row"><span class="provider-mark"><svg class="github-mark" width="19" height="19" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.3 1.8 1.3 1.1 1.8 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.3-3.2-.1-.3-.6-1.6.1-3.2 0 0 1.1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.3 2.9.1 3.2.8.9 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z" /></svg></span><div><strong>GitHub</strong><small v-if="account.current.githubLinked">{{ zh ? '已用于安全登录' : 'Connected for sign-in' }}</small><small v-else>{{ zh ? '绑定后可快捷登录，不读取仓库' : 'Link for sign-in without repository access' }}</small></div><span v-if="account.current.githubLinked" class="linked-state">{{ zh ? '已绑定' : 'Linked' }}</span><button v-else class="text-action" :disabled="account.busy || !githubEnabled" @click="account.githubStart()">{{ zh ? '绑定' : 'Link' }}</button></div>
            <button v-if="account.githubPending" class="button primary complete-button" :disabled="account.busy" @click="account.githubComplete()">{{ zh ? '完成 GitHub 绑定' : 'Complete GitHub link' }}</button>
            <div class="sync-note"><i /><p><strong>{{ zh ? '个人 Skill 自动同步' : 'Personal Skill sync' }}</strong><span>{{ zh ? '仅同步你创建的 Skill，不上传服务器、凭据或任务日志。' : 'Only your personal Skills sync. Servers, credentials, and task logs stay local.' }}</span></p></div>
          </section>
        </div>

        <footer class="account-footer"><span>{{ zh ? '积分为最近一次服务端快照' : 'Credits reflect the latest server snapshot' }}</span><div><button class="text-action" :disabled="account.busy" @click="account.refresh()">{{ zh ? '刷新数据' : 'Refresh' }}</button><button class="text-action danger" :disabled="account.busy" @click="account.logout()">{{ zh ? '退出账号' : 'Sign out' }}</button></div></footer>
      </template>

      <template v-else>
        <div class="signin-grid">
          <form class="signin-panel" @submit.prevent="submit">
            <div class="signin-heading"><span class="section-kicker">{{ zh ? '邮箱账号' : 'Email account' }}</span><h2>{{ mode === 'login' ? (zh ? '欢迎回来' : 'Welcome back') : (zh ? '创建 OpsArk 账号' : 'Create your OpsArk account') }}</h2></div>
            <div class="mode-switch" role="tablist"><button type="button" :aria-selected="mode === 'login'" @click="mode = 'login'">{{ zh ? '登录' : 'Sign in' }}</button><button type="button" :disabled="!account.policy.enabled" :aria-selected="mode === 'register'" @click="mode = 'register'">{{ zh ? '注册' : 'Register' }}</button></div>
            <p v-if="mode === 'register' && account.policy.enabled" class="grant-note">{{ zh ? '注册即得' : 'Registration grant' }} <strong>{{ formatCredits(account.policy.initial_tokens) }}</strong> {{ zh ? '积分' : 'credits' }}</p>
            <fieldset :disabled="account.busy"><label><span>{{ zh ? '邮箱' : 'Email' }}</span><input v-model="email" type="email" autocomplete="username" maxlength="254" required /></label><label><span>{{ zh ? '密码' : 'Password' }}</span><input v-model="password" type="password" :autocomplete="mode === 'login' ? 'current-password' : 'new-password'" minlength="10" maxlength="256" required /><small>{{ zh ? '至少 10 位' : 'At least 10 characters' }}</small></label><button class="button primary wide" type="submit" :disabled="mode === 'register' && !account.policy.enabled">{{ account.busy ? (zh ? '处理中…' : 'Working…') : mode === 'login' ? (zh ? '登录账号' : 'Sign in') : (zh ? '注册并领取额度' : 'Register & claim credits') }}</button></fieldset>
            <p class="form-footnote">{{ zh ? '内测期间暂不支持自助找回密码。' : 'Self-service password recovery is unavailable during beta.' }}</p>
          </form>

          <section class="signin-panel github-panel">
            <span class="provider-mark large"><svg class="github-mark" width="27" height="27" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.1c-3.3.7-4-1.4-4-1.4-.5-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.3 1.8 1.3 1.1 1.8 2.9 1.3 3.6 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.3-3.2-.1-.3-.6-1.6.1-3.2 0 0 1.1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.3 2.9.1 3.2.8.9 1.3 1.9 1.3 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3Z" /></svg></span><div class="github-copy"><span class="section-kicker">{{ zh ? '快捷登录' : 'Quick sign-in' }}</span><h2>GitHub</h2><p>{{ zh ? '仅获取公开身份和已验证邮箱，不请求仓库权限。' : 'Uses your public identity and verified email. No repository access.' }}</p></div>
            <button class="button secondary wide" :disabled="account.busy || !githubEnabled" @click="account.githubStart()">{{ zh ? '使用 GitHub 继续' : 'Continue with GitHub' }}</button>
            <button v-if="account.githubPending" class="button primary wide" :disabled="account.busy" @click="account.githubComplete()">{{ zh ? '我已授权，完成登录' : 'Authorization complete' }}</button>
            <small v-if="!githubEnabled" class="panel-warning">{{ zh ? 'GitHub 登录暂不可用' : 'GitHub sign-in is unavailable' }}</small>
          </section>
        </div>
        <div class="local-note"><span>{{ zh ? '不登录也能使用本地功能和自带模型' : 'Local features and your own models work without an account' }}</span><RouterLink to="/models">{{ zh ? '管理自带模型' : 'Manage own models' }}</RouterLink></div>
      </template>
    </div>
    <ContactPopover v-model:open="contactOpen" />
  </div>
</template>

<style scoped>
.account-page{overflow:auto}.account-header{align-items:center;margin-bottom:24px}.account-header h1{font-size:32px;letter-spacing:-.035em}.service-state{display:inline-flex;align-items:center;gap:7px;padding:7px 10px;border:1px solid var(--border);border-radius:6px;color:var(--muted);font-size:11px;background:var(--panel)}.service-state i,.verified-mark i{width:6px;height:6px;border-radius:50%;background:var(--green);box-shadow:0 0 9px color-mix(in srgb,var(--green) 55%,transparent)}.account-shell{max-width:1120px;margin:0 auto}.account-message{margin:0 0 14px;padding:11px 13px;border-left:2px solid var(--accent);background:var(--accent-soft);color:var(--text);font-size:12px}.account-message.error{border-color:var(--red);background:color-mix(in srgb,var(--red) 10%,transparent)}.account-message.muted{border-color:var(--border);background:var(--panel);color:var(--muted)}.section-kicker{display:block;margin-bottom:8px;color:var(--dim);font:500 9px/1.2 var(--font-mono);letter-spacing:.08em;text-transform:uppercase}.account-overview{display:grid;grid-template-columns:minmax(0,1.4fr) minmax(260px,.8fr);gap:28px;padding:24px 26px 27px;border:1px solid var(--border);border-radius:10px;background:radial-gradient(circle at 80% -30%,var(--accent-soft),transparent 45%),var(--panel)}.identity-block h2{margin:0;font-size:20px;line-height:1.25;letter-spacing:-.02em;overflow-wrap:anywhere}.identity-meta{display:flex;gap:10px;align-items:center;margin-top:12px;color:var(--muted);font-size:11px}.identity-meta>span+span{padding-left:10px;border-left:1px solid var(--border)}.verified-mark{display:inline-flex;align-items:center;gap:6px;color:var(--text)}.balance-block{padding-left:28px;border-left:1px solid var(--border)}.balance-value{display:flex;align-items:baseline;gap:8px}.balance-value strong{font:600 34px/1 var(--font-mono);letter-spacing:-.05em}.balance-value span{color:var(--muted);font:10px var(--font-mono)}.balance-block p{margin:10px 0 0;color:var(--muted);font-size:11px}.reserved-block{grid-column:1/-1;display:flex;justify-content:space-between;padding-top:15px;border-top:1px solid var(--border-soft);color:var(--muted);font-size:11px}.reserved-block strong{color:var(--text);font-family:var(--font-mono)}.account-grid{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(320px,.85fr);gap:14px;margin-top:14px}.account-panel,.signin-panel{padding:22px;border:1px solid var(--border);border-radius:9px;background:var(--panel)}.panel-heading{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:18px}.panel-heading h2,.signin-heading h2{margin:0;font-size:16px;letter-spacing:-.015em}.count-mark{min-width:25px;padding:4px 7px;border-radius:5px;background:var(--panel-3);color:var(--muted);font:10px var(--font-mono);text-align:center}.model-list{display:grid;gap:1px;margin:0;padding:0;list-style:none;background:var(--border-soft)}.model-list li{display:grid;grid-template-columns:7px 1fr auto;align-items:center;gap:10px;padding:11px 12px;background:var(--panel)}.model-list i{width:6px;height:6px;border-radius:50%;background:var(--accent)}.model-list span{font-size:12px;font-weight:600}.model-list small{color:var(--muted);font-size:10px}.empty-state{padding:14px 0 4px}.empty-state strong{font-size:13px}.empty-state p{max-width:52ch;margin:7px 0 10px;color:var(--muted);font-size:11px;line-height:1.6}.empty-state a,.local-note a{color:var(--accent);font-size:11px}.access-row{display:grid;grid-template-columns:36px 1fr auto;align-items:center;gap:11px;padding:12px 0;border-block:1px solid var(--border-soft)}.provider-mark{display:grid;width:34px;height:34px;place-items:center;border-radius:7px;background:var(--text);color:var(--bg);font:700 10px var(--font-mono);letter-spacing:-.04em}.provider-mark.large{width:44px;height:44px;border-radius:9px;font-size:12px}.access-row div{display:grid;gap:3px}.access-row strong{font-size:12px}.access-row small{color:var(--muted);font-size:10px}.linked-state{color:var(--green);font:600 10px var(--font-mono)}.text-action{padding:5px 2px;border:0;background:transparent;color:var(--accent);font-size:11px;font-weight:600;cursor:pointer}.text-action:hover{text-decoration:underline}.text-action.danger{color:var(--muted)}.text-action.danger:hover{color:var(--red)}.complete-button{width:100%;margin-top:12px}.sync-note{display:flex;gap:10px;margin-top:18px;color:var(--muted)}.sync-note>i{width:2px;align-self:stretch;background:var(--accent)}.sync-note p{display:grid;gap:5px;margin:0}.sync-note strong{color:var(--text);font-size:11px}.sync-note span{font-size:10px;line-height:1.55}.panel-warning{color:var(--orange);font-size:11px;line-height:1.5}.account-footer{display:flex;align-items:center;justify-content:space-between;padding:15px 4px;color:var(--dim);font-size:10px}.account-footer div{display:flex;gap:16px}.signin-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(300px,.8fr);gap:14px}.signin-panel{min-height:360px}.signin-heading{margin-bottom:18px}.mode-switch{display:grid;grid-template-columns:1fr 1fr;margin-bottom:18px;padding:3px;border-radius:7px;background:var(--panel-2)}.mode-switch button{min-height:32px;border:0;border-radius:5px;background:transparent;color:var(--muted);font-size:11px;cursor:pointer}.mode-switch button[aria-selected=true]{background:var(--raised);color:var(--text);box-shadow:0 3px 10px var(--shadow-color-soft)}.grant-note{margin:0 0 15px;padding:9px 11px;border-left:2px solid var(--accent);background:var(--accent-soft);color:var(--muted);font-size:11px}.grant-note strong{color:var(--text);font-family:var(--font-mono)}.signin-panel fieldset{display:grid;gap:14px;margin:0;padding:0;border:0}.signin-panel label{display:grid;grid-template-columns:1fr auto;gap:7px;color:var(--muted);font-size:10px}.signin-panel input{grid-column:1/-1;width:100%;height:39px;padding:0 11px;border:1px solid var(--border);border-radius:6px;background:var(--bg);color:var(--text)}.signin-panel label small{color:var(--dim)}.form-footnote{margin:14px 0 0;color:var(--dim);font-size:10px}.github-panel{display:flex;flex-direction:column;align-items:center;gap:18px;text-align:center;background:radial-gradient(circle at 100% 0,var(--accent-soft),transparent 46%),var(--panel)}.github-copy{display:grid;justify-items:center}.github-panel h2{margin:0 0 7px;font-size:22px}.github-panel p{max-width:38ch;margin:0 auto;color:var(--muted);font-size:11px;line-height:1.65}.github-panel .button{align-self:stretch}.github-panel .button:first-of-type{margin-top:auto}.github-panel .panel-warning{text-align:center}.local-note{display:flex;justify-content:space-between;gap:20px;padding:15px 4px;color:var(--muted);font-size:10px}@media(max-width:850px){.account-overview,.account-grid,.signin-grid{grid-template-columns:1fr}.balance-block{padding:18px 0 0;border-left:0;border-top:1px solid var(--border-soft)}.signin-panel{min-height:0}}@media(max-width:620px){.account-page{padding:28px 20px}.account-header{align-items:flex-start}.service-state{display:none}.account-overview,.account-panel,.signin-panel{padding:18px}.account-footer,.local-note{align-items:flex-start;flex-direction:column}}
.balance-block .low-credit-note button{margin-left:3px;padding:0;border:0;background:transparent;color:var(--accent);font:inherit;font-weight:600;cursor:pointer}.balance-block .low-credit-note button:hover{text-decoration:underline}
</style>
