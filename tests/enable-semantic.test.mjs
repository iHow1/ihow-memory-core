// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Opt-in semantic engine (alpha.18). Turning semantic ON is explicit, per-space, reversible, and
// ADDITIVE. These tests lock the invariants WITHOUT requiring a real Ollama (CI has none):
//   (1) DEFAULT is FTS5 — no semantic.json ⇒ mcpServerSpec injects NOTHING (capabilities.semantic stays
//       false). This is the moat red line: semantic never leaks into the default binary.
//   (2) enable-semantic REFUSES when the provider is unreachable — it never persists a lane that would
//       only fall back (probed against a closed port; exits non-zero; writes no semantic.json).
//   (3) when semantic.json IS present, the server args carry the vector lane pointing at the BUNDLED
//       sidecar; disable-semantic reverses it.
//   (4) doctor treats a configured-but-down provider as a WARNING, never a failure (additive lane).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveWorkspace, ensureWorkspace } from '../src/workspace.ts';
import {
  buildSemanticConfig,
  detectOllama,
  loadSemanticConfig,
  removeSemanticConfig,
  writeSemanticConfig,
  semanticEngineArgs,
  semanticConfigPath,
} from '../src/semantic.ts';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
// A host that is essentially guaranteed to refuse instantly — a closed port on loopback.
const DEAD_HOST = 'http://127.0.0.1:9';

function runCli(home, args) {
  const env = { ...process.env, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: path.join(home, '.state') };
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env }), stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const ws = (home, space) => resolveWorkspace({ root: home, stateRoot: path.join(home, '.state'), space });

test('RED LINE: no semantic.json ⇒ mcpServerSpec injects nothing (default stays zero-dependency FTS5)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-sem-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const workspace = await ensureWorkspace(ws(home, 'demo'));
  assert.deepEqual(semanticEngineArgs(workspace), [], 'default workspace has no semantic engine args');
});

test('enable-semantic REFUSES an unreachable provider — exits non-zero, persists nothing', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-sem-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const r = runCli(home, ['enable-semantic', '--space', 'demo', '--host', DEAD_HOST]);
  assert.notEqual(r.code, 0, 'non-zero exit when Ollama is unreachable');
  assert.match(r.stderr, /not reachable/i);
  const workspace = ws(home, 'demo');
  assert.equal(await loadSemanticConfig(workspace), null, 'no semantic.json written on failure');
  assert.deepEqual(semanticEngineArgs(workspace), [], 'and therefore no injected engine args');
});

test('persisted semantic config injects the vector lane pointing at the bundled sidecar; disable reverses it', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-sem-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const workspace = await ensureWorkspace(ws(home, 'demo'));

  // buildSemanticConfig points at the bundled sidecar (dist/providers), with the chosen host/model.
  const cfg = buildSemanticConfig({ host: 'http://localhost:11434', model: 'nomic-embed-text' });
  assert.equal(cfg.engine, 'vector');
  assert.match(cfg.vectorProviderCommand, /dist\/providers\/ollama-embedding-provider\.mjs/);
  assert.equal(cfg.vectorModel, 'nomic-embed-text');

  // Persist directly (bypassing the live Ollama probe) and assert the injection + round-trip.
  await writeSemanticConfig(workspace, cfg);
  const loaded = await loadSemanticConfig(workspace);
  assert.equal(loaded?.engine, 'vector');
  const args = semanticEngineArgs(workspace);
  assert.ok(args.includes('--engine') && args[args.indexOf('--engine') + 1] === 'vector', 'injects --engine vector');
  assert.ok(args.includes('--vector-provider-command'), 'injects the provider command');
  assert.equal(args[args.indexOf('--vector-model') + 1], 'nomic-embed-text');

  // disable-semantic removes the marker → back to default FTS (no args).
  const r = runCli(home, ['disable-semantic', '--space', 'demo']);
  assert.equal(r.code, 0);
  assert.equal(await loadSemanticConfig(workspace), null, 'semantic.json removed');
  assert.deepEqual(semanticEngineArgs(workspace), [], 'default FTS restored');
  // removeSemanticConfig is idempotent (already off ⇒ false, no throw).
  assert.equal(await removeSemanticConfig(workspace), false);
});

test('detectOllama reports an unreachable daemon honestly (never throws)', async () => {
  const probe = await detectOllama({ host: DEAD_HOST, timeoutMs: 1500 });
  assert.equal(probe.reachable, false);
  assert.equal(probe.hasModel, false);
  assert.ok(typeof probe.error === 'string' && probe.error.length > 0);
});

test('doctor: a configured-but-down semantic provider is a WARNING, never a failure (additive lane)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-sem-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const workspace = await ensureWorkspace(ws(home, 'demo'));
  // Enable semantic pointing at a dead host (write directly — the doctor probe will find it down).
  await writeSemanticConfig(workspace, buildSemanticConfig({ host: DEAD_HOST, model: 'nomic-embed-text' }));
  assert.ok(await fs.stat(semanticConfigPath(workspace)).then(() => true), 'semantic.json present');

  const r = runCli(home, ['doctor', '--space', 'demo', '--json']);
  const report = JSON.parse(r.stdout);
  const semantic = report.checks.find((c) => c.name === 'semantic');
  assert.ok(semantic, 'doctor emits a semantic check when enabled');
  assert.equal(semantic.ok, false, 'down provider is not ok');
  assert.equal(semantic.required, false, 'but it is NOT a required check');
  assert.match(semantic.detail, /falls back to FTS/i, 'detail says search degrades to FTS');
  assert.equal(report.ok, true, 'doctor still passes overall — semantic is additive, not load-bearing');
  assert.equal(r.code, 0, 'doctor exits 0 despite the down semantic provider');
});
