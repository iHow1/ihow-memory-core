// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCore } from '../src/core.ts';

const repo = path.resolve(import.meta.dirname, '..');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');
const fakeGithubPat = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');

function invokeBridge(event, env = {}) {
  return spawnSync(process.execPath, ['--experimental-strip-types', bridge], {
    cwd: repo,
    encoding: 'utf8',
    input: `${JSON.stringify(event)}\n`,
    env: { ...process.env, ...env },
  });
}

const base = {
  schemaVersion: 1,
  runtime: 'hermes',
  cwd: '/repo',
  sessionId: 'session-1',
  platform: 'cli',
  observedAt: '2026-07-12T00:00:00.000Z',
};

test('bridge maps a before-prompt event to bounded context_probe recall', async () => {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-state-'));
  await fs.mkdir(path.join(memoryRoot, 'scopes'), { recursive: true });
  await fs.writeFile(
    path.join(memoryRoot, 'scopes', 'project.md'),
    '# Activation truth\n\nHermes adapter keeps activation truth verified and bounded.\n',
    'utf8',
  );
  const core = await openCore({ memoryRoot, stateRoot, cwd: '/repo' });
  await core.rebuild();
  const run = invokeBridge({
    ...base,
    event: 'runtime.before_prompt',
    promptDigest: 'Hermes activation truth',
  }, {
    MEMORY_ROOT: memoryRoot,
    IHOW_MEMORY_STATE_ROOT: stateRoot,
  });

  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.ok, true);
  assert.equal(typeof output.context, 'string');
  assert.match(output.context, /Activation truth|Hermes adapter/i);
  assert.ok(output.context.length <= 8000);
  assert.equal('promptDigest' in output, false);
});

test('bridge records synthetic probe evidence but never claims native-live activation by itself', async () => {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-state-'));
  const run = invokeBridge({ ...base, event: 'runtime.session_start' }, {
    MEMORY_ROOT: memoryRoot,
    IHOW_MEMORY_STATE_ROOT: stateRoot,
  });

  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.ok, true);
  assert.equal(output.context === undefined || typeof output.context === 'string', true);

  const ledger = await fs.readFile(path.join(memoryRoot, '_mcp', 'activation-ledger.ndjson'), 'utf8');
  assert.match(ledger, /"runtime":"hermes"/);
  assert.match(ledger, /"source":"context-probe"/);
  assert.match(ledger, /"status":"synthetic"/);
  assert.doesNotMatch(ledger, /"source":"native-hook"/);
  assert.doesNotMatch(ledger, /"status":"observed-live-/);
  assert.doesNotMatch(ledger, /session-1/);
});

test('bridge applies canonical governance redaction before recall or audit persistence', async () => {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-state-'));
  await fs.mkdir(path.join(memoryRoot, 'scopes'), { recursive: true });
  await fs.writeFile(path.join(memoryRoot, 'scopes', 'project.md'), '# Hermes continuity\n', 'utf8');
  const core = await openCore({ memoryRoot, stateRoot, cwd: '/repo' });
  await core.rebuild();
  const secrets = [
    'password is hunter2',
    fakeGithubPat,
    'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
    '密码：中文秘密值',
  ];
  const run = invokeBridge({
    ...base,
    event: 'runtime.before_prompt',
    prompt: `Hermes continuity ${secrets.join(' ')}`,
  }, { MEMORY_ROOT: memoryRoot, IHOW_MEMORY_STATE_ROOT: stateRoot });
  assert.equal(run.status, 0, run.stderr);
  const auditDirs = [path.join(memoryRoot, '_events'), path.join(memoryRoot, '_mcp', '_events')];
  const auditParts = [];
  for (const eventsDir of auditDirs) {
    const eventFiles = await fs.readdir(eventsDir).catch(() => []);
    auditParts.push(...await Promise.all(eventFiles.filter(name => name.endsWith('.ndjson')).map(name => fs.readFile(path.join(eventsDir, name), 'utf8'))));
  }
  const audit = auditParts.join('\n');
  for (const secret of secrets) assert.doesNotMatch(audit, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(audit, /promptDigestHash/);
  assert.doesNotMatch(run.stdout, /hunter2|ghp_|AKIA|eyJhbG|中文秘密值/);
});

test('bridge rejects invalid event input with a machine-readable error and no stack trace', () => {
  const run = invokeBridge({ ...base, event: 'runtime.unknown' });
  assert.equal(run.status, 1);
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.ok, false);
  assert.equal(output.error, 'runtime_event_name_invalid');
  assert.doesNotMatch(run.stdout, /at .+\(/);
});
