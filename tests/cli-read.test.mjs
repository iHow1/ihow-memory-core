// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));

function run(args) {
  return JSON.parse(execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0' },
    timeout: 20_000,
  }));
}

test('CLI read exposes bounded preview and explicit full modes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cli-read-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const written = run(['write-candidate', `ZCLIREADBUDGET\n${'z'.repeat(9_000)}`, '--root', root, '--space', 't', '--no-auto-promote']);
  const defaultPreview = run(['read', written.path, '--root', root, '--space', 't']);
  assert.equal(defaultPreview.contentMode, 'preview');
  assert.equal(defaultPreview.content.length, 8_000);
  assert.equal(defaultPreview.truncated, true);

  const preview = run(['read', written.path, '--root', root, '--space', 't', '--max-chars', '512']);
  assert.equal(preview.contentMode, 'preview');
  assert.equal(preview.content.length, 512);
  assert.equal(preview.truncated, true);
  assert.match(preview.next, /--full|mode=full/);

  const full = run(['read', written.path, '--root', root, '--space', 't', '--full']);
  assert.equal(full.contentMode, 'full');
  assert.equal(full.content.length, full.originalChars);
  assert.equal(full.truncated, false);
});

test('CLI read rejects invalid max-char budgets with actionable guidance', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cli-read-invalid-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  for (const value of ['nope', '0', '-1', '1.5']) {
    const result = spawnSync(process.execPath, [CLI, 'read', 'memory/example.md', '--root', root, '--space', 't', '--max-chars', value], {
      encoding: 'utf8',
      env: { ...process.env, IHOW_CAPTURE_FLOOR: '0' },
      timeout: 20_000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--max-chars requires a positive integer/);
  }
});
