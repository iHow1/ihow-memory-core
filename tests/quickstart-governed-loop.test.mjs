// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// SHIP-BLOCKER regression (alpha.17): the README §"The governed loop in 60 seconds" copy-paste block
// must actually run clean for a brand-new user. Two faults this locks:
//   (1) write-candidate auto-promotes by DEFAULT, so the documented write→promote two-step needs
//       `--no-auto-promote` or `promote $CAND` fails (candidate already moved) → $PROMOTED empty →
//       `read ""` resolves to the memory ROOT dir → cryptic `EISDIR`.
//   (2) `read` with an empty/missing path must fail with a CLEAN actionable message + non-zero exit,
//       never a raw `EISDIR` (the symptom an empty shell var produced).
// We also lock the DOCUMENTED DEFAULT (auto-promote ON → one-step durable) so the README note stays true.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));

// Run the CLI in an isolated memory home. Returns { code, stdout, stderr }; never throws on non-zero.
function run(home, args) {
  const env = { ...process.env, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: path.join(home, '.state') };
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
// Mirror the README's path extraction (sed grabbing the first JSON "path").
const firstPath = (out) => {
  const m = out.match(/"path":\s*"([^"]+)"/);
  return m ? m[1] : '';
};

test('README §3 governed-loop block runs clean end-to-end (write→promote→read, no EISDIR)', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-quickstart-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });

  assert.equal(run(home, ['init', '--space', 'demo']).code, 0, 'init');

  const wc = run(home, ['write-candidate', 'Decision: ship weekly release notes.', '--no-auto-promote', '--space', 'demo']);
  assert.equal(wc.code, 0, 'write-candidate exits 0');
  const cand = firstPath(wc.stdout);
  assert.match(cand, /memory\/candidate\/inbox\//, '--no-auto-promote → a proposed inbox candidate, not yet durable');
  // The extraction yields exactly ONE path (no second autoPromote.path line to corrupt the shell var).
  assert.equal((wc.stdout.match(/"path":/g) || []).length, 1, 'one path field — no autoPromote.path duplicate');

  const pr = run(home, ['promote', cand, '--scope', 'team', '--title', 'Release notes cadence', '--space', 'demo']);
  assert.equal(pr.code, 0, 'promote exits 0');
  const promoted = firstPath(pr.stdout);
  assert.match(promoted, /memory\/scopes\/team\//, 'promote → durable team scope');
  assert.ok(promoted.length > 0, 'promoted path is non-empty (the var that fed read)');

  const search = run(home, ['search', 'release notes', '--space', 'demo']);
  assert.equal(search.code, 0, 'search exits 0');

  const rd = run(home, ['read', promoted, '--space', 'demo']);
  assert.equal(rd.code, 0, 'read exits 0');
  assert.doesNotMatch(rd.stdout + rd.stderr, /EISDIR/, 'no EISDIR');
  assert.match(rd.stdout, /ship weekly release notes/, 'read returns the durable content');
});

test('read with an empty or missing path fails CLEANLY (non-zero, actionable) — never raw EISDIR', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-readguard-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  run(home, ['init', '--space', 'demo']);

  for (const args of [['read', '', '--space', 'demo'], ['read', '--space', 'demo']]) {
    const r = run(home, args);
    assert.notEqual(r.code, 0, `\`${args.join(' ')}\` exits non-zero`);
    assert.match(r.stderr, /missing memory path/, 'clean actionable message');
    assert.doesNotMatch(r.stdout + r.stderr, /EISDIR/, 'no raw EISDIR leaks to the user');
  }
});

test('DEFAULT write-candidate (no flag) auto-promotes in one step — documented behaviour stays true', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-autopromote-'));
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  run(home, ['init', '--space', 'demo']);

  const wc = run(home, ['write-candidate', 'Decision: ship weekly release notes.', '--space', 'demo']);
  assert.equal(wc.code, 0);
  assert.match(wc.stdout, /"status":\s*"promoted"/, 'default → already durable (auto-promote)');
  const p = firstPath(wc.stdout);
  // The returned top-level path is the DURABLE one, so a naive write→promote(path) two-step would now
  // hit candidate_not_found — which is exactly why the README block opts out with --no-auto-promote.
  assert.match(p, /memory\/scopes\//, 'returned path is the durable destination, not an inbox candidate');
});
