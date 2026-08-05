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

function cliText(root, args, env = {}) {
  return execFileSync(process.execPath, ['--experimental-strip-types', CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env, HOME: root, IHOW_MEMORY_HOME: root, IHOW_MEMORY_STATE_ROOT: path.join(root, '.state') },
  });
}

test('alpha26 readiness: default/no config is explicit lexical FTS-only, not semantic', async (t) => {
  const root = await tmpRoot(t);
  const status = await (await openCore({ root, stateRoot: path.join(root, '.state'), space: 'demo' })).status();
  assert.equal(status.recallReadiness.lexicalReady, true);
  assert.equal(status.recallReadiness.semanticAvailable, false);
  assert.equal(status.recallReadiness.semanticReady, false);
  assert.equal(status.recallReadiness.provider, 'fts/lexical');
  assert.equal(status.recallReadiness.modeLabel, 'lexical/FTS only');
  assert.equal(status.recallReadiness.summary, 'semantic recall not enabled');
  assert.match(status.recallReadiness.nextAction, /Optional: run ihow-memory enable-semantic --model bge-m3/i);
  assert.match(status.recallReadiness.nextAction, /no action is required/i);
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
  assert.equal(status.recallReadiness.modeLabel, 'semantic-ready + lexical fallback');
  assert.match(status.recallReadiness.summary, /semantic recall ready with measured model "bge-m3"/i);
  assert.match(status.recallReadiness.nextAction, /No action needed/i);
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
  assert.equal(status.recallReadiness.modeLabel, 'semantic provider available; recall gate fail-closed');
  assert.match(status.recallReadiness.summary, /no measured recall floor/i);
  assert.match(status.recallReadiness.nextAction, /measured recall floor|calibration|override/i);
  assert.match(status.recallReadiness.nextAction, /fail-closed/i);
  assert.match(status.recallReadiness.reason, /no measured recall floor|fail-closed/i);
});

test('alpha26 doctor/status surface recall-readiness honesty without failing default local doctor', async (t) => {
  const root = await tmpRoot(t);
  const status = cliJson(root, ['status', '--space', 'demo']);
  assert.equal(status.recallReadiness.provider, 'fts/lexical');
  assert.equal(status.recallReadiness.semanticReady, false);
  assert.equal(status.recallReadiness.modeLabel, 'lexical/FTS only');
  assert.equal(status.recallReadiness.summary, 'semantic recall not enabled');
  assert.match(status.recallReadiness.nextAction, /enable-semantic --model bge-m3/i);

  const humanStatus = cliText(root, ['status', '--space', 'demo']);
  assert.match(humanStatus, /Recall mode: lexical\/FTS only; semantic recall not enabled/i);

  const doctor = cliJson(root, ['doctor', '--space', 'demo']);
  const readiness = doctor.checks.find((c) => c.name === 'recall-readiness');
  assert.ok(readiness, 'doctor includes recall-readiness');
  assert.equal(readiness.ok, false);
  assert.equal(readiness.required, false, 'not semantic-ready is an honesty warning, not a local-health failure');
  assert.equal(readiness.severity, 'info', 'default lexical-only is optional, not a scary warning');
  assert.match(readiness.detail, /Recall mode: lexical\/FTS only; semantic recall not enabled/i);
  assert.match(readiness.hint, /Optional: run ihow-memory enable-semantic --model bge-m3/i);
  assert.equal(doctor.ok, true, 'default lexical-only install still passes doctor');
});

test('alpha26 doctor: unmeasured semantic provider is optional warning with calibration next action', async (t) => {
  const root = await tmpRoot(t);
  const command = `${process.execPath} ${ORACLE}`;
  const doctor = cliJson(root, [
    'doctor',
    '--space', 'demo',
    '--engine', 'vector',
    '--vector-provider-command', command,
    '--vector-model', 'nomic-embed-text',
    '--vector-timeout-ms', '4000',
  ]);
  const readiness = doctor.checks.find((c) => c.name === 'recall-readiness');
  assert.ok(readiness, 'doctor includes recall-readiness');
  assert.equal(readiness.ok, false);
  assert.equal(readiness.required, false);
  assert.equal(readiness.severity, 'warning');
  assert.match(readiness.detail, /recall gate fail-closed/i);
  assert.match(readiness.hint, /measured recall floor|calibration|override/i);
  assert.equal(doctor.ok, true, 'unmeasured semantic readiness remains non-required');
});
