<script setup lang="ts">
import { ref } from "vue";
import { permissionTools, readExecutionPermissions, saveExecutionPermissions } from "@/features/tools/executionPermissions";
const draft = ref(readExecutionPermissions()), notice = ref("");
function save() {
  try { saveExecutionPermissions(draft.value); notice.value = "权限已保存，对后续派发生效；不会中断已发出的操作。"; }
  catch { notice.value = "权限保存失败，请检查本机存储。"; }
}
</script>
<template>
  <div class="page management-page"><header class="page-header"><div><span class="eyebrow">EXECUTION PERMISSIONS</span><h1>执行权限</h1><p>权限由你授权，系统与用户 Skill 只能在已授权范围内请求操作。</p></div></header>
    <form class="permissions-card" @submit.prevent="save"><label><input v-model="draft.allowShell" type="checkbox" /> 允许 Agent 执行 Shell（仍需遵守任务风险审批）</label>
      <p>Shell 可以访问文件、网络和服务，不能用下方工具开关限制 Shell 内的同类行为。若只允许指定原子工具，请同时关闭 Shell。这不是操作系统沙箱。</p>
      <h2>允许的原子工具</h2><label v-for="tool in permissionTools" :key="tool.id"><input v-model="draft.toolIds" type="checkbox" :value="tool.id" /> {{ tool.name }}</label>
      <p>工具名称与实现由程序提供，不能由用户 Skill 或模型替换。关闭权限不会删除本地数据，也不会影响手动终端操作。</p><button class="button primary">保存权限</button><p role="status">{{ notice }}</p>
    </form>
  </div>
</template>
<style scoped>.permissions-card{max-width:850px;padding:24px;border:1px solid var(--border);border-radius:12px;background:var(--panel)}.permissions-card label{display:flex;align-items:center;gap:10px;margin:16px 0;font-size:14px}.permissions-card p{font-size:13px;line-height:1.8;color:var(--muted)}.permissions-card h2{margin-top:25px;font-size:17px}</style>
