<script setup lang="ts">
import { computed, ref } from "vue";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  History,
  LoaderCircle,
  ShieldAlert,
} from "lucide-vue-next";
import { useI18n } from "vue-i18n";
import type { ObservationStatus, PlanStep, TaskExecutionPhase } from "@/types";

const props = defineProps<{
  phase: TaskExecutionPhase;
  index: number;
}>();

const { t } = useI18n();
const expanded = ref(false);
const expandedSteps = ref<string[]>([]);

const counts = computed(() => {
  const completed = props.phase.plan.filter((step) => step.status === "completed").length;
  const failed = props.phase.plan.filter((step) => step.status === "failed").length;
  const skipped = props.phase.plan.filter((step) => step.status === "skipped").length;
  return {
    completed,
    failed,
    skipped,
    pending: Math.max(0, props.phase.plan.length - completed - failed - skipped),
    total: props.phase.plan.length,
  };
});

const outcome = computed(() => {
  if (counts.value.failed) return "blocked";
  if (counts.value.total && counts.value.completed === counts.value.total) return "completed";
  return "adjusted";
});

const brief = computed(() => t(`agent.phaseBrief${outcome.value === "blocked" ? "Blocked" : outcome.value === "completed" ? "Completed" : "Adjusted"}`));
const progress = computed(() => t("agent.phaseProgress", counts.value));
const summary = computed(() => {
  if (props.phase.summary?.trim()) return props.phase.summary.trim();
  const failed = [...props.phase.plan].reverse().find((step) => step.status === "failed");
  if (failed?.review?.summary) return failed.review.summary;
  if (failed?.result?.failureReason) return failed.result.failureReason;
  const reviewed = [...props.phase.plan].reverse().find((step) => step.review?.summary);
  if (reviewed?.review?.summary) return reviewed.review.summary;
  return t(`agent.phaseSummary${outcome.value === "blocked" ? "Blocked" : outcome.value === "completed" ? "Completed" : "Adjusted"}`, {
    total: counts.value.total,
  });
});

function toggleStep(id: string) {
  expandedSteps.value = expandedSteps.value.includes(id)
    ? expandedSteps.value.filter((item) => item !== id)
    : [...expandedSteps.value, id];
}

function riskText(step: PlanStep) {
  return t(`agent.risk${step.risk === "low" ? "Low" : step.risk === "medium" ? "Medium" : "High"}`);
}

function executionText(step: PlanStep) {
  const labels = {
    success: "agent.executionSuccess",
    failed: "agent.executionFailed",
    cancelled: "agent.executionCancelled",
    blocked: "agent.executionBlocked",
  };
  return step.result ? t(labels[step.result.executionStatus]) : t("agent.executionPending");
}

function observationText(step: PlanStep) {
  if (step.result?.executionStatus === "failed") return t("agent.observationMissing");
  const labels: Record<ObservationStatus, string> = {
    matched: "agent.observationMatched",
    not_found: "agent.observationNotFound",
    healthy: "agent.observationHealthy",
    unhealthy: "agent.observationUnhealthy",
    warning: "agent.observationWarning",
    unknown: "agent.observationUnknown",
  };
  return step.result?.observationStatus ? t(labels[step.result.observationStatus]) : t("agent.observationNone");
}
</script>

<template>
  <section :class="['plan-card', 'phase-history-card', `phase-${outcome}`]">
    <button
      class="plan-card-head archived-head phase-history-head"
      type="button"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >
      <span>
        <History :size="15" />
        <span>
          <strong>{{ t("agent.phaseTitle", { index }) }}</strong>
          <small>{{ brief }}</small>
        </span>
      </span>
      <span>
        <small class="phase-progress">{{ progress }}</small>
        <ChevronDown v-if="expanded" :size="15" />
        <ChevronRight v-else :size="15" />
      </span>
    </button>

    <template v-if="expanded">
      <div class="phase-execution-summary">
        <span>{{ t("agent.phaseExecutionSummary") }}</span>
        <p>{{ summary }}</p>
      </div>
      <div class="phase-step-heading">
        <strong>{{ t("agent.phaseExecutionSteps") }}</strong>
        <small>{{ progress }}</small>
      </div>
      <div class="steps">
        <div v-for="(step, stepIndex) in phase.plan" :key="step.id" :class="['plan-step', step.status]">
          <button class="step-main" type="button" @click="toggleStep(step.id)">
            <span class="step-icon">
              <CheckCircle2 v-if="step.status === 'completed'" :size="17" />
              <LoaderCircle v-else-if="['running', 'validating'].includes(step.status)" class="spin" :size="17" />
              <ShieldAlert v-else-if="step.status === 'failed'" :size="17" />
              <Circle v-else :size="17" />
            </span>
            <span class="step-copy">
              <strong>{{ stepIndex + 1 }}. {{ step.title }}</strong>
              <small>{{ step.description }}</small>
            </span>
            <span v-if="step.result" :class="['observation-tag', step.result.observationStatus]">{{ observationText(step) }}</span>
            <span :class="['risk-tag', step.risk]">{{ riskText(step) }}</span>
            <ChevronDown v-if="expandedSteps.includes(step.id)" :size="15" />
            <ChevronRight v-else :size="15" />
          </button>
          <div v-if="expandedSteps.includes(step.id)" class="step-detail">
            <label>{{ t("agent.command") }}</label><code>{{ step.command }}</code>
            <label>{{ t("agent.expectedValidation") }}</label>
            <p>{{ step.expected }} · {{ step.kind === "observe" ? t("agent.commandResultEvidence") : step.validation }}</p>
            <template v-if="step.result">
              <label>{{ t("agent.executionObservation") }}</label>
              <div class="step-result-line">
                <span :class="['execution-tag', step.result.executionStatus]">{{ executionText(step) }}</span>
                <span :class="['observation-tag', step.result.observationStatus]">{{ observationText(step) }}</span>
              </div>
              <label>{{ t("agent.evidence") }}</label><pre>{{ JSON.stringify(step.result.facts, null, 2) }}</pre>
              <p v-if="step.result.warnings.length" class="evidence-warning">{{ step.result.warnings.join("；") }}</p>
            </template>
            <template v-if="step.output"><label>{{ t("agent.output") }}</label><pre>{{ step.output }}</pre></template>
            <template v-if="step.review">
              <label>{{ t("agent.review") }}</label>
              <p class="review-result">{{ step.review.summary }}（{{ step.review.reason }}）</p>
            </template>
          </div>
        </div>
      </div>
    </template>
  </section>
</template>
