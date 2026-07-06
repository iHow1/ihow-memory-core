// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { scanRepository, scanText } from '../scripts/secret-scan.mjs';

test('secret scan ignores intentionally fake credential fixtures but still catches real-shaped leaks', () => {
  const fakeOpenAi = ['sk', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('-');
  const fakeAws = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');
  const fakeGitHub = ['ghp', '123456789012345678901234'].join('_');
  assert.deepEqual(
    scanText('tests/redaction-fixture.test.mjs', `const fake = '${fakeOpenAi}';\nconst aws = '${fakeAws}';\n`),
    [],
  );

  const hits = scanText('src/accidental-leak.ts', `const key = '${fakeOpenAi}';\nconst token = '${fakeGitHub}';\n`);
  assert.deepEqual(hits, [
    { file: 'src/accidental-leak.ts', line: 1, rule: 'openai-key' },
    { file: 'src/accidental-leak.ts', line: 2, rule: 'github-token' },
  ]);
});

test('secret scan reports rule ids instead of printing secret values', () => {
  const value = ['ghp', '123456789012345678901234'].join('_');
  const hits = scanText('docs/example.md', `token=${value}`);
  assert.equal(hits.length, 1);
  assert.equal(Object.values(hits[0]).includes(value), false);
});

test('repository scan covers tracked and untracked non-ignored files only', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-secret-scan-')));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  execFileSync('git', ['init', '-q'], { cwd: root });
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n', 'utf8');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'tracked clean\n', 'utf8');
  execFileSync('git', ['add', '.gitignore', 'tracked.txt'], { cwd: root });

  const untrackedValue = ['ghp', '123456789012345678901234'].join('_');
  const ignoredValue = ['ghp', '999999999999999999999999'].join('_');
  await fs.writeFile(path.join(root, 'candidate.txt'), `token=${untrackedValue}\n`, 'utf8');
  await fs.writeFile(path.join(root, 'ignored.txt'), `token=${ignoredValue}\n`, 'utf8');

  const { hits } = scanRepository(root);
  assert.deepEqual(hits, [{ file: 'candidate.txt', line: 1, rule: 'github-token' }]);
});
