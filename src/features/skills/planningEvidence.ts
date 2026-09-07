import { currentEvidenceSteps } from "@/features/agent/attemptState";
import { inspectProjectManifest } from "@/features/skills/builtins/projectManifestEvidence";
import { normalizeToolEvidencePath } from "@/features/tools/toolEvidence";
import type { OpsTask } from "@/types";
import type { SkillEvidenceRequirement, SkillPlanningEvidence } from "./types";

/** Only linked executor evidence is eligible; model prose and result-only claims are not. */
export function collectPlanningEvidence(task: OpsTask, adapters: Array<"project_manifest"> = []) {
  const resources = new Map<string, { evidence: SkillPlanningEvidence; rawOutput?: string }>();
  for (const step of currentEvidenceSteps(task, true)) {
    const facts = step.result!.facts;
    if (typeof facts.evidenceKind !== "string" || !facts.evidenceKind.trim()
      || typeof facts.evidenceScope !== "string" || !facts.evidenceScope.trim()
      || typeof facts.evidenceComplete !== "boolean" || typeof facts.toolId !== "string") continue;
    const linked = step.evidence?.filter(item => item.source === "main"
      && item.type === "command-output" && step.result!.evidenceIds.includes(item.id)
      && ["toolId", "evidenceKind", "evidenceScope", "evidenceComplete", "truncated",
        "evidenceNonEmpty", "evidenceFingerprint"].every(key => item.facts[key] === facts[key]));
    // One tool result is one observation, regardless of repeated evidence IDs.
    if (!linked?.length) continue;
    const item = linked[linked.length - 1];
    const evidence: SkillPlanningEvidence = {
      evidenceId: item.id, stepId: step.id, toolId: facts.toolId,
      kind: facts.evidenceKind, scope: facts.evidenceScope,
      complete: facts.evidenceComplete && facts.truncated !== true,
      facts: item.facts,
    };
    // A newer partial observation also supersedes a previous complete one.
    resources.set(JSON.stringify([evidence.toolId, evidence.kind, evidence.scope]), { evidence, rawOutput: item.rawOutput });
  }
  const result: SkillPlanningEvidence[] = [];
  for (const { evidence, rawOutput } of resources.values()) {
    result.push(evidence);
    if (!adapters.includes("project_manifest") || evidence.kind !== "file_content"
      || !evidence.complete || evidence.toolId !== "files.read_content" || !rawOutput) continue;
    try {
      const data: unknown = JSON.parse(rawOutput);
      if (!data || typeof data !== "object" || !("path" in data) || normalizeToolEvidencePath(data.path) !== evidence.scope
        || !("content" in data) || typeof data.content !== "string") continue;
      const manifest = inspectProjectManifest(evidence.scope, data.content);
      if (manifest) result.push({
        ...evidence, kind: "project_manifest", facts: {
          ...manifest,
          projectDirectory: evidence.scope.slice(0, evidence.scope.lastIndexOf("/")) || "/",
        },
      });
    } catch { /* An old text result is available via full-context fallback. */ }
  }
  return result;
}

export function matchPlanningEvidence(evidence: SkillPlanningEvidence[], requirement: SkillEvidenceRequirement) {
  return evidence.filter(item => item.kind === requirement.kind
    && (requirement.complete === false || item.complete)
    && (!requirement.toolIds?.length || requirement.toolIds.includes(item.toolId))
    && (requirement.scope === undefined || item.scope === requirement.scope)
    && Object.entries(requirement.facts ?? {}).every(([key, value]) => item.facts[key] === value));
}

export function planningEvidenceSatisfies(evidence: SkillPlanningEvidence[], requirements: SkillEvidenceRequirement[] = []) {
  return requirements.every(requirement => {
    const matches = matchPlanningEvidence(evidence, requirement);
    // minCount counts distinct resources, not aliases or repeated reads of one file.
    const resources = new Set(matches.map(item => JSON.stringify([item.kind, item.scope])));
    return resources.size >= (requirement.minCount ?? 1);
  });
}
