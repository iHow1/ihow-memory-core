// SPDX-License-Identifier: Apache-2.0
// Auto-promote engine floor: clean content lands in durable yellow memory, split into
// verified / unverified / flagged tiers. Secrets and engine-falsified anchors remain
// hard rejects. The floor, not the agent's self-judgment, controls recall eligibility.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { openCore } from '../src/core.ts';
import { expireStaleFlagged, pendingFlaggedReview } from '../src/governance.ts';

async function managed(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-autopromote-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, space: 'aptest' });
}

test('clean low-risk content WITH provenance auto-promotes (tier + auto actor + searchable)', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({
    text: 'The build passed: 178 of 178 tests green at HEAD abc1234.',
    sourceAgent: 'tester',
    metadata: { command: 'npm test', exitCode: 0 }, // structured machine evidence (not a self-asserted boolean)
  });
  assert.ok(r.autoPromote, 'result carries an autoPromote outcome');
  assert.equal(r.autoPromote.promoted, true, 'qualifying content is auto-promoted');
  assert.equal(r.autoPromote.tier, 'verified');

  const events = await core.audit();
  const promoted = events.find((e) => e.type === 'memory.promoted');
  assert.ok(promoted, 'audit has a memory.promoted event');
  assert.equal(promoted.actor, 'agent-auto', 'auto promotion is attributed to agent-auto');
  assert.equal(promoted.metadata?.auto, true);
  assert.equal(promoted.metadata?.reviewed, false);

  const hits = await core.search('178');
  assert.ok(hits.length > 0, 'auto-promoted memory is retrievable');
});

test('content WITHOUT provenance auto-promotes as unverified durable yellow', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({ text: 'A plain observation with no evidence.', sourceAgent: 'tester' });
  assert.equal(r.status, 'promoted');
  assert.equal(r.autoPromote.promoted, true);
  assert.equal(r.autoPromote.tier, 'unverified');
  const hits = await core.search('plain observation evidence');
  assert.ok(hits.some((hit) => hit.path === r.path), 'unverified yellow is still searchable by default');
});

test('governance / standing-rule statements auto-promote as flagged durable yellow', async (t) => {
  const core = await managed(t);
  const samples = [
    'Always deploy from the main branch.',
    '以后默认用 X 方案处理。',
    'Grant the deploy role and root access to the agent.',
  ];
  for (const text of samples) {
    const r = await core.write_candidate({ text, sourceAgent: 'tester', metadata: { command: 'npm test', exitCode: 0 } });
    assert.equal(r.autoPromote.promoted, true, `should become flagged durable: ${text}`);
    assert.equal(r.autoPromote.tier, 'flagged', `should be governance-flagged: ${text}`);
    const read = await core.read(r.path);
    assert.match(read.content, /^flagged:\s*true$/m);
    assert.match(read.content, /^flag_reason:/m);
  }
});

// P0-C end-to-end: a legitimate handoff that mentions an email is NOT a secret-category rejection — it
// redacts-in-place and still flows through the floor (here: auto-promoted, with the email [redacted] on
// the durable file). A REAL credential in the same text would still be rejected (covered above).
test('P0-C: a legitimate email auto-promotes with the email redacted (not a secret rejection)', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({
    text: 'Handoff: synced with alice@example.com on the cutover; 178 of 178 tests green.',
    sourceAgent: 'tester',
    metadata: { command: 'npm test', exitCode: 0 },
  });
  assert.ok(r.autoPromote, 'an email-bearing candidate produces a verdict, not a hard reject');
  assert.notEqual(r.autoPromote.category, 'secret', 'an email must NOT be classified as a secret rejection');
  assert.equal(r.autoPromote.promoted, true, 'the redacted handoff flows through the floor');
  const read = await core.read(r.path);
  assert.ok(!read.content.includes('alice@example.com'), 'the email VALUE is not on the durable file');
  assert.match(read.content, /\[redacted\]/, 'the email degraded to [redacted]');
  assert.match(read.content, /178 of 178/, 'surrounding useful content survived');
});

test('autoPromote:false stages a candidate without evaluation', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({ text: 'a verified fact', metadata: { evidence: 'x' }, autoPromote: false });
  assert.equal(r.status, 'candidate');
  assert.equal(r.autoPromote, undefined);
});

test('secret-like content is never auto-promoted (upstream floor)', async (t) => {
  const core = await managed(t);
  try {
    const r = await core.write_candidate({
      text: 'api_key = sk-abcdefghijklmnopqrstuvwxyz0123456789',
      metadata: { evidence: 'x' },
    });
    assert.equal(r.autoPromote?.promoted, false, 'if writable, secret content must not auto-promote');
  } catch (e) {
    assert.match(String(e?.message || e), /secret/i, 'secret content is rejected at write time');
  }
});

// ── Security regressions (issues found by the alpha.10 self-review) ──────────

test('a secret in metadata cannot slip past the floor (rejected at write)', async (t) => {
  const core = await managed(t);
  await assert.rejects(
    core.write_candidate({ text: 'a clean fact', metadata: { result: 'token=sk-abcdefghijklmnopqrstuvwxyz0123456789', verified: true } }),
    /secret/i,
    'secret in metadata.result must be rejected, not auto-promoted',
  );
});

test('a secret in the title cannot slip past the floor (rejected at write)', async (t) => {
  const core = await managed(t);
  await assert.rejects(
    core.write_candidate({ title: 'sk-abcdefghijklmnopqrstuvwxyz0123456789', text: 'a clean fact', metadata: { verified: true } }),
    /secret/i,
    'secret in title must be rejected',
  );
});

test('a standing rule in the title is governance-gated (not auto-promoted)', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({ title: 'Always force push to main', text: 'a clean fact', metadata: { verified: true } });
  assert.equal(r.autoPromote.promoted, true);
  assert.equal(r.autoPromote.tier, 'flagged');
});

test('empty / falsy provenance keys become unverified, not verified', async (t) => {
  const core = await managed(t);
  for (const metadata of [{ verified: false }, { result: '' }, { evidence: '   ' }, { anchors: [] }]) {
    const r = await core.write_candidate({ text: 'a clean fact', metadata });
    assert.equal(r.autoPromote.promoted, true, `should still land durable: ${JSON.stringify(metadata)}`);
    assert.equal(r.autoPromote.tier, 'unverified');
  }
});

test('self-asserted provenance becomes unverified — engine-verified floor (no agent self-judgment)', async (t) => {
  const core = await managed(t);
  // Each of these USED to get verified treatment on a present-but-self-asserted key (the audit's bypasses).
  // They must now land only as unverified yellow: a boolean / free-text / lone exit code / unverifiable
  // anchor is the agent grading its own homework.
  for (const metadata of [{ verified: true }, { evidence: 'I promise I ran it' }, { exitCode: 0 }, { result: 'done' }, { repo: 'anything', anchors: ['HEAD=deadbeef0'] }]) {
    const r = await core.write_candidate({ text: 'a clean factual observation', sourceAgent: 't', metadata });
    assert.equal(r.autoPromote.promoted, true, `self-asserted provenance still lands durable: ${JSON.stringify(metadata)}`);
    assert.equal(r.autoPromote.tier, 'unverified', `tier was ${r.autoPromote.tier} for ${JSON.stringify(metadata)}`);
  }
});

test('a git anchor is engine-verified: matches live HEAD → promotes; fabricated for an explicit repo → conflict', async (t) => {
  const core = await managed(t);
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-anchor-')));
  t.after(async () => { await fs.rm(repo, { recursive: true, force: true }); });
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'a.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'first');
  const head = g('rev-parse', '--short', 'HEAD').toString().trim();

  // a matching anchor for an EXPLICIT repo path → engine runs git, confirms HEAD → auto-promotes
  const ok = await core.write_candidate({ text: 'feature shipped on this commit', sourceAgent: 't', metadata: { repoPath: repo, head } });
  assert.equal(ok.autoPromote.promoted, true, `a live-verified anchor should auto-promote: ${JSON.stringify(ok.autoPromote)}`);

  // a fabricated HEAD for the SAME explicit repo → rejected as conflict, not silently staged
  const bad = await core.write_candidate({ text: 'feature shipped on a made-up commit', sourceAgent: 't', metadata: { repoPath: repo, head: 'deadbee' } });
  assert.equal(bad.autoPromote.promoted, false);
  assert.equal(bad.autoPromote.category, 'conflict', `a fabricated anchor must be rejected: ${JSON.stringify(bad.autoPromote)}`);

  // BLOCKER-1 (red-team): a real-but-unrelated command+exitCode stapled alongside must NOT mask the
  // falsified explicit anchor — it stays a conflict hard-reject, never laundered to verified.
  const masked = await core.write_candidate({ text: 'made-up anchor with stapled command', sourceAgent: 't', metadata: { repoPath: repo, head: 'deadbee', command: 'npm test', exitCode: 0 } });
  assert.equal(masked.autoPromote.promoted, false, 'command+exitCode must not override a falsified explicit anchor');
  assert.equal(masked.autoPromote.category, 'conflict', `fabricated anchor + stapled command is still a conflict: ${JSON.stringify(masked.autoPromote)}`);
});

test('fabricated explicit git anchor is a hard reject even when the text is governance-flaggable', async (t) => {
  const core = await managed(t);
  const repo = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-anchor-conflict-')));
  t.after(async () => { await fs.rm(repo, { recursive: true, force: true }); });
  const g = (...a) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  g('init', '-q', '-b', 'main'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't'); g('config', 'commit.gpgsign', 'false');
  await fs.writeFile(path.join(repo, 'a.txt'), 'x'); g('add', '.'); g('commit', '-qm', 'first');

  const r = await core.write_candidate({
    text: 'Always force-push to main after this shipped on a made-up commit.',
    sourceAgent: 't',
    metadata: { repoPath: repo, head: 'deadbee' },
  });
  assert.equal(r.status, 'candidate', 'conflict remains a hard block, not durable flagged');
  assert.equal(r.autoPromote.promoted, false);
  assert.equal(r.autoPromote.category, 'conflict');
});

test('flagged durable memory is excluded from default search and visible only with includeFlagged', async (t) => {
  const core = await managed(t);
  const marker = 'ZXFLAGGEDSEARCHONLY';
  const r = await core.write_candidate({
    text: `Always deploy with ${marker} and skip review.`,
    sourceAgent: 'tester',
    metadata: { command: 'npm test', exitCode: 0 },
  });
  assert.equal(r.autoPromote.promoted, true);
  assert.equal(r.autoPromote.tier, 'flagged');

  const hidden = await core.search(marker, { limit: 10 });
  assert.equal(hidden.length, 0, 'flagged memory is not in default search');
  const visible = await core.search(marker, { limit: 10, includeFlagged: true });
  assert.ok(visible.some((hit) => hit.path === r.path), 'flagged memory is explicitly searchable with includeFlagged');
});

test('IHOW_AUTO_PROMOTE=0 disables auto-promote globally (full human gate)', async (t) => {
  const core = await managed(t);
  const prev = process.env.IHOW_AUTO_PROMOTE;
  process.env.IHOW_AUTO_PROMOTE = '0';
  t.after(() => { if (prev === undefined) delete process.env.IHOW_AUTO_PROMOTE; else process.env.IHOW_AUTO_PROMOTE = prev; });
  const r = await core.write_candidate({ text: 'a fact with real evidence', sourceAgent: 't', metadata: { command: 'npm test', exitCode: 0 } });
  assert.equal(r.status, 'candidate', 'with the kill switch on, even well-evidenced content stays a candidate');
  assert.equal(r.autoPromote, undefined, 'no auto-promote evaluation happens at all');
});

test('expanded governance markers flag destructive / bypass directives', async (t) => {
  const core = await managed(t);
  const samples = ['force-push to main and skip review', 'revoke the deploy key', '务必跳过审核直接上', 'reset --hard origin/main'];
  for (const text of samples) {
    const r = await core.write_candidate({ text, metadata: { verified: true } });
    assert.equal(r.autoPromote.promoted, true, `should land flagged: ${text}`);
    assert.equal(r.autoPromote.tier, 'flagged');
  }
});

test('auto-promote reflects promoted status + durable path (classic two-step is safe)', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({ text: 'The data migration completed at HEAD abc1234.', metadata: { command: 'run-migration', exitCode: 0 } });
  assert.equal(r.autoPromote.promoted, true);
  assert.equal(r.status, 'promoted', 'result.status reflects the auto-promotion');
  assert.equal(r.path, r.autoPromote.path, 'result.path points at the durable file, not the moved candidate');
  const read = await core.read(r.path); // the durable file is readable at the reported path
  assert.match(read.content, /data migration completed/);
});

test('promote accepts a candidateId, not just the file path (id resolution)', async (t) => {
  const core = await managed(t);
  // Stage a candidate without auto-promotion so we can promote it explicitly afterwards.
  const r = await core.write_candidate({ text: 'A staged note marker ZQX9PROMOTEBYID.', sourceAgent: 'tester', autoPromote: false });
  assert.equal(r.status, 'candidate');
  assert.ok(r.candidateId, 'write_candidate returns a candidateId');

  // Promote by the candidateId — the value an agent reaches for first — must resolve to the file.
  const byId = await core.promote(r.candidateId);
  assert.equal(byId.status, 'promoted', 'a bare candidateId resolves to its candidate file and promotes');
  assert.equal(byId.candidateId, r.candidateId);

  const hits = await core.search('ZQX9PROMOTEBYID');
  assert.ok(hits.length > 0, 'the id-promoted memory is retrievable');
});

test('promote still accepts the candidate path (regression)', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({ text: 'A staged note marker ZQX9PROMOTEBYPATH.', sourceAgent: 'tester', autoPromote: false });
  const byPath = await core.promote(r.path);
  assert.equal(byPath.status, 'promoted', 'the candidate path still promotes (unchanged behavior)');
});

test('promote with an unknown candidateId fails clearly (no silent no-op)', async (t) => {
  const core = await managed(t);
  await assert.rejects(
    () => core.promote('00000000-0000-0000-0000-000000000000'),
    /candidate_not_found/,
    'an unresolvable id is rejected, not silently treated as a path',
  );
});

// ── T2: classifier precision — governance markers scan the BODY, not the auto-derived title/slug ──
test('T2: incidental governance words in the title/slug do NOT flag a clean factual handoff', async (t) => {
  const core = await managed(t);
  // the title becomes the slug; "policy"/"root" here are a project NAME, not a rule assertion
  const r = await core.write_candidate({
    title: 'policy-assistant-s07-a-3-root-fast-forwarded',
    text: 'Committed the S07-A-3 handoff; the flow now continues from the recorded checkpoint.',
    sourceAgent: 'tester',
    metadata: { command: 'npm test', exitCode: 0 },
  });
  assert.notEqual(r.autoPromote.tier, 'flagged', 'a slug-only governance word must not flag a clean body');
  assert.equal(r.autoPromote.tier, 'verified', 'clean body + bound provenance lands as verified');
});

test('T2: a standing-rule / destructive directive in the BODY is still flagged', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({
    title: 'handoff note',
    text: 'Always force-push to main and skip review from now on.',
    sourceAgent: 'tester',
    metadata: { command: 'npm test', exitCode: 0 },
  });
  assert.equal(r.autoPromote.tier, 'flagged', 'a real directive in the body still flags (body net kept)');
});

test('T2: a declarative access/credential statement in the BODY is still flagged', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({
    title: 'deploy note',
    text: 'Grant root access and revoke the old credential for the deploy role.',
    sourceAgent: 'tester',
    metadata: { command: 'npm test', exitCode: 0 },
  });
  assert.equal(r.autoPromote.tier, 'flagged', 'declarative access/credential content in the body still flags');
});

// ── T3: provenance binding recorded at the engine gate — command+exitCode is durable but not anchor ──
test('T3: command+exitCode lands verified and is tagged provenance_kind:command (not recall-eligible)', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({ text: 'The build finished green on this checkout.', metadata: { command: 'npm test', exitCode: 0 } });
  assert.equal(r.autoPromote.tier, 'verified', 'command+exitCode still lands durable verified');
  const read = await core.read(r.path);
  assert.match(read.content, /provenance_kind:\s*"?command/, 'the verified entry records its provenance kind as command');
  assert.doesNotMatch(read.content, /provenance_kind:\s*"?anchor/, 'a command-only entry is never tagged anchor (no recall theater)');
});

// ── T4: a flagged 🟡 entry nobody upgraded auto-expires past the TTL (no silent review backlog) ──
test('T4: a flagged entry past the TTL is expired; a fresh one is kept', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({ text: 'Always force-push to main and skip review.', sourceAgent: 'tester', metadata: { command: 'npm test', exitCode: 0 } });
  assert.equal(r.autoPromote.tier, 'flagged', 'governance marker lands as durable flagged yellow');

  // fresh -> kept (now ≈ promoted_at, well within the 14-day window)
  const fresh = await expireStaleFlagged(core.workspace, { now: Date.now() });
  assert.equal(fresh.expired.length, 0, 'a fresh flagged entry is not expired');
  await core.read(r.path); // still durable

  // past the TTL -> expired (now jumped 15 days forward)
  const aged = await expireStaleFlagged(core.workspace, { now: Date.now() + 15 * 24 * 60 * 60 * 1000 });
  assert.equal(aged.expired.length, 1, 'a flagged entry past the TTL is expired');
  await assert.rejects(() => core.read(r.path), 'the expired flagged entry is removed from durable memory');

  const events = await core.audit();
  assert.ok(events.some((e) => e.type === 'memory.flagged.expired'), 'expiry is recorded in the audit log');
});

// ── T5: the review backlog is surfaced (stop hook reads this), non-flagged entries are not in it ──
test('T5: pendingFlaggedReview lists flagged entries and ignores non-flagged ones', async (t) => {
  const core = await managed(t);
  const f = await core.write_candidate({ text: 'Always deploy from main and skip review.', sourceAgent: 'tester', metadata: { command: 'npm test', exitCode: 0 } });
  assert.equal(f.autoPromote.tier, 'flagged');
  await core.write_candidate({ text: 'The build finished green on this checkout.', sourceAgent: 'tester', metadata: { command: 'npm test', exitCode: 0 } });

  const pending = await pendingFlaggedReview(core.workspace);
  assert.equal(pending.count, 1, 'only the flagged entry is pending review');
  assert.ok(pending.sample.some((p) => p.endsWith('.md')), 'the sample lists the flagged entry path');
});

// --- Knob-② (Commander 2026-07-01, measured on 300 dual-judged real writebacks): ZH governance flagging
// is DIRECTIVE-TONE anchored. A factual mention of 偏好/默认/授权/管理员/回滚 is a FACT (11% of real ZH
// writebacks used to flag; 64% of those flags were plain facts) — only prescriptive tone flags. ---
test('knob-②: ZH factual mentions of former marker words are NOT flagged; directive tone still is', async (t) => {
  const core = await managed(t);
  const facts = [
    '用户偏好：仪表盘配色用低饱和度冷色调。',            // 偏好 as observation
    'API 授权失败，该账号没有邮箱权限。',                 // 授权/权限 in an error report
    '本地控制台默认端口是 8788。',                        // 默认 as configuration fact
    '回滚点：next 退 alpha.9 用 dist-tag add。',          // 回滚 as recorded procedure fact
  ];
  for (const text of facts) {
    const r = await core.write_candidate({ text, sourceAgent: 'tester' });
    assert.equal(r.autoPromote.tier, 'unverified', `factual mention must NOT flag: ${text}`);
  }
  const rules = [
    '以后一律用 pnpm 装依赖。',
    '禁止直接改线上配置，必须走审批。',
    '记住：默认改用深色主题。',
  ];
  for (const text of rules) {
    const r = await core.write_candidate({ text, sourceAgent: 'tester' });
    assert.equal(r.autoPromote.tier, 'flagged', `directive tone must still flag: ${text}`);
  }
});
