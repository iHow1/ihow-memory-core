// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFile } from '../src/store/files.ts';

const PRIVATE_DURABLE_OPTIONS = Object.freeze({
  directoryMode: 0o700,
  fileMode: 0o600,
  durable: true,
  boundedTemp: true,
});

test('private durable atomic writes clean stale temp and preserve final bytes on rename failure', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-atomic-write-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const directory = path.join(root, 'private-store');
  const file = path.join(directory, 'v1.json');
  const temp = path.join(directory, '.v1.json.tmp');
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(temp, 'stale-crash-bytes', { mode: 0o600 });

  await atomicWriteFile(file, 'old-final-bytes', root, PRIVATE_DURABLE_OPTIONS);
  assert.equal(await fs.readFile(file, 'utf8'), 'old-final-bytes');
  assert.deepEqual(await fs.readdir(directory), ['v1.json']);

  const originalRename = fs.rename;
  let observedPrivateTemp = false;
  fs.rename = async (from, to) => {
    assert.equal(from, temp);
    assert.equal(to, file);
    const stat = await fs.lstat(from);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.mode & 0o777, 0o600);
    assert.equal(await fs.readFile(from, 'utf8'), 'new-final-bytes');
    observedPrivateTemp = true;
    throw Object.assign(new Error('injected_rename_failure'), { code: 'EIO' });
  };
  try {
    await assert.rejects(
      async () => await atomicWriteFile(file, 'new-final-bytes', root, PRIVATE_DURABLE_OPTIONS),
      /injected_rename_failure/,
    );
  } finally {
    fs.rename = originalRename;
  }

  assert.equal(observedPrivateTemp, true);
  assert.equal(await fs.readFile(file, 'utf8'), 'old-final-bytes');
  assert.deepEqual(await fs.readdir(directory), ['v1.json']);
});
