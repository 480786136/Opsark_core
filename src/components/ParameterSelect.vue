<script setup lang="ts">
import { Check, ChevronDown } from "lucide-vue-next";

defineProps<{
  modelValue: string;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
</script>

<template>
  <details class="parameter-select">
    <summary :aria-label="ariaLabel">
      <span>{{ options.find((option) => option.value === modelValue)?.label }}</span>
      <ChevronDown :size="14" />
    </summary>
    <div class="parameter-options" role="listbox" :aria-label="ariaLabel">
      <button
        v-for="option in options"
        :key="option.value"
        type="button"
        role="option"
        :aria-selected="option.value === modelValue"
        @click="emit('update:modelValue', option.value); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')"
      >
        <span>{{ option.label }}</span>
        <Check v-if="option.value === modelValue" :size="14" />
      </button>
    </div>
  </details>
</template>

<style scoped>
.parameter-select{position:relative;width:100%;margin:0;border:0}.parameter-select summary{display:flex;align-items:center;justify-content:space-between;width:100%;height:38px;padding:0 11px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text);cursor:pointer;list-style:none}.parameter-select summary::-webkit-details-marker{display:none}.parameter-select[open] summary{border-color:var(--accent);outline:1px solid var(--accent)}.parameter-select[open] summary svg{transform:rotate(180deg)}.parameter-select summary svg{flex-shrink:0;color:var(--muted);transition:transform .14s}.parameter-options{position:absolute;z-index:20;top:calc(100% + 5px);left:0;width:100%;max-height:220px;padding:5px;overflow:auto;border:1px solid var(--border);border-radius:8px;background:var(--raised);box-shadow:0 14px 34px #0006}.parameter-options button{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:34px;padding:7px 9px;border:0;border-radius:5px;background:transparent;color:var(--text);text-align:left;cursor:pointer}.parameter-options button:hover,.parameter-options button:focus-visible{background:var(--accent-soft);color:var(--accent-strong);outline:0}.parameter-options svg{flex-shrink:0;color:var(--accent)}
</style>
