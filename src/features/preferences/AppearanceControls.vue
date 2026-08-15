<script setup lang="ts">
import { ref } from "vue";
import { Keyboard, Languages, Monitor, Palette, TerminalSquare, Type, X } from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import { accentThemes, usePreferenceStore, type SurfaceTheme, type TerminalColorTheme } from "./preferenceStore";

const open = ref(false);
const preferences = usePreferenceStore();
const { t } = useI18n();
const surfaceThemes: SurfaceTheme[] = ["carbon", "ink", "graphite", "porcelain", "mist"];
const terminalThemes: Array<{ id: TerminalColorTheme; colors: [string, string] }> = [
  { id: "opsark", colors: ["#0b0e11", "#d8ff5f"] },
  { id: "aurora", colors: ["#0a1016", "#65d9e8"] },
  { id: "paper", colors: ["#f4f1e8", "#315a68"] },
];
</script>

<template>
  <div class="appearance-control">
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
        <label><Monitor :size="14" />{{ t("appearance.surface") }}</label>
        <div class="theme-segments">
          <button
            v-for="theme in surfaceThemes"
            :key="theme"
            type="button"
            :class="['surface-option', theme, { active: preferences.surfaceTheme === theme }]"
            @click="preferences.setSurfaceTheme(theme)"
          ><i></i><span>{{ t(`appearance.${theme}`) }}</span></button>
        </div>
        <label><Palette :size="14" />{{ t("appearance.color") }}</label>
        <div class="color-swatches">
          <button
            v-for="theme in accentThemes"
            :key="theme.id"
            :class="{ active: preferences.accentTheme === theme.id }"
            :style="{ '--swatch': theme.color }"
            :title="t(theme.labelKey)"
            @click="preferences.setAccentTheme(theme.id)"
          ><i></i></button>
        </div>
        <label><TerminalSquare :size="14" />{{ t("appearance.terminalColor") }}</label>
        <div class="terminal-theme-options">
          <button
            v-for="theme in terminalThemes"
            :key="theme.id"
            type="button"
            :class="{ active: preferences.terminalColorTheme === theme.id }"
            :title="t(`appearance.${theme.id}`)"
            @click="preferences.setTerminalColorTheme(theme.id)"
          >
            <i :style="{ '--terminal-surface': theme.colors[0], '--terminal-ink': theme.colors[1] }"></i>
            <span>{{ t(`appearance.${theme.id}`) }}</span>
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
        <label><Keyboard :size="14" />{{ t("appearance.shortcuts") }}</label>
        <div class="segmented-control">
          <button type="button" :class="{ active: preferences.terminalShortcutPreset === 'platform' }" @click="preferences.setTerminalShortcutPreset('platform')">{{ t("appearance.platformShortcuts") }}</button>
          <button type="button" :class="{ active: preferences.terminalShortcutPreset === 'vscode' }" @click="preferences.setTerminalShortcutPreset('vscode')">{{ t("appearance.vscodeShortcuts") }}</button>
        </div>
      </section>
    </Transition>
  </div>
</template>
