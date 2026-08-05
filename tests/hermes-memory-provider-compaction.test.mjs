// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildHandoffPacket } from '../src/handoff.ts';
import { openCore } from '../src/core.ts';

const repo = path.resolve(import.meta.dirname, '..');
const providerSource = path.join(repo, 'integrations', 'hermes', 'ihow-memory-compaction', 'provider.py');
const bridgeSource = path.join(repo, 'src', 'hermes-bridge.ts');
const CHECKPOINT_ID_RE = /^cp_[a-f0-9]{64}$/;

async function fixture(t, label) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-hermes-compaction-${label}-`)));
  const home = path.join(root, 'hermes-home');
  const memoryRoot = path.join(root, 'memory');
  const stateRoot = path.join(root, 'state');
  const project = path.join(root, 'project');
  const fakeAgent = path.join(root, 'fake-agent');
  await Promise.all([
    fs.mkdir(home, { recursive: true }),
    fs.mkdir(memoryRoot, { recursive: true }),
    fs.mkdir(stateRoot, { recursive: true }),
    fs.mkdir(project, { recursive: true }),
    fs.mkdir(path.join(fakeAgent, 'agent'), { recursive: true }),
  ]);
  await fs.writeFile(path.join(fakeAgent, 'agent', '__init__.py'), '', 'utf8');
  await fs.writeFile(path.join(fakeAgent, 'agent', 'memory_provider.py'), 'class MemoryProvider:\n    pass\n', 'utf8');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, home, memoryRoot, stateRoot, project, fakeAgent };
}

function runProvider(f, script, env = {}, timeout = 15_000, source = providerSource) {
  return spawnSync('python3', ['-c', script, source, f.home], {
    cwd: f.project,
    encoding: 'utf8',
    timeout,
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      PYTHONPATH: f.fakeAgent,
      HERMES_HOME: f.home,
      ...env,
    },
  });
}

const providerLoader = String.raw`
import importlib.util, json, pathlib, sys
provider_path = pathlib.Path(sys.argv[1])
hermes_home = pathlib.Path(sys.argv[2])
spec = importlib.util.spec_from_file_location("ihow_memory_provider", provider_path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
`;

test('MemoryProvider pre-compress is content-free, bounded, idempotent, and rebinds both compression modes', async (t) => {
  const f = await fixture(t, 'adapter');
  const calls = path.join(f.root, 'calls.ndjson');
  const fakeBridge = path.join(f.root, 'fake-bridge.mjs');
  await fs.writeFile(fakeBridge, String.raw`
import crypto from 'node:crypto';
import fs from 'node:fs';
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.appendFileSync(process.env.IHOW_TEST_CALLS, JSON.stringify(request) + '\n');
const id = 'cp_' + crypto.createHash('sha256').update(request.compactionId).digest('hex');
process.stdout.write(JSON.stringify({ ok: true, checkpointId: id, deduplicated: false, coverageStatus: 'partial', ignored: process.env.IHOW_TEST_SECRET }) + '\n');
`, 'utf8');

  const rawSession = 'session-password-is-session-canary-4817';
  const rawPrompt = 'prompt-canary password is hunter2';
  const rawTool = 'tool-output-canary sk-not-a-real-key-1234567890';
  const rawPath = path.join(f.project, 'private', 'source.ts');
  const script = providerLoader + String.raw`
provider = module.IHowMemoryCompactionProvider()
provider.initialize(${JSON.stringify(rawSession)}, hermes_home=str(hermes_home), platform="cli")
messages = [
    {"role": "user", "content": ${JSON.stringify(rawPrompt)}},
    {"role": "assistant", "tool_calls": [{"function": {"name": "read_file", "arguments": ${JSON.stringify(rawPath)}}}]},
    {"role": "tool", "content": ${JSON.stringify(rawTool)}},
]
first = provider.on_pre_compress(messages)
duplicate = provider.on_pre_compress(messages)
same_session = ${JSON.stringify(rawSession)}
provider.on_session_switch(same_session, parent_session_id=same_session, reset=False, reason="compression")
in_place = provider.on_pre_compress(messages)
provider.on_session_switch("rotated-password-is-legacy-canary", parent_session_id=same_session, reset=False, reason="compression")
rotated = provider.on_pre_compress(messages)
print(json.dumps({
    "name": provider.name,
    "available": provider.is_available(),
    "tools": provider.get_tool_schemas(),
    "first": first,
    "duplicate": duplicate,
    "inPlace": in_place,
    "rotated": rotated,
    "protection": provider.protection_state,
}, sort_keys=True))
`;
  const run = runProvider(f, script, {
    IHOW_MEMORY_HERMES_BRIDGE: fakeBridge,
    IHOW_MEMORY_HERMES_NODE: process.execPath,
    IHOW_TEST_CALLS: calls,
    IHOW_TEST_SECRET: 'bridge-response-password-is-response-canary',
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.name, 'ihow-memory-compaction');
  assert.equal(output.available, true);
  assert.deepEqual(output.tools, []);
  assert.equal(output.first, output.duplicate, 'at-least-once duplicate returns the same handoff without a second write');
  assert.notEqual(output.inPlace, output.first, 'successful in-place boundary advances the idempotency generation');
  assert.notEqual(output.rotated, output.inPlace, 'legacy rotation rebinds checkpoint identity');
  assert.match(output.first, /UNVERIFIED/);
  assert.match(output.first, /memory\.continue/);
  assert.ok(output.first.length <= 320);
  assert.deepEqual(output.protection.status, 'UNVERIFIED');
  assert.notEqual(output.protection.status, 'GREEN');

  const serializedCalls = await fs.readFile(calls, 'utf8');
  const requests = serializedCalls.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), ['compactionId', 'operation', 'runtime', 'schemaVersion', 'sessionHash']);
    assert.equal(request.operation, 'checkpoint.pre_compress');
    assert.equal(request.runtime, 'hermes');
    assert.match(request.sessionHash, /^[a-f0-9]{64}$/);
    assert.match(request.compactionId, /^[a-f0-9]{64}$/);
  }
  for (const forbidden of [rawSession, rawPrompt, rawTool, rawPath, 'hunter2', 'response-canary', 'rotated-password']) {
    assert.doesNotMatch(serializedCalls, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(JSON.stringify(output), new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('MemoryProvider timeout and bridge error fail open while protection truth fails closed', async (t) => {
  const f = await fixture(t, 'fail-open');
  const slowBridge = path.join(f.root, 'slow-bridge.mjs');
  await fs.writeFile(slowBridge, 'setTimeout(() => process.stdout.write(JSON.stringify({ok:true}) + "\\n"), 500);\n', 'utf8');
  const script = providerLoader + String.raw`
provider = module.IHowMemoryCompactionProvider()
provider.initialize("timeout-session", hermes_home=str(hermes_home))
timeout_result = provider.on_pre_compress([{"role": "user", "content": "secret timeout body"}])
timeout_state = provider.protection_state
provider._bridge_command = lambda: ["/definitely/missing/ihow-bridge"]
error_result = provider.on_pre_compress([{"role": "user", "content": "different secret error body"}])
print(json.dumps({"timeout": timeout_result, "timeoutState": timeout_state, "error": error_result, "errorState": provider.protection_state}, sort_keys=True))
`;
  const started = Date.now();
  const run = runProvider(f, script, {
    IHOW_MEMORY_HERMES_BRIDGE: slowBridge,
    IHOW_MEMORY_HERMES_NODE: process.execPath,
    IHOW_MEMORY_HERMES_TIMEOUT_SECONDS: '0.05',
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.ok(Date.now() - started < 2_000, 'timeout remains bounded');
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.timeout, '');
  assert.equal(output.error, '');
  assert.deepEqual(output.timeoutState, { status: 'UNVERIFIED', coverage: 'unknown', reason: 'transport_failed' });
  assert.deepEqual(output.errorState, { status: 'UNVERIFIED', coverage: 'unknown', reason: 'transport_failed' });
});

test('installed bridge routing overrides stale ambient workspace roots', async (t) => {
  const f = await fixture(t, 'installed-routing');
  const installed = path.join(f.root, 'installed-provider');
  const installedProvider = path.join(installed, 'provider.py');
  const fakeBridge = path.join(f.root, 'routing-bridge.mjs');
  const observed = path.join(f.root, 'observed-routing.json');
  await fs.mkdir(installed, { recursive: true });
  await fs.copyFile(providerSource, installedProvider);
  await fs.writeFile(fakeBridge, String.raw`
import crypto from 'node:crypto';
import fs from 'node:fs';
const request = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(process.env.IHOW_TEST_ROUTING, JSON.stringify({
  memoryRoot: process.env.MEMORY_ROOT,
  stateRoot: process.env.IHOW_MEMORY_STATE_ROOT,
}));
process.stdout.write(JSON.stringify({
  ok: true,
  checkpointId: 'cp_' + crypto.createHash('sha256').update(request.compactionId).digest('hex'),
  coverageStatus: 'partial',
}) + '\n');
`, 'utf8');
  await fs.writeFile(path.join(installed, 'bridge.json'), `${JSON.stringify({
    schemaVersion: 1,
    node: process.execPath,
    bridge: fakeBridge,
    memoryRoot: f.memoryRoot,
    stateRoot: f.stateRoot,
  })}\n`, 'utf8');
  const script = providerLoader + String.raw`
provider = module.IHowMemoryCompactionProvider()
provider.initialize("installed-routing-session", hermes_home=str(hermes_home))
result = provider.on_pre_compress([{"role":"user","content":"never persisted"}])
print(json.dumps({"result": result, "state": provider.protection_state}, sort_keys=True))
`;
  const run = runProvider(f, script, {
    IHOW_MEMORY_HERMES_BRIDGE: '',
    IHOW_MEMORY_HERMES_NODE: '',
    MEMORY_ROOT: path.join(f.root, 'stale-memory-root'),
    IHOW_MEMORY_STATE_ROOT: path.join(f.root, 'stale-state-root'),
    IHOW_TEST_ROUTING: observed,
  }, 15_000, installedProvider);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const routing = JSON.parse(await fs.readFile(observed, 'utf8'));
  assert.deepEqual(routing, { memoryRoot: f.memoryRoot, stateRoot: f.stateRoot });
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.state.status, 'UNVERIFIED');
  assert.equal(output.state.coverage, 'partial');
});

test('real bridge smoke creates one partial pre-compact checkpoint and recovery caps stale/drifted truth', async (t) => {
  const f = await fixture(t, 'real-bridge');
  const git = (args) => execFileSync('git', args, { cwd: f.project, encoding: 'utf8' }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(f.project, 'seed.txt'), 'seed\n', 'utf8');
  git(['add', 'seed.txt']);
  git(['commit', '-q', '-m', 'seed']);

  const rawPrompt = 'raw-transcript-canary password is compaction-secret';
  const rawTool = 'raw-tool-output-canary';
  const script = providerLoader + String.raw`
provider = module.IHowMemoryCompactionProvider()
provider.initialize("real-session-secret-canary", hermes_home=str(hermes_home), platform="cli")
messages = [{"role":"user","content":${JSON.stringify(rawPrompt)}},{"role":"tool","content":${JSON.stringify(rawTool)}}]
first = provider.on_pre_compress(messages)
second = provider.on_pre_compress(messages)
print(json.dumps({"first": first, "second": second, "protection": provider.protection_state}, sort_keys=True))
`;
  const run = runProvider(f, script, {
    IHOW_MEMORY_HERMES_BRIDGE: bridgeSource,
    IHOW_MEMORY_HERMES_NODE: process.execPath,
    MEMORY_ROOT: f.memoryRoot,
    IHOW_MEMORY_STATE_ROOT: f.stateRoot,
  }, 30_000);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.first, output.second);
  assert.match(output.first, /UNVERIFIED/);
  assert.deepEqual(output.protection.coverage, 'partial');
  assert.match(output.protection.checkpointId, CHECKPOINT_ID_RE);

  const core = await openCore({ memoryRoot: f.memoryRoot, stateRoot: f.stateRoot, cwd: f.project });
  const listed = await core.checkpoints.list();
  assert.equal(listed.length, 1);
  const artifact = await core.checkpoints.read(listed[0].id);
  assert.equal(artifact.trigger.kind, 'pre_compact');
  assert.equal(artifact.trigger.sourceEvent, 'Hermes.MemoryProvider.on_pre_compress');
  assert.equal(artifact.coverage.complete, false);
  assert.deepEqual(artifact.state, { completed: [], pending: [], decisions: [], blockers: [], nextActions: [] });
  assert.deepEqual(artifact.anchors.files, []);
  assert.deepEqual(artifact.anchors.commands, []);
  assert.match(artifact.anchors.git?.statusHash ?? '', /^[a-f0-9]{64}$/);

  const artifactRaw = JSON.stringify(artifact);
  for (const forbidden of [rawPrompt, rawTool, f.project, 'compaction-secret', 'real-session-secret-canary']) {
    assert.doesNotMatch(artifactRaw, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(output.first, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }

  const stale = await buildHandoffPacket({
    cwd: f.project,
    workspace: core.workspace,
    now: Date.parse(artifact.createdAt) + 48 * 60 * 60 * 1000,
  });
  const staleCandidate = stale.candidates.find(candidate => candidate.checkpoint?.artifactId === artifact.id);
  assert.ok(staleCandidate);
  assert.equal(staleCandidate.narrative.unverified, true);
  assert.equal(staleCandidate.freshness.stale, true);
  assert.notEqual(staleCandidate.verdict.state, 'GREEN');

  await fs.writeFile(path.join(f.project, 'seed.txt'), 'drift\n', 'utf8');
  const drifted = await buildHandoffPacket({ cwd: f.project, workspace: core.workspace });
  const driftedCandidate = drifted.candidates.find(candidate => candidate.checkpoint?.artifactId === artifact.id);
  assert.ok(driftedCandidate);
  assert.equal(driftedCandidate.narrative.unverified, true);
  assert.notEqual(driftedCandidate.verdict.state, 'GREEN');
});

test('packed Hermes integration includes the explicit MemoryProvider adapter without the old orphaned path', async (t) => {
  const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-pack-cache-'));
  t.after(() => fs.rm(npmCache, { recursive: true, force: true }));
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, npm_config_cache: npmCache },
  });
  const files = new Set(JSON.parse(raw)[0].files.map(entry => entry.path.replace(/\\/g, '/')));
  assert.ok(files.has('integrations/hermes/ihow-memory-compaction/__init__.py'));
  assert.ok(files.has('integrations/hermes/ihow-memory-compaction/plugin.yaml'));
  assert.ok(files.has('integrations/hermes/ihow-memory-compaction/provider.py'));
  assert.equal(files.has('integrations/hermes/ihow-memory/provider.py'), false);
});
