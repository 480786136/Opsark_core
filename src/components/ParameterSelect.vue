<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";

const props = defineProps<{
  modelValue: string;
  options: Array<{ value: string; label: string }>;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  clearable?: boolean;
  clearLabel?: string;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();
const root = ref<HTMLDetailsElement>();
const trigger = ref<HTMLElement>();
const isOpen = ref(false);
const listboxId = useId();
const selectedOption = computed(() => props.options.find((option) => option.value === props.modelValue));
const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder ?? "");

function closeMenu(restoreFocus = false) {
  isOpen.value = false;
  if (restoreFocus) trigger.value?.focus();
}

async function focusOption(index: number) {
  await nextTick();
  if (!isOpen.value || props.disabled) return;
  root.value?.querySelectorAll<HTMLButtonElement>('[role="option"]')[index]?.focus();
}

function toggleMenu() {
  if (props.disabled) return;
  isOpen.value = !isOpen.value;
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (props.disabled) {
    if (event.key !== "Tab") event.preventDefault();
    return;
  }
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    isOpen.value = true;
    const selectedIndex = props.options.findIndex((option) => option.value === props.modelValue);
    const index = event.key === "Home" ? 0 : event.key === "End" ? props.options.length - 1
      : selectedIndex >= 0 ? selectedIndex : event.key === "ArrowUp" ? props.options.length - 1 : 0;
    void focusOption(index);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    toggleMenu();
    if (isOpen.value) void focusOption(Math.max(0, props.options.findIndex((option) => option.value === props.modelValue)));
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeMenu();
  }
}

function onOptionKeydown(event: KeyboardEvent, index: number) {
  if (props.disabled) return;
  const last = props.options.length - 1;
  const nextIndex = event.key === "ArrowDown" ? Math.min(last, index + 1)
    : event.key === "ArrowUp" ? Math.max(0, index - 1)
    : event.key === "Home" ? 0 : event.key === "End" ? last : undefined;
  if (nextIndex !== undefined) {
    event.preventDefault();
    void focusOption(nextIndex);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
  }
}

function chooseOption(value: string) {
  if (props.disabled) return;
  emit("update:modelValue", value);
  closeMenu(true);
}

function clearSelection() {
  if (props.clearable && !props.required) chooseOption("");
}

function onFocusOut(event: FocusEvent) {
  if (!root.value?.contains(event.relatedTarget as Node | null)) closeMenu();
}

function onOutsidePointer(event: PointerEvent) {
  if (!root.value?.contains(event.target as Node | null)) closeMenu();
}

watch(() => props.disabled, (disabled) => { if (disabled) closeMenu(); }, { flush: "sync" });
onMounted(() => document.addEventListener("pointerdown", onOutsidePointer));
onBeforeUnmount(() => document.removeEventListener("pointerdown", onOutsidePointer));
</script>

<template>
  <details ref="root" class="parameter-select" :class="{ 'is-disabled': disabled }" :open="isOpen" @focusout="onFocusOut">
    <summary
      ref="trigger"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      :aria-controls="listboxId"
      :aria-disabled="Boolean(disabled)"
      :tabindex="disabled ? -1 : 0"
      @click.prevent="toggleMenu"
      @keydown="onTriggerKeydown"
    >
      <span :class="{ placeholder: !selectedOption }" :title="displayLabel">{{ displayLabel }}</span>
      <ChevronDown :size="14" />
    </summary>
    <div class="parameter-options">
      <div :id="listboxId" role="listbox" :aria-label="ariaLabel" :aria-required="required || undefined">
        <button
          v-for="(option, index) in options"
          :key="option.value"
          type="button"
          role="option"
          tabindex="-1"
          :disabled="disabled"
          :aria-selected="option.value === modelValue"
          :title="option.label"
          @click="chooseOption(option.value)"
          @keydown="onOptionKeydown($event, index)"
        >
          <span>{{ option.label }}</span>
          <Check v-if="option.value === modelValue" :size="14" />
        </button>
      </div>
      <button
        v-if="clearable && !required && modelValue !== ''"
        class="parameter-clear"
        type="button"
        :aria-label="`${clearLabel ?? 'Clear'} ${ariaLabel}`"
        :disabled="disabled"
        @click="clearSelection"
        @keydown.esc.prevent="closeMenu(true)"
      >{{ clearLabel ?? 'Clear' }}</button>
    </div>
  </details>
</template>

<style scoped>
.parameter-select{position:relative;width:100%;margin:0;border:0}.parameter-select summary{display:flex;align-items:center;justify-content:space-between;width:100%;height:38px;padding:0 11px;border:1px solid var(--border);border-radius:7px;background:var(--bg);color:var(--text);cursor:pointer;list-style:none}.parameter-select summary::-webkit-details-marker{display:none}.parameter-select[open] summary{border-color:var(--accent);outline:1px solid var(--accent)}.parameter-select[open] summary svg{transform:rotate(180deg)}.parameter-select summary svg{flex-shrink:0;color:var(--muted);transition:transform .14s}.parameter-options{position:absolute;z-index:20;top:calc(100% + 5px);left:0;width:100%;max-height:220px;padding:5px;overflow:auto;border:1px solid var(--border);border-radius:8px;background:var(--raised);box-shadow:0 14px 34px #0006}.parameter-options button{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:34px;padding:7px 9px;border:0;border-radius:5px;background:transparent;color:var(--text);text-align:left;cursor:pointer}.parameter-options button:hover,.parameter-options button:focus-visible{background:var(--accent-soft);color:var(--accent-strong);outline:0}.parameter-options svg{flex-shrink:0;color:var(--accent)}
.parameter-select{min-width:0}.parameter-select summary span,.parameter-options button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.parameter-select summary,.parameter-options button{gap:8px}.parameter-select .placeholder{color:var(--muted)}.parameter-select.is-disabled summary{opacity:.6;cursor:not-allowed}.parameter-select summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.parameter-options .parameter-clear{margin-top:4px;border-top:1px solid var(--border);border-radius:0;color:var(--muted)}
</style>
