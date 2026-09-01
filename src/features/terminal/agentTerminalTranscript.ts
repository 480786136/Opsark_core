import type { AgentTerminalEntry } from "./agentTerminalStore";

function appendLineBoundary(transcript: string) {
  return transcript && !transcript.endsWith("\n") ? `${transcript}\n` : transcript;
}

function commandTranscript(entry: AgentTerminalEntry) {
  const label = entry.kind === "validation" ? "Agent 验证" : "Agent";
  const command = entry.text.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const lines = command.split("\n");
  return lines.map((line, index) => `[${label}] ${index === 0 ? "$" : ">"} ${line}`).join("\n");
}

/**
 * Build the read-only terminal transcript shown in the Agent sandbox.
 *
 * The intelligent-requirement panel owns plans, step titles, reviews and audit
 * events. The Agent terminal intentionally renders only commands sent to the
 * server, raw stdout/stderr and the real process exit status.
 */
export function buildAgentTerminalTranscript(entries: AgentTerminalEntry[]) {
  let transcript = "";
  for (const entry of entries) {
    if (entry.kind === "system") continue;
    if (entry.kind === "command" || entry.kind === "validation") {
      transcript = appendLineBoundary(transcript);
      transcript += `${commandTranscript(entry)}\n`;
    } else {
      transcript += entry.text;
    }
    if (entry.exitCode !== undefined) {
      transcript = appendLineBoundary(transcript);
      transcript += `[Agent] process exited with code ${entry.exitCode}\n`;
    }
  }
  return transcript;
}

export function toXtermData(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}
