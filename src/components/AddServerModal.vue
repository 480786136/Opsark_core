<script setup lang="ts">
import { reactive } from "vue";
import { X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { useOpsStore } from "@/stores/ops";
import type { ServerProfile } from "@/types";

const props = defineProps<{ server?: ServerProfile }>();
const emit = defineEmits<{ close: [] }>();
const store = useOpsStore();
const { t } = useI18n();
const form = reactive({
  name: props.server?.name ?? "",
  host: props.server?.host ?? "",
  port: props.server?.port ?? 22,
  username: props.server?.username ?? "root",
  group: props.server?.group ?? t("dashboard.defaultGroup"),
  password: "",
});

function submit() {
  if (!form.name.trim() || !form.host.trim()) return;
  const { password, ...server } = form;
  if (props.server) store.updateServer(props.server.id, server, password);
  else store.addServer(server, password);
  emit("close");
}
</script>

<template>
  <div class="modal-backdrop">
    <form class="modal-card" @submit.prevent="submit">
      <div class="modal-title">
        <div>
          <h2>{{ t(props.server ? "serverForm.editTitle" : "serverForm.title") }}</h2>
          <p>{{ t(props.server ? "serverForm.editSubtitle" : "serverForm.subtitle") }}</p>
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
        <button class="button primary" type="submit">{{ t(props.server ? "serverForm.save" : "serverForm.submit") }}</button>
      </div>
    </form>
  </div>
</template>
