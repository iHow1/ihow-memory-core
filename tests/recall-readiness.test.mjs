// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const ORACLE = fileURLToPath(new URL('../examples/synonym-oracle-provider.mjs', import.meta.url));

async function tmpRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-readiness-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return root;
}

function cliJson(root, args, env = {}) {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ...env, HOME: root, IHOW_MEMORY_HOME: root, IHOW_MEMORY_STATE_ROOT: path.join(root, '.state') },
  });
  return JSON.parse(out);
}

test('alpha26 readiness: default/no config is explicit lexical FTS-only, not semantic', async (t) => {
  const root = await tmpRoot(t);
  const status = await (await openCore({ root, stateRoot: path.join(root, '.state'), space: 'demo' })).status();
  assert.equal(status.recallReadiness.lexicalReady, true);
  assert.equal(status.recallReadiness.semanticAvailable, false);
  assert.equal(status.recallReadiness.semanticReady, false);
  assert.equal(status.recallReadiness.provider, 'fts/lexical');
  assert.match(status.recallReadiness.reason, /no semantic provider\/config|FTS-only/i);
  assert.equal(status.capabilities.semantic, false, 'default status still does not claim semantic capability');
});

test('alpha26 readiness: configured measured vector source is semantic ready', async (t) => {
  const root = await tmpRoot(t);
  const command = `${process.execPath} ${ORACLE}`;
  const core = await openCore({
    root,
    stateRoot: path.join(root, '.state'),
    space: 'demo',
    engine: 'vector',
    vectorProviderCommand: command,
    vectorModel: 'bge-m3',
    vectorTimeoutMs: 4000,
  });
  const status = await core.status();
  assert.equal(status.recallReadiness.lexicalReady, true);
  assert.equal(status.recallReadiness.semanticAvailable, true, 'provider status is active/ready');
  assert.equal(status.recallReadiness.semanticReady, true, 'bge-m3 has a measured floor');
  assert.equal(status.recallReadiness.provider, 'vector-gguf');
  assert.equal(status.recallReadiness.measuredSemanticModel, true);
  assert.equal(status.recallReadiness.semanticRecallFloor, 0.58);
  assert.equal(status.capabilities.semantic, true);
});

test('alpha26 readiness: configured unmeasured model is available but semantic bypass stays fail-closed', async (t) => {
  const root = await tmpRoot(t);
  const command = `${process.execPath} ${ORACLE}`;
  const status = await (await openCore({
    root,
    stateRoot: path.join(root, '.state'),
    space: 'demo',
    engine: 'vector',
    vectorProviderCommand: command,
    vectorModel: 'nomic-embed-text',
    vectorTimeoutMs: 4000,
  })).status();
  assert.equal(status.recallReadiness.semanticAvailable, true, 'provider can run');
  assert.equal(status.recallReadiness.semanticReady, false, 'unmeasured recall floor blocks semantic readiness');
  assert.equal(status.recallReadiness.measuredSemanticModel, false);
  assert.equal(status.recallReadiness.semanticRecallFloor, null);
  assert.deepEqual(status.recallReadiness.warnings, ['semantic_model_unmeasured']);
  assert.match(status.recallReadiness.reason, /no measured recall floor|fail-closed/i);
});

test('alpha26 doctor/status surface recall-readiness honesty without failing default local doctor', async (t) => {
  const root = await tmpRoot(t);
  const status = cliJson(root, ['status', '--space', 'demo']);
  assert.equal(status.recallReadiness.provider, 'fts/lexical');
  assert.equal(status.recallReadiness.semanticReady, false);

  const doctor = cliJson(root, ['doctor', '--space', 'demo']);
  const readiness = doctor.checks.find((c) => c.name === 'recall-readiness');
  assert.ok(readiness, 'doctor includes recall-readiness');
  assert.equal(readiness.ok, false);
  assert.equal(readiness.required, false, 'not semantic-ready is an honesty warning, not a local-health failure');
  assert.match(readiness.detail, /FTS-only|no semantic provider\/config/i);
  assert.equal(doctor.ok, true, 'default lexical-only install still passes doctor');
});
