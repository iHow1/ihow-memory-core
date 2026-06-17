// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// automation-v2 capture FLOOR tests (the SessionStart hook). When a new session starts, the hook
// looks back at the PREVIOUS session's Stop marker and — only if that session did NOT cooperatively
// journal — deterministically summarizes its transcript and writes a LOW-WEIGHT, rollbackable journal
// entry (sourceAgent='claude-code-hook'). Verified deterministically by piping fake SessionStart
// payloads and seeding markers/transcripts on disk:
//   - real jsonl shape -> a redacted floor journal lands; the marker is flipped processed.
//   - bounded scan: stale (>48h) markers and the current session's own marker are NEVER floored.
//   - dedup: a session that already has a cooperative journal in its window is NOT floored (no
//     double-write); re-running the hook stays idempotent.
//   - redact zero-hit: a floor body that contained an email is hard-detector-clean on disk.
//   - unreadable transcript -> floorOutcome='unreadable', no journal, never throws.
//   - recall stays OFF: the hook writes NO context to stdout.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { containsSecretLikeContent } from '../src/governance.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}
function iso(msAgo) {
  return new Date(Date.now() - msAgo).toISOString();
}
function runSessionStart(payload, root, space) {
  return execFileSync(process.execPath, [CLI, 'hook-session-start', '--root', root, '--space', space], {
    encoding: 'utf8',
    input: JSON.stringify(payload),
  });
}
function runJournal(text, actor, root, space) {
  return execFileSync(process.execPath, [CLI, 'journal', text, '--actor', actor, '--root', root, '--space', space], { encoding: 'utf8' });
}
function runAudit(root, space) {
  return JSON.parse(execFileSync(process.execPath, [CLI, 'audit', '--root', root, '--space', space], { encoding: 'utf8' }));
}
function runRollback(eventId, root, space) {
  return JSON.parse(execFileSync(process.execPath, [CLI, 'rollback', '--event', eventId, '--root', root, '--space', space], { encoding: 'utf8' }));
}
// Seed a v2 Stop marker on disk under <root>/<space>/.hooks/.
async function writeMarker(root, space, name, marker) {
  const dir = path.join(root, space, '.hooks');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `stop-${name}.json`);
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 2, processed: false, ...marker }), 'utf8');
  return file;
}
async function readMarker(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}
// All journal markdown across BOTH lanes (main + _mcp) for the managed space.
async function journalText(root, space) {
  const dirs = [path.join(root, space, 'memory', 'journal'), path.join(root, space, 'memory', '_mcp', 'journal')];
  let all = '';
  for (const dir of dirs) {
    let files;
    try { files = (await fs.readdir(dir)).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) all += await fs.readFile(path.join(dir, f), 'utf8');
  }
  return all;
}
// A realistic transcript jsonl: string + array content, a tool_use turn, non-conversational + malformed
// lines, and a SUBSTANTIVE terminal handoff segment (>=160 chars) so v2 picks it as the closing.
function realTranscript(closing) {
  return [
    JSON.stringify({ type: 'user', message: { content: '帮我把官网收口' } }),
    JSON.stringify({ type: 'attachment', foo: 1 }), // non-conversational -> skipped
    'not json at all {{{', // malformed -> skipped
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/Users/x/site/index.html' } }, { type: 'text', text: '读了首页，准备改导航。' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '中间汇报：导航改完，验证中。' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: closing }] } }),
  ].join('\n') + '\n';
}

test('floor: real-shape prior session -> a redacted floor journal lands, marker flipped processed', async (t) => {
  const root = await mkdtempReal('ihow-floor-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const transcript = path.join(root, 'prev.jsonl');
  const closing = '交接：官网新版已上线但验证仍 pending，blocked on 用户授权超时；下一步切回中文核对再收口，状态可 rollback。'.repeat(2);
  await fs.writeFile(transcript, realTranscript(closing), 'utf8');
  const markerFile = await writeMarker(root, space, 'prev', {
    sessionId: 'prev-sess',
    cwd: root,
    transcriptPath: transcript,
    hookStartedAt: iso(10 * 60 * 1000),
    hookLastAt: iso(9 * 60 * 1000),
    markerCreatedAt: iso(10 * 60 * 1000),
    prompts: 1,
    lastEntries: 6,
  });

  const out = runSessionStart({ session_id: 'new-sess', cwd: root, transcript_path: path.join(root, 'new.jsonl') }, root, space);
  assert.equal(out.trim(), '', 'recall OFF: SessionStart injects no context to stdout');

  const m = await readMarker(markerFile);
  assert.equal(m.processed, true, 'prior marker flipped processed');
  assert.equal(m.floorOutcome, 'journaled');
  assert.ok(typeof m.floorEventId === 'string' && m.floorEventId.length > 0, 'floor event id recorded for rollback/audit');

  const j = await journalText(root, space);
  assert.match(j, /claude-code-hook · auto-capture \(deterministic\)/, 'low-weight floor entry attributed to the hook');
  assert.match(j, /验证仍 pending/, 'captured the terminal handoff (v2 last substantive segment)');
  assert.match(j, /index\.html/, 'in-scope file path captured');
  assert.ok(!j.includes('中间汇报'), 'did NOT freeze the stale mid-session report');
});

test('floor: bounded scan — stale (>48h) and the current session are never floored', async (t) => {
  const root = await mkdtempReal('ihow-floor-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const staleTranscript = path.join(root, 'stale.jsonl');
  const curTranscript = path.join(root, 'cur.jsonl');
  const closing = '交接：这是一个足够长的实质收尾段，描述了当前状态、下一步与可回滚点，长度超过阈值用于被段选择器选中。'.repeat(2);
  await fs.writeFile(staleTranscript, realTranscript(closing), 'utf8');
  await fs.writeFile(curTranscript, realTranscript(closing), 'utf8');
  const staleFile = await writeMarker(root, space, 'stale', {
    sessionId: 'stale-sess', cwd: root, transcriptPath: staleTranscript,
    hookStartedAt: iso(72 * 60 * 60 * 1000), hookLastAt: iso(72 * 60 * 60 * 1000), markerCreatedAt: iso(72 * 60 * 60 * 1000),
  });
  const ownFile = await writeMarker(root, space, 'cur', {
    sessionId: 'cur-sess', cwd: root, transcriptPath: curTranscript,
    hookStartedAt: iso(5 * 60 * 1000), hookLastAt: iso(4 * 60 * 1000), markerCreatedAt: iso(5 * 60 * 1000),
  });

  runSessionStart({ session_id: 'cur-sess', cwd: root, transcript_path: curTranscript }, root, space);

  assert.equal((await readMarker(staleFile)).processed, false, 'stale (>48h) marker is outside the lookback — left untouched');
  assert.equal((await readMarker(ownFile)).processed, false, 'the current session never floors itself');
  assert.equal(await journalText(root, space), '', 'no floor journal written');
});

test('floor: dedup — a cooperatively-journaled session is NOT floored, and re-runs stay idempotent', async (t) => {
  const root = await mkdtempReal('ihow-floor-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const transcript = path.join(root, 'prev.jsonl');
  const closing = '交接：足够长的实质收尾段用于触发段选择器，描述状态/下一步/回滚点，超过最小阈值以避免回退到最长段。'.repeat(2);
  await fs.writeFile(transcript, realTranscript(closing), 'utf8');
  const markerFile = await writeMarker(root, space, 'prev', {
    sessionId: 'prev-sess', cwd: root, transcriptPath: transcript,
    hookStartedAt: iso(10 * 60 * 1000), hookLastAt: iso(9 * 60 * 1000), markerCreatedAt: iso(10 * 60 * 1000),
  });

  // The session already journaled cooperatively in-session (the Stop-hook nudge worked). actor != hook.
  runJournal('cooperative in-session handoff', 'claude-code', root, space);
  const before = await journalText(root, space);

  runSessionStart({ session_id: 'new-sess', cwd: root, transcript_path: path.join(root, 'new.jsonl') }, root, space);
  const m = await readMarker(markerFile);
  assert.equal(m.processed, true);
  assert.equal(m.floorOutcome, 'skipped-cooperative', 'floor defers to the cooperative capture (no double-write)');
  assert.equal(m.floorEventId, undefined, 'no floor entry id — nothing was written');

  const after = await journalText(root, space);
  assert.ok(!after.includes('claude-code-hook'), 'no floor entry — the floor is a backstop, not a duplicate');
  assert.equal(after, before, 'journal unchanged by the skipped floor');

  // Re-running the hook (Stop/SessionStart fire often) must not write a duplicate either.
  runSessionStart({ session_id: 'new-sess-2', cwd: root, transcript_path: path.join(root, 'new2.jsonl') }, root, space);
  assert.equal(await journalText(root, space), before, 'idempotent: no duplicate floor on a later start');
});

test('floor: redact zero-hit — a body that contained an email is hard-detector-clean on disk', async (t) => {
  const root = await mkdtempReal('ihow-floor-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const transcript = path.join(root, 'prev.jsonl');
  const closing = '上线收口：新版已发布并独立验证完成；企业咨询请联系 hi@ihowmemory.com，按钮点击即可复制该邮箱地址。'.repeat(3);
  await fs.writeFile(transcript, realTranscript(closing), 'utf8');
  const markerFile = await writeMarker(root, space, 'prev', {
    sessionId: 'prev-sess', cwd: root, transcriptPath: transcript,
    hookStartedAt: iso(10 * 60 * 1000), hookLastAt: iso(9 * 60 * 1000), markerCreatedAt: iso(10 * 60 * 1000),
  });

  runSessionStart({ session_id: 'new-sess', cwd: root, transcript_path: path.join(root, 'new.jsonl') }, root, space);

  assert.equal((await readMarker(markerFile)).floorOutcome, 'journaled');
  const j = await journalText(root, space);
  assert.ok(!j.includes('hi@ihowmemory.com'), 'the email VALUE was redacted out of the floor entry');
  assert.ok(!containsSecretLikeContent(j), 'POST-redaction the on-disk floor journal is hard-detector zero-hit (OpenClaw §3.5)');
  assert.ok(j.includes('上线收口'), 'redaction preserved the surrounding useful content');
});

test('floor: dedup window is SAME-CWD (a journal landing after another cwd started still credits its own session)', async (t) => {
  // Regression for OpenClaw 2026-06-17 §4: the SessionStart dedup upper bound must match the metrics
  // oracle (next SAME-CWD marker), not "next any-cwd marker". P (cwd a) ran; then Q (cwd b) started in a
  // different project sharing the workspace; then P's handoff journal lands. With an any-cwd bound, Q's
  // start would close P's window early and exclude P's journal -> false floor (double-write). With the
  // same-cwd bound, P's window stays open and the journal is correctly credited -> skip.
  const root = await mkdtempReal('ihow-floor-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const transcript = path.join(root, 'p.jsonl');
  const closing = '交接：cwd A 的会话足够长的实质收尾段,描述状态/下一步/回滚点,超过最小阈值用于被段选择器选中而非回退最长。'.repeat(2);
  await fs.writeFile(transcript, realTranscript(closing), 'utf8');
  const pFile = await writeMarker(root, space, 'P-cwdA', {
    sessionId: 'P-sess', cwd: '/proj/a', transcriptPath: transcript,
    hookStartedAt: iso(30 * 60 * 1000), hookLastAt: iso(29 * 60 * 1000), markerCreatedAt: iso(30 * 60 * 1000),
  });
  // A different-cwd session started AFTER P. It is already processed (not a candidate) — present only so
  // it would (wrongly) bound P's window under the old any-cwd logic.
  await writeMarker(root, space, 'Q-cwdB', {
    sessionId: 'Q-sess', cwd: '/proj/b', transcriptPath: path.join(root, 'q.jsonl'),
    hookStartedAt: iso(20 * 60 * 1000), hookLastAt: iso(20 * 60 * 1000), markerCreatedAt: iso(20 * 60 * 1000),
    processed: true, floorOutcome: 'skipped-cooperative',
  });
  // P's cooperative handoff lands now (after Q started). It belongs to P's still-open same-cwd window.
  runJournal('P 的迟到协作 handoff', 'claude-code', root, space);

  runSessionStart({ session_id: 'new-sess', cwd: root, transcript_path: path.join(root, 'new.jsonl') }, root, space);

  assert.equal((await readMarker(pFile)).floorOutcome, 'skipped-cooperative', 'same-cwd open-ended window credits P\'s late journal (would be journaled=false-floor under any-cwd bound)');
  assert.ok(!(await journalText(root, space)).includes('claude-code-hook'), 'no floor double-write');
});

test('floor: a journaled floor entry is audit-visible and rollback-able by its floorEventId (OpenClaw §5.1)', async (t) => {
  const root = await mkdtempReal('ihow-floor-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const transcript = path.join(root, 'prev.jsonl');
  const closing = '交接：足够长的实质收尾段用于触发段选择器,描述状态/下一步/回滚点,超过最小阈值,这条会被 floor 兜底记下来。'.repeat(2);
  await fs.writeFile(transcript, realTranscript(closing), 'utf8');
  const markerFile = await writeMarker(root, space, 'prev', {
    sessionId: 'prev-sess', cwd: root, transcriptPath: transcript,
    hookStartedAt: iso(10 * 60 * 1000), hookLastAt: iso(9 * 60 * 1000), markerCreatedAt: iso(10 * 60 * 1000),
  });

  runSessionStart({ session_id: 'new-sess', cwd: root, transcript_path: path.join(root, 'new.jsonl') }, root, space);
  const m = await readMarker(markerFile);
  assert.equal(m.floorOutcome, 'journaled');
  const eventId = m.floorEventId;
  assert.ok(typeof eventId === 'string' && eventId.length > 0, 'floorEventId recorded');

  // audit-visible (both lanes), attributed to the floor actor
  const audit = runAudit(root, space);
  const ev = audit.find((e) => e.id === eventId);
  assert.ok(ev, 'floor event is visible in `audit`');
  assert.equal(ev.type, 'memory.journal.appended');
  assert.equal(ev.actor, 'claude-code-hook');
  assert.ok((await journalText(root, space)).includes('floor 兜底记下来'), 'floor body on disk before rollback');

  // rollback-able by that eventId -> entry removed
  const rb = runRollback(eventId, root, space);
  assert.equal(rb.removed, true, 'rollback removed the floor entry');
  assert.ok(!(await journalText(root, space)).includes('floor 兜底记下来'), 'floor body gone after rollback');
});

test('floor: unreadable transcript -> floorOutcome=unreadable, no journal, never throws', async (t) => {
  const root = await mkdtempReal('ihow-floor-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const space = 'h';
  const markerFile = await writeMarker(root, space, 'gone', {
    sessionId: 'gone-sess', cwd: root, transcriptPath: path.join(root, 'does-not-exist.jsonl'),
    hookStartedAt: iso(10 * 60 * 1000), hookLastAt: iso(9 * 60 * 1000), markerCreatedAt: iso(10 * 60 * 1000),
  });

  const out = runSessionStart({ session_id: 'new-sess', cwd: root, transcript_path: path.join(root, 'new.jsonl') }, root, space);
  assert.equal(out.trim(), '', 'no crash, no output');
  const m = await readMarker(markerFile);
  assert.equal(m.processed, true, 'still flipped processed so we do not retry a missing transcript forever');
  assert.equal(m.floorOutcome, 'unreadable');
  assert.equal(await journalText(root, space), '', 'no journal written for an unreadable transcript');
});
