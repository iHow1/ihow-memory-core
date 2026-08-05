// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// automation-v2.1 CROSS-RUNTIME capture floor. The Claude-Code floor is marker-driven (SessionStart
// hook). This sweep — fired from MCP-server startup — brings the SAME deterministic, redacted, low-weight
// capture to runtimes that connect the MCP server but install no native hook (Codex / Hermes / OpenCode /
// WorkBuddy / OpenClaw), the exact gap real test users hit ("it doesn't auto-record; I have to remind the
// agent"). These lock the post-adversarial-review contract: floors an idle non-Claude session once,
// dedups on a COMPOSITE (runtime, sessionId) key, self-excludes the live session by a generous idle gate,
// never sweeps Claude, does NOT let a nearby cooperative/Claude-floor journal suppress a real capture
// (xrt-1), floors same-id-different-runtime sessions independently (dedup-2), skips a session with no
// usable id (dedup-5), and redacts secret VALUES before writing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';
import { runCaptureFloorSweep } from '../src/floor.ts';
import { appendFloorJournalOnce } from '../src/governance.ts';
import { listResumableSessions } from '../src/handoff.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const IDLE_OLD = 40 * 60 * 1000; // > the 30-min idle gate -> eligible
const NARR = 'FLOOR-NARRATIVE 这是最近一段跨 runtime 工作,做了若干改动并验证,下一步继续收口。'.repeat(2);

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

const codexMeta = (id, cwd) =>
  JSON.stringify({ timestamp: '2026-06-19T00:00:00Z', type: 'session_meta', payload: { id, cwd, git: {} } });
const codexMsg = (role, text) =>
  JSON.stringify({ timestamp: '2026-06-19T00:00:01Z', type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

async function plantCodexSession(home, { id, cwd = '/tmp/codexproj', text = NARR, mtimeMs }) {
  const dir = path.join(home, '.codex', 'sessions', '2026', '06', '19');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl`);
  const raw = [codexMeta(id, cwd), codexMsg('user', '继续做这个项目,接着上一段。'.repeat(2)), codexMsg('assistant', text)].join('\n') + '\n';
  await fs.writeFile(file, raw, 'utf8');
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

// WorkBuddy: ~/.workbuddy/projects/<encoded-cwd>/<file>.jsonl, records {type:'message',role,content,cwd,sessionId}.
async function plantWorkbuddySession(home, { id, cwd = '/tmp/wbproj', text = NARR, mtimeMs }) {
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(home, '.workbuddy', 'projects', encoded);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id || 'wb-anon'}.jsonl`);
  const rec = (role, content) => JSON.stringify({ type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text: content }], cwd, sessionId: id });
  const raw = [rec('user', '继续做这个 workbuddy 项目,接着上一段。'.repeat(2)), rec('assistant', text)].join('\n') + '\n';
  await fs.writeFile(file, raw, 'utf8');
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

// Hermes legacy JSON: ~/.hermes/sessions/session_*.json. projectDir is mined from tool-call workdirs by
// chooseHermesProject, which probes EACH workdir with a synchronous git — the one reader-internal git path.
async function plantHermesSession(home, { id, repo, text = NARR, mtimeMs }) {
  const dir = path.join(home, '.hermes', 'sessions');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `session_${id}.json`);
  const doc = {
    session_id: id,
    messages: [
      { role: 'user', content: '继续做这个 hermes 项目,接着上一段。'.repeat(2) },
      { role: 'assistant', content: text, tool_calls: [{ function: { name: 'terminal', arguments: JSON.stringify({ workdir: repo, command: 'ls' }) } }] },
    ],
  };
  await fs.writeFile(file, JSON.stringify(doc), 'utf8');
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

async function plantClaudeSession(home, { id, cwd = '/tmp/claudeproj', text = NARR, mtimeMs }) {
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const dir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [
    JSON.stringify({ type: 'user', message: { content: '继续做这个项目,接着上一段。' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
    JSON.stringify({ type: 'user', message: { content: '好的。' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }),
  ];
  await fs.writeFile(file, lines.join('\n') + '\n', 'utf8');
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

async function setup(t) {
  const home = await mkdtempReal('ihow-floor-home-');
  const root = await mkdtempReal('ihow-floor-root-');
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  const core = await openCore({ root, space: 'floortest' });
  return { core, home, setHome: () => { process.env.HOME = home; } };
}

async function floorEvents(core) {
  return (await core.audit()).filter((e) => e.type === 'memory.journal.appended' && e?.metadata?.floor === true);
}
function readJournal(core, day) {
  return fs.readFile(path.join(core.workspace.memoryDir, 'journal', `${day}.md`), 'utf8');
}

test('floors an idle Codex session once: low-weight entry, codex-floor actor, composite key stamped', async (t) => {
  const { core, home, setHome } = await setup(t);
  const now = Date.now();
  await plantCodexSession(home, { id: 'codex-sess-1', mtimeMs: now - IDLE_OLD });
  setHome();

  const res = await runCaptureFloorSweep(core.workspace, { now, reindex: () => core.rebuild() });
  assert.equal(res.journaled, 1, 'one session floored');
  const fe = await floorEvents(core);
  assert.equal(fe.length, 1, 'exactly one floor audit event');
  assert.equal(fe[0].actor, 'codex-floor', 'actor tags the runtime + floor');
  assert.equal(fe[0].metadata.sessionId, 'codex-sess-1');
  assert.equal(fe[0].metadata.floorRuntime, 'codex', 'composite key carries the runtime');
  assert.equal(fe[0].metadata.weight, 'low', 'always low weight — never authoritative');
  assert.match(await readJournal(core, fe[0].metadata.day), /FLOOR-NARRATIVE/, 'session narrative captured');
});

test('Codex SessionStart hook triggers the Codex floor sweep while excluding the live session', async (t) => {
  const { core, home } = await setup(t);
  const now = Date.now();
  await plantCodexSession(home, { id: 'prior-codex', mtimeMs: now - IDLE_OLD });
  await plantCodexSession(home, { id: 'live-codex', text: 'LIVE-SHOULD-NOT-FLOOR '.repeat(8), mtimeMs: now });

  const out = execFileSync(process.execPath, [CLI, 'hook-session-start', '--runtime', 'codex', '--root', core.workspace.root, '--space', core.workspace.space], {
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'live-codex', source: 'startup', cwd: '/tmp/codexproj' }),
    env: { ...process.env, HOME: home, IHOW_RESUME_HINT: '0' },
  });
  assert.equal(out.trim(), '', 'floor hook is silent when resume hint is disabled');
  const fe = await floorEvents(core);
  assert.equal(fe.length, 1, 'floored exactly one prior Codex session');
  assert.equal(fe[0].metadata.sessionId, 'prior-codex');
  assert.equal(fe[0].metadata.floorRuntime, 'codex');
  const body = await readJournal(core, fe[0].metadata.day);
  assert.match(body, /FLOOR-NARRATIVE/, 'prior session captured');
  assert.doesNotMatch(body, /LIVE-SHOULD-NOT-FLOOR/, 'live session was excluded');
});

test('Codex SessionStart hook keeps the idle gate: fresh prior sessions are not floored', async (t) => {
  const { core, home } = await setup(t);
  const now = Date.now();
  await plantCodexSession(home, { id: 'fresh-prior-codex', text: 'FRESH-SHOULD-NOT-FLOOR '.repeat(8), mtimeMs: now - 60 * 1000 });

  execFileSync(process.execPath, [CLI, 'hook-session-start', '--runtime', 'codex', '--root', core.workspace.root, '--space', core.workspace.space], {
    encoding: 'utf8',
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'new-codex', source: 'startup', cwd: '/tmp/codexproj' }),
    env: { ...process.env, HOME: home, IHOW_RESUME_HINT: '0' },
  });
  assert.equal((await floorEvents(core)).length, 0, 'fresh prior session remains protected by idle gate');
});

test('idempotent by composite key: a second sweep writes nothing for the same session', async (t) => {
  const { core, home, setHome } = await setup(t);
  const now = Date.now();
  await plantCodexSession(home, { id: 'codex-sess-2', mtimeMs: now - IDLE_OLD });
  setHome();

  assert.equal((await runCaptureFloorSweep(core.workspace, { now })).journaled, 1, 'first sweep floors');
  const r2 = await runCaptureFloorSweep(core.workspace, { now });
  assert.equal(r2.journaled, 0, 'second sweep is a no-op');
  assert.ok(r2.outcomes.some((o) => o.sessionId === 'codex-sess-2' && o.outcome === 'skipped-already-floored'));
  assert.equal((await floorEvents(core)).length, 1, 'still exactly one floor entry');
});

test('self-excludes the live session: a too-fresh session is skipped, then captured once it settles', async (t) => {
  const { core, home, setHome } = await setup(t);
  const now = Date.now();
  await plantCodexSession(home, { id: 'codex-fresh', mtimeMs: now - 30 * 1000 }); // 30s old << 30min idle gate
  setHome();

  const res = await runCaptureFloorSweep(core.workspace, { now });
  assert.equal(res.journaled, 0, 'a fresh/active session is never floored');
  assert.ok(res.outcomes.some((o) => o.sessionId === 'codex-fresh' && o.outcome === 'skipped-too-fresh'));

  const res2 = await runCaptureFloorSweep(core.workspace, { now: now + IDLE_OLD });
  assert.equal(res2.journaled, 1, 'the settled session is captured on a later sweep');
});

test('never sweeps Claude Code (it keeps its own marker-driven SessionStart floor)', async (t) => {
  const { core, home, setHome } = await setup(t);
  const now = Date.now();
  await plantClaudeSession(home, { id: 'claude-sess', mtimeMs: now - IDLE_OLD });
  setHome();

  const res = await runCaptureFloorSweep(core.workspace, { now });
  assert.equal(res.journaled, 0, 'no Claude session is floored by the cross-runtime sweep');
  assert.ok(!res.outcomes.some((o) => o.tool === 'claude-code'), 'claude-code is filtered out entirely');
  assert.equal((await floorEvents(core)).length, 0);
});

test('xrt-1 regression: a nearby Claude-floor / cooperative journal does NOT suppress a real capture', async (t) => {
  const { core, home, setHome } = await setup(t);
  const now = Date.now();
  // A Claude SessionStart floor entry (actor claude-code-hook, NO floor metadata) lands ~now, and a
  // genuine cooperative journal too — neither must suppress an un-captured non-Claude session.
  await core.journal({ text: 'Claude floor wrote this deterministic summary.', sourceAgent: 'claude-code-hook' });
  await core.journal({ text: 'Agent cooperatively journaled this in-session.', sourceAgent: 'codex' });
  await plantCodexSession(home, { id: 'codex-not-suppressed', mtimeMs: now - IDLE_OLD });
  setHome();

  const res = await runCaptureFloorSweep(core.workspace, { now });
  assert.equal(res.journaled, 1, 'the non-Claude session is still floored despite nearby journals');
  assert.ok((await floorEvents(core)).some((e) => e.metadata.sessionId === 'codex-not-suppressed'));
});

test('dedup-2: same sessionId on different runtimes floors independently (composite key)', async (t) => {
  const { core, home, setHome } = await setup(t);
  const now = Date.now();
  await plantCodexSession(home, { id: 'shared-id', mtimeMs: now - IDLE_OLD });
  await plantWorkbuddySession(home, { id: 'shared-id', mtimeMs: now - IDLE_OLD });
  setHome();

  const res = await runCaptureFloorSweep(core.workspace, { now });
  assert.equal(res.journaled, 2, 'a colliding sessionId across runtimes is NOT mistaken for a duplicate');
  const runtimes = (await floorEvents(core)).map((e) => e.metadata.floorRuntime).sort();
  assert.deepEqual(runtimes, ['codex', 'workbuddy']);
});

test('dedup-5: a session with no usable sessionId is skipped (not re-floored every sweep)', async (t) => {
  const { core, home, setHome } = await setup(t);
  const now = Date.now();
  await plantWorkbuddySession(home, { id: '', mtimeMs: now - IDLE_OLD }); // inline sessionId: '' -> no usable key
  setHome();

  const res = await runCaptureFloorSweep(core.workspace, { now });
  assert.equal(res.journaled, 0, 'an un-keyable session is never floored (would re-floor forever otherwise)');
  assert.ok(res.outcomes.some((o) => o.outcome === 'skipped-no-session-id'));
  assert.equal((await floorEvents(core)).length, 0);
});

test('NB-1: the floor discovery path skips git (skipAnchors) — no spawnSync on the MCP event loop', async (t) => {
  // A codex session whose cwd is a REAL git repo. WITHOUT skipAnchors, listResumableSessions would run
  // gitAnchors and report isRepo:true. The floor passes skipAnchors:true so no `git` is spawned (it would
  // block the single-threaded MCP server at startup); proof = isRepo stays false despite a real repo.
  const home = await mkdtempReal('ihow-floor-home-');
  const repo = await mkdtempReal('ihow-floor-repo-');
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(repo, 'seed.txt'), 'x\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed']);
  await plantCodexSession(home, { id: 'codex-in-repo', cwd: repo, mtimeMs: Date.now() - IDLE_OLD });
  process.env.HOME = home;

  const withGit = await listResumableSessions(20, undefined);
  const skipGit = await listResumableSessions(20, undefined, { skipAnchors: true });
  const a = withGit.find((s) => s.sessionId === 'codex-in-repo');
  const b = skipGit.find((s) => s.sessionId === 'codex-in-repo');
  assert.ok(a && b, 'the codex session surfaces either way');
  assert.equal(a.anchors.isRepo, true, 'control: anchors resolve to a real repo when NOT skipping');
  assert.equal(b.anchors.isRepo, false, 'skipAnchors: no git probe ran (isRepo false despite a real repo)');
  assert.ok(b.body && b.body.length > 0, 'the body is still captured without anchors');
});

test('NB-1 (hermes): skipAnchors skips the reader-internal chooseHermesProject git probe', async (t) => {
  // The ONLY reader that spawns git INSIDE read() is hermes (chooseHermesProject probes each tool-call
  // workdir). NB-1 above plants codex, which only proves the listResumableSessions-level gate. This pins
  // the reader-internal git-skip so a future refactor dropping the hermes readers' opts can't silently
  // reintroduce a blocking git on MCP startup. projectDir resolved=repo (control) vs undefined (skip)
  // proves chooseHermesProject ran vs was skipped.
  const home = await mkdtempReal('ihow-floor-home-');
  const repo = await mkdtempReal('ihow-floor-repo-');
  const origHome = process.env.HOME;
  t.after(async () => {
    process.env.HOME = origHome;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(repo, { recursive: true, force: true });
  });
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  await fs.writeFile(path.join(repo, 'seed.txt'), 'x\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'seed']);
  await plantHermesSession(home, { id: 'hermes-x', repo, mtimeMs: Date.now() - IDLE_OLD });
  process.env.HOME = home;

  const withGit = await listResumableSessions(20, undefined);
  const skipGit = await listResumableSessions(20, undefined, { skipAnchors: true });
  const a = withGit.find((s) => s.tool === 'hermes' && s.sessionId === 'hermes-x');
  const b = skipGit.find((s) => s.tool === 'hermes' && s.sessionId === 'hermes-x');
  assert.ok(a && b, 'the hermes session surfaces either way');
  assert.equal(a.projectDir, repo, 'control: chooseHermesProject resolves the repo via git when NOT skipping');
  assert.equal(b.projectDir, undefined, 'skipAnchors: chooseHermesProject is skipped (no reader-internal git probe)');
  assert.ok(b.body && b.body.length > 0, 'the body is still captured without the git probe');
});

test('dedup-1: concurrent floor writes for the same (runtime, sessionId) produce exactly one entry', async (t) => {
  const { core } = await setup(t); // direct writer test — exercises the under-lock check-then-write
  const payload = { text: 'concurrent floor body long enough to be a real captured entry.', runtime: 'codex', sessionId: 'race-1', title: 'x' };
  // Two racers contend for the SAME workspace lock (fs.open wx = atomic exclusive create). The winner
  // writes the audit key; the loser then acquires the lock, re-reads the audit INSIDE it, and no-ops.
  const [a, b] = await Promise.all([
    appendFloorJournalOnce(core.workspace, payload),
    appendFloorJournalOnce(core.workspace, payload),
  ]);
  assert.deepEqual([a.status, b.status].sort(), ['journaled', 'skipped-duplicate'], 'one wins, one is deduped under the lock');
  assert.equal((await floorEvents(core)).length, 1, 'exactly one floor entry despite the race');
});

test('redacts secret VALUES before writing (the journal carries [redacted], not the secret)', async (t) => {
  const { core, home, setHome } = await setup(t);
  const now = Date.now();
  const secretText = '上线收口:新版已发布并独立验证;企业咨询联系 leak-secret@evil-domain.com,按此邮箱回执即可继续推进。'.repeat(3);
  await plantCodexSession(home, { id: 'codex-secret', text: secretText, mtimeMs: now - IDLE_OLD });
  setHome();

  const res = await runCaptureFloorSweep(core.workspace, { now });
  assert.equal(res.journaled, 1, 'still captured — redaction preserves content, only the value degrades');
  const journal = await readJournal(core, (await floorEvents(core))[0].metadata.day);
  assert.ok(!journal.includes('leak-secret@evil-domain.com'), 'the raw secret value never lands in the journal');
  assert.match(journal, /\[redacted\]/, 'the value degraded to [redacted]');
  assert.match(journal, /上线收口/, 'surrounding useful content is preserved');
});
