<script setup lang="ts">
import { Check, Copy, Mail, MessageCircle, X } from "lucide-vue-next";
import { ref } from "vue";
import { useUpdateStore } from "@/features/support/updateStore";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const updates = useUpdateStore();
const copied = ref<"wechat" | "email" | "">("");
const error = ref("");

async function copy(value: string, kind: "wechat" | "email") {
  error.value = "";
  try {
    await navigator.clipboard.writeText(value);
    copied.value = kind;
  } catch {
    error.value = "复制失败，请手动复制联系方式。";
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="contact-popover-backdrop" @click.self="emit('update:open', false)">
      <section class="contact-popover" role="dialog" aria-modal="true" aria-labelledby="contact-popover-title">
        <header><div><span>OPSARK SUPPORT</span><h2 id="contact-popover-title">联系我们</h2></div><button type="button" aria-label="关闭" @click="emit('update:open', false)"><X :size="18" /></button></header>
        <p>欢迎交流使用体验、额度需求与产品建议。</p>
        <div class="contact-popover-item"><MessageCircle :size="18"/><div><small>微信</small><strong>{{ updates.contact.support_wechat }}</strong></div><button type="button" aria-label="复制微信号" @click="copy(updates.contact.support_wechat, 'wechat')"><Check v-if="copied === 'wechat'" :size="15"/><Copy v-else :size="15"/></button></div>
        <div class="contact-popover-item"><Mail :size="18"/><div><small>邮箱</small><strong>{{ updates.contact.support_email }}</strong></div><button type="button" aria-label="复制邮箱" @click="copy(updates.contact.support_email, 'email')"><Check v-if="copied === 'email'" :size="15"/><Copy v-else :size="15"/></button></div>
        <p v-if="copied" class="contact-popover-notice" role="status">{{ copied === 'wechat' ? '微信号已复制' : '邮箱地址已复制' }}</p>
        <p v-if="error" class="contact-popover-error" role="alert">{{ error }}</p>
        <footer><span>开发者</span><strong>{{ updates.contact.developer_name }}</strong></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.contact-popover-backdrop{position:fixed;inset:0;z-index:2100;display:grid;place-items:center;padding:20px;background:rgba(5,8,12,.48);backdrop-filter:blur(4px)}
.contact-popover{width:min(360px,100%);padding:22px;border:1px solid var(--border);border-radius:12px;background:var(--raised);box-shadow:var(--shadow-dialog)}
.contact-popover header{display:flex;justify-content:space-between;align-items:flex-start}.contact-popover header span{color:var(--accent);font:600 9px/1.2 var(--font-mono);letter-spacing:.12em}.contact-popover h2{margin:6px 0 0;font-size:20px}.contact-popover header button,.contact-popover-item>button{display:grid;place-items:center;border:0;border-radius:6px;background:transparent;color:var(--muted);cursor:pointer}.contact-popover header button{width:30px;height:30px}.contact-popover>p{margin:13px 0 17px;color:var(--muted);font-size:11px;line-height:1.65}.contact-popover-item{display:grid;grid-template-columns:22px 1fr 30px;align-items:center;gap:10px;padding:13px 0;border-top:1px solid var(--border-soft)}.contact-popover-item>svg{color:var(--muted)}.contact-popover-item div{display:grid;gap:4px}.contact-popover-item small{color:var(--dim);font-size:9px}.contact-popover-item strong{font-size:12px;font-weight:550;user-select:text}.contact-popover-item>button{width:30px;height:30px}.contact-popover button:hover{background:var(--hover);color:var(--text)}.contact-popover .contact-popover-notice{margin:10px 0 0;color:var(--accent)}.contact-popover .contact-popover-error{margin:10px 0 0;color:var(--red)}.contact-popover footer{display:flex;justify-content:space-between;margin-top:16px;padding-top:14px;border-top:1px solid var(--border-soft);color:var(--muted);font-size:11px}.contact-popover footer strong{color:var(--text);font-weight:550}
</style>
