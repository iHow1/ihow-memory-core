// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openCore } from '../src/core.ts';
import { automationMatrix, deriveRuntimeActivation } from '../src/automation-doctor.ts';
import { readActivationEvidence } from '../src/activation-ledger.ts';
import { buildHandoffPacket } from '../src/handoff.ts';

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-runtime-event-'));
  const root = path.join(base, 'store');
  const project = path.join(base, 'project');
  await fs.mkdir(project, { recursive: true });
  t.after(async () => fs.rm(base, { recursive: true, force: true }));
  return { root, project };
}

function event(project, overrides = {}) {
  return {
    schemaVersion: 1,
    event: 'runtime.before_prompt',
    runtime: 'dsh',
    cwd: project,
    sessionId: 'dsh-session-1',
    platform: 'host-plugin',
    observedAt: '2026-08-25T12:00:00.000Z',
    promptDigest: 'remember the deployment preference',
    ...overrides,
  };
}

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  const run = (args) => execFileSync('git', args, { cwd: dir });
  run(['init', '-q']);
  run(['config', 'user.email', 't@example.com']);
  run(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(dir, 'seed.txt'), 'x\n', 'utf8');
  run(['add', '-A']);
  run(['commit', '-q', '-m', 'seed']);
}

function editedTranscript(repo, marker) {
  return [
    JSON.stringify({ type: 'user', message: { content: 'continue' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: path.join(repo, 'seed.txt') } }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `handoff ${marker} `.repeat(12) }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `next ${marker} `.repeat(12) }] } }),
  ].join('\n') + '\n';
}

test('Core configure_runtime records one hashed DSH wiring generation', async (t) => {
  const f = await fixture(t);
  const core = await openCore({ root: f.root, space: 'test', cwd: f.project });
  await core.configure_runtime('dsh', {
    source: 'managed-hook',
    configurationKey: 'dsh-host-plugin-v1',
  });
  await core.configure_runtime('dsh', {
    source: 'managed-hook',
    configurationKey: 'dsh-host-plugin-v1',
  });

  const evidence = await readActivationEvidence(core.workspace);
  const configured = evidence.filter((row) => row.runtime === 'dsh' && row.status === 'configured');
  assert.equal(configured.length, 1);
  assert.match(configured[0].configuration.id, /^[a-f0-9]{64}$/);
  const raw = await fs.readFile(path.join(core.workspace.mcpDir, 'activation-ledger.ndjson'), 'utf8');
  assert.doesNotMatch(raw, /dsh-host-plugin-v1/);
});

test('configured DSH lifecycle becomes completion-attested after a managed host event', async (t) => {
  const f = await fixture(t);
  const core = await openCore({ root: f.root, space: 'test', cwd: f.project });
  await core.configure_runtime('dsh', {
    source: 'managed-hook',
    configurationKey: 'dsh-host-plugin-v1',
  });
  const observedAt = new Date(Date.now() + 1_000).toISOString();
  await core.runtime_event(event(f.project, { observedAt }), {
    source: 'managed-hook',
    configurationKey: 'dsh-host-plugin-v1',
  });

  const activation = deriveRuntimeActivation('dsh', await readActivationEvidence(core.workspace));
  assert.equal(activation.status, 'READY — WAITING FOR FIRST ACTIVITY');
  assert.equal(activation.reasonCode, 'ACTIVATION_COMPLETION_UNATTESTED');
});

test('automation matrix reports the exact DSH lifecycle surfaces', async (t) => {
  const f = await fixture(t);
  const core = await openCore({ root: f.root, space: 'test', cwd: f.project });
  const matrix = await automationMatrix(core.workspace, { command: process.execPath });
  const row = matrix.rows.find((candidate) => candidate.runtime === 'DSH');

  assert.equal(row.sessionStartResume, 'agent/session-start');
  assert.equal(row.promptRecall, 'agent/pre-step');
  assert.equal(row.sessionEndCapture, 'agent/disposed');
  assert.equal(row.floorFallback, 'native compaction checkpoint');
});

test('Core runtime_event applies shared prompt recall and records metadata-only DSH evidence', async (t) => {
  const f = await fixture(t);
  const core = await openCore({ root: f.root, space: 'test', cwd: f.project });
  await core.write_candidate({
    title: 'Reviewed deployment preference',
    text: 'The deployment preference uses an amber terminal theme.',
    sourceAgent: 'runtime-event-test',
    autoPromote: false,
  }).then((written) => core.promote(written.path));

  const result = await core.runtime_event(event(f.project));
  assert.equal(result.event, 'runtime.before_prompt');
  assert.match(result.context ?? '', /<recalled-memory>/);
  assert.match(result.context ?? '', /amber terminal theme/);
  assert.equal(result.citations.length, 1);

  const evidence = await readActivationEvidence(core.workspace);
  const dsh = evidence.filter((row) => row.runtime === 'dsh' && row.source === 'native-hook');
  assert.deepEqual(dsh.map((row) => row.status).sort(), ['observed-live-completed', 'observed-live-started']);
  const raw = await fs.readFile(path.join(core.workspace.mcpDir, 'activation-ledger.ndjson'), 'utf8');
  assert.doesNotMatch(raw, /remember the deployment preference|dsh-session-1|amber terminal theme/);
});

test('Core runtime_event session start does not inject a different project handoff', async (t) => {
  const f = await fixture(t);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-runtime-home-'));
  const foreign = path.join(path.dirname(f.project), 'foreign-project');
  const originalHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = originalHome;
    await fs.rm(home, { recursive: true, force: true });
  });
  await makeRepo(foreign);
  const sessionDir = path.join(home, '.claude', 'projects', '-foreign-session');
  await fs.mkdir(sessionDir, { recursive: true });
  await fs.writeFile(path.join(sessionDir, 'foreign.jsonl'), editedTranscript(foreign, 'FOREIGN-DSH-STARTUP'), 'utf8');
  process.env.HOME = home;

  const core = await openCore({ root: f.root, space: 'test', cwd: f.project });
  const result = await core.runtime_event(event(f.project, { event: 'runtime.session_start' }));
  const manual = await buildHandoffPacket({ cwd: f.project, limit: 5 });
  assert.match(JSON.stringify(manual), /FOREIGN-DSH-STARTUP/, 'fixture is visible to manual continue');
  assert.equal(result.context, undefined);
  assert.equal(result.verdict, 'NONE');
  assert.deepEqual(result.citations, []);
});

test('Core runtime_event validates event names before writing activation evidence', async (t) => {
  const f = await fixture(t);
  const core = await openCore({ root: f.root, space: 'test', cwd: f.project });
  await assert.rejects(
    core.runtime_event(event(f.project, { event: 'runtime.unknown' })),
    /runtime_event_name_invalid/,
  );
  assert.deepEqual(await readActivationEvidence(core.workspace), []);
});

test('Core runtime_event rejects non-DSH adapters before writing activation evidence', async (t) => {
  const f = await fixture(t);
  const core = await openCore({ root: f.root, space: 'test', cwd: f.project });
  await assert.rejects(
    core.runtime_event(event(f.project, { runtime: 'hermes' })),
    /runtime_adapter_unsupported/,
  );
  assert.deepEqual(await readActivationEvidence(core.workspace), []);
});

test('Core runtime_event resolves workspace from the DSH session cwd', async (t) => {
  const f = await fixture(t);
  const otherProject = path.join(path.dirname(f.project), 'other-project');
  await fs.mkdir(otherProject, { recursive: true });
  const core = await openCore({ root: f.root, space: 'bootstrap', cwd: f.project });
  const result = await core.runtime_event(event(otherProject, { event: 'runtime.session_end' }), {
    workspace: { root: f.root },
  });
  assert.equal(result.event, 'runtime.session_end');

  const expected = await openCore({ root: f.root, cwd: otherProject });
  const evidence = await readActivationEvidence(expected.workspace);
  const lifecycle = evidence.filter((row) => row.runtime === 'dsh' && row.source === 'native-hook');
  assert.deepEqual(lifecycle.map((row) => row.status).sort(), ['observed-live-completed', 'observed-live-started']);
});

test('Core runtime_event finalizes a partial DSH session-end checkpoint', async (t) => {
  const f = await fixture(t);
  const core = await openCore({ root: f.root, space: 'test', cwd: f.project });
  const result = await core.runtime_event(event(f.project, { event: 'runtime.session_finalize' }));

  assert.match(result.checkpointId ?? '', /^cp_[a-f0-9]{64}$/);
  assert.equal(result.checkpointSkipped, undefined);
  const artifact = await core.checkpoints.read(result.checkpointId);
  assert.equal(artifact.trigger.kind, 'session_end');
  assert.equal(artifact.trigger.signal, 'native');
  assert.equal(artifact.trigger.sourceEvent, 'DSH.AgentRegistry.dispose');
  assert.equal(artifact.trigger.reasonCode, 'dsh_lifecycle_checkpoint_partial');
  assert.equal(artifact.session.runtime, 'dsh');
  assert.equal(artifact.coverage.complete, false);
  assert.equal(artifact.coverage.eventCount, 0);
});
