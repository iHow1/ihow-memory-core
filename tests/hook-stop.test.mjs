// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.4 Stop-hook handler tests. The hook reads the Claude Code Stop payload on stdin and,
// for a substantive session not yet captured, emits {decision:"block", reason} so the agent
// records a memory handoff before stopping. Verified deterministically by piping fake payloads:
// recursion guard, triviality skip, the decision:block emission, and once-per-session idempotency.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

function runHookStop(payload, root, space) {
  return execFileSync(process.execPath, [CLI, 'hook-stop', '--root', root, '--space', space], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
  });
}

test('hook-stop: recursion guard — stop_hook_active emits nothing', async (t) => {
  const root = await mkdtempReal('ihow-hook-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const out = runHookStop({ stop_hook_active: true, session_id: 's1' }, root, 'h');
  assert.equal(out.trim(), '');
});

test('hook-stop: trivial session (no/short transcript) emits nothing', async (t) => {
  const root = await mkdtempReal('ihow-hook-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const out = runHookStop({ session_id: 's2' }, root, 'h'); // no transcript_path => trivial
  assert.equal(out.trim(), '');
});

test('hook-stop: substantive session emits decision:block once, then is idempotent', async (t) => {
  const root = await mkdtempReal('ihow-hook-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const transcript = path.join(root, 'transcript.jsonl');
  await fs.writeFile(
    transcript,
    ['{"role":"user"}', '{"role":"assistant"}', '{"role":"user"}', '{"role":"assistant"}', '{"role":"user"}'].join('\n') + '\n',
    'utf8',
  );
  const payload = { session_id: 's3', transcript_path: transcript };

  const out1 = runHookStop(payload, root, 'h');
  const parsed = JSON.parse(out1);
  assert.equal(parsed.decision, 'block');
  assert.match(parsed.reason, /memory\.journal/);

  // Stop fires every turn; a second invocation in the same session (no growth, nothing captured)
  // must be a no-op — no duplicate prompt.
  const out2 = runHookStop(payload, root, 'h');
  assert.equal(out2.trim(), '');
});

test('hook-stop: re-prompts as the session grows, then stops once a journal entry is captured', async (t) => {
  const root = await mkdtempReal('ihow-hook-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const mkTranscript = async (n) => {
    const p = path.join(root, `t${n}.jsonl`);
    await fs.writeFile(p, Array.from({ length: n }, (_, i) => `{"i":${i}}`).join('\n') + '\n', 'utf8');
    return p;
  };
  // first substantive stop → prompt
  assert.equal(JSON.parse(runHookStop({ session_id: 'g1', transcript_path: await mkTranscript(5) }, root, 'h')).decision, 'block');
  // grew by >= 6 entries, nothing captured yet → re-prompt (at-least-once, not permanent miss)
  assert.equal(JSON.parse(runHookStop({ session_id: 'g1', transcript_path: await mkTranscript(12) }, root, 'h')).decision, 'block');
  // a journal entry now lands in the same workspace
  execFileSync(process.execPath, [CLI, 'journal', 'captured handoff', '--root', root, '--space', 'h'], { encoding: 'utf8' });
  // session grows again, but the audit log shows capture happened → no more prompts (no duplicate spam)
  assert.equal(runHookStop({ session_id: 'g1', transcript_path: await mkTranscript(20) }, root, 'h').trim(), '');
});

test('hook-stop: marker records the session window (session_id/cwd/transcriptPath/startedAt) for correlation', async (t) => {
  const root = await mkdtempReal('ihow-hook-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const transcript = path.join(root, 'win.jsonl');
  await fs.writeFile(
    transcript,
    ['{"role":"user"}', '{"role":"assistant"}', '{"role":"user"}', '{"role":"assistant"}', '{"role":"user"}'].join('\n') + '\n',
    'utf8',
  );
  runHookStop({ session_id: 'win-sess', cwd: root, transcript_path: transcript }, root, 'h');

  const hooksDir = path.join(root, 'h', '.hooks');
  const files = (await fs.readdir(hooksDir)).filter((f) => f.startsWith('stop-') && f.endsWith('.json'));
  assert.equal(files.length, 1, 'exactly one stop marker');
  const m = JSON.parse(await fs.readFile(path.join(hooksDir, files[0]), 'utf8'));
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.sessionId, 'win-sess');
  assert.equal(m.cwd, root);
  assert.equal(m.transcriptPath, transcript);
  assert.ok(typeof m.startedAt === 'string' && !Number.isNaN(Date.parse(m.startedAt)), 'startedAt is an ISO timestamp');
  assert.ok(typeof m.lastAt === 'string' && !Number.isNaN(Date.parse(m.lastAt)), 'lastAt is an ISO timestamp');
});
