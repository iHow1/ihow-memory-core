// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { canonicalSha256V1 } from '../src/evaluation.ts';
import { createMemoryProposalV1 } from '../src/memory-proposals.ts';

const repo = path.resolve(import.meta.dirname, '..');
const plugin = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');
const receiptStore = (memoryRoot) => path.join(memoryRoot, '_mcp', 'turn-receipts', 'v1.json');

function isolatedEnv(memoryRoot, stateRoot, extra = {}) {
  const env = {
    ...process.env,
    MEMORY_ROOT: memoryRoot,
    IHOW_MEMORY_STATE_ROOT: stateRoot,
    IHOW_MEMORY_HERMES_BRIDGE: bridge,
    IHOW_MEMORY_HERMES_NODE: process.execPath,
    PYTHONDONTWRITEBYTECODE: '1',
    ...extra,
  };
  for (const key of [
    'HERMES_HOME',
    'HERMES_SAFE_MODE',
    'IHOW_MEMORY_ROOT',
    'IHOW_MEMORY_HOME',
    'IHOW_MEMORY_HERMES_TEST_MODE',
  ]) delete env[key];
  return env;
}

async function fixtureRoots(t, label) {
  const memoryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${label}-memory-`)));
  const stateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${label}-state-`)));
  t.after(async () => Promise.all([
    fs.rm(memoryRoot, { recursive: true, force: true }),
    fs.rm(stateRoot, { recursive: true, force: true }),
  ]));
  return { memoryRoot, stateRoot };
}

async function invokePreHook(t, { persisted = true, markerMissing = false, userText = 'raw-user-text-canary-3167' } = {}) {
  const { memoryRoot, stateRoot } = await fixtureRoots(t, 'ihow-hermes-no-b3');
  const eventLog = path.join(stateRoot, 'hermes-events.ndjson');
  const script = String.raw`
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
result = ctx.hooks["pre_llm_call"](
    session_id="raw-session-canary-7841",
    turn_id="raw-turn-canary-5293",
    user_message=config["userText"],
    conversation_history=[{
        "role": "user",
        "content": config["userText"],
        **({} if config["markerMissing"] else {"_db_persisted": config["persisted"]}),
    }],
    task_id="raw-task-canary-9024",
    platform="cli",
    cwd=config["cwd"],
)
print(json.dumps(result, sort_keys=True))
`;
  const run = spawnSync('python3', ['-B', '-c', script, plugin, JSON.stringify({
    cwd: repo,
    markerMissing,
    persisted,
    userText,
  })], {
    cwd: repo,
    encoding: 'utf8',
    env: isolatedEnv(memoryRoot, stateRoot, { IHOW_MEMORY_HERMES_EVENT_LOG: eventLog }),
  });
  return { run, memoryRoot };
}

async function readReceipts(memoryRoot) {
  return JSON.parse(await fs.readFile(receiptStore(memoryRoot), 'utf8')).receipts;
}

test('Node bridge rejects unknown, extra, and malformed commit actions fail-closed', () => {
  const identity = {
    schemaVersion: 1,
    runtime: 'hermes',
    projectId: 'a'.repeat(64),
    sessionHash: 'b'.repeat(64),
    turnId: 'c'.repeat(64),
    revision: 1,
    inputSourceHash: `sha256:${'d'.repeat(64)}`,
    inputContentSha256: 'e'.repeat(64),
    finalSourceHash: `sha256:${'f'.repeat(64)}`,
    finalContentSha256: '1'.repeat(64),
    committedAt: '2026-07-17T12:00:03.000Z',
    deltaState: 'not_emitted',
  };
  for (const turnReceipt of [
    { action: 'delete', receipt: identity },
    { action: 'commit', receipt: { ...identity, extra: true } },
    { action: 'commit', receipt: { ...identity, deltaState: 'explicit_none' } },
  ]) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', bridge], {
      cwd: repo,
      encoding: 'utf8',
      input: `${JSON.stringify({
        schemaVersion: 1,
        event: 'runtime.session_end',
        runtime: 'hermes',
        cwd: repo,
        observedAt: '2026-07-17T12:00:03.000Z',
        turnReceipt,
      })}\n`,
      env: isolatedEnv(path.join(os.tmpdir(), `unused-${crypto.randomUUID()}`), path.join(os.tmpdir(), `unused-state-${crypto.randomUUID()}`)),
    });
    assert.notEqual(run.status, 0);
    assert.equal(JSON.parse(run.stdout).ok, false);
  }
});

test('Node bridge rejects a valid capture action outside runtime.session_end without mutating the OPEN receipt', async (t) => {
  const projectId = 'a'.repeat(64);
  const sessionHash = 'b'.repeat(64);
  const turnId = 'c'.repeat(64);
  const inputSourceHash = `sha256:${'d'.repeat(64)}`;
  const inputContentSha256 = 'e'.repeat(64);
  const identity = { runtime: 'hermes', projectId, sessionHash, turnId, revision: 1 };
  const created = createMemoryProposalV1({
    schemaVersion: 1,
    kind: 'fact',
    text: '[memory:fact] subject=B4 | key=capture event | value=session end only',
    subject: 'B4',
    key: 'capture event',
    value: 'session end only',
    scope: {
      declaredVisibility: 'project', effectiveVisibility: 'project', projectScope: projectId,
      sourcePath: null, frontmatter: null,
    },
    provenance: {
      sourceKind: 'runtime-event', sourceId: `hermes-final:${'1'.repeat(64)}`, runtime: 'hermes',
      observedAt: '2026-07-18T12:00:01.000Z', sourceSha256: '1'.repeat(64),
      evidenceLocator: 'memory-delta:proposal:0',
    },
    relation: {
      verdict: 'review_required', targetProposalIds: [], targetPaths: [], reviewRequired: true,
      destructive: false, reason: 'ordinary_language_typed_sidecar',
    },
    review: { mode: 'review-first', state: 'pending' },
    safety: {
      outcome: 'candidate-only', directDurableWrite: false, indexWrite: false,
      destructive: false, autoPromote: false,
    },
  });
  const { proposalId: _proposalId, ...proposal } = created;
  const hashInput = {
    schemaVersion: 1,
    receiptIdentity: identity,
    finalEvidence: {
      finalSourceHash: `sha256:${'1'.repeat(64)}`,
      finalContentSha256: '1'.repeat(64),
      committedAt: '2026-07-18T12:00:02.000Z',
    },
    proposal,
  };
  const capture = { action: 'capture', delta: { ...hashInput, deltaHash: canonicalSha256V1(hashInput) } };

  for (const event of ['runtime.after_turn', 'runtime.session_finalize']) {
    const { memoryRoot, stateRoot } = await fixtureRoots(t, `ihow-hermes-capture-${event.replaceAll('.', '-')}`);
    const env = isolatedEnv(memoryRoot, stateRoot);
    const open = spawnSync(process.execPath, ['--experimental-strip-types', bridge], {
      cwd: repo,
      encoding: 'utf8',
      input: `${JSON.stringify({
        schemaVersion: 1, event: 'runtime.before_prompt', runtime: 'hermes', cwd: repo,
        observedAt: '2026-07-18T12:00:00.000Z',
        turnReceipt: { action: 'open', receipt: {
          schemaVersion: 1, ...identity, inputSourceHash, inputContentSha256,
          openedAt: '2026-07-18T12:00:00.000Z',
        } },
      })}\n`,
      env,
    });
    assert.equal(open.status, 0, open.stderr || open.stdout);

    const forged = spawnSync(process.execPath, ['--experimental-strip-types', bridge], {
      cwd: repo,
      encoding: 'utf8',
      input: `${JSON.stringify({
        schemaVersion: 1, event, runtime: 'hermes', cwd: repo,
        observedAt: '2026-07-18T12:00:02.000Z', turnReceipt: capture,
      })}\n`,
      env,
    });
    assert.notEqual(forged.status, 0, `${event} must reject capture`);
    assert.deepEqual(JSON.parse(forged.stdout), { ok: false, error: 'hermes_turn_receipt_event_invalid' });

    const receipts = await readReceipts(memoryRoot);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'OPEN');
    assert.equal(receipts[0].deltaState, 'not_emitted');
    const candidateRoot = path.join(memoryRoot, 'memory', 'candidate');
    assert.deepEqual(await fs.readdir(candidateRoot, { recursive: true }).catch(() => []), []);
  }
});

test('Node bridge strictly rejects attacker fields and malformed commit_not_proven diagnostics', () => {
  for (const diagnostic of [
    { code: 'commit_not_proven', reason: 'pending_not_found', extra: 'raw-content-canary' },
    { code: 'commit_not_proven', reason: 'attacker_reason' },
    { code: 'commit_not_proven', reason: 'pending_not_found', sessionHash: 'a'.repeat(64) },
    { code: 'commit_not_proven', reason: 'pending_not_found', sessionHash: 'raw-session', turnId: 'b'.repeat(64) },
  ]) {
    const run = spawnSync(process.execPath, ['--experimental-strip-types', bridge], {
      cwd: repo,
      encoding: 'utf8',
      input: `${JSON.stringify({
        schemaVersion: 1,
        event: 'runtime.after_turn',
        runtime: 'hermes',
        cwd: repo,
        observedAt: '2026-07-17T12:00:03.000Z',
        diagnostic,
      })}\n`,
      env: isolatedEnv(path.join(os.tmpdir(), `unused-${crypto.randomUUID()}`), path.join(os.tmpdir(), `unused-state-${crypto.randomUUID()}`)),
    });
    assert.notEqual(run.status, 0);
    assert.equal(JSON.parse(run.stdout).error, 'hermes_commit_diagnostic_invalid');
  }
});

test('fail-open hook logs contain only a fixed code without exception traceback or canaries', () => {
  const rawIdentity = 'raw-log-session-canary-4812';
  const rawContent = 'raw-log-content-canary-5923';
  const rawPath = '/raw/log/path/canary-6034';
  const script = String.raw`
import importlib.util, logging, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
logging.basicConfig(level=logging.DEBUG)
def fail(_event): raise RuntimeError(${JSON.stringify(`${rawIdentity} ${rawContent} ${rawPath}`)})
module._dispatch = fail
module._on_post_llm_call(session_id=${JSON.stringify(rawIdentity)}, turn_id="turn", conversation_history=[])
`;
  const run = spawnSync('python3', ['-B', '-c', script, plugin], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stderr, /ihow_memory_hermes_hook_failed_open/);
  assert.doesNotMatch(run.stderr, /Traceback|RuntimeError|raw-log-session|raw-log-content|raw\/log\/path/);
});

test('missing B3 evidence creates no receipt even when the legacy persistence marker is absent', async (t) => {
  const fixture = await invokePreHook(t, { markerMissing: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  await assert.rejects(fs.access(receiptStore(fixture.memoryRoot)), { code: 'ENOENT' });
});

test('missing B3 evidence creates no receipt when the legacy persistence marker is false', async (t) => {
  const fixture = await invokePreHook(t, { persisted: false });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  await assert.rejects(fs.access(receiptStore(fixture.memoryRoot)), { code: 'ENOENT' });
});

test('oversized prompt without B3 evidence fails open and creates no receipt', async (t) => {
  const fixture = await invokePreHook(t, { userText: '😀'.repeat(501) });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  await assert.rejects(fs.access(receiptStore(fixture.memoryRoot)), { code: 'ENOENT' });
});

test('unpaired-surrogate prompt without B3 evidence fails open and creates no receipt', async (t) => {
  const fixture = await invokePreHook(t, { userText: '\ud800' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  assert.equal(fixture.run.stdout.trim(), 'null');
  await assert.rejects(fs.access(receiptStore(fixture.memoryRoot)), { code: 'ENOENT' });
});
