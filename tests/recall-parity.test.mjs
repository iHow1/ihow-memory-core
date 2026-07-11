// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const SERVER = fileURLToPath(new URL('../src/mcp/server.ts', import.meta.url));

async function tmpDir(t, prefix) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  return dir;
}

async function seedParityMemory(memoryRoot) {
  const team = path.join(memoryRoot, 'scopes', 'team');
  await fs.mkdir(team, { recursive: true });
  await fs.writeFile(path.join(team, 'reviewed-orion.md'), [
    '---',
    'status: "promoted"',
    'type: "memory"',
    '---',
    '',
    'Decision: ZXPARITYALPHA adopt orionwidget for the cross-runtime dashboard handoff.',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(team, 'flagged-never.md'), [
    '---',
    'flagged: true',
    '---',
    '',
    'ZXPARITYFLAGGED should never surface in prompt recall.',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(team, 'private-never.md'), [
    '---',
    'visibility: private',
    '---',
    '',
    'ZXPARITYPRIVATE should never surface in prompt recall.',
    '',
  ].join('\n'), 'utf8');
  await fs.writeFile(path.join(team, 'audit-never.md'), [
    '---',
    'visibility: audit-only',
    '---',
    '',
    'ZXPARITYAUDIT should never surface in prompt recall.',
    '',
  ].join('\n'), 'utf8');
}

function cliJson(args, env = {}) {
  const out = execFileSync(process.execPath, ['--experimental-strip-types', CLI, ...args, '--json'], {
    encoding: 'utf8',
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0', ...env },
    timeout: 20000,
  });
  return JSON.parse(out);
}

function reindex(memoryRoot, stateRoot, env = {}) {
  execFileSync(process.execPath, ['--experimental-strip-types', CLI, 'reindex', '--memory-root', memoryRoot, '--state-root', stateRoot], {
    encoding: 'utf8',
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0', ...env },
    timeout: 20000,
  });
}

function claudePromptRecall(memoryRoot, stateRoot, prompt, env = {}) {
  const out = spawnSync(process.execPath, ['--experimental-strip-types', CLI, 'hook-user-prompt-submit', '--memory-root', memoryRoot, '--state-root', stateRoot], {
    input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, cwd: path.dirname(memoryRoot) }),
    encoding: 'utf8',
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0', ...env },
    timeout: 20000,
  });
  assert.equal(out.status, 0, out.stderr || 'hook exits successfully');
  if (!out.stdout.trim()) return '';
  return JSON.parse(out.stdout).hookSpecificOutput.additionalContext;
}

function codexContextProbe(memoryRoot, stateRoot, cwd, promptDigest, env = {}) {
  const lines = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.context_probe', arguments: { cwd, runtime: 'codex', eventHint: 'prompt', promptDigest } } },
  ];
  const out = execFileSync(process.execPath, ['--experimental-strip-types', SERVER, '--memory-root', memoryRoot, '--state-root', stateRoot], {
    input: `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    encoding: 'utf8',
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0', ...env },
    timeout: 20000,
  });
  const messages = out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return messages.find((message) => message.id === 2).result.structuredContent;
}

function assertExcludedEverywhere(text, markers) {
  for (const marker of markers) assert.ok(!text.includes(marker), `${marker} is absent`);
}

test('alpha26 cross-runtime recall parity smoke: hook recall and Codex context_probe share deterministic boundaries', async (t) => {
  const parent = await tmpDir(t, 'ihow-parity-memory-');
  const stateRoot = await tmpDir(t, 'ihow-parity-state-');
  const cwd = await tmpDir(t, 'ihow-parity-cwd-');
  const home = await tmpDir(t, 'ihow-parity-home-');
  const memoryRoot = path.join(parent, 'memory');
  await fs.mkdir(memoryRoot, { recursive: true });
  await seedParityMemory(memoryRoot);
  reindex(memoryRoot, stateRoot, { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot });

  const relevantPrompt = 'What did we decide about ZXPARITYALPHA orionwidget dashboard handoff?';
  const claudeRelevant = claudePromptRecall(memoryRoot, stateRoot, relevantPrompt, { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot });
  const codexRelevant = codexContextProbe(memoryRoot, stateRoot, cwd, relevantPrompt, { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot });

  assert.match(claudeRelevant, /<recalled-memory>/, 'Claude-style UserPromptSubmit hook emits a recalled-memory block');
  assert.match(claudeRelevant, /ZXPARITYALPHA.*orionwidget|orionwidget.*ZXPARITYALPHA/s, 'reviewed relevant memory is visible through the hook surface');
  assert.equal(codexRelevant.event, 'prompt_recall');
  assert.equal(codexRelevant.verdict, 'GREEN');
  assert.match(codexRelevant.injectText, /ZXPARITYALPHA.*orionwidget|orionwidget.*ZXPARITYALPHA/s, 'reviewed relevant memory is visible through context_probe(prompt)');
  assert.ok(codexRelevant.citations.some((citation) => citation.endsWith('scopes/team/reviewed-orion.md')), 'context_probe keeps an eligible citation path');

  const excludedMarkers = ['ZXPARITYFLAGGED', 'ZXPARITYPRIVATE', 'ZXPARITYAUDIT'];
  assertExcludedEverywhere(claudeRelevant, excludedMarkers);
  assertExcludedEverywhere(codexRelevant.injectText || '', excludedMarkers);

  const excludedPrompt = 'Recall ZXPARITYFLAGGED ZXPARITYPRIVATE ZXPARITYAUDIT boundary notes';
  const claudeExcluded = claudePromptRecall(memoryRoot, stateRoot, excludedPrompt, { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot });
  const codexExcluded = codexContextProbe(memoryRoot, stateRoot, cwd, excludedPrompt, { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot });
  assert.equal(claudeExcluded, '', 'hook recall stays silent when only flagged/private/audit-only memory matches');
  assert.equal(codexExcluded.injectText, undefined, 'context_probe(prompt) stays silent when only flagged/private/audit-only memory matches');
  assert.deepEqual(codexExcluded.citations, []);

  const offTopicPrompt = 'quantum gardening nebula recipes unrelated';
  const claudeOffTopic = claudePromptRecall(memoryRoot, stateRoot, offTopicPrompt, { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot });
  const codexOffTopic = codexContextProbe(memoryRoot, stateRoot, cwd, offTopicPrompt, { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot });
  assert.equal(claudeOffTopic, '', 'hook recall injects nothing for off-topic prompts');
  assert.equal(codexOffTopic.injectText, undefined, 'context_probe(prompt) injects nothing for off-topic prompts');
  assert.equal(codexOffTopic.verdict, 'NONE');

  const status = cliJson(['status', '--memory-root', memoryRoot, '--state-root', stateRoot], { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot });
  assert.equal(status.workspace.mode, 'existing-memory-root');
  assert.equal(status.workspace.memoryRoot, memoryRoot);
  assert.equal(status.recallReadiness.lexicalReady, true);
  assert.equal(status.recallReadiness.semanticAvailable, false);
  assert.equal(status.recallReadiness.semanticReady, false);
  assert.equal(status.recallReadiness.provider, 'fts/lexical');

  const doctor = cliJson(['doctor', '--memory-root', memoryRoot, '--state-root', stateRoot], { HOME: home, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: stateRoot });
  const readiness = doctor.checks.find((check) => check.name === 'recall-readiness');
  assert.ok(readiness, 'CLI doctor reports recall-readiness on the same local memory root without probing a real external client');
  assert.equal(readiness.required, false, 'readiness is status-only and must not widen recall eligibility');
});
