const INITIAL_PLAN_PROGRESS_PATTERN = /^已生成\s+\d+\s+个执行步骤(?:[，,。；;]|$)/u;
const DISCOVERY_PLAN_PROGRESS_PATTERN = /^已根据发现证据生成\s+\d+\s+个后续步骤(?:[，,。；;]|$)/u;
const LEGACY_ADJUSTMENT_PROGRESS_PATTERN = /^(?:已根据失败结果(?:自动)?生成|已根据执行异常自动生成|已按用户请求生成)\s+\d+\s+个调整步骤(?:[，,。；;]|$)/u;
const NEXT_PHASE_PROGRESS_PATTERN = /^已进入下一阶段(?:[，,。：:；;]|$)|^下一阶段计划已生成(?:[，,。：:；;]|$)/u;

export function isAdjustmentProgressMessage(content: string) {
  return LEGACY_ADJUSTMENT_PROGRESS_PATTERN.test(content)
    || NEXT_PHASE_PROGRESS_PATTERN.test(content);
}

export function isPlanProgressMessage(content: string) {
  return INITIAL_PLAN_PROGRESS_PATTERN.test(content)
    || DISCOVERY_PLAN_PROGRESS_PATTERN.test(content)
    || isAdjustmentProgressMessage(content);
}
