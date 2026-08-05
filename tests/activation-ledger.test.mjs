// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  activationLedgerPath,
  appendActivationEvidence,
  readActivationEvidence,
} from '../src/activation-ledger.ts';
import { deriveRuntimeActivation } from '../src/automation-doctor.ts';
import { contextProbe } from '../src/context-probe.ts';
import { resolveWorkspace } from '../src/workspace.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const READY = 'READY — WAITING FOR FIRST ACTIVITY';

async function fixture(t, slug, space = 't') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `ihow-activation-${slug}-`));
  const workspace = resolveWorkspace({ root, space });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, workspace };
}

async function evidence(workspace, runtime, status, observedAt, dedupeKey, extra = {}) {
  const eventByStatus = {
    configured: 'runtime-configured',
    synthetic: 'synthetic-check',
    'observed-live-started': 'hook-session-start',
    'observed-live-completed': 'hook-session-start',
    failed: 'hook-session-start',
  };
  return appendActivationEvidence(workspace, {
    runtime,
    event: eventByStatus[status],
    source: status === 'configured' ? 'setup' : status === 'synthetic' ? 'synthetic-proof' : 'native-hook',
    status,
    observedAt,
    dedupeKey,
    ...extra,
  });
}

test('configured wiring without live activity is READY with a stable reason code', async (t) => {
  const { workspace } = await fixture(t, 'configured');
  await evidence(workspace, 'claude-code', 'configured', '2026-07-11T20:00:00.000Z', 'install-1');
  const state = deriveRuntimeActivation('claude-code', await readActivationEvidence(workspace), { now: Date.parse('2026-07-11T21:00:00Z') });
  assert.equal(state.status, READY);
  assert.equal(state.reasonCode, 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY');
});

test('started-only evidence never upgrades a runtime to ACTIVE', async (t) => {
  const { workspace } = await fixture(t, 'started');
  await evidence(workspace, 'codex', 'configured', '2026-07-11T20:00:00.000Z', 'install-1');
  await evidence(workspace, 'codex', 'observed-live-started', '2026-07-11T20:01:00.000Z', 'event-1');
  const state = deriveRuntimeActivation('codex', await readActivationEvidence(workspace), { now: Date.parse('2026-07-11T21:00:00Z') });
  assert.equal(state.status, READY);
  assert.equal(state.reasonCode, 'ACTIVATION_STARTED_ONLY');
});

test('only a live completion strictly after installation upgrades to ACTIVE', async (t) => {
  const { workspace } = await fixture(t, 'completed-after');
  await evidence(workspace, 'claude-code', 'configured', '2026-07-11T20:00:00.000Z', 'install-1');
  await evidence(workspace, 'claude-code', 'observed-live-completed', '2026-07-11T20:00:01.000Z', 'event-1');
  const state = deriveRuntimeActivation('claude-code', await readActivationEvidence(workspace), { now: Date.parse('2026-07-11T21:00:00Z') });
  assert.equal(state.status, 'ACTIVE');
  assert.equal(state.reasonCode, 'ACTIVATION_LIVE_COMPLETED_AFTER_INSTALL');
});

test('a completion before installation does not upgrade to ACTIVE', async (t) => {
  const { workspace } = await fixture(t, 'completed-before');
  await evidence(workspace, 'claude-code', 'observed-live-completed', '2026-07-11T19:59:59.000Z', 'event-1');
  await evidence(workspace, 'claude-code', 'configured', '2026-07-11T20:00:00.000Z', 'install-1');
  const state = deriveRuntimeActivation('claude-code', await readActivationEvidence(workspace), { now: Date.parse('2026-07-11T21:00:00Z') });
  assert.equal(state.status, READY);
  assert.equal(state.reasonCode, 'ACTIVATION_COMPLETED_BEFORE_INSTALL');
});

test('Hermes stays TOOLS ONLY without a verifiable native lifecycle, even after failure evidence', async (t) => {
  const { workspace } = await fixture(t, 'failure');
  await evidence(workspace, 'hermes', 'configured', '2026-07-11T20:00:00.000Z', 'install-1');
  await evidence(workspace, 'hermes', 'failed', '2026-07-11T20:30:00.000Z', 'event-1');
  const state = deriveRuntimeActivation('hermes', await readActivationEvidence(workspace), { now: Date.parse('2026-07-11T21:00:00Z') });
  assert.equal(state.status, 'TOOLS ONLY');
  assert.equal(state.reasonCode, 'ACTIVATION_NO_VERIFIED_LIFECYCLE_TOOLS_ONLY');
});

test('no-hook runtimes stay TOOLS ONLY even after a completed context probe', async (t) => {
  const { workspace } = await fixture(t, 'no-hook');
  await evidence(workspace, 'workbuddy', 'configured', '2026-07-11T20:00:00.000Z', 'install-1');
  await appendActivationEvidence(workspace, {
    runtime: 'workbuddy',
    event: 'context-probe-session-start',
    source: 'context-probe',
    status: 'observed-live-completed',
    observedAt: '2026-07-11T20:01:00.000Z',
    dedupeKey: 'probe-1',
  });
  const state = deriveRuntimeActivation('no-hook', await readActivationEvidence(workspace), { now: Date.parse('2026-07-11T21:00:00Z') });
  assert.equal(state.status, 'TOOLS ONLY');
  assert.equal(state.reasonCode, 'ACTIVATION_NO_HOOK_TOOLS_ONLY');
});

test('OpenClaw synthetic evidence remains TOOLS ONLY without a verifiable native lifecycle', async (t) => {
  const { workspace } = await fixture(t, 'synthetic');
  await evidence(workspace, 'openclaw', 'configured', '2026-07-11T20:00:00.000Z', 'install-1');
  await evidence(workspace, 'openclaw', 'synthetic', '2026-07-11T20:01:00.000Z', 'synthetic-1');
  const state = deriveRuntimeActivation('openclaw', await readActivationEvidence(workspace), { now: Date.parse('2026-07-11T21:00:00Z') });
  assert.equal(state.status, 'TOOLS ONLY');
  assert.equal(state.reasonCode, 'ACTIVATION_NO_VERIFIED_LIFECYCLE_TOOLS_ONLY');
});

test('ledger stores metadata-only evidence, hashes secret-like dedupe material, and deduplicates repeats', async (t) => {
  const { workspace } = await fixture(t, 'privacy-dedupe', 'private-space-9f3e');
  const secret = 'sk-live-super-secret-123456789';
  const first = await appendActivationEvidence(workspace, {
    runtime: 'claude-code',
    event: 'hook-stop',
    source: 'native-hook',
    status: 'observed-live-completed',
    observedAt: '2026-07-11T20:01:00.000Z',
    dedupeKey: `session:${secret}`,
    transcript: `user said ${secret}`,
    payload: { authorization: `Bearer ${secret}` },
  });
  const second = await appendActivationEvidence(workspace, {
    runtime: 'claude-code',
    event: 'hook-stop',
    source: 'native-hook',
    status: 'observed-live-completed',
    observedAt: '2026-07-11T20:02:00.000Z',
    dedupeKey: `session:${secret}`,
  });
  assert.equal(first.appended, true);
  assert.equal(second.appended, false);
  const raw = await fs.readFile(activationLedgerPath(workspace), 'utf8');
  assert.equal(raw.trim().split('\n').length, 1, 'duplicate event appends no second audit row');
  assert.ok(!raw.includes(secret));
  assert.ok(!raw.includes(workspace.root));
  assert.ok(!raw.includes(workspace.space));
  assert.ok(!raw.includes('transcript'));
  assert.ok(!raw.includes('authorization'));
  const row = JSON.parse(raw);
  for (const key of ['runtime', 'event', 'source', 'status', 'observedAt', 'workspaceBinding', 'dedupe']) assert.ok(key in row, `row includes ${key}`);
});

test('doctor JSON exposes verified-wiring activation status and stable reason code', async (t) => {
  const { root } = await fixture(t, 'doctor-json');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-doctor-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-doctor-cwd-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const env = { ...process.env, HOME: home, IHOW_CAPTURE_FLOOR: '0' };
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], {
    encoding: 'utf8',
    env,
  });
  const out = execFileSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], {
    encoding: 'utf8',
    env,
  });
  const doctor = JSON.parse(out);
  const claude = doctor.automationMatrix.find((row) => row.runtime === 'Claude Code');
  assert.equal(claude.activationStatus, READY);
  assert.equal(claude.activationReasonCode, 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY');
  assert.equal(doctor.automationMetrics.activationEvidenceCount, 1);
});

test('only the currently wired frozen CLI records generation-bound native hook completion', async (t) => {
  const { root, workspace } = await fixture(t, 'native-hook');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-native-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-native-cwd-'));
  const transcript = path.join(root, 'transcript.jsonl');
  await fs.writeFile(transcript, ['a', 'b', 'c', 'd', 'e'].join('\n'), 'utf8');
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home };
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const runtimeCli = path.join(root, 't', '.runtime', 'cli.js');
  const result = spawnSync(process.execPath, [
    runtimeCli, 'hook-stop', '--hook-owner', 'ihow-memory-v1', '--runtime', 'claude-code',
    '--root', root, '--space', 't', '--cwd', cwd,
  ], {
    encoding: 'utf8', env,
    input: JSON.stringify({ session_id: 's1', hook_event_name: 'Stop', cwd, transcript_path: transcript }),
  });
  assert.equal(result.status, 0);
  const rows = await readActivationEvidence(workspace);
  const configured = rows.find((row) => row.status === 'configured');
  const completed = rows.find((row) => row.event === 'hook-stop' && row.status === 'observed-live-completed');
  assert.ok(rows.some((row) => row.event === 'hook-stop' && row.status === 'observed-live-started'));
  assert.ok(completed?.configuration?.id);
  assert.equal(completed.configuration.id, configured.configuration.id, 'live evidence is bound to the verified wiring generation');
  assert.equal(deriveRuntimeActivation('claude-code', rows).status, 'ACTIVE');
});

test('manual source-CLI invocation and recursion-guard payload cannot forge ACTIVE', async (t) => {
  const { root, workspace } = await fixture(t, 'manual-forgery');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-forgery-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-forgery-cwd-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home };
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const forged = spawnSync(process.execPath, [CLI, 'hook-stop', '--root', root, '--space', 't', '--cwd', cwd], {
    encoding: 'utf8', env,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'manually-forged', stop_hook_active: true }),
  });
  assert.equal(forged.status, 0);
  const forgedOwner = spawnSync(process.execPath, [
    CLI, 'hook-session-start', '--hook-owner', 'ihow-memory-v1', '--runtime', 'claude-code',
    '--root', root, '--space', 't', '--cwd', cwd,
  ], {
    encoding: 'utf8', env,
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'manual-source-owner', cwd, source: 'startup' }),
  });
  assert.equal(forgedOwner.status, 0);
  const rows = await readActivationEvidence(workspace);
  assert.ok(!rows.some((row) => row.status === 'observed-live-started' || row.status === 'observed-live-completed'));
});

test('invalid context-probe input is not runtime failure evidence', async (t) => {
  const { workspace } = await fixture(t, 'probe-invalid');
  await assert.rejects(() => contextProbe(workspace, {
    cwd: '', runtime: 'hermes', eventHint: 'prompt', promptDigest: 'caller-error',
  }));
  assert.deepEqual(await readActivationEvidence(workspace), []);
});

test('a well-formed context-probe execution failure records metadata-only failed evidence', async (t) => {
  const { workspace } = await fixture(t, 'probe-failed');
  const secret = 'probe-secret-never-persist';
  await assert.rejects(() => contextProbe(workspace, {
    cwd: workspace.root,
    runtime: 'hermes',
    eventHint: 'prompt',
    promptDigest: secret,
  }, {
    search: async () => { throw new Error('provider_down'); },
  }));
  const rows = await readActivationEvidence(workspace);
  assert.ok(rows.some((row) => row.runtime === 'hermes' && row.event === 'context-probe-prompt' && row.status === 'failed'));
  assert.ok(!(await fs.readFile(activationLedgerPath(workspace), 'utf8')).includes(secret));
});

test('ledger write failure is fail-open and never blocks the host hook', async (t) => {
  const { root, workspace } = await fixture(t, 'fail-open');
  await fs.mkdir(activationLedgerPath(workspace), { recursive: true }); // appendFile must fail with EISDIR
  const result = spawnSync(process.execPath, [CLI, 'hook-stop', '--root', root, '--space', 't'], {
    encoding: 'utf8',
    input: JSON.stringify({ stop_hook_active: true, session_id: 's1', hook_event_name: 'Stop' }),
  });
  assert.equal(result.status, 0, 'activation evidence failure must not fail the host hook');
  assert.equal(result.stderr, '');
});

test('a torn final ledger row does not swallow the next valid activation event', async (t) => {
  const { workspace } = await fixture(t, 'torn-row');
  await fs.mkdir(path.dirname(activationLedgerPath(workspace)), { recursive: true });
  await fs.writeFile(activationLedgerPath(workspace), '{"schemaVersion":1,"torn"', 'utf8');
  await appendActivationEvidence(workspace, {
    runtime: 'claude-code', event: 'hook-stop', source: 'native-hook', status: 'observed-live-completed',
    observedAt: '2026-07-11T20:00:00Z', dedupeKey: 'after-crash',
  });
  const rows = await readActivationEvidence(workspace);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dedupe.algorithm, 'sha256');
  assert.match(await fs.readFile(activationLedgerPath(workspace), 'utf8'), /"torn"\n\{"schemaVersion":1/);
});

test('the same verified wiring generation deduplicates across setup/connect/install-hook sources', async (t) => {
  const { workspace } = await fixture(t, 'configured-generation');
  const first = await appendActivationEvidence(workspace, {
    runtime: 'claude-code', event: 'runtime-configured', source: 'setup', status: 'configured',
    observedAt: '2026-07-11T20:00:00Z', dedupeKey: 'generation-a', configurationKey: 'generation-a',
  });
  const rerun = await appendActivationEvidence(workspace, {
    runtime: 'claude-code', event: 'runtime-configured', source: 'connect', status: 'configured',
    observedAt: '2026-07-11T21:00:00Z', dedupeKey: 'generation-a', configurationKey: 'generation-a',
  });
  const repair = await appendActivationEvidence(workspace, {
    runtime: 'claude-code', event: 'runtime-configured', source: 'install-hook', status: 'configured',
    observedAt: '2026-07-11T22:00:00Z', dedupeKey: 'generation-b', configurationKey: 'generation-b',
  });
  assert.equal(first.appended, true);
  assert.equal(rerun.appended, false, 'unchanged generation does not move configuredAt through another front door');
  assert.equal(repair.appended, true, 'a repaired generation creates a new installation epoch');
  assert.deepEqual((await readActivationEvidence(workspace)).map((row) => row.observedAt), [
    '2026-07-11T20:00:00.000Z', '2026-07-11T22:00:00.000Z',
  ]);
});

test('empty hook payload records no live evidence and explicit synthetic dispatch records synthetic only', async (t) => {
  const { root, workspace } = await fixture(t, 'invalid-synthetic');
  const empty = spawnSync(process.execPath, [CLI, 'hook-stop', '--root', root, '--space', 't'], {
    encoding: 'utf8', input: '{}',
  });
  assert.equal(empty.status, 0);
  assert.deepEqual(await readActivationEvidence(workspace), [], 'empty/manual payload is not live host activity');

  const synthetic = spawnSync(process.execPath, [CLI, 'hook-stop', '--root', root, '--space', 't', '--synthetic'], {
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'synthetic-1', stop_hook_active: true }),
  });
  assert.equal(synthetic.status, 0);
  const rows = await readActivationEvidence(workspace);
  assert.deepEqual(rows.map((row) => row.status), ['synthetic']);
  assert.ok(!rows.some((row) => row.status === 'observed-live-completed'));
});

test('setup --no-install-hook remains TOOLS ONLY and creates no configured automation evidence', async (t) => {
  const { root } = await fixture(t, 'setup-no-hook');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-nohook-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-nohook-cwd-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin', IHOW_CAPTURE_FLOOR: '0' };
  execFileSync(process.execPath, [CLI, 'setup', '--runtime', 'claude-code', '--root', root, '--space', 't', '--cwd', cwd, '--no-install-hook', '--json'], { encoding: 'utf8', env });
  const doctor = JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env }));
  const claude = doctor.automationMatrix.find((row) => row.runtime === 'Claude Code');
  assert.equal(claude.activationStatus, 'TOOLS ONLY');
  assert.equal(claude.activationReasonCode, 'ACTIVATION_NOT_ENABLED_TOOLS_ONLY');
  assert.equal(doctor.automationMetrics.activationEvidenceCount, 0);
});

test('deleting live Claude hooks degrades ACTIVE to NEEDS REPAIR and fails doctor', async (t) => {
  const { root } = await fixture(t, 'claude-deleted');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-delete-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-delete-cwd-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, PATH: '/usr/bin:/bin', IHOW_CAPTURE_FLOOR: '0' };
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const runtimeCli = path.join(root, 't', '.runtime', 'cli.js');
  const transcript = path.join(root, 'delete-transcript.jsonl');
  await fs.writeFile(transcript, ['a', 'b', 'c', 'd', 'e'].join('\n'), 'utf8');
  const live = spawnSync(process.execPath, [
    runtimeCli, 'hook-stop', '--hook-owner', 'ihow-memory-v1', '--runtime', 'claude-code',
    '--root', root, '--space', 't', '--cwd', cwd,
  ], {
    encoding: 'utf8', env,
    input: JSON.stringify({ hook_event_name: 'Stop', session_id: 'live-1', cwd, transcript_path: transcript }),
  });
  assert.equal(live.status, 0);
  const before = JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env }));
  assert.equal(before.automationMatrix.find((row) => row.runtime === 'Claude Code').activationStatus, 'ACTIVE');

  await fs.rm(path.join(cwd, '.claude', 'settings.local.json'));
  const afterRun = spawnSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env });
  assert.equal(afterRun.status, 1);
  const after = JSON.parse(afterRun.stdout);
  const claude = after.automationMatrix.find((row) => row.runtime === 'Claude Code');
  assert.equal(claude.activationStatus, 'NEEDS REPAIR');
  assert.equal(claude.activationReasonCode, 'ACTIVATION_WIRING_BROKEN');
  assert.equal(claude.status, 'BROKEN');
});

test('wrong Codex workspace binding becomes NEEDS REPAIR and fails doctor', async (t) => {
  const { root } = await fixture(t, 'codex-wrong-binding');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-codex-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-codex-cwd-'));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, IHOW_CAPTURE_FLOOR: '0' };
  execFileSync(process.execPath, [CLI, 'install-hook', '--runtime', 'codex', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const configPath = path.join(codexHome, 'hooks.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  for (const groups of Object.values(config.hooks || {})) {
    for (const group of groups) for (const hook of group.hooks || []) hook.command = hook.command.replace(root, `${root}-wrong`);
  }
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const run = spawnSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env });
  assert.equal(run.status, 1);
  const doctor = JSON.parse(run.stdout);
  const codex = doctor.automationMatrix.find((row) => row.runtime === 'Codex');
  assert.equal(codex.activationStatus, 'NEEDS REPAIR');
  assert.equal(codex.activationReasonCode, 'ACTIVATION_WIRING_BROKEN');
  assert.equal(codex.status, 'BROKEN');
});

test('activation ledger lock contention fails open within a bounded hook budget', async (t) => {
  const { root, workspace } = await fixture(t, 'lock-budget');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-lock-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-lock-cwd-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home };
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const before = await readActivationEvidence(workspace);
  const lock = `${activationLedgerPath(workspace)}.lock`;
  await fs.writeFile(lock, `${process.pid}\n${new Date().toISOString()}\n`, 'utf8');
  const started = Date.now();
  const run = spawnSync(process.execPath, [
    path.join(root, 't', '.runtime', 'cli.js'), 'hook-session-start',
    '--hook-owner', 'ihow-memory-v1', '--runtime', 'claude-code', '--root', root, '--space', 't', '--cwd', cwd,
  ], {
    encoding: 'utf8', env,
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'lock-1', cwd, source: 'startup' }),
  });
  const elapsed = Date.now() - started;
  assert.equal(run.status, 0);
  assert.ok(elapsed < 1_000, `hook must fail open quickly under ledger lock contention (elapsed=${elapsed}ms)`);
  assert.deepEqual(await readActivationEvidence(workspace), before, 'busy activation lock adds no partial live evidence');
});

test('duplicate current Claude hooks across local and user scopes are NEEDS REPAIR, not ACTIVE', async (t) => {
  const { root } = await fixture(t, 'claude-duplicate-scopes');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-dup-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-dup-cwd-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, IHOW_CAPTURE_FLOOR: '0' };
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd, '--global-hook'], { encoding: 'utf8', env });
  const run = spawnSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--global-hook', '--json'], { encoding: 'utf8', env });
  assert.equal(run.status, 1);
  const claude = JSON.parse(run.stdout).automationMatrix.find((row) => row.runtime === 'Claude Code');
  assert.equal(claude.activationStatus, 'NEEDS REPAIR');
  assert.match(claude.notes, /duplicated across Claude user and project\/local scopes/);
});

test('same-binding iHow-shaped hooks with a wrong owner are conflicts, not third-party entries', async (t) => {
  const { root } = await fixture(t, 'wrong-owner');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-owner-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-owner-cwd-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, IHOW_CAPTURE_FLOOR: '0' };
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const configPath = path.join(cwd, '.claude', 'settings.local.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  for (const groups of Object.values(config.hooks || {})) {
    for (const group of groups) {
      const duplicate = (group.hooks || []).map((hook) => ({
        ...hook,
        command: hook.command.replace('--hook-owner ihow-memory-v1', '--hook-owner attacker-v2'),
      }));
      group.hooks.push(...duplicate);
    }
  }
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const run = spawnSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env });
  assert.equal(run.status, 1);
  const claude = JSON.parse(run.stdout).automationMatrix.find((row) => row.runtime === 'Claude Code');
  assert.equal(claude.activationStatus, 'NEEDS REPAIR');
  assert.equal(claude.activationReasonCode, 'ACTIVATION_WIRING_BROKEN');
});

test('touching unchanged hook config does not create a new wiring generation or move configuredAt', async (t) => {
  const { root, workspace } = await fixture(t, 'touch-stable');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-touch-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-touch-cwd-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, IHOW_CAPTURE_FLOOR: '0' };
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const configPath = path.join(cwd, '.claude', 'settings.local.json');
  const beforeBytes = await fs.readFile(configPath);
  const beforeRows = await readActivationEvidence(workspace);
  const configuredAt = beforeRows.find((row) => row.status === 'configured').observedAt;
  const future = new Date(Date.now() + 10_000);
  await fs.utimes(configPath, future, future);
  assert.deepEqual(await fs.readFile(configPath), beforeBytes);
  let doctor = JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env }));
  assert.equal(doctor.automationMatrix.find((row) => row.runtime === 'Claude Code').activationReasonCode, 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY');

  const externalEdit = JSON.parse(await fs.readFile(configPath, 'utf8'));
  externalEdit.vendorSetting = { enabled: true };
  externalEdit.hooks.Stop.push({ hooks: [{ type: 'command', command: "'/usr/bin/true'", timeout: 5 }] });
  const atomicTemp = `${configPath}.vendor-tmp`;
  await fs.writeFile(atomicTemp, `${JSON.stringify(externalEdit, null, 2)}\n`, 'utf8');
  await fs.rename(atomicTemp, configPath);
  doctor = JSON.parse(execFileSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env }));
  assert.equal(doctor.automationMatrix.find((row) => row.runtime === 'Claude Code').activationReasonCode, 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY', 'unrelated third-party bytes and atomic rename keep the managed epoch stable');
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const afterRows = await readActivationEvidence(workspace);
  assert.equal(afterRows.filter((row) => row.status === 'configured').length, 1);
  assert.equal(afterRows.find((row) => row.status === 'configured').observedAt, configuredAt);

  const damaged = JSON.parse(await fs.readFile(configPath, 'utf8'));
  damaged.hooks.Stop[0].hooks[0].timeout = 31;
  await fs.writeFile(configPath, `${JSON.stringify(damaged, null, 2)}\n`, 'utf8');
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const repairedRows = (await readActivationEvidence(workspace)).filter((row) => row.status === 'configured');
  assert.equal(repairedRows.length, 2, 'a real managed-hook repair creates a new installation epoch');
  assert.notEqual(repairedRows[0].configuration.id, repairedRows[1].configuration.id);
});

test('tampered non-empty managed generation is BROKEN and installer replaces it without re-authenticating it', async (t) => {
  const { root, workspace } = await fixture(t, 'generation-tamper');
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-tamper-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-tamper-cwd-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, IHOW_CAPTURE_FLOOR: '0' };
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const configPath = path.join(cwd, '.claude', 'settings.local.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const original = config.hooks.UserPromptSubmit[0].hooks[0].ihowGeneration;
  assert.match(original, /^ihow-generation-v1\./);
  config.hooks.UserPromptSubmit[0].hooks[0].ihowGeneration = 'attacker-controlled-nonce';
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');

  let run = spawnSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env });
  assert.equal(run.status, 1);
  let claude = JSON.parse(run.stdout).automationMatrix.find((row) => row.runtime === 'Claude Code');
  assert.equal(claude.activationStatus, 'NEEDS REPAIR');
  assert.equal(claude.activationReasonCode, 'ACTIVATION_WIRING_BROKEN');

  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const repaired = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const replacement = repaired.hooks.UserPromptSubmit[0].hooks[0].ihowGeneration;
  assert.match(replacement, /^ihow-generation-v1\./);
  assert.notEqual(replacement, original);
  assert.notEqual(replacement, 'attacker-controlled-nonce');
  assert.equal((await readActivationEvidence(workspace)).filter((row) => row.status === 'configured').length, 2);

  const trustedLedger = await fs.readFile(activationLedgerPath(workspace));
  repaired.hooks.Stop[0].hooks[0].timeout = 31;
  await fs.writeFile(configPath, `${JSON.stringify(repaired, null, 2)}\n`, 'utf8');
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const untrustedValid = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const untrustedValidGeneration = untrustedValid.hooks.Stop[0].hooks[0].ihowGeneration;
  await fs.writeFile(activationLedgerPath(workspace), trustedLedger);
  run = spawnSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env });
  assert.equal(run.status, 1, 'a structurally valid but unrecorded generation must not be silently trusted');
  claude = JSON.parse(run.stdout).automationMatrix.find((row) => row.runtime === 'Claude Code');
  assert.equal(claude.activationStatus, 'NEEDS REPAIR');
  assert.equal(claude.activationReasonCode, 'ACTIVATION_WIRING_GENERATION_UNCONFIRMED');
  execFileSync(process.execPath, [CLI, 'install-hook', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const reauthorizedByRepair = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.notEqual(reauthorizedByRepair.hooks.Stop[0].hooks[0].ihowGeneration, untrustedValidGeneration, 'installer forces a fresh epoch instead of authenticating already-present untrusted state');
  assert.equal((await readActivationEvidence(workspace)).filter((row) => row.status === 'configured').length, 3);

  reauthorizedByRepair.hooks.UserPromptSubmit[0].hooks[0].ihowGeneration = reauthorizedByRepair.hooks.Stop[0].hooks[0].ihowGeneration;
  await fs.writeFile(configPath, `${JSON.stringify(reauthorizedByRepair, null, 2)}\n`, 'utf8');
  run = spawnSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env });
  assert.equal(run.status, 1, 'a valid marker copied from another managed event is still invalid for this binding');
  claude = JSON.parse(run.stdout).automationMatrix.find((row) => row.runtime === 'Claude Code');
  assert.equal(claude.activationStatus, 'NEEDS REPAIR');
});

test('valid foreign-workspace Codex hooks do not block the current workspace audit', async (t) => {
  const { root: rootA } = await fixture(t, 'codex-foreign-a');
  const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-codex-foreign-b-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-codex-foreign-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-codex-foreign-cwd-'));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  t.after(async () => { await fs.rm(rootB, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, IHOW_CAPTURE_FLOOR: '0' };
  const install = (root) => execFileSync(process.execPath, [CLI, 'install-hook', '--runtime', 'codex', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  install(rootA);
  const configPath = path.join(codexHome, 'hooks.json');
  const configA = JSON.parse(await fs.readFile(configPath, 'utf8'));
  install(rootB);
  const configB = JSON.parse(await fs.readFile(configPath, 'utf8'));
  for (const event of new Set([...Object.keys(configA.hooks || {}), ...Object.keys(configB.hooks || {})])) {
    configA.hooks[event] = [...(configA.hooks[event] || []), ...(configB.hooks[event] || [])];
  }
  await fs.writeFile(configPath, `${JSON.stringify(configA, null, 2)}\n`, 'utf8');
  const run = spawnSync(process.execPath, [CLI, 'doctor', '--root', rootA, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env });
  assert.equal(run.status, 0, run.stderr);
  const codex = JSON.parse(run.stdout).automationMatrix.find((row) => row.runtime === 'Codex');
  assert.equal(codex.status, 'OK');
  assert.equal(codex.activationStatus, READY);
});

test('current frozen CLI with a wrong-binding duplicate is BROKEN, not foreign-workspace wiring', async (t) => {
  const { root } = await fixture(t, 'codex-wrong-binding-cli');
  const otherRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-codex-wrong-root-'));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-codex-wrong-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-activation-codex-wrong-cwd-'));
  const codexHome = path.join(home, '.codex');
  await fs.mkdir(codexHome, { recursive: true });
  t.after(async () => { await fs.rm(otherRoot, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true }); await fs.rm(cwd, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, IHOW_CAPTURE_FLOOR: '0' };
  execFileSync(process.execPath, [CLI, 'install-hook', '--runtime', 'codex', '--root', root, '--space', 't', '--cwd', cwd], { encoding: 'utf8', env });
  const configPath = path.join(codexHome, 'hooks.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const group = config.hooks.SessionStart[0];
  const duplicate = structuredClone(group.hooks[0]);
  duplicate.command = duplicate.command.replace(`--root '${root}'`, `--root '${otherRoot}'`);
  assert.notEqual(duplicate.command, group.hooks[0].command);
  group.hooks.push(duplicate);
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const run = spawnSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--cwd', cwd, '--json'], { encoding: 'utf8', env });
  assert.equal(run.status, 1);
  const codex = JSON.parse(run.stdout).automationMatrix.find((row) => row.runtime === 'Codex');
  assert.equal(codex.activationStatus, 'NEEDS REPAIR');
  assert.equal(codex.activationReasonCode, 'ACTIVATION_WIRING_BROKEN');
});
