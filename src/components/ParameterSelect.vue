<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onDeactivated, onMounted, ref, useId, watch } from "vue";
import { Check, ChevronDown } from "lucide-vue-next";

export type ParameterSelectOption = {
  value: string;
  label: string;
  disabled?: boolean;
  action?: boolean;
};

const props = withDefaults(defineProps<{
  modelValue: string;
  options: ReadonlyArray<ParameterSelectOption>;
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  required?: boolean;
  clearable?: boolean;
  clearLabel?: string;
  size?: "compact" | "small" | "default";
  popupMinWidth?: number;
}>(), {
  size: "default",
  popupMinWidth: 160,
});
const emit = defineEmits<{
  "update:modelValue": [value: string];
  change: [value: string];
  "option-action": [value: string];
}>();
const root = ref<HTMLDetailsElement>();
const trigger = ref<HTMLElement>();
const popup = ref<HTMLElement>();
const isOpen = ref(false);
const disabledByFieldset = ref(false);
const placement = ref<"top" | "bottom">("bottom");
const popupStyle = ref<Record<string, string>>({});
const listboxId = useId();
const selectedOption = computed(() => props.options.find((option) => option.value === props.modelValue));
const displayLabel = computed(() => selectedOption.value?.label ?? props.placeholder ?? "");
const effectiveDisabled = computed(() => Boolean(props.disabled || disabledByFieldset.value));
let fieldsetObserver: MutationObserver | undefined;
let triggerResizeObserver: ResizeObserver | undefined;

function isInsideControl(node: Node | null) {
  return Boolean(node && (root.value?.contains(node) || popup.value?.contains(node)));
}

function closeMenu(restoreFocus = false) {
  if (!isOpen.value && !restoreFocus) return;
  isOpen.value = false;
  if (restoreFocus && !effectiveDisabled.value) void nextTick(() => trigger.value?.focus());
}

function optionButtons() {
  return [...(popup.value?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])];
}

function firstEnabledIndex(fromEnd = false) {
  const indexes = props.options
    .map((option, index) => option.disabled ? -1 : index)
    .filter((index) => index >= 0);
  return fromEnd ? indexes[indexes.length - 1] ?? -1 : indexes[0] ?? -1;
}

function nextEnabledIndex(index: number, direction: -1 | 1) {
  for (let next = index + direction; next >= 0 && next < props.options.length; next += direction) {
    if (!props.options[next]?.disabled) return next;
  }
  return index;
}

function focusOption(index: number) {
  if (!isOpen.value || effectiveDisabled.value || index < 0) return;
  const button = optionButtons()[index];
  if (button) button.focus();
  else void nextTick(() => optionButtons()[index]?.focus());
}

function selectedOrBoundaryIndex(fromEnd = false) {
  const selectedIndex = props.options.findIndex((option) => option.value === props.modelValue && !option.disabled);
  return selectedIndex >= 0 ? selectedIndex : firstEnabledIndex(fromEnd);
}

async function openMenu(focusIndex?: number) {
  if (effectiveDisabled.value) return;
  isOpen.value = true;
  await nextTick();
  updatePopupPosition();
  if (focusIndex !== undefined) focusOption(focusIndex);
}

function toggleMenu() {
  if (effectiveDisabled.value) return;
  if (isOpen.value) closeMenu();
  else void openMenu();
}

function focusAfterTrigger(backwards: boolean) {
  const current = trigger.value;
  if (!current) return;
  const scope = current.closest<HTMLElement>('dialog, [role="dialog"]') ?? document;
  const layoutAvailable = current.getClientRects().length > 0;
  const candidates = [...scope.querySelectorAll<HTMLElement>(
    'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])',
  )].filter((element) => !element.hasAttribute("disabled")
    && element.getAttribute("aria-disabled") !== "true"
    && !element.closest("[hidden], [inert], [aria-hidden='true']")
    && !popup.value?.contains(element)
    && (!element.closest("details:not([open])") || element.matches("details:not([open]) > summary"))
    && (!layoutAvailable || element.getClientRects().length > 0));
  const index = candidates.indexOf(current);
  const target = candidates[index + (backwards ? -1 : 1)];
  closeMenu();
  void nextTick(() => target?.focus());
}

function onTriggerKeydown(event: KeyboardEvent) {
  if (effectiveDisabled.value) {
    if (event.key !== "Tab") event.preventDefault();
    return;
  }
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    const fromEnd = event.key === "ArrowUp" || event.key === "End";
    const index = event.key === "Home" ? firstEnabledIndex() : event.key === "End" ? firstEnabledIndex(true) : selectedOrBoundaryIndex(fromEnd);
    void openMenu(index);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    if (isOpen.value) closeMenu();
    else void openMenu(selectedOrBoundaryIndex());
  } else if (event.key === "Escape" && isOpen.value) {
    event.preventDefault();
    closeMenu(true);
  } else if (event.key === "Tab" && isOpen.value) {
    closeMenu();
  }
}

function onOptionKeydown(event: KeyboardEvent, index: number) {
  if (effectiveDisabled.value) return;
  let nextIndex: number | undefined;
  if (event.key === "ArrowDown") nextIndex = nextEnabledIndex(index, 1);
  else if (event.key === "ArrowUp") nextIndex = nextEnabledIndex(index, -1);
  else if (event.key === "Home") nextIndex = firstEnabledIndex();
  else if (event.key === "End") nextIndex = firstEnabledIndex(true);
  if (nextIndex !== undefined) {
    event.preventDefault();
    focusOption(nextIndex);
  } else if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    const option = props.options[index];
    if (option && !option.disabled) chooseOption(option.value);
  } else if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
  } else if (event.key === "Tab") {
    event.preventDefault();
    focusAfterTrigger(event.shiftKey);
  }
}

function onPopupKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    closeMenu(true);
  }
}

function chooseOption(value: string) {
  if (effectiveDisabled.value) return;
  const option = props.options.find((item) => item.value === value);
  if (option?.disabled) return;
  if (option?.action) {
    emit("option-action", value);
    closeMenu(true);
    return;
  }
  if (value !== props.modelValue) {
    emit("update:modelValue", value);
    emit("change", value);
  }
  closeMenu(true);
}

function clearSelection() {
  if (props.clearable && !props.required) chooseOption("");
}

function onFocusOut(event: FocusEvent) {
  if (!isInsideControl(event.relatedTarget as Node | null)) closeMenu();
}

function onOutsidePointer(event: PointerEvent) {
  if (!isInsideControl(event.target as Node | null)) closeMenu();
}

function updatePopupPosition() {
  if (!isOpen.value || !trigger.value) return;
  const rect = trigger.value.getBoundingClientRect();
  const viewport = window.visualViewport;
  const viewportLeft = viewport?.offsetLeft ?? 0;
  const viewportTop = viewport?.offsetTop ?? 0;
  const viewportWidth = viewport?.width && viewport.width > 0 ? viewport.width : window.innerWidth;
  const viewportHeight = viewport?.height && viewport.height > 0 ? viewport.height : window.innerHeight;
  const viewportRight = viewportLeft + viewportWidth;
  const viewportBottom = viewportTop + viewportHeight;
  if (rect.bottom < viewportTop || rect.top > viewportBottom || rect.right < viewportLeft || rect.left > viewportRight) {
    closeMenu();
    return;
  }
  const margin = 8;
  const gap = 5;
  const availableBelow = Math.max(0, viewportBottom - rect.bottom - gap - margin);
  const availableAbove = Math.max(0, rect.top - viewportTop - gap - margin);
  const estimatedHeight = Math.min(240, props.options.length * (props.size === "compact" ? 28 : 34) + (props.clearable ? 38 : 10));
  placement.value = availableBelow < Math.min(estimatedHeight, 150) && availableAbove > availableBelow ? "top" : "bottom";
  const availableHeight = placement.value === "top" ? availableAbove : availableBelow;
  const width = Math.max(0, Math.min(Math.max(rect.width, props.popupMinWidth), viewportWidth - margin * 2));
  const left = Math.min(Math.max(rect.left, viewportLeft + margin), Math.max(viewportLeft + margin, viewportRight - margin - width));
  popupStyle.value = {
    left: `${left}px`,
    top: `${placement.value === "top" ? rect.top - gap : rect.bottom + gap}px`,
    width: `${width}px`,
    maxHeight: `${Math.min(240, availableHeight)}px`,
    transform: placement.value === "top" ? "translateY(-100%)" : "none",
  };
}

function isDisabledByAncestorFieldset() {
  let element = root.value?.parentElement;
  while (element) {
    if (element instanceof HTMLFieldSetElement && element.disabled) {
      const firstLegend = [...element.children].find((child) => child instanceof HTMLLegendElement);
      if (!firstLegend?.contains(root.value ?? null)) return true;
    }
    element = element.parentElement;
  }
  return false;
}

function syncFieldsetDisabled() {
  disabledByFieldset.value = isDisabledByAncestorFieldset();
}

function addViewportListeners() {
  window.addEventListener("resize", updatePopupPosition);
  window.addEventListener("scroll", updatePopupPosition, true);
  window.visualViewport?.addEventListener("resize", updatePopupPosition);
  window.visualViewport?.addEventListener("scroll", updatePopupPosition);
}

function removeViewportListeners() {
  window.removeEventListener("resize", updatePopupPosition);
  window.removeEventListener("scroll", updatePopupPosition, true);
  window.visualViewport?.removeEventListener("resize", updatePopupPosition);
  window.visualViewport?.removeEventListener("scroll", updatePopupPosition);
}

watch(effectiveDisabled, (disabled) => { if (disabled) closeMenu(); }, { flush: "sync" });
watch(isOpen, async (open) => {
  removeViewportListeners();
  if (!open) return;
  addViewportListeners();
  await nextTick();
  updatePopupPosition();
});
watch(() => props.options, () => { if (isOpen.value) void nextTick(updatePopupPosition); }, { deep: true });

onMounted(() => {
  document.addEventListener("pointerdown", onOutsidePointer);
  syncFieldsetDisabled();
  const fieldsets: HTMLFieldSetElement[] = [];
  let element = root.value?.parentElement;
  while (element) {
    if (element instanceof HTMLFieldSetElement) fieldsets.push(element);
    element = element.parentElement;
  }
  if (fieldsets.length) {
    fieldsetObserver = new MutationObserver(syncFieldsetDisabled);
    fieldsets.forEach((fieldset) => fieldsetObserver?.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] }));
  }
  if (trigger.value && typeof ResizeObserver !== "undefined") {
    triggerResizeObserver = new ResizeObserver(updatePopupPosition);
    triggerResizeObserver.observe(trigger.value);
  }
});
onBeforeUnmount(() => {
  document.removeEventListener("pointerdown", onOutsidePointer);
  removeViewportListeners();
  fieldsetObserver?.disconnect();
  triggerResizeObserver?.disconnect();
});
onDeactivated(() => closeMenu());
</script>

<template>
  <details ref="root" :class="['parameter-select', `size-${size}`, { 'is-disabled': effectiveDisabled }]" :open="isOpen" @focusout="onFocusOut">
    <summary
      ref="trigger"
      :aria-label="ariaLabel"
      aria-haspopup="listbox"
      :aria-expanded="isOpen"
      :aria-controls="listboxId"
      :aria-disabled="effectiveDisabled"
      :tabindex="effectiveDisabled ? -1 : 0"
      @click.prevent="toggleMenu"
      @keydown="onTriggerKeydown"
    >
      <span :class="{ placeholder: !selectedOption }" :title="displayLabel">{{ displayLabel }}</span>
      <ChevronDown :size="14" />
    </summary>
    <Teleport to="body">
      <div
        v-if="isOpen"
        ref="popup"
        :class="['parameter-options', `size-${size}`, `placement-${placement}`]"
        :style="popupStyle"
        @focusout="onFocusOut"
        @keydown="onPopupKeydown"
      >
        <div :id="listboxId" role="listbox" :aria-label="ariaLabel" :aria-required="required || undefined">
          <button
            v-for="(option, index) in options"
            :key="option.value"
            type="button"
            role="option"
            tabindex="-1"
            :data-value="option.value"
            :data-action="option.action || undefined"
            :disabled="effectiveDisabled || option.disabled"
            :aria-disabled="option.disabled || undefined"
            :aria-selected="option.value === modelValue"
            :title="option.label"
            @click="chooseOption(option.value)"
            @keydown="onOptionKeydown($event, index)"
          >
            <span>{{ option.label }}</span>
            <Check v-if="!option.action && option.value === modelValue" :size="14" />
          </button>
        </div>
        <button
          v-if="clearable && !required && modelValue !== ''"
          class="parameter-clear"
          type="button"
          :aria-label="`${clearLabel ?? 'Clear'} ${ariaLabel}`"
          :disabled="effectiveDisabled"
          @click="clearSelection"
          @keydown.tab.prevent="focusAfterTrigger($event.shiftKey)"
        >{{ clearLabel ?? 'Clear' }}</button>
      </div>
    </Teleport>
  </details>
</template>

<style scoped>
.parameter-select,.parameter-options{--parameter-select-height:38px;--parameter-select-font-size:12px;--parameter-select-radius:7px;--parameter-option-height:34px}.parameter-select.size-small{--parameter-select-height:35px;--parameter-select-font-size:10px;--parameter-select-radius:5px;--parameter-option-height:32px}.parameter-options.size-small{--parameter-select-font-size:11px;--parameter-select-radius:5px;--parameter-option-height:32px}.parameter-select.size-compact{--parameter-select-height:26px;--parameter-select-font-size:10px;--parameter-select-radius:4px;--parameter-option-height:30px}.parameter-options.size-compact{--parameter-select-font-size:11px;--parameter-select-radius:4px;--parameter-option-height:30px}
.parameter-select{position:relative;width:100%;min-width:0;margin:0;border:0}.parameter-select summary{display:flex;align-items:center;justify-content:space-between;width:100%;height:var(--parameter-select-height);padding:0 10px;gap:8px;border:1px solid var(--border,#3a414b);border-radius:var(--parameter-select-radius);background:var(--panel,var(--raised,#171b21));color:var(--text,#edf0f3);font-size:var(--parameter-select-font-size);cursor:pointer;list-style:none;transition:border-color .14s ease,background-color .14s ease,box-shadow .14s ease}.parameter-select summary::-webkit-details-marker{display:none}.parameter-select summary:hover{border-color:color-mix(in srgb,var(--accent,#d9f763) 34%,var(--border,#3a414b));background:var(--hover,var(--panel-2,#20252c))}.parameter-select[open] summary{border-color:var(--accent,#d9f763);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent,#d9f763) 16%,transparent)}.parameter-select[open] summary svg{transform:rotate(180deg)}.parameter-select summary svg{flex-shrink:0;color:var(--muted,#929ba7);transition:transform .14s ease}.parameter-select summary span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.parameter-select .placeholder{color:var(--muted,#929ba7)}.parameter-select.is-disabled summary{opacity:.52;cursor:not-allowed}.parameter-select.is-disabled summary:hover{border-color:var(--border,#3a414b);background:var(--panel,var(--raised,#171b21))}.parameter-select summary:focus-visible{outline:2px solid var(--accent,#d9f763);outline-offset:2px}
.parameter-options{position:fixed;z-index:2000;display:flex;flex-direction:column;min-width:0;padding:5px;overflow:hidden;border:1px solid var(--border,#3a414b);border-radius:calc(var(--parameter-select-radius) + 1px);background:var(--raised,#171b21);color:var(--text,#edf0f3);box-shadow:var(--shadow-popover,0 14px 34px rgba(0,0,0,.36));font-size:var(--parameter-select-font-size)}.parameter-options>div{min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-color:var(--border,#3a414b) transparent}.parameter-options button{display:flex;align-items:center;justify-content:space-between;width:100%;min-height:var(--parameter-option-height);padding:6px 9px;gap:8px;border:0;border-radius:calc(var(--parameter-select-radius) - 2px);background:transparent;color:var(--text,#edf0f3);font-size:inherit;text-align:left;cursor:pointer}.parameter-options button span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.parameter-options button:hover:not(:disabled),.parameter-options button:focus-visible{background:var(--hover,var(--panel-2,#222830));color:var(--text,#edf0f3);outline:0}.parameter-options button[aria-selected="true"]{background:var(--accent-soft,color-mix(in srgb,var(--accent,#d9f763) 12%,transparent));color:var(--accent,#d9f763)}.parameter-options button[aria-selected="true"]:hover,.parameter-options button[aria-selected="true"]:focus-visible{background:color-mix(in srgb,var(--accent,#d9f763) 18%,transparent)}.parameter-options button:focus-visible{box-shadow:inset 0 0 0 1px var(--accent,#d9f763)}.parameter-options button:disabled{opacity:.45;cursor:not-allowed}.parameter-options svg{flex-shrink:0;color:var(--accent,#d9f763)}.parameter-options .parameter-clear{margin-top:4px;border-top:1px solid var(--border,#3a414b);border-radius:0;color:var(--muted,#929ba7)}
.parameter-options button[data-action="true"]{color:var(--muted,#929ba7)}.parameter-options button[data-action="true"]:hover,.parameter-options button[data-action="true"]:focus-visible{color:var(--accent,#d9f763)}
@media(prefers-reduced-motion:reduce){.parameter-select summary,.parameter-select summary svg{transition:none}}
</style>
