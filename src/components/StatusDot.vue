<script setup lang="ts">
import { useI18n } from "vue-i18n";

defineProps<{ status: "online" | "testing" | "offline" }>();
const { t } = useI18n();
</script>

<template>
  <span :class="['status-dot', status]">
    <span></span>{{ t(`status.${status}`) }}
  </span>
</template>
