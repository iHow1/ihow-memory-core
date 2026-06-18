// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// `continue` command integration. The command assembles a verify-first handoff envelope from the most
// recent Stop marker's transcript (lazily, no hook needed) + live git anchors, filtered to the cwd.
// These tests lock the command's behavior on the real CLI/disk: the prior narrative is carried under
// the UNVERIFIED banner (design lock), the fixed receiver protocol is present, a marker for a
// different cwd is not used, and an absent prior session degrades to an honest refusal.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));

function mkdtemp(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
function iso(agoMs = 0) {
  return new Date(Date.now() - agoMs).toISOString();
}
async function writeMarker(root, space, name, marker) {
  const dir = path.join(root, space, '.hooks');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `stop-${name}.json`);
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, processed: false, ...marker }), 'utf8');
  return file;
}
function transcriptWith(closing) {
  return (
    [
      JSON.stringify({ type: 'user', message: { content: '继续修 token 刷新' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: closing }] } }),
    ].join('\n') + '\n'
  );
}
function runContinue(root, space, cwd) {
  return execFileSync(process.execPath, [CLI, 'continue', '--root', root, '--space', space, '--cwd', cwd], {
    encoding: 'utf8',
  });
}

test('continue: assembles an envelope from the latest Stop marker transcript', async (t) => {
  const root = await mkdtemp('ihow-continue-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const space = 'h';
  const cwd = path.join(root, 'work');
  await fs.mkdir(cwd, { recursive: true });
  const transcript = path.join(root, 'prev.jsonl');
  const closing =
    '已经实现了 token 刷新的核心逻辑并提交。下一步: 给刷新流程补一个失败重试的测试, 并在 README 记录新环境变量。这两步还没做, 是本次交接的待办。'.repeat(2);
  await fs.writeFile(transcript, transcriptWith(closing), 'utf8');
  await writeMarker(root, space, 'prev', {
    sessionId: 'prev-sess',
    cwd,
    transcriptPath: transcript,
    hookLastAt: iso(60000),
    markerCreatedAt: iso(60000),
  });

  const out = runContinue(root, space, cwd);
  assert.match(out, /attributed transport envelope/);
  assert.match(out, /MACHINE ANCHORS/);
  assert.match(out, /UNVERIFIED/);
  assert.match(out, /token 刷新/, 'the prior narrative is carried into the envelope');
  assert.match(out, /RECEIVER PROTOCOL/);
  assert.match(out, /PREFLIGHT/);
  assert.ok(out.indexOf('token 刷新') > out.indexOf('UNVERIFIED'), 'narrative is under the UNVERIFIED banner (design lock)');
});

test('continue: honest refusal when there is no prior session for this cwd', async (t) => {
  const root = await mkdtemp('ihow-continue-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const space = 'h';
  const cwd = path.join(root, 'work');
  await fs.mkdir(cwd, { recursive: true });

  const out = runContinue(root, space, cwd);
  assert.match(out, /attributed transport envelope/, 'still prints the envelope frame');
  assert.match(out, /no substantive prior-session summary/, 'empty narrative is stated honestly');
  assert.match(out, /no captured prior session/i, 'points the user to install-hook');
});

test('continue: a Stop marker for a different cwd is not used', async (t) => {
  const root = await mkdtemp('ihow-continue-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const space = 'h';
  const cwdA = path.join(root, 'A');
  const cwdB = path.join(root, 'B');
  await fs.mkdir(cwdA, { recursive: true });
  await fs.mkdir(cwdB, { recursive: true });
  const transcriptB = path.join(root, 'b.jsonl');
  await fs.writeFile(transcriptB, transcriptWith('B 项目的交接内容: 完成了某模块的重构, 下一步迁移调用方。'.repeat(4)), 'utf8');
  await writeMarker(root, space, 'b', {
    sessionId: 'b-sess',
    cwd: cwdB,
    transcriptPath: transcriptB,
    hookLastAt: iso(1000),
    markerCreatedAt: iso(1000),
  });

  const out = runContinue(root, space, cwdA);
  assert.doesNotMatch(out, /B 项目的交接内容/, 'a different-cwd marker must not be picked');
  assert.match(out, /no captured prior session/i, 'cwd A has no marker -> honest refusal');
});
