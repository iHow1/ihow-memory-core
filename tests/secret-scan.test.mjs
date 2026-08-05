// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { privateDenylistRules, scanRepository, scanText } from '../scripts/secret-scan.mjs';

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

test('secret scan rejects credential-bearing service URIs without returning their values', () => {
  const value = ['mongodb', '://', 'operator', ':', 'not-a-real-password', '@', 'db.example', '/app'].join('');
  const hits = scanText('tests/accidental-uri-fixture.mjs', `const uri = ${JSON.stringify(value)};`);
  assert.deepEqual(hits, [{ file: 'tests/accidental-uri-fixture.mjs', line: 1, rule: 'credential-uri' }]);
  assert.equal(Object.values(hits[0]).includes(value), false);
});

test('public-boundary rules reject private strategy, customer, and machine-local traces', () => {
  const samples = [
    ['real-customer-relationship', ['real', ' customer', "'s", ' tool'].join('')],
    ['real-customer-relationship', ['customer', "'s", ' tool'].join('')],
    ['machine-user-path', ['/Users', '/operator/private.md'].join('')],
    ['operator-workspace', ['.open', 'claw/workspace/internal.md'].join('')],
    ['private-product-map', ['产品化', '总图'].join('')],
    ['private-product-strategy', ['产品化', '战略'].join('')],
    ['private-business-model', ['商业', '模式'].join('')],
    ['private-deployment-positioning', ['私有化', '部署'].join('')],
    ['private-recovery-product', ['恢复', '中心'].join('')],
    ['private-continuity-tier', ['Personal', ' Continuity'].join('')],
    ['unratified-product-pivot', ['产品转向', '尚未批准'].join('')],
    ['private-product-strategy-en', ['product', ' strategy'].join('')],
    ['private-commercial-plan', ['business', ' model'].join('')],
    ['private-commercial-plan', ['commercial', ' strategy'].join('')],
    ['private-commercial-plan', ['go', '-to-market'].join('')],
    ['private-deployment-positioning-en', ['private', ' deployment'].join('')],
  ];
  for (const [rule, value] of samples) {
    const hits = scanText('docs/private-note.md', value);
    assert.deepEqual(hits.map((hit) => hit.rule), [rule]);
    assert.equal(Object.values(hits[0]).includes(value), false);
  }
});

test('private denylist rules use exact injected values without returning them', () => {
  const value = ['Project', ' J[un]iper'].join('');
  const rules = privateDenylistRules(`${value}\n${value}\n`);
  const hits = scanText('docs/private-note.md', `deployment=${value}`, rules);
  assert.deepEqual(hits, [{ file: 'docs/private-note.md', line: 1, rule: 'private-denylist' }]);
  assert.equal(Object.values(hits[0]).includes(value), false);
});

test('CI scan fails closed when the private denylist is not configured', () => {
  const env = { ...process.env, CI: 'true' };
  delete env.IHOW_PUBLIC_BOUNDARY_DENYLIST;
  const result = spawnSync(process.execPath, ['scripts/secret-scan.mjs'], {
    cwd: process.cwd(),
    env,
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /IHOW_PUBLIC_BOUNDARY_DENYLIST is required in CI/u);
});

test('public-boundary rules allow ordinary open-source technical communication', () => {
  const text = [
    'The roadmap covers protocol interoperability and conformance maintenance.',
    'Enterprise and team deployments must enforce tenant isolation.',
    '产品文档可以讨论开放协议、合成测试与安全边界。',
    'Customer data is never included in fixtures.',
    'The adapter may read .claude/settings.local.json without publishing its contents.',
    'A rollback file can use the .ihow-bak suffix.',
  ].join('\n');
  assert.deepEqual(scanText('docs/open-technical-notes.md', text), []);
});

test('repository scan rejects tracked machine-local files by path', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-private-path-scan-')));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  execFileSync('git', ['init', '-q'], { cwd: root });
  await fs.mkdir(path.join(root, '.claude'), { recursive: true });
  await fs.mkdir(path.join(root, '.openclaw', 'workspace'), { recursive: true });
  await fs.writeFile(path.join(root, '.claude', 'settings.local.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(root, '.openclaw', 'workspace', 'handoff.md'), 'private\n', 'utf8');
  await fs.writeFile(path.join(root, 'config.ihow-bak-1'), 'backup\n', 'utf8');
  execFileSync('git', ['add', '-f', '.'], { cwd: root });

  const operatorWorkspacePath = ['.open', 'claw/workspace/handoff.md'].join('');
  const { hits, forbidden } = scanRepository(root);
  assert.deepEqual(hits, [{
    file: operatorWorkspacePath,
    line: 1,
    rule: 'operator-workspace',
  }]);
  assert.deepEqual(forbidden, [
    '.claude/settings.local.json',
    operatorWorkspacePath,
    'config.ihow-bak-1',
  ]);
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

test('repository scan does not skip tracked text after a NUL byte', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-secret-scan-nul-')));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  const privatePhrase = ['商业', '模式'].join('');
  await fs.writeFile(path.join(root, 'nul-fixture.txt'), Buffer.from(`prefix\0${privatePhrase}\n`, 'utf8'));
  execFileSync('git', ['add', 'nul-fixture.txt'], { cwd: root });
  const { hits } = scanRepository(root);
  assert.deepEqual(hits, [{ file: 'nul-fixture.txt', line: 1, rule: 'private-business-model' }]);
});
