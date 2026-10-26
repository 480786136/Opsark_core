// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { executeHealthObservation } from "./healthObservationExecution";
import { normalizeHealthObservationRequest, healthObservationResultIssue } from "./healthObservation";

const servers = [];
function posixProcess(executable, args) {
  return process.platform === "win32"
    ? spawn("wsl.exe", ["--distribution", process.env.OPSARK_TEST_WSL_DISTRO || "Ubuntu-22.04", "--exec", executable, ...args], { windowsHide: true })
    : spawn(executable, args, { windowsHide: true });
}
const serverSource = `import http.server, threading, sys, json
requests = []
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        requests.append(self.path)
        ready = self.path.startswith('/eventual') and len(requests) >= 3
        self.send_response(200 if ready else 503)
        self.end_headers()
        self.wfile.write(b'body-is-never-captured')
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
print(json.dumps({'port':server.server_port}), flush=True)
sys.stdin.readline()
server.shutdown()
server.server_close()
print(json.dumps({'requests':requests}), flush=True)
`;
async function startServer() {
  const code = `import base64;exec(base64.b64decode('${Buffer.from(serverSource).toString("base64")}'))`;
  const process = posixProcess("python3", ["-u", "-c", code]);
  let output = "", error = "";
  const ended = once(process, "exit");
  const handle = { process, ended, get output() { return output; }, stopped: false };
  servers.push(handle);
  process.stdout.on("data", data => { output += data.toString(); });
  process.stderr.on("data", data => { error += data.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("POSIX HTTP fixture startup timeout: " + error)), 10000);
    const ready = () => { if (output.includes("\n")) { clearTimeout(timer); process.stdout.off("data", ready); resolve(); } };
    process.stdout.on("data", ready);
    process.once("error", cause => { clearTimeout(timer); reject(cause); });
    process.once("exit", code => { if (!output.includes("\n")) { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${error}`)); } });
  });
  return { ...handle, port: JSON.parse(output.split("\n")[0]).port, handle };
}
async function stopServer(handle) {
  if (handle.stopped) return;
  handle.stopped = true;
  handle.process.stdin.end("stop\n");
  const [code] = await handle.ended;
  expect(code).toBe(0);
}
afterEach(async () => { for (const handle of servers.splice(0)) await stopServer(handle); });

function runProbe(command, progress, extra = "") {
  const process = posixProcess("/bin/sh", ["-s"]);
  let stdout = "", stderr = "";
  process.stdout.on("data", chunk => { const text = chunk.toString(); stdout += text; progress(text); });
  process.stderr.on("data", chunk => { stderr += chunk.toString(); });
  process.stdin.end(`${extra}\n${command}\n`);
  return new Promise((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", exitCode => resolve({ success: exitCode === 0, exitCode, stdout, stderr, stdoutTruncated: false }));
  });
}
const binding = { taskId: "real-http", roundId: "round", workflowEpoch: 1, stepId: "health", executionId: "real-health" };

describe.skipIf(process.platform === "win32" && process.env.OPSARK_LOCAL_POSIX !== "1")("真实POSIX curl健康观察", () => {
  it("准备两分钟后仍发真实GET，并在第三次样本就绪，环境代理不改变目标", async () => {
    const server = await startServer();
    const request = normalizeHealthObservationRequest({ url: `http://127.0.0.1:${server.port}/eventual?literal='$(printf%20no)'`, windowSeconds: 8, intervalSeconds: 1 });
    const snapshots = [];
    const result = await executeHealthObservation(request, { binding, preparationStartedAt: Date.now() - 120000 }, {
      assertCurrent: () => {}, isCancelled: () => false, persist: snapshot => { snapshots.push(snapshot); }, cancel: async () => {},
      execute: (command, _id, progress) => runProbe(command, progress, "export http_proxy=http://127.0.0.1:1 https_proxy=http://127.0.0.1:1 ALL_PROXY=http://127.0.0.1:1 NO_PROXY=''"),
    });
    expect(healthObservationResultIssue(request, result)).toBeUndefined();
    expect(result.observation.state).toBe("matched");
    expect(result.observation.preparationElapsedMs).toBeGreaterThanOrEqual(120000);
    expect(result.observation.samples.map(sample => sample.facts.httpStatus)).toEqual([503, 503, 200]);
    expect(result.observation.samples.every(sample => sample.status === "valid")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("body-is-never-captured");
    await stopServer(server.handle);
    const report = JSON.parse(server.handle.output.trim().split("\n").at(-1));
    expect(report.requests).toHaveLength(3);
    expect(report.requests[0]).toContain("$(printf%20no)");
    expect(snapshots.at(-1).state).toBe("matched");
  }, 25000);
  it("始终503时保留真实样本并到期结束；缺curl不能冒充超时观察", async () => {
    const server = await startServer();
    const request = normalizeHealthObservationRequest({ url: `http://127.0.0.1:${server.port}/never`, windowSeconds: 3, intervalSeconds: 1 });
    const deps = { assertCurrent: () => {}, isCancelled: () => false, persist: () => {}, cancel: async () => {},
      execute: (command, _id, progress) => runProbe(command, progress) };
    const result = await executeHealthObservation(request, { binding, preparationStartedAt: Date.now() }, deps);
    expect(result.observation).toMatchObject({ state: "window_elapsed", windowSatisfied: true });
    expect(result.observation.observationElapsedMs).toBeGreaterThanOrEqual(3000);
    expect(result.observation.samples.length).toBeGreaterThanOrEqual(2);
    expect(result.observation.samples.every(sample => sample.facts.httpStatus === 503 && !sample.matched)).toBe(true);
    const unsupported = await executeHealthObservation(request, { binding: { ...binding, executionId: "no-curl" }, preparationStartedAt: Date.now() }, {
      ...deps, execute: (command, _id, progress) => runProbe(command, progress, "PATH=/opsark-test-no-command; export PATH"),
    });
    expect(unsupported.observation).toMatchObject({ state: "unsupported", windowSatisfied: false, observationElapsedMs: 0 });
    expect(unsupported.observation.firstValidProbeAt).toBeUndefined();
    await stopServer(server.handle);
    const report = JSON.parse(server.handle.output.trim().split("\n").at(-1));
    expect(report.requests).toHaveLength(result.observation.samples.length);
  }, 20000);
});
