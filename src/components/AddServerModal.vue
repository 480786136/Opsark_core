<script setup lang="ts">
import { reactive } from "vue";
import { X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";

const emit = defineEmits<{ close: [] }>();
const store = useOpsStore();
const { t } = useI18n();
const form = reactive({ name: "", host: "", port: 22, username: "root", group: t("dashboard.defaultGroup"), password: "" });

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
          <h2>{{ t("serverForm.title") }}</h2>
          <p>{{ t("serverForm.subtitle") }}</p>
        </div>
        <button class="icon-button" type="button" @click="emit('close')"><X :size="18" /></button>
      </div>
      <label>{{ t("serverForm.name") }}<input v-model="form.name" :placeholder="t('serverForm.namePlaceholder')" autofocus /></label>
      <label>{{ t("serverForm.host") }}<input v-model="form.host" :placeholder="t('serverForm.hostPlaceholder')" /></label>
      <div class="form-row">
        <label>{{ t("serverForm.port") }}<input v-model.number="form.port" type="number" /></label>
        <label>{{ t("serverForm.username") }}<input v-model="form.username" /></label>
      </div>
      <label>{{ t("serverForm.group") }}<input v-model="form.group" /></label>
      <label>{{ t("serverForm.password") }}<input v-model="form.password" type="password" autocomplete="new-password" :placeholder="t('serverForm.passwordPlaceholder')" /></label>
      <div class="modal-actions">
        <button class="button secondary" type="button" @click="emit('close')">{{ t("common.cancel") }}</button>
        <button class="button primary" type="submit">{{ t("serverForm.submit") }}</button>
      </div>
    </form>
  </div>
</template>
