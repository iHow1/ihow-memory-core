// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const plugin = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');
const receiptStoreRelative = path.join('_mcp', 'turn-receipts', 'v1.json');

function digest(domain, value) {
  return crypto.createHash('sha256').update(domain).update(value).digest('hex');
}

function evidence(label) {
  return {
    schemaVersion: 1,
    identityDomain: 'hermes-transcript-v1',
    sessionHash: digest('b6-safety-session\0', label),
    turnId: digest('b6-safety-turn\0', label),
    inputSourceHash: `sha256:${digest('b6-safety-input-source\0', label)}`,
    inputContentSha256: digest('b6-safety-input-content\0', label),
  };
}

async function isolatedRoots(t, label) {
  const memoryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-b6-${label}-memory-`)));
  const stateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-b6-${label}-state-`)));
  t.after(async () => Promise.all([
    fs.rm(memoryRoot, { recursive: true, force: true }),
    fs.rm(stateRoot, { recursive: true, force: true }),
  ]));
  return { memoryRoot, stateRoot };
}

function isolatedEnv(memoryRoot, stateRoot) {
  const env = {
    ...process.env,
    MEMORY_ROOT: memoryRoot,
    IHOW_MEMORY_STATE_ROOT: stateRoot,
    IHOW_MEMORY_HERMES_BRIDGE: bridge,
    IHOW_MEMORY_HERMES_NODE: process.execPath,
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const key of [
    'HERMES_HOME',
    'HERMES_SAFE_MODE',
    'IHOW_MEMORY_ROOT',
    'IHOW_MEMORY_HOME',
    'IHOW_MEMORY_HERMES_TEST_MODE',
    'IHOW_MEMORY_HERMES_EVENT_LOG',
  ]) delete env[key];
  return env;
}

async function regularFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push({ path: target, bytes: await fs.readFile(target) });
    }
  }
  await visit(root);
  return files;
}

async function readStore(memoryRoot) {
  return JSON.parse(await fs.readFile(path.join(memoryRoot, receiptStoreRelative), 'utf8'));
}

const repeatedPreScript = String.raw`
import importlib.util, json, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
config = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class Ctx:
    def __init__(self): self.hooks = {}; self.tools = []
    def register_hook(self, name, callback): self.hooks[name] = callback
    def register_tool(self, *args, **kwargs): self.tools.append((args, kwargs))
ctx = Ctx(); module.register(ctx)
kwargs = {
    "session_id": config["rawSession"],
    "turn_id": config["rawTurn"],
    "user_message": config["rawUser"],
    "conversation_history": [{"role": "user", "content": config["rawUser"], "_db_persisted": True}],
    "cwd": config["cwd"],
    "platform": "cli",
    "durable_transcript_input": config["evidence"],
    "source_path": config["rawPath"],
    "secret_canary": config["rawSecret"],
}
ctx.hooks["pre_llm_call"](**kwargs)
ctx.hooks["pre_llm_call"](**kwargs)
print(json.dumps({"status": "PASS", "hookRegistered": "pre_llm_call" in ctx.hooks}, sort_keys=True))
`;

test('B3 schema-v2 OPEN is idempotent and persists no raw Adapter canaries', async (t) => {
  const { memoryRoot, stateRoot } = await isolatedRoots(t, 'adapter-idempotent');
  const raw = {
    rawSession: 'raw-b6-safety-session-canary-71d3',
    rawTurn: 'raw-b6-safety-turn-canary-82e4',
    rawUser: 'raw B6 safety user canary 93f5',
    rawPath: '/raw/b6/safety/path-canary-a406',
    rawSecret: 'raw-b6-safety-secret-canary-b517',
  };
  const durable = evidence('idempotent');
  const run = spawnSync('python3', ['-B', '-c', repeatedPreScript, plugin, JSON.stringify({
    ...raw,
    cwd: repo,
    evidence: durable,
  })], {
    cwd: repo,
    encoding: 'utf8',
    env: isolatedEnv(memoryRoot, stateRoot),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { hookRegistered: true, status: 'PASS' });
  const store = await readStore(memoryRoot);
  assert.equal(store.receipts.length, 1);
  const [receipt] = store.receipts;
  assert.deepEqual({
    schemaVersion: receipt.schemaVersion,
    state: receipt.state,
    identityDomain: receipt.identityDomain,
    origin: receipt.origin,
    runtime: receipt.runtime,
    sessionHash: receipt.sessionHash,
    turnId: receipt.turnId,
    revision: receipt.revision,
    inputSourceHash: receipt.inputSourceHash,
    inputContentSha256: receipt.inputContentSha256,
  }, {
    schemaVersion: 2,
    state: 'OPEN',
    identityDomain: 'hermes-transcript-v1',
    origin: 'native-hook',
    runtime: 'hermes',
    sessionHash: durable.sessionHash,
    turnId: durable.turnId,
    revision: 1,
    inputSourceHash: durable.inputSourceHash,
    inputContentSha256: durable.inputContentSha256,
  });
  assert.equal(store.receipts.some(item => item.schemaVersion === 1), false);

  const persisted = [
    ...await regularFiles(memoryRoot),
    ...await regularFiles(stateRoot),
  ];
  for (const [name, canary] of Object.entries(raw)) {
    const encoded = Buffer.from(canary);
    for (const file of persisted) {
      assert.equal(file.bytes.includes(encoded), false, `raw ${name} persisted in ${file.path}`);
    }
  }
});

const projectRootScript = String.raw`
import importlib.util, json, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
config = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class Ctx:
    def __init__(self): self.hooks = {}; self.tools = []
    def register_hook(self, name, callback): self.hooks[name] = callback
    def register_tool(self, *args, **kwargs): self.tools.append((args, kwargs))
class Completed:
    returncode = 0
    stderr = ""
    def __init__(self, root): self.stdout = root + "\n"
ctx = Ctx(); module.register(ctx)
real_run = module.subprocess.run
count = 0
def controlled_run(argv, *args, **kwargs):
    global count
    if isinstance(argv, (list, tuple)) and list(argv[:3]) == ["git", "rev-parse", "--show-toplevel"]:
        count += 1
        return Completed(config["projectRoot"])
    return real_run(argv, *args, **kwargs)
module.subprocess.run = controlled_run
module._project_root.cache_clear()
for index, durable in enumerate(config["evidence"]):
    ctx.hooks["pre_llm_call"](
        session_id=f"raw-cache-session-{index}",
        turn_id=f"raw-cache-turn-{index}",
        user_message="bounded project root cache probe",
        conversation_history=[],
        cwd=config["cwd"],
        platform="cli",
        durable_transcript_input=durable,
    )
print(json.dumps({
    "gitCalls": count,
    "rejectsControl": not module._valid_project_root_candidate("bad\nroot"),
    "rejectsOverlong": not module._valid_project_root_candidate("x" * 4097),
}, sort_keys=True))
`;

test('registered B3 pre-hook resolves one bounded cached project root per process', async (t) => {
  const { memoryRoot, stateRoot } = await isolatedRoots(t, 'adapter-project-root');
  const projectRoot = await fs.realpath(repo);
  const durable = [evidence('project-root-a'), evidence('project-root-b')];
  const run = spawnSync('python3', ['-B', '-c', projectRootScript, plugin, JSON.stringify({
    cwd: repo,
    projectRoot,
    evidence: durable,
  })], {
    cwd: repo,
    encoding: 'utf8',
    env: isolatedEnv(memoryRoot, stateRoot),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    gitCalls: 1,
    rejectsControl: true,
    rejectsOverlong: true,
  });
  const store = await readStore(memoryRoot);
  assert.equal(store.receipts.length, 2);
  const expectedProjectId = digest('turn-receipt-project-v1\0', projectRoot);
  assert.deepEqual([...new Set(store.receipts.map(receipt => receipt.projectId))], [expectedProjectId]);
  assert.deepEqual(
    store.receipts.map(receipt => receipt.turnId).sort(),
    durable.map(item => item.turnId).sort(),
  );
  assert.equal(store.receipts.every(receipt => receipt.schemaVersion === 2 && receipt.origin === 'native-hook'), true);
});

const durableFailureScript = String.raw`
import importlib.util, json, logging, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
config = json.loads(sys.argv[2])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class Ctx:
    def __init__(self): self.hooks = {}; self.tools = []
    def register_hook(self, name, callback): self.hooks[name] = callback
    def register_tool(self, *args, **kwargs): self.tools.append((args, kwargs))
ctx = Ctx(); module.register(ctx)
logging.basicConfig(level=logging.DEBUG)
def fail(_event):
    raise RuntimeError(config["rawException"])
module._dispatch = fail
ctx.hooks["on_durable_transcript_revision"](**config["publication"])
print(json.dumps({"status": "PASS"}, sort_keys=True))
`;

test('registered durable revision hook fails open with bounded logs and no false receipt', async (t) => {
  const { memoryRoot, stateRoot } = await isolatedRoots(t, 'adapter-durable-failure');
  const rawException = 'raw durable transport exception canary /raw/b6/transport/path-c628';
  const sessionHash = 'a'.repeat(64);
  const publication = {
    schemaVersion: 1,
    sessionHash,
    revision: 1,
    manifestPath: `manifests/${sessionHash}.json`,
    transcriptPath: `revisions/${sessionHash}/1.json`,
    contentSha256: 'b'.repeat(64),
    committedAt: '2026-07-18T12:34:56.123456Z',
  };
  const run = spawnSync('python3', ['-B', '-c', durableFailureScript, plugin, JSON.stringify({
    rawException,
    publication,
  })], {
    cwd: repo,
    encoding: 'utf8',
    env: isolatedEnv(memoryRoot, stateRoot),
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), { status: 'PASS' });
  assert.match(run.stderr, /ihow_memory_hermes_durable_revision_failed_open/);
  assert.doesNotMatch(run.stderr, /Traceback|RuntimeError|raw durable transport|raw\/b6\/transport/);
  await assert.rejects(
    fs.access(path.join(memoryRoot, receiptStoreRelative)),
    { code: 'ENOENT' },
  );
  for (const file of [
    ...await regularFiles(memoryRoot),
    ...await regularFiles(stateRoot),
  ]) {
    assert.equal(file.bytes.includes(Buffer.from(rawException)), false, `raw exception persisted in ${file.path}`);
  }
});
