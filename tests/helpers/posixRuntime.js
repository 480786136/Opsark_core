// Test infrastructure only. Shell probes and their fixtures always share one POSIX filesystem.
import { spawnSync } from "node:child_process";
import { posix } from "node:path";

const roots = new Map();
const isWindows = process.platform === "win32";

export function runPosixShell(command, options = {}) {
  const executable = isWindows ? "wsl.exe" : "/bin/sh";
  const args = isWindows
    ? ["--distribution", process.env.OPSARK_TEST_WSL_DISTRO || "Ubuntu-22.04", "--exec", "/bin/sh", "-s"]
    : ["-s"];
  // stdin avoids Windows command-line reinterpretation of quotes, newlines and shell substitutions.
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 10000,
    maxBuffer: 1024 * 1024, ...options, input: command.endsWith("\n") ? command : `${command}\n` });
  if (result.error) throw new Error(`POSIX runtime unavailable (${executable}): ${result.error.message}`);
  if (result.status === null) throw new Error(`POSIX process did not exit normally: ${result.signal}\n${result.stderr}`);
  return result;
}

function fixtureOperation(request) {
  const encoded = Buffer.from(JSON.stringify(request), "utf8").toString("base64");
  const script = `import base64, json, os, pathlib, re, secrets, shutil, tempfile
request = json.loads(base64.b64decode('${encoded}'))
temp_root = pathlib.Path(tempfile.gettempdir()).resolve()
if request['op'] == 'create':
    root = pathlib.Path(tempfile.mkdtemp(prefix='opsark-readonly-', dir=str(temp_root)))
    token = secrets.token_hex(24)
    marker = root.with_name(root.name + '.owner')
    with marker.open('x', encoding='utf-8') as handle: handle.write(token)
    result = {'path': str(root), 'token': token}
else:
    root = pathlib.Path(request['root'])
    if not root.is_absolute() or root.parent != temp_root or not re.fullmatch(r'opsark-readonly-[A-Za-z0-9_-]+', root.name):
        raise ValueError('fixture root is outside the dedicated POSIX temp directory')
    if root.is_symlink() or root.resolve() != root or not root.is_dir():
        raise ValueError('fixture root changed identity')
    marker = root.with_name(root.name + '.owner')
    if marker.is_symlink() or marker.read_text(encoding='utf-8') != request['token']:
        raise ValueError('fixture ownership does not match this test process')
    def checked(value):
        path = pathlib.Path(value)
        if not path.is_absolute() or '..' in path.parts or os.path.commonpath([str(path), str(root)]) != str(root):
            raise ValueError('fixture operation escaped its registered root')
        if path != root and os.path.commonpath([str(path.parent.resolve()), str(root)]) != str(root):
            raise ValueError('fixture parent resolves outside its registered root')
        return path
    op = request['op']
    result = None
    if op == 'remove':
        # This is the only recursive delete. Root, parent, symlink and ownership were checked above.
        shutil.rmtree(root)
        marker.unlink()
    else:
        path = checked(request['path'])
        if op == 'mkdir': path.mkdir()
        elif op == 'write': path.write_text(request['data'], encoding='utf-8')
        elif op == 'symlink': path.symlink_to(checked(request['target']))
        elif op == 'link': os.link(checked(request['target']), path)
        elif op == 'stat': result = {'blocks': path.stat().st_blocks}
        else: raise ValueError('unknown fixture operation')
print(json.dumps(result, ensure_ascii=True))
`;
  const result = runPosixShell(`python3 - <<'OPSARK_POSIX_FIXTURE_PY'\n${script}OPSARK_POSIX_FIXTURE_PY\n`);
  if (result.status !== 0) throw new Error(`POSIX fixture ${request.op} failed (${result.status}):\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function owner(path) {
  for (const [root, token] of roots) {
    const relative = posix.relative(root, path);
    if (posix.isAbsolute(path) && relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative)) return { root, token };
  }
  throw new Error("Path is not inside a fixture registered by this test process");
}

export function createPosixFixture() {
  const { path, token } = fixtureOperation({ op: "create" });
  roots.set(path, token);
  return path;
}

export const posixFixtureFs = {
  mkdirSync(path) { fixtureOperation({ op: "mkdir", ...owner(path), path }); },
  writeFileSync(path, data) { fixtureOperation({ op: "write", ...owner(path), path, data }); },
  symlinkSync(target, path) { fixtureOperation({ op: "symlink", ...owner(path), path, target }); },
  linkSync(target, path) { fixtureOperation({ op: "link", ...owner(path), path, target }); },
  statSync(path) { return fixtureOperation({ op: "stat", ...owner(path), path }); },
  rmSync(root) {
    const token = roots.get(root);
    if (!token) throw new Error("Refusing to remove an unregistered fixture root");
    fixtureOperation({ op: "remove", root, token });
    roots.delete(root);
  },
};
