// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

function run(args, env = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, IHOW_HANDOFF_METRICS: '0', ...env },
  });
}

test('default help is compact and the complete command reference remains discoverable', () => {
  const compact = run([]);
  assert.match(compact, /Start here \(about 3 minutes\)/);
  for (const command of ['setup', 'proof', 'continue', 'forget']) assert.match(compact, new RegExp(`ihow-memory ${command}`));
  assert.match(compact, /ihow-memory help --all/);
  assert.ok(compact.length < 1800, `compact help should stay bounded, got ${compact.length} bytes`);

  const full = run(['help', '--all']);
  assert.match(full, /Complete command reference/);
  assert.match(full, /ihow-memory organize/);
  assert.match(full, /ihow-memory enable-semantic/);
  assert.ok(full.length > compact.length * 2, 'full help keeps the complete operator surface');

  const flagFull = run(['--help', '--all']);
  assert.match(flagFull, /Complete command reference/);
});

test('proof demonstrates receiver-side GREEN then drift RED and keeps governed memory evidence', () => {
  const out = run(['proof']);
  assert.match(out, /prior narrative: UNVERIFIED/);
  assert.match(out, /receiver verdict before drift: GREEN/);
  assert.match(out, /receiver verdict after drift: RED/);
  assert.match(out, /Governed local-memory proof/);
  assert.match(out, /citation:/);
  assert.match(out, /audit event: memory\.promoted/);
  assert.match(out, /PASS proof:/);
});

test('proof --json exposes the same handoff verdicts without prose parsing', () => {
  const result = JSON.parse(run(['proof', '--json']));
  assert.equal(result.ok, true);
  assert.equal(result.handoff.narrative.trust, 'UNVERIFIED');
  assert.equal(result.handoff.green.state, 'GREEN');
  assert.equal(result.handoff.red.state, 'RED');
  assert.equal(result.agentB.read.containsMarker, true);
  assert.equal(result.audit.event.type, 'memory.promoted');
});

test('continue --json with no history is structured, honest, and points to proof', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-first-run-root-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-first-run-cwd-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });
  const result = JSON.parse(run(['continue', '--root', root, '--space', 'fresh', '--cwd', cwd, '--json']));
  assert.equal(result.resumed, false);
  assert.equal(result.firstRun, true);
  assert.equal(result.status, 'first-run');
  assert.deepEqual(result.nextSteps, ['ihow-memory proof']);
  assert.equal(result.quotedBody, '');
});
