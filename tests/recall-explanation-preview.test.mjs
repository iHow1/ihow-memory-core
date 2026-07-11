// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { explainPromptRecall } from '../src/recall-explanation.ts';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

async function tmpDir(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function seed(memoryRoot) {
  const team = path.join(memoryRoot, 'scopes', 'team');
  const journal = path.join(memoryRoot, 'journal');
  await fs.mkdir(team, { recursive: true });
  await fs.mkdir(journal, { recursive: true });
  await fs.writeFile(path.join(team, 'reviewed-orion.md'), [
    '---',
    'status: "promoted"',
    'type: "memory"',
    '---',
    '',
    'Decision: ZXPREVIEWALPHA use orionwidget for the recall explanation preview.',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(team, 'flagged-secret-marker.md'), [
    '---',
    'flagged: true',
    '---',
    '',
    'ZXPREVIEWFLAGGED-DO-NOT-LEAK is quarantined and must not be printed.',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(team, 'private-secret-marker.md'), [
    '---',
    'visibility: private',
    '---',
    '',
    'ZXPREVIEWPRIVATE-DO-NOT-LEAK is private and must not be printed.',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(team, 'audit-secret-marker.md'), [
    '---',
    'visibility: audit-only',
    '---',
    '',
    'ZXPREVIEWAUDIT-DO-NOT-LEAK is audit-only and must not be printed.',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(journal, '2026-07-09.md'), 'ZXPREVIEWJOURNAL low-weight journal lane should be counted non-curated only.\n', 'utf8');
}

function reindex(memoryRoot, stateRoot, env = {}) {
  execFileSync(process.execPath, ['--experimental-strip-types', CLI, 'reindex', '--memory-root', memoryRoot, '--state-root', stateRoot], {
    encoding: 'utf8',
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0', ...env },
    timeout: 20000,
  });
}

function cliJson(args, env = {}) {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0', ...env },
    timeout: 20000,
  });
  return JSON.parse(out);
}

function hook(prompt, memoryRoot, stateRoot, env = {}) {
  const out = spawnSync(process.execPath, ['--experimental-strip-types', CLI, 'hook-user-prompt-submit', '--memory-root', memoryRoot, '--state-root', stateRoot], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: path.dirname(memoryRoot) }),
    encoding: 'utf8',
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0', ...env },
    timeout: 20000,
  });
  assert.equal(out.status, 0, out.stderr || 'hook exits successfully');
  return out.stdout.trim() ? JSON.parse(out.stdout) : null;
}

function assertNoExcludedLeak(value) {
  const text = JSON.stringify(value);
  assert.ok(!text.includes('ZXPREVIEWFLAGGED-DO-NOT-LEAK'), 'flagged content not leaked');
  assert.ok(!text.includes('ZXPREVIEWPRIVATE-DO-NOT-LEAK'), 'private content not leaked');
  assert.ok(!text.includes('ZXPREVIEWAUDIT-DO-NOT-LEAK'), 'audit-only content not leaked');
}

test('alpha26 recall explanation includes reviewed relevant citation/tier/reason and excluded counts without content leak', async (t) => {
  const parent = await tmpDir(t, 'ihow-preview-memory-');
  const stateRoot = await tmpDir(t, 'ihow-preview-state-');
  const home = await tmpDir(t, 'ihow-preview-home-');
  const memoryRoot = path.join(parent, 'memory');
  await fs.mkdir(memoryRoot, { recursive: true });
  await seed(memoryRoot);
  const env = { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot };
  reindex(memoryRoot, stateRoot, env);

  const prompt = 'Explain ZXPREVIEWALPHA and also check ZXPREVIEWFLAGGED ZXPREVIEWPRIVATE ZXPREVIEWAUDIT';
  const explanation = await explainPromptRecall({ memoryRoot, stateRoot }, prompt);
  assert.equal(explanation.version, 'alpha26-recall-explanation-v0');
  assert.equal(explanation.mode, 'lexical/FTS only');
  assert.equal(explanation.readiness.semanticReady, false);
  assert.equal(explanation.noRelevantRecall, false);
  assert.equal(explanation.bounded.bounded, true);
  assert.equal(explanation.included.length, 1);
  assert.equal(explanation.included[0].path, 'memory/scopes/team/reviewed-orion.md');
  assert.equal(explanation.included[0].citation.path, 'memory/scopes/team/reviewed-orion.md');
  assert.equal(explanation.included[0].tier, 'reviewed');
  assert.match(explanation.included[0].reason, /matched prompt terms/i);
  assert.ok(explanation.included[0].matchedTerms.includes('zxpreviewalpha'));
  assert.equal(explanation.excluded.counts.flagged, 1);
  assert.equal(explanation.excluded.counts.private, 1);
  assert.equal(explanation.excluded.counts['audit-only'], 1);
  assertNoExcludedLeak(explanation);

  const cli = cliJson(['recall-preview', prompt, '--memory-root', memoryRoot, '--state-root', stateRoot], env);
  assert.deepEqual(cli.excluded.counts, explanation.excluded.counts, 'CLI preview exposes the same safe counts');
  assertNoExcludedLeak(cli);
});

test('alpha26 recall preview off-topic is empty with no relevant recall and lexical-only mode', async (t) => {
  const parent = await tmpDir(t, 'ihow-preview-off-memory-');
  const stateRoot = await tmpDir(t, 'ihow-preview-off-state-');
  const home = await tmpDir(t, 'ihow-preview-off-home-');
  const memoryRoot = path.join(parent, 'memory');
  await fs.mkdir(memoryRoot, { recursive: true });
  await seed(memoryRoot);
  const env = { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot };
  reindex(memoryRoot, stateRoot, env);

  const explanation = cliJson(['recall-preview', 'quantum gardening nebula recipes', '--memory-root', memoryRoot, '--state-root', stateRoot], env);
  assert.equal(explanation.mode, 'lexical/FTS only');
  assert.equal(explanation.noRelevantRecall, true);
  assert.deepEqual(explanation.included, []);
  assert.match(explanation.summary, /no relevant recall/i);
  assertNoExcludedLeak(explanation);
});

test('alpha26 hook explanation is opt-in structuredContent and does not change injected recall eligibility', async (t) => {
  const parent = await tmpDir(t, 'ihow-preview-hook-memory-');
  const stateRoot = await tmpDir(t, 'ihow-preview-hook-state-');
  const home = await tmpDir(t, 'ihow-preview-hook-home-');
  const memoryRoot = path.join(parent, 'memory');
  await fs.mkdir(memoryRoot, { recursive: true });
  await seed(memoryRoot);
  const env = { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot };
  reindex(memoryRoot, stateRoot, env);

  const prompt = 'What did we decide about ZXPREVIEWALPHA orionwidget?';
  const normal = hook(prompt, memoryRoot, stateRoot, env);
  assert.ok(normal.hookSpecificOutput.additionalContext.includes('ZXPREVIEWALPHA'));
  assert.equal(normal.structuredContent, undefined, 'default hook output stays quiet');

  const explained = hook(prompt, memoryRoot, stateRoot, { ...env, IHOW_RECALL_EXPLAIN: '1' });
  assert.equal(explained.hookSpecificOutput.additionalContext, normal.hookSpecificOutput.additionalContext, 'explanation does not change recall injection');
  assert.equal(explained.structuredContent.version, 'alpha26-recall-explanation-v0');
  assert.equal(explained.structuredContent.included.length, 1);
  assertNoExcludedLeak(explained);
});
