<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Check, CircleHelp, Keyboard, Languages, Palette, Type, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { systemThemes, usePreferenceStore } from "./preferenceStore";

const open = ref(false);
const root = ref<HTMLElement>();
const preferences = usePreferenceStore();
const { t } = useI18n();

function closeOnOutsidePointer(event: PointerEvent) {
  if (open.value && !root.value?.contains(event.target as Node)) open.value = false;
}

onMounted(() => document.addEventListener("pointerdown", closeOnOutsidePointer));
onBeforeUnmount(() => document.removeEventListener("pointerdown", closeOnOutsidePointer));
</script>

<template>
  <div ref="root" class="appearance-control">
    <button class="rail-action" type="button" :title="t('nav.appearance')" @click="open = !open">
      <Palette :size="18" />
    </button>
    <Transition name="popover">
      <section v-if="open" class="appearance-popover">
        <header>
          <div><Palette :size="15" /><strong>{{ t("appearance.title") }}</strong></div>
          <button type="button" :title="t('common.close')" @click="open = false"><X :size="15" /></button>
        </header>
        <label><Languages :size="14" />{{ t("appearance.language") }}</label>
        <div class="segmented-control">
          <button :class="{ active: preferences.locale === 'zh-CN' }" @click="preferences.setLocale('zh-CN')">{{ t("appearance.zh") }}</button>
          <button :class="{ active: preferences.locale === 'en-US' }" @click="preferences.setLocale('en-US')">{{ t("appearance.en") }}</button>
        </div>
        <div class="appearance-section-heading">
          <label><Palette :size="14" />{{ t("appearance.systemTheme") }}</label>
          <small>{{ t("appearance.systemThemeHint") }}</small>
        </div>
        <div class="system-theme-grid">
          <button
            v-for="theme in systemThemes"
            :key="theme.id"
            type="button"
            :class="{ active: preferences.systemTheme === theme.id }"
            :aria-pressed="preferences.systemTheme === theme.id"
            @click="preferences.setSystemTheme(theme.id)"
          >
            <span class="theme-preview" :style="{ '--preview-bg': theme.preview[0], '--preview-panel': theme.preview[1], '--preview-accent': theme.preview[2], '--preview-terminal': theme.preview[3] }">
              <i></i><i></i><i></i>
            </span>
            <span class="theme-copy"><strong>{{ t(theme.labelKey) }}</strong><small>{{ t(theme.descriptionKey) }}</small></span>
            <Check v-if="preferences.systemTheme === theme.id" :size="13" />
          </button>
        </div>
        <label><Type :size="14" />{{ t("appearance.terminalTypography") }}</label>
        <div class="terminal-range-control">
          <span>{{ t("appearance.fontSize", { value: preferences.terminalFontSize }) }}</span>
          <input
            type="range"
            min="10"
            max="18"
            step="1"
            :value="preferences.terminalFontSize"
            @input="preferences.setTerminalTypography(Number(($event.target as HTMLInputElement).value), preferences.terminalLineHeight)"
          />
        </div>
        <div class="terminal-range-control">
          <span>{{ t("appearance.lineHeight", { value: preferences.terminalLineHeight.toFixed(2) }) }}</span>
          <input
            type="range"
            min="1"
            max="1.8"
            step="0.05"
            :value="preferences.terminalLineHeight"
            @input="preferences.setTerminalTypography(preferences.terminalFontSize, Number(($event.target as HTMLInputElement).value))"
          />
        </div>
        <label class="shortcut-label">
          <Keyboard :size="14" />{{ t("appearance.shortcuts") }}
          <button class="shortcut-help" type="button" :aria-label="t('appearance.shortcutsHelp')">
            <CircleHelp :size="13" />
            <span class="shortcut-tooltip" role="tooltip">
              <strong>{{ t(preferences.terminalShortcutPreset === 'vscode' ? 'appearance.vscodeShortcuts' : 'appearance.platformShortcuts') }}</strong>
              <span><kbd>{{ preferences.terminalShortcutPreset === 'vscode' ? 'Ctrl+Shift+F' : '⌘/Ctrl+F' }}</kbd>{{ t("appearance.shortcutFind") }}</span>
              <span><kbd>{{ preferences.terminalShortcutPreset === 'vscode' ? 'Ctrl+Shift+C' : '⌘/Ctrl+Shift+C' }}</kbd>{{ t("appearance.shortcutCopy") }}</span>
              <span><kbd>{{ preferences.terminalShortcutPreset === 'vscode' ? 'Ctrl+Shift+K' : '⌘/Ctrl+K' }}</kbd>{{ t("appearance.shortcutClear") }}</span>
              <span><kbd>Ctrl+R</kbd>{{ t("appearance.shortcutHistory") }}</span>
            </span>
          </button>
        </label>
        <div class="segmented-control">
          <button type="button" :class="{ active: preferences.terminalShortcutPreset === 'platform' }" @click="preferences.setTerminalShortcutPreset('platform')">{{ t("appearance.platformShortcuts") }}</button>
          <button type="button" :class="{ active: preferences.terminalShortcutPreset === 'vscode' }" @click="preferences.setTerminalShortcutPreset('vscode')">{{ t("appearance.vscodeShortcuts") }}</button>
        </div>
      </section>
    </Transition>
  </div>
</template>
