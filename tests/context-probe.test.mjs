// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deriveProbeMetrics } from '../src/context-probe.ts';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.ts');
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

async function mkdtemp(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function runMcp(root, lines, env = {}) {
  const out = execFileSync(process.execPath, [SERVER, '--root', root, '--space', 't'], {
    encoding: 'utf8',
    input: `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`,
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0', ...env },
    timeout: 20000,
  });
  return out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('MCP tools/list includes memory.context_probe', async (t) => {
  const root = await mkdtemp('ihow-cp-root-');
  const home = await mkdtemp('ihow-cp-home-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const msgs = runMcp(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ], { HOME: home });
  const list = msgs.find((m) => m.id === 2);
  assert.ok(list.result.tools.some((tool) => tool.name === 'memory.context_probe'), 'context_probe is advertised');
});

test('context_probe(session_end, workbuddy) returns cooperative journal and never floor_journaled', async (t) => {
  const root = await mkdtemp('ihow-cp-root-');
  const cwd = await mkdtemp('ihow-cp-cwd-');
  const home = await mkdtemp('ihow-cp-home-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const msgs = runMcp(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.context_probe', arguments: { cwd, runtime: 'workbuddy', eventHint: 'session_end' } } },
  ], { HOME: home });
  const payload = msgs.find((m) => m.id === 2).result.structuredContent;
  assert.equal(payload.event, 'session_end');
  assert.equal(payload.action, 'journal');
  assert.notEqual(payload.action, 'floor_journaled');
  assert.equal(payload.diagnostics.transcriptSource, 'none');
  assert.equal(payload.diagnostics.autoWriteAllowed, false);
  assert.ok(payload.auditEventId, 'probe call is audited');
});

test('context_probe(prompt) is silent for empty promptDigest', async (t) => {
  const root = await mkdtemp('ihow-cp-root-');
  const cwd = await mkdtemp('ihow-cp-cwd-');
  const home = await mkdtemp('ihow-cp-home-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const msgs = runMcp(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.context_probe', arguments: { cwd, runtime: 'workbuddy', eventHint: 'prompt' } } },
  ], { HOME: home });
  const payload = msgs.find((m) => m.id === 2).result.structuredContent;
  assert.equal(payload.event, 'prompt_recall');
  assert.equal(payload.action, 'none');
  assert.equal(payload.verdict, 'NONE');
  assert.equal(payload.injectText, undefined);
  assert.deepEqual(payload.citations, []);
});

test('context_probe(prompt) recalls reviewed curated memory but excludes auto/flagged entries', async (t) => {
  const root = await mkdtemp('ihow-cp-root-');
  const cwd = await mkdtemp('ihow-cp-cwd-');
  const home = await mkdtemp('ihow-cp-home-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const scopes = path.join(root, 't', 'memory', 'scopes', 'team');
  await fs.mkdir(scopes, { recursive: true });
  await fs.writeFile(path.join(scopes, 'reviewed-zeta.md'), [
    '---', 'status: "promoted"', 'type: "memory"', '---', '',
    'Decision: adopt zetaframework for the dashboard rollout.', '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(scopes, 'auto-kappa.md'), [
    '---', 'tier: "auto-promoted"', 'reviewed: false', '---', '',
    'The kappaframework migration finished.', '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(scopes, 'flagged-lambda.md'), [
    '---', 'flagged: true', '---', '',
    'The lambdaframework secret migration finished.', '',
  ].join('\n'), 'utf8');
  const msgs = runMcp(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.context_probe', arguments: { cwd, runtime: 'workbuddy', eventHint: 'prompt', promptDigest: 'zetaframework kappaframework lambdaframework dashboard decision' } } },
  ], { HOME: home });
  const payload = msgs.find((m) => m.id === 2).result.structuredContent;
  assert.equal(payload.event, 'prompt_recall');
  assert.equal(payload.action, 'none');
  assert.equal(payload.verdict, 'GREEN');
  assert.match(payload.injectText, /<recalled-memory>/);
  assert.match(payload.injectText, /zetaframework/);
  assert.ok(!/kappaframework/i.test(payload.injectText), 'auto-promoted entry excluded');
  assert.ok(!/lambdaframework/i.test(payload.injectText), 'flagged entry excluded');
  assert.equal(payload.citations.length, 1);
});

test('context_probe(prompt) bounds reviewed recall to three hits', async (t) => {
  const root = await mkdtemp('ihow-cp-root-');
  const cwd = await mkdtemp('ihow-cp-cwd-');
  const home = await mkdtemp('ihow-cp-home-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const scopes = path.join(root, 't', 'memory', 'scopes', 'team');
  await fs.mkdir(scopes, { recursive: true });
  for (let i = 0; i < 5; i += 1) {
    await fs.writeFile(path.join(scopes, `reviewed-zeta-${i}.md`), `---\nstatus: "promoted"\n---\n\nDecision ${i}: zetaframework dashboard rollout note ${i}.\n`, 'utf8');
  }
  const msgs = runMcp(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.context_probe', arguments: { cwd, runtime: 'workbuddy', eventHint: 'prompt', promptDigest: 'zetaframework dashboard rollout' } } },
  ], { HOME: home });
  const payload = msgs.find((m) => m.id === 2).result.structuredContent;
  assert.equal(payload.citations.length, 3);
  assert.ok(payload.injectText.length <= 1200, 'bounded recall block');
});

test('context_probe(session_start) is safe without prior marker', async (t) => {
  const root = await mkdtemp('ihow-cp-root-');
  const cwd = await mkdtemp('ihow-cp-cwd-');
  const home = await mkdtemp('ihow-cp-home-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const msgs = runMcp(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.context_probe', arguments: { cwd, runtime: 'workbuddy', eventHint: 'session_start' } } },
  ], { HOME: home });
  const payload = msgs.find((m) => m.id === 2).result.structuredContent;
  assert.equal(payload.event, 'session_start');
  assert.ok(['NONE', 'YELLOW', 'GREEN', 'RED'].includes(payload.verdict));
  assert.notEqual(payload.action, 'floor_journaled');
  assert.equal(payload.diagnostics.staleMarker, false);
});

test('stale marker returns YELLOW diagnostics without fabricating summary', async (t) => {
  const root = await mkdtemp('ihow-cp-root-');
  const cwd = await mkdtemp('ihow-cp-cwd-');
  const home = await mkdtemp('ihow-cp-home-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  const space = 't';
  const mcpDir = path.join(root, space, 'memory', '_mcp');
  await fs.mkdir(mcpDir, { recursive: true });
  await fs.writeFile(path.join(mcpDir, 'context-probe-marker.json'), JSON.stringify({
    updatedAt: new Date(Date.now() - 45 * 60 * 1000).toISOString(),
    cwdHash: 'old',
    runtime: 'workbuddy',
    eventHint: 'tick',
  }), 'utf8');
  const msgs = runMcp(root, [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.context_probe', arguments: { cwd, runtime: 'workbuddy', eventHint: 'session_start' } } },
  ], { HOME: home });
  const payload = msgs.find((m) => m.id === 2).result.structuredContent;
  assert.equal(payload.verdict, 'YELLOW');
  assert.equal(payload.action, 'verify_anchors');
  assert.equal(payload.diagnostics.staleMarker, true);
  assert.match(payload.injectText, /No summary was fabricated/);
});

test('probe audit events derive runtime counts and journal conversion metrics', () => {
  const metrics = deriveProbeMetrics([
    { id: '1', at: '2026-01-01T00:00:00Z', type: 'memory.context_probe', metadata: { runtime: 'workbuddy', action: 'journal' } },
    { id: '2', at: '2026-01-01T00:00:01Z', type: 'memory.context_probe', metadata: { runtime: 'codex', action: 'none' } },
    { id: '3', at: '2026-01-01T00:00:02Z', type: 'memory.journal.appended', metadata: { weight: 'low' } },
    { id: '4', at: '2026-01-01T00:00:03Z', type: 'memory.journal.appended', metadata: { floor: true, floorRuntime: 'codex' } },
  ]);
  assert.equal(metrics.probeCallsByRuntime.workbuddy, 1);
  assert.equal(metrics.probeCallsByRuntime.codex, 1);
  assert.equal(metrics.journalSuggestionsByRuntime.workbuddy, 1);
  assert.equal(metrics.cooperativeJournalCount, 1);
  assert.equal(metrics.probeToJournalConversionRate, 1);
  assert.equal(metrics.floorCaptureSources.codex, 1);
});

test('doctor matrix includes runtime rows and path classifier warns/breaks obvious dead paths', async (t) => {
  const root = await mkdtemp('ihow-doctor-matrix-');
  const home = await mkdtemp('ihow-doctor-home-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(home, { recursive: true, force: true });
  });
  let out;
  try {
    out = execFileSync(process.execPath, [CLI, 'doctor', '--root', root, '--space', 't', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, IHOW_CAPTURE_FLOOR: '0' },
    });
  } catch (e) {
    out = e.stdout;
  }
  const doc = JSON.parse(out);
  const labels = doc.automationMatrix.map((row) => row.runtime);
  for (const expected of ['Claude Code', 'Codex', 'OpenClaw', 'Hermes', 'WorkBuddy/OpenCode/Gemini']) {
    assert.ok(labels.includes(expected), `matrix includes ${expected}`);
  }
  assert.ok(doc.automationMatrix.every((row) => ['OK', 'WARN', 'BROKEN'].includes(row.status)), 'every row has a status');
  assert.ok(doc.checks.some((check) => check.name === 'automation-matrix'), 'doctor emits an automation-matrix check');
});
