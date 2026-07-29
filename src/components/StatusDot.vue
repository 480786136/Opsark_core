<script setup lang="ts">
defineProps<{ status: "online" | "testing" | "offline" }>();
</script>

<template>
  <span :class="['status-dot', status]">
    <span></span>{{ status === "online" ? "在线" : status === "testing" ? "检测中" : "离线" }}
  </span>
</template>
