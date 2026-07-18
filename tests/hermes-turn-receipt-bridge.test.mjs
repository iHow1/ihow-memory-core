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

function digest(domain, value) {
  return crypto.createHash('sha256').update(domain).update(value).digest('hex');
}

async function invokePreHook({ persisted = true, markerMissing = false, memoryRoot: suppliedMemoryRoot, stateRoot: suppliedStateRoot, userText: suppliedUserText } = {}) {
  const memoryRoot = suppliedMemoryRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-receipt-memory-'));
  const stateRoot = suppliedStateRoot || await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-receipt-state-'));
  const eventLog = path.join(stateRoot, 'hermes-events.ndjson');
  const sessionId = 'raw-session-canary-7841';
  const turnId = 'raw-turn-canary-5293';
  const userText = suppliedUserText || 'raw-user-text-canary-3167';
  const taskId = 'raw-task-canary-9024';
  const script = String.raw`
import importlib.util, json, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Ctx(); module.register(ctx)
result = ctx.hooks["pre_llm_call"](
    session_id=${JSON.stringify(sessionId)}, turn_id=${JSON.stringify(turnId)},
    user_message=${JSON.stringify(userText)},
    conversation_history=[{"role": "user", "content": ${JSON.stringify(userText)}${markerMissing ? '' : `, "_db_persisted": ${persisted ? 'True' : 'False'}`}}],
    task_id=${JSON.stringify(taskId)}, platform="cli", cwd=${JSON.stringify(repo)},
)
print(json.dumps(result, sort_keys=True))
`;
  const run = spawnSync('python3', ['-c', script, plugin], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORY_ROOT: memoryRoot,
      IHOW_MEMORY_STATE_ROOT: stateRoot,
      IHOW_MEMORY_HERMES_BRIDGE: bridge,
      IHOW_MEMORY_HERMES_NODE: process.execPath,
      IHOW_MEMORY_HERMES_EVENT_LOG: eventLog,
    },
  });
  return { run, memoryRoot, stateRoot, eventLog, sessionId, turnId, userText, taskId };
}

async function invokePrePostHooks({
  postMarkerMissing = false,
  skipPost = false,
  end = false,
  completed = true,
  interrupted = false,
  endIdentityMismatch = false,
  endTransportFailure = false,
  replay = false,
  conflictingPost = false,
  identicalPostReplay = false,
  completedLiteral = null,
  interruptedLiteral = null,
  latePostAfterEnd = false,
  finalizeAfterPost = false,
  postRole = 'assistant',
  postContentNonString = false,
  postContentOversized = false,
} = {}) {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-receipt-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-receipt-state-'));
  const eventLog = path.join(stateRoot, 'hermes-events.ndjson');
  const sessionId = 'raw-session-post-canary-1842';
  const turnId = 'raw-turn-post-canary-6357';
  const userText = 'raw-user-post-canary-9031';
  const durableTail = 'durable assistant tail canary 4278';
  const conflictingDurableTail = 'conflicting durable assistant tail canary 5519';
  const assistantResponse = 'non-durable assistant response canary 8165';
  const script = String.raw`
import importlib.util, json, os, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Ctx(); module.register(ctx)
def run_pre(): return ctx.hooks["pre_llm_call"](
    session_id=${JSON.stringify(sessionId)}, turn_id=${JSON.stringify(turnId)},
    user_message=${JSON.stringify(userText)},
    conversation_history=[{"role": "user", "content": ${JSON.stringify(userText)}, "_db_persisted": True}],
    platform="cli", cwd=${JSON.stringify(repo)},
)
def run_post(content=${JSON.stringify(durableTail)}): return ctx.hooks["post_llm_call"](
    session_id=${JSON.stringify(sessionId)}, turn_id=${JSON.stringify(turnId)},
    assistant_response=${JSON.stringify(assistantResponse)},
    conversation_history=[
        {"role": "user", "content": ${JSON.stringify(userText)}, "_db_persisted": True},
        {"role": ${JSON.stringify(postRole)}, "content": ${postContentNonString ? '7' : postContentOversized ? JSON.stringify('x'.repeat(2001)) : 'content'}${postMarkerMissing ? '' : ', "_db_persisted": True'}},
    ],
    platform="cli", cwd=${JSON.stringify(repo)},
)
def run_end(): return ctx.hooks["on_session_end"](
    session_id=${JSON.stringify(endIdentityMismatch ? `${sessionId}-mismatch` : sessionId)},
    turn_id=${JSON.stringify(endIdentityMismatch ? `${turnId}-mismatch` : turnId)},
    ${completedLiteral === 'OMIT' ? '' : `completed=${completedLiteral ?? (completed ? 'True' : 'False')},`}
    ${interruptedLiteral === 'OMIT' ? '' : `interrupted=${interruptedLiteral ?? (interrupted ? 'True' : 'False')},`}
    platform="cli", cwd=${JSON.stringify(repo)},
)
def run_finalize(): return ctx.hooks["on_session_finalize"](
    session_id=${JSON.stringify(sessionId)}, turn_id=${JSON.stringify(turnId)},
    completed=True, interrupted=False, checkpointClaims={"claimed": "commit"},
    platform="cli", cwd=${JSON.stringify(repo)},
)
pre = run_pre()
${latePostAfterEnd ? 'run_end()' : ''}
${skipPost ? '' : 'run_post()'}
${identicalPostReplay ? 'run_post()' : ''}
${conflictingPost ? `run_post(${JSON.stringify(conflictingDurableTail)})` : ''}
${finalizeAfterPost ? 'run_finalize()' : ''}
pending_before_end = module._pending_receipts_snapshot()
${endTransportFailure ? 'os.environ["IHOW_MEMORY_HERMES_BRIDGE"] = "/definitely/missing/hermes-bridge.ts"' : ''}
${end || latePostAfterEnd ? 'run_end()' : ''}
${replay ? `
first_committed_at = json.loads((pathlib.Path(os.environ["MEMORY_ROOT"]) / "_mcp" / "turn-receipts" / "v1.json").read_text())["receipts"][0]["committedAt"]
os.environ["IHOW_MEMORY_HERMES_BRIDGE"] = ${JSON.stringify(bridge)}
run_pre(); run_post(); run_end()
` : ''}
print(json.dumps({
    "pre": pre,
    "pendingBeforeEnd": pending_before_end,
    "pending": module._pending_receipts_snapshot(),
    "pendingStats": module._pending_receipts_stats(),
    ${replay ? '"firstCommittedAt": first_committed_at,' : ''}
}, sort_keys=True))
`;
  const run = spawnSync('python3', ['-c', script, plugin], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORY_ROOT: memoryRoot,
      IHOW_MEMORY_STATE_ROOT: stateRoot,
      IHOW_MEMORY_HERMES_BRIDGE: bridge,
      IHOW_MEMORY_HERMES_NODE: process.execPath,
      IHOW_MEMORY_HERMES_EVENT_LOG: eventLog,
    },
  });
  return { run, memoryRoot, stateRoot, eventLog, sessionId, turnId, userText, durableTail, conflictingDurableTail, assistantResponse };
}

async function readReceipts(memoryRoot) {
  const store = JSON.parse(await fs.readFile(path.join(memoryRoot, '_mcp', 'turn-receipts', 'v1.json'), 'utf8'));
  return store.receipts;
}

async function readRegularFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push({ path: entryPath, content: await fs.readFile(entryPath) });
    }
  }
  await visit(root);
  return files;
}

async function readCoreEvents(memoryRoot) {
  const eventsDir = path.join(memoryRoot, '_mcp', '_events');
  const files = await fs.readdir(eventsDir).catch(() => []);
  const rows = [];
  for (const file of files.filter(name => name.endsWith('.ndjson')).sort()) {
    const raw = await fs.readFile(path.join(eventsDir, file), 'utf8');
    for (const line of raw.trim().split('\n')) if (line) rows.push(JSON.parse(line));
  }
  return rows;
}

async function commitDiagnostics(memoryRoot) {
  return (await readCoreEvents(memoryRoot))
    .filter(row => row.type === 'memory.context_probe' && row.metadata?.code === 'commit_not_proven')
    .map(row => row.metadata);
}

test('conflicting PRE invalidates stale pending before failed Core OPEN', async () => {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-receipt-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-receipt-state-'));
  const sessionId = 'raw-conflict-session-canary-7132';
  const turnId = 'raw-conflict-turn-canary-8243';
  const userA = 'raw-conflict-user-A-canary-9354';
  const userB = 'raw-conflict-user-B-canary-1465';
  const finalB = 'raw-conflict-final-B-canary-2576';
  const script = String.raw`
import importlib.util, json, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Ctx(); module.register(ctx)
def pre(text): return ctx.hooks["pre_llm_call"](
    session_id=${JSON.stringify(sessionId)}, turn_id=${JSON.stringify(turnId)}, user_message=text,
    conversation_history=[{"role": "user", "content": text, "_db_persisted": True}], cwd=${JSON.stringify(repo)})
pre(${JSON.stringify(userA)})
pre(${JSON.stringify(userA)})
pre(${JSON.stringify(userB)})
ctx.hooks["post_llm_call"](
    session_id=${JSON.stringify(sessionId)}, turn_id=${JSON.stringify(turnId)},
    conversation_history=[{"role": "assistant", "content": ${JSON.stringify(finalB)}, "_db_persisted": True}], cwd=${JSON.stringify(repo)})
ctx.hooks["on_session_end"](
    session_id=${JSON.stringify(sessionId)}, turn_id=${JSON.stringify(turnId)},
    completed=True, interrupted=False, cwd=${JSON.stringify(repo)})
print(json.dumps({"pending": module._pending_receipts_stats()}, sort_keys=True))
`;
  const run = spawnSync('python3', ['-c', script, plugin], {
    cwd: repo, encoding: 'utf8',
    env: { ...process.env, MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot,
      IHOW_MEMORY_HERMES_BRIDGE: bridge, IHOW_MEMORY_HERMES_NODE: process.execPath },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).pending.count, 0);
  const receipts = await readReceipts(memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal(receipts[0].inputContentSha256, digest('', userA));
  assert.equal('committedAt' in receipts[0], false);
  const diagnostics = (await commitDiagnostics(memoryRoot))
    .filter(item => item.reason === 'input_conflict');
  assert.deepEqual(diagnostics, [{
    code: 'commit_not_proven', reason: 'input_conflict',
    sessionHash: digest('turn-receipt-session-v1\0', sessionId),
    turnId: digest('turn-receipt-turn-v1\0', turnId),
  }]);
  const persisted = await readRegularFiles(memoryRoot);
  for (const canary of [sessionId, turnId, userA, userB, finalB]) {
    for (const file of persisted) {
      assert.equal(file.content.includes(Buffer.from(canary)), false, `raw canary persisted in ${file.path}: ${canary}`);
    }
  }
});

test('persisted current Hermes user tail creates one durable OPEN receipt', async () => {
  const fixture = await invokePreHook();
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.deepEqual(receipts[0], {
    schemaVersion: 1,
    state: 'OPEN',
    runtime: 'hermes',
    projectId: digest('turn-receipt-project-v1\0', repo),
    sessionHash: digest('turn-receipt-session-v1\0', fixture.sessionId),
    turnId: digest('turn-receipt-turn-v1\0', fixture.turnId),
    revision: 1,
    inputSourceHash: `sha256:${digest('turn-receipt-source-v1\0', fixture.turnId)}`,
    inputContentSha256: digest('', fixture.userText),
    openedAt: receipts[0].openedAt,
    deltaState: 'not_emitted',
  });
  assert.match(receipts[0].openedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('same-process POST stages hashes from the durable assistant tail and leaves receipt OPEN', async () => {
  const fixture = await invokePrePostHooks();
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.equal(output.pending.length, 1);
  assert.deepEqual(output.pendingStats, { count: 1, maxCount: 256, ttlSeconds: 3600 });
  assert.equal(output.pending[0].finalContentSha256, digest('', fixture.durableTail));
  assert.notEqual(output.pending[0].finalContentSha256, digest('', fixture.assistantResponse));
  assert.match(output.pending[0].finalSourceHash, /^sha256:[a-f0-9]{64}$/);

  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal('finalSourceHash' in receipts[0], false);
  assert.equal('finalContentSha256' in receipts[0], false);
  assert.equal('committedAt' in receipts[0], false);
});

test('same-process matching successful END commits the durable assistant evidence', async () => {
  const fixture = await invokePrePostHooks({ end: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'COMMITTED');
  assert.equal(receipts[0].finalContentSha256, digest('', fixture.durableTail));
  assert.notEqual(receipts[0].finalContentSha256, digest('', fixture.assistantResponse));
  assert.equal(receipts[0].deltaState, 'not_emitted');
  assert.match(receipts[0].committedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test('conflicting durable POST fails closed and matching END leaves receipt OPEN', async () => {
  const fixture = await invokePrePostHooks({ conflictingPost: true, end: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.equal(output.pendingBeforeEnd.length, 1);
  assert.equal(output.pendingBeforeEnd[0].finalConflict, true);
  assert.equal('finalContentSha256' in output.pendingBeforeEnd[0], false);
  assert.equal('finalSourceHash' in output.pendingBeforeEnd[0], false);
  assert.equal(output.pendingStats.count, 0);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal('finalContentSha256' in receipts[0], false);
  assert.equal('finalSourceHash' in receipts[0], false);
  assert.equal('committedAt' in receipts[0], false);
  assert.deepEqual((await commitDiagnostics(fixture.memoryRoot)).map(item => item.reason), [
    'final_conflict', 'final_conflict',
  ]);
  const exposed = JSON.stringify(output);
  const persistedFiles = [
    ...await readRegularFiles(fixture.memoryRoot),
    ...await readRegularFiles(fixture.stateRoot),
  ];
  for (const canary of [
    fixture.sessionId,
    fixture.turnId,
    fixture.userText,
    fixture.durableTail,
    fixture.conflictingDurableTail,
    fixture.assistantResponse,
  ]) {
    assert.equal(exposed.includes(canary), false, `raw canary exposed: ${canary}`);
    for (const file of persistedFiles) {
      assert.equal(file.content.includes(Buffer.from(canary)), false, `raw canary persisted in ${file.path}: ${canary}`);
    }
  }
});

test('identical durable POST replay remains idempotent and commits', async () => {
  const fixture = await invokePrePostHooks({ identicalPostReplay: true, end: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'COMMITTED');
  assert.equal(receipts[0].finalContentSha256, digest('', fixture.durableTail));
});

for (const [name, options] of [
  ['completed missing', { completedLiteral: 'OMIT' }],
  ['interrupted missing', { interruptedLiteral: 'OMIT' }],
  ["completed='true'", { completedLiteral: "'true'" }],
  ['completed=1', { completedLiteral: '1' }],
  ['interrupted=0', { interruptedLiteral: '0' }],
  ['interrupted=None', { interruptedLiteral: 'None' }],
  ['completed=False interrupted=False', { completedLiteral: 'False', interruptedLiteral: 'False' }],
  ['completed=True interrupted=True', { completedLiteral: 'True', interruptedLiteral: 'True' }],
]) {
  test(`strict booleans reject ${name}, leave OPEN, and clear matching pending`, async () => {
    const fixture = await invokePrePostHooks({ ...options, end: true });
    assert.equal(fixture.run.status, 0, fixture.run.stderr);
    const output = JSON.parse(fixture.run.stdout);
    const receipts = await readReceipts(fixture.memoryRoot);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'OPEN');
    assert.equal('committedAt' in receipts[0], false);
    assert.equal(output.pendingStats.count, 0);
    assert.equal((await commitDiagnostics(fixture.memoryRoot)).at(-1).reason, 'end_not_successful');
  });
}

test('successful END consumes pending so late POST and later END cannot revive commit', async () => {
  const fixture = await invokePrePostHooks({ latePostAfterEnd: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.deepEqual(output.pendingBeforeEnd, []);
  assert.equal(output.pendingStats.count, 0);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
});

test('session finalize claims never commit without END', async () => {
  const fixture = await invokePrePostHooks({ finalizeAfterPost: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.equal(output.pendingStats.count, 1);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
});

for (const [name, options] of [
  ['non-assistant', { postRole: 'tool' }],
  ['non-string content', { postContentNonString: true }],
  ['oversized content', { postContentOversized: true }],
]) {
  test(`POST ${name} tail followed by END stays OPEN and clears pending`, async () => {
    const fixture = await invokePrePostHooks({ ...options, end: true });
    assert.equal(fixture.run.status, 0, fixture.run.stderr);
    const output = JSON.parse(fixture.run.stdout);
    assert.equal(output.pendingStats.count, 0);
    const receipts = await readReceipts(fixture.memoryRoot);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'OPEN');
    assert.equal((await commitDiagnostics(fixture.memoryRoot))[0].reason, 'final_evidence_invalid');
  });
}

for (const [name, options] of [
  ['missing POST', { skipPost: true }],
  ['assistant durable marker missing', { postMarkerMissing: true }],
  ['identity mismatch', { endIdentityMismatch: true }],
  ['transport failure', { endTransportFailure: true }],
]) {
  test(`${name} END leaves the durable receipt OPEN and clears no false commit state`, async () => {
    const fixture = await invokePrePostHooks({ ...options, end: true });
    assert.equal(fixture.run.status, 0, fixture.run.stderr);
    const output = JSON.parse(fixture.run.stdout);
    const receipts = await readReceipts(fixture.memoryRoot);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'OPEN');
    assert.equal('committedAt' in receipts[0], false);
    if (!options.endIdentityMismatch) assert.equal(output.pendingStats.count, 0);
    if (options.postMarkerMissing) {
      assert.equal((await commitDiagnostics(fixture.memoryRoot))[0].reason, 'durable_marker_missing');
    }
    if (options.endIdentityMismatch) {
      assert.equal((await commitDiagnostics(fixture.memoryRoot)).at(-1).reason, 'pending_not_found');
    }
  });
}

test('replayed PRE POST END converges to one canonical COMMITTED receipt', async () => {
  const fixture = await invokePrePostHooks({ end: true, replay: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'COMMITTED');
  assert.equal(receipts[0].finalContentSha256, digest('', fixture.durableTail));
  assert.equal(receipts[0].committedAt, output.firstCommittedAt);
});

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
      env: { ...process.env, MEMORY_ROOT: path.join(os.tmpdir(), 'unused-hermes-parser-root') },
    });
    assert.notEqual(run.status, 0);
    assert.equal(JSON.parse(run.stdout).ok, false);
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
      cwd: repo, encoding: 'utf8',
      input: `${JSON.stringify({ schemaVersion: 1, event: 'runtime.after_turn', runtime: 'hermes',
        cwd: repo, observedAt: '2026-07-17T12:00:03.000Z', diagnostic })}\n`,
      env: { ...process.env, MEMORY_ROOT: path.join(os.tmpdir(), `unused-${crypto.randomUUID()}`) },
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
  const run = spawnSync('python3', ['-c', script, plugin], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stderr, /ihow_memory_hermes_hook_failed_open/);
  assert.doesNotMatch(run.stderr, /Traceback|RuntimeError|raw-log-session|raw-log-content|raw\/log\/path/);
});

test('COMMIT transport failure emits bounded fallback diagnostic and diagnostic failure stays fail-open', () => {
  const rawSession = 'raw-transport-session-canary-7145';
  const rawTurn = 'raw-transport-turn-canary-8256';
  const script = String.raw`
import importlib.util, json, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
action = module._open_receipt_action({
 "session_id": ${JSON.stringify(rawSession)}, "turn_id": ${JSON.stringify(rawTurn)},
 "user_message": "bounded input", "conversation_history": [
   {"role": "user", "content": "bounded input", "_db_persisted": True}
 ]
})
module._retain_open_receipt(action["receipt"])
module._stage_final_receipt({
 "session_id": ${JSON.stringify(rawSession)}, "turn_id": ${JSON.stringify(rawTurn)},
 "conversation_history": [{"role": "assistant", "content": "bounded final", "_db_persisted": True}]
})
calls = []
def dispatch(event):
    calls.append(event)
    if len(calls) == 1: raise RuntimeError("raw exception content and /raw/path")
    return {"ok": True}
module._dispatch = dispatch
module._on_session_end(session_id=${JSON.stringify(rawSession)}, turn_id=${JSON.stringify(rawTurn)}, completed=True, interrupted=False)
print(json.dumps(calls, sort_keys=True))
`;
  const run = spawnSync('python3', ['-c', script, plugin], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const calls = JSON.parse(run.stdout);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].turnReceipt.action, 'commit');
  assert.deepEqual(calls[1].diagnostic, {
    code: 'commit_not_proven', reason: 'transport_failure',
    sessionHash: digest('turn-receipt-session-v1\0', rawSession),
    turnId: digest('turn-receipt-turn-v1\0', rawTurn),
  });
  assert.doesNotMatch(JSON.stringify(calls[1]), /raw-transport|raw exception|raw\/path/);
});

test('POST transport failure preserves staged final and emits bounded fallback diagnostic', () => {
  const rawSession = 'raw-post-transport-session-canary-3412';
  const rawTurn = 'raw-post-transport-turn-canary-4523';
  const rawFinal = 'raw-post-transport-final-canary-5634';
  const rawPath = '/raw/post/transport/path/canary-6745';
  const script = String.raw`
import importlib.util, json, logging, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
logging.basicConfig(level=logging.DEBUG)
action = module._open_receipt_action({
 "session_id": ${JSON.stringify(rawSession)}, "turn_id": ${JSON.stringify(rawTurn)},
 "user_message": "bounded input", "conversation_history": [
   {"role": "user", "content": "bounded input", "_db_persisted": True}
 ]
})
module._retain_open_receipt(action["receipt"])
calls = []
def dispatch(event):
    calls.append(event)
    if len(calls) == 1: raise RuntimeError(${JSON.stringify(`raw exception canary ${rawPath}`)})
    if len(calls) == 3: raise RuntimeError("fallback raw exception")
    return {"ok": True}
module._dispatch = dispatch
kwargs = {
 "session_id": ${JSON.stringify(rawSession)}, "turn_id": ${JSON.stringify(rawTurn)},
 "conversation_history": [{"role": "assistant", "content": ${JSON.stringify(rawFinal)}, "_db_persisted": True}]
}
module._on_post_llm_call(**kwargs)
first_pending = module._pending_receipts_snapshot()
module._on_post_llm_call(**kwargs)
print(json.dumps({"calls": calls, "firstPending": first_pending,
                  "finalPending": module._pending_receipts_snapshot()}, sort_keys=True))
`;
  const run = spawnSync('python3', ['-c', script, plugin], { cwd: repo, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout);
  assert.equal(output.calls.length, 4);
  assert.deepEqual(output.calls[1].diagnostic, {
    code: 'commit_not_proven', reason: 'transport_failure',
    sessionHash: digest('turn-receipt-session-v1\0', rawSession),
    turnId: digest('turn-receipt-turn-v1\0', rawTurn),
  });
  assert.equal('turnReceipt' in output.calls[1], false);
  assert.deepEqual(output.calls[3].diagnostic, output.calls[1].diagnostic);
  assert.equal(output.firstPending.length, 1);
  assert.equal(output.firstPending[0].finalContentSha256, digest('', rawFinal));
  assert.deepEqual(output.finalPending, output.firstPending);
  assert.match(run.stderr, /ihow_memory_hermes_hook_failed_open/);
  assert.doesNotMatch(
    `${JSON.stringify(output.calls[1])}\n${run.stderr}`,
    /raw-post-transport|raw exception|raw\/post\/transport|fallback raw exception/,
  );
});

test('POST assistant tail without the durable marker stages no final hashes', async () => {
  const fixture = await invokePrePostHooks({ postMarkerMissing: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.deepEqual(output.pending, []);
  assert.deepEqual(output.pendingStats, { count: 1, maxCount: 256, ttlSeconds: 3600 });
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
});

test('Hermes user tail without the durable marker creates no receipt', async () => {
  const fixture = await invokePreHook({ markerMissing: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  await assert.rejects(
    fs.access(path.join(fixture.memoryRoot, '_mcp', 'turn-receipts', 'v1.json')),
    { code: 'ENOENT' },
  );
});

test('Hermes user tail with a false durable marker creates no receipt', async () => {
  const fixture = await invokePreHook({ persisted: false });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  await assert.rejects(
    fs.access(path.join(fixture.memoryRoot, '_mcp', 'turn-receipts', 'v1.json')),
    { code: 'ENOENT' },
  );
});

test('Hermes user text above the 2,000 UTF-8 byte ceiling creates no receipt', async () => {
  const fixture = await invokePreHook({ userText: '😀'.repeat(501) });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  await assert.rejects(
    fs.access(path.join(fixture.memoryRoot, '_mcp', 'turn-receipts', 'v1.json')),
    { code: 'ENOENT' },
  );
});

test('Hermes pre hook fails open for an unpaired-surrogate user value', async () => {
  const fixture = await invokePreHook({ userText: '\ud800' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  assert.equal(fixture.run.stdout.trim(), 'null');
  await assert.rejects(
    fs.access(path.join(fixture.memoryRoot, '_mcp', 'turn-receipts', 'v1.json')),
    { code: 'ENOENT' },
  );
});

test('Hermes project root is bounded, validated, and cached once per process', () => {
  const script = String.raw`
import importlib.util, json, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
repo = sys.argv[2]
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
calls = 0
class Completed:
    returncode = 0
    stdout = repo + "\n"
def fake_run(*args, **kwargs):
    global calls
    calls += 1
    return Completed()
module.subprocess.run = fake_run
module._project_root.cache_clear()
kwargs = {
    "session_id": "session", "turn_id": "turn", "user_message": "hello",
    "conversation_history": [{"role": "user", "content": "hello", "_db_persisted": True}],
}
first = module._open_receipt_action(kwargs)["receipt"]["projectId"]
second = module._open_receipt_action(kwargs)["receipt"]["projectId"]
print(json.dumps({
    "calls": calls,
    "sameProjectId": first == second,
    "rejectsControl": not module._valid_project_root_candidate("bad\nroot"),
    "rejectsOverlong": not module._valid_project_root_candidate("x" * 4097),
}))
`;
  const run = spawnSync('python3', ['-c', script, plugin, repo], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), {
    calls: 1,
    sameProjectId: true,
    rejectsControl: true,
    rejectsOverlong: true,
  });
});

test('Hermes user text at the 2,000 UTF-8 byte ceiling creates OPEN with exact content hash', async () => {
  const userText = '😀'.repeat(500);
  const fixture = await invokePreHook({ userText });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal(receipts[0].inputContentSha256, digest('', userText));
});

test('replaying the same Hermes pre hook is idempotent', async () => {
  const first = await invokePreHook();
  assert.equal(first.run.status, 0, first.run.stderr);
  const replay = await invokePreHook({ memoryRoot: first.memoryRoot, stateRoot: first.stateRoot });
  assert.equal(replay.run.status, 0, replay.run.stderr);
  const receipts = await readReceipts(first.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
});

test('memory and state roots contain no raw identity or content canaries in any regular file', async () => {
  const fixture = await invokePrePostHooks({ end: true });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const persistedFiles = [
    ...await readRegularFiles(fixture.memoryRoot),
    ...await readRegularFiles(fixture.stateRoot),
  ];
  for (const canary of [
    fixture.sessionId,
    fixture.turnId,
    fixture.userText,
    fixture.durableTail,
    fixture.assistantResponse,
    repo,
  ]) {
    const encoded = Buffer.from(canary);
    for (const file of persistedFiles) {
      assert.equal(file.content.includes(encoded), false, `raw canary persisted in ${file.path}: ${canary}`);
    }
  }
  const receiptAndEventLog = [
    await fs.readFile(path.join(fixture.memoryRoot, '_mcp', 'turn-receipts', 'v1.json'), 'utf8'),
    await fs.readFile(fixture.eventLog, 'utf8'),
  ].join('\n');
  assert.doesNotMatch(receiptAndEventLog, /turnReceipt|checkpointClaims|"prompt"/);
});
