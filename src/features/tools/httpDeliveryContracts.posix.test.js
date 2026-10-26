import { describe, expect, it } from "vitest";
import { runPosixShell } from "../../../tests/helpers/posixRuntime.js";
import probe from "./http_delivery_probe.py?raw";

describe("HTTP authority 原生探针配对验证保持不变", () => {
  it("真实 Python 验证缺省和完整配对，拒绝任一单边字段，不发 HTTP 请求", () => {
    const script = `import json
namespace = {'__name__': 'opsark_contract_test'}
exec(compile(${JSON.stringify(probe)}, '<http_delivery_probe>', 'exec'), namespace)
base = dict(url='https://delivery.test/', bodyMode='sha256', maxBodyBytes=65536, timeoutSeconds=15)
spec = dict(path='/srv/backend.jsonl', injection=dict(kind='header', name='X-Request-ID'), probeIdPointer='/probe', requestTargetPointer='/target', expectedRequestTarget='/backend', windowMs=250, maxLogBytes=65536)
cases = [('no_observation', None, True), ('no_authority', {}, True), ('paired', dict(authorityPointer='/host', expectedAuthority='backend.test'), True), ('pointer_only', dict(authorityPointer='/host'), False), ('authority_only', dict(expectedAuthority='backend.test'), False)]
results = []
for name, patch, expected in cases:
    request = dict(base)
    if patch is not None: request['backendObservation'] = dict(spec, **patch)
    try:
        namespace['target_for'](request, dict(probeId='controlled-probe'))
        accepted = True
    except ValueError:
        accepted = False
    results.append(dict(name=name, accepted=accepted))
    assert accepted == expected, name
print(json.dumps(results))
`;
    const result = runPosixShell(`python3 -I -B - <<'OPSARK_HTTP_CONTRACT_PY'\n${script}OPSARK_HTTP_CONTRACT_PY\n`);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { name: "no_observation", accepted: true }, { name: "no_authority", accepted: true }, { name: "paired", accepted: true },
      { name: "pointer_only", accepted: false }, { name: "authority_only", accepted: false },
    ]);
  });
});
