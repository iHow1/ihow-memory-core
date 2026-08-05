// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Resume AWARENESS (not auto-resume). On a FRESH context (new session / after /clear) the SessionStart
// hook surfaces a ONE-LINE pointer that a prior session is resumable — never its content. This keeps a
// deliberate clean start unpolluted: nothing prior is loaded unless the user says "继续" (content is
// opt-in). The hint is opt-out (IHOW_RESUME_HINT=0), skipped on 'compact'/'resume' sources, and names
// exactly what `continue` would resume (reuses the same discovery). Driven by the documented
// SessionStart additionalContext form.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' });

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  git(dir, ['init', '-q']);
  git(dir, ['config', 'user.email', 't@example.com']);
  git(dir, ['config', 'user.name', 'T']);
  await fs.writeFile(path.join(dir, 'seed.txt'), 'x\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '-m', 'seed']);
}

function editedTranscript(repo, narrativeMarker) {
  const u = (c) => JSON.stringify({ type: 'user', message: { content: c } });
  const asst = (blocks) => JSON.stringify({ type: 'assistant', message: { content: blocks } });
  const tool = (name, fp) => ({ type: 'tool_use', name, input: { file_path: fp } });
  const text = (t) => ({ type: 'text', text: t });
  return [
    u('继续干'),
    asst([tool('Edit', path.join(repo, 'a.js')), text('改了 a.js')]),
    asst([tool('Edit', path.join(repo, 'b.js')), text('又改了 b.js')]),
    asst([text(`交接：${narrativeMarker} 下一步继续完善功能。`.repeat(2))]),
  ].join('\n') + '\n';
}

// Seed a prior session's transcript under HOME/.claude/projects/<encoded-cwd>/ and return {home, root}.
async function seed(t, cwd, repo, narrativeMarker) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-root-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'prev.jsonl'), editedTranscript(repo, narrativeMarker), 'utf8');
  return { home, root };
}

function runHook(payload, root, env) {
  return execFileSync(process.execPath, [CLI, 'hook-session-start', '--root', root, '--space', 'hinttest'], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
    env: { ...process.env, ...env },
  });
}

test('SessionStart: fresh context surfaces a one-line resumable POINTER (project + 继续), not the content', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  const repo = path.join(base, 'projHint');
  await makeRepo(repo);
  const cwd = '/tmp/hint-proj-cwd';
  const { home, root } = await seed(t, cwd, repo, 'SECRET-NARRATIVE-BODY');

  const out = runHook({ session_id: 'newsess', cwd, source: 'startup' }, root, { HOME: home });
  assert.match(out, /"hookEventName":"SessionStart"/, 'emitted via the SessionStart additionalContext form');
  assert.match(out, /resumable session is available/, 'tells the user a session is resumable');
  assert.match(out, /projHint/, 'names the project continue would resume');
  assert.match(out, /继续/, 'points at the opt-in trigger');
  assert.doesNotMatch(out, /SECRET-NARRATIVE-BODY/, 'POINTER only — never injects the prior narrative content');
});

test('SessionStart: IHOW_RESUME_HINT=0 suppresses the hint (opt-out honored)', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  const repo = path.join(base, 'projHint');
  await makeRepo(repo);
  const cwd = '/tmp/hint-optout-cwd';
  const { home, root } = await seed(t, cwd, repo, 'X');
  const out = runHook({ session_id: 'newsess', cwd, source: 'startup' }, root, { HOME: home, IHOW_RESUME_HINT: '0' });
  assert.doesNotMatch(out, /resumable session/, 'no hint when opted out');
});

test('SessionStart: a compaction continuation is NOT nudged (only a fresh start is)', async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-base-'));
  t.after(async () => { await fs.rm(base, { recursive: true, force: true }); });
  const repo = path.join(base, 'projHint');
  await makeRepo(repo);
  const cwd = '/tmp/hint-compact-cwd';
  const { home, root } = await seed(t, cwd, repo, 'X');
  const out = runHook({ session_id: 'newsess', cwd, source: 'compact' }, root, { HOME: home });
  assert.doesNotMatch(out, /resumable session/, 'mid-session compaction is the same task continuing — no fresh-start nudge');
});
