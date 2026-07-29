<script setup lang="ts">
import { reactive } from "vue";
import { X } from "lucide-vue-next";
import { useOpsStore } from "@/stores/ops";

const emit = defineEmits<{ close: [] }>();
const store = useOpsStore();
const form = reactive({ name: "", host: "", port: 22, username: "root", group: "默认分组", password: "" });

function submit() {
  if (!form.name.trim() || !form.host.trim()) return;
  const { password, ...server } = form;
  store.addServer(server, password);
  emit("close");
}
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <form class="modal-card" @submit.prevent="submit">
      <div class="modal-title">
        <div>
          <h2>添加服务器</h2>
          <p>保存后将自动测试连接并采集基础信息</p>
        </div>
        <button class="icon-button" type="button" @click="emit('close')"><X :size="18" /></button>
      </div>
      <label>显示名称<input v-model="form.name" placeholder="例如：生产 Web-02" autofocus /></label>
      <label>主机地址<input v-model="form.host" placeholder="IP 地址或域名" /></label>
      <div class="form-row">
        <label>端口<input v-model.number="form.port" type="number" /></label>
        <label>用户名<input v-model="form.username" /></label>
      </div>
      <label>分组<input v-model="form.group" /></label>
      <label>SSH 密码（可选）<input v-model="form.password" type="password" autocomplete="new-password" placeholder="连接成功后安全保存到系统钥匙串" /></label>
      <div class="modal-actions">
        <button class="button secondary" type="button" @click="emit('close')">取消</button>
        <button class="button primary" type="submit">保存并测试连接</button>
      </div>
    </form>
  </div>
</template>
