import { afterEach, describe, expect, it } from "vitest";
import { createPosixFixture, posixFixtureFs as fs, runPosixShell } from "../../../tests/helpers/posixRuntime.js";
import { buildHttpDeliveryCommand, createHttpDeliveryBinding, normalizeHttpDeliveryRequest, parseHttpDeliveryOutput } from "./httpDeliveryInspection";
const quote = value => "'" + value.replace(/'/g, "'\"'\"'") + "'";
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true });
});

function fixture() {
  const root = createPosixFixture(); roots.push(root);
  fs.writeFileSync(root + "/server.py", `import http.server,json,pathlib,subprocess,sys,threading,urllib.parse
root=pathlib.Path(${JSON.stringify(root)})
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  query=urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
  with (root/'backend.jsonl').open('a') as f: f.write(json.dumps({'probe':query.get('probe',['']), 'target':self.path})+'\\n')
  body='中文'.encode('utf-8')
  self.send_response(200)
  self.send_header('Content-Length',str(len(body)))
  self.end_headers()
  self.wfile.write(body)
 def log_message(self,*args): pass
server=http.server.HTTPServer(('127.0.0.1',int(sys.argv[1])),Handler)
(root/'backend.jsonl').write_text('')
worker=threading.Thread(target=server.serve_forever,kwargs={'poll_interval':.01},daemon=True)
worker.start()
try:
 result=subprocess.run(['/bin/sh','-c',json.loads(sys.argv[2])],capture_output=True,timeout=10)
 sys.stdout.buffer.write(result.stdout)
 sys.stderr.buffer.write(result.stderr)
 sys.exit(result.returncode)
finally:
 server.shutdown()
 server.server_close()
 worker.join(2)
`);
  // A subsequently occupied candidate causes bind to fail; never contact the
  // port unless the owned wrapper successfully binds and starts this fixture.
  const launched = runPosixShell(`python3 -c ${quote("import socket; s=socket.socket(); s.bind(('127.0.0.1',0)); print(s.getsockname()[1]); s.close()")}`);
  expect(launched.status, launched.stderr).toBe(0);
  return { root, port: Number(launched.stdout.trim()) };
}

describe("HTTP 真实固定命令到回执消费", () => {
  it("Core私有绑定穿过Shell/Python，保存Host路径与新增日志窗口身份", async () => {
    const { root, port } = fixture();
    const request = normalizeHttpDeliveryRequest({ url: `http://delivery.test:${port}/中文`.replace("中文", "%E4%B8%AD%E6%96%87") + "?a=1&a=2",
      connectAddress: "127.0.0.1", bodyMode: "utf8", backendObservation: { path: root + "/backend.jsonl", injection: { kind: "query", name: "probe" },
        probeIdPointer: "/probe", requestTargetPointer: "/target", expectedRequestTarget: "/%E4%B8%AD%E6%96%87?a=1&a=2", windowMs: 50 } });
    const binding = await createHttpDeliveryBinding("actual-shell-execution", request);
    const command = buildHttpDeliveryCommand(request, binding);
    const result = runPosixShell(`python3 -I -B -u ${quote(root + "/server.py")} ${port} ${quote(JSON.stringify(command))}`, { timeout: 20000 });
    expect(result.status, result.stderr).toBe(0);
    const data = parseHttpDeliveryOutput(request, result.stdout, binding);
    expect(data.response.body).toMatchObject({ text: "中文", readBytes: 6, complete: true });
    expect(data.correlation).toMatchObject({ status: "matched", startOffset: 0, matchedCount: 1, sourceVerified: false });
    expect(data.binding).toEqual(binding);
  });
});
