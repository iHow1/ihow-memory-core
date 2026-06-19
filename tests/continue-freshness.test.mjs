// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// R3 (capture-surface fragility): a handoff product that SILENTLY hands over a stale or empty capsule
// is worse than no product — the receiver says "继续", gets nothing useful, and never learns the
// capture broke. So `continue` must degrade LOUDLY: always report source freshness, and raise a banner
// when the capture is EMPTY (no prior session) or POSSIBLY STALE (source older than a day). Driven by
// transcript mtime + body emptiness — deterministic, never an LLM judgement.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
const u = (c) => JSON.stringify({ type: 'user', message: { content: c } });
const a = (c) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: c }] } });
const big = (closing) => [u('开始任务'), a('第一步'), a('中间汇报'), a(closing)].join('\n') + '\n';

async function withProjectTranscript(t, cwd, name, body) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  const file = path.join(projDir, name);
  await fs.writeFile(file, body, 'utf8');
  return { home, file };
}

test('continue: a FRESH handoff always reports source freshness (never silent), no stale banner', async (t) => {
  const cwd = '/tmp/fresh-cwd';
  const { home } = await withProjectTranscript(t, cwd, 'fresh.jsonl', big('刚刚的工作 FRESH-OK，下一步继续。'.repeat(3)));
  const out = execFileSync(process.execPath, [CLI, 'continue', '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'unrelated', IHOW_HANDOFF_METRICS: '0' },
  });
  assert.match(out, /source_freshness: source session last active/, 'freshness is always reported');
  assert.doesNotMatch(out, /POSSIBLY STALE/, 'a fresh handoff is not flagged stale');
  assert.doesNotMatch(out, /CAPTURE HEALTH: EMPTY/, 'a non-empty handoff is not flagged empty');
});

test('continue: a handoff older than a day degrades LOUDLY as POSSIBLY STALE', async (t) => {
  const cwd = '/tmp/stale-cwd';
  const { file, home } = await withProjectTranscript(t, cwd, 'stale.jsonl', big('两天前的工作 STALE-WORK，可能过时。'.repeat(3)));
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  await fs.utimes(file, twoDaysAgo, twoDaysAgo); // backdate the transcript so it reads as stale
  const out = execFileSync(process.execPath, [CLI, 'continue', '--cwd', cwd], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'unrelated', IHOW_HANDOFF_METRICS: '0' },
  });
  assert.match(out, /⚠️ CAPTURE HEALTH: POSSIBLY STALE/, 'an old handoff raises the loud stale banner');
  assert.match(out, /capture hook may have stopped firing/, 'tells the user why it might be stale');
});

test('continue: NO captured session degrades LOUDLY as EMPTY (never hands over silence)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
  });
  // a cwd Claude Code never recorded -> no project dir, no markers -> empty capture
  const out = execFileSync(process.execPath, [CLI, 'continue', '--cwd', '/tmp/never-recorded-xyz'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, CLAUDE_CODE_SESSION_ID: 'unrelated', IHOW_HANDOFF_METRICS: '0' },
  });
  assert.match(out, /⚠️ CAPTURE HEALTH: EMPTY/, 'an empty capture raises the loud empty banner');
  assert.match(out, /NO handoff narrative to resume/, 'is explicit there is nothing to resume');
});
