// SPDX-License-Identifier: Apache-2.0
// Auto-promote engine floor (alpha.10): qualifying low-risk content WITH provenance
// is promoted automatically on write_candidate; everything else stays a candidate with
// a reason. The floor — not the agent's self-judgment — gates what reaches durable
// memory (OpenClaw red-team: the most dangerous poisoning looks like low-risk state).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

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
    metadata: { evidence: 'npm test', verified: true },
  });
  assert.ok(r.autoPromote, 'result carries an autoPromote outcome');
  assert.equal(r.autoPromote.promoted, true, 'qualifying content is auto-promoted');
  assert.equal(r.autoPromote.tier, 'auto-promoted');

  const events = await core.audit();
  const promoted = events.find((e) => e.type === 'memory.promoted');
  assert.ok(promoted, 'audit has a memory.promoted event');
  assert.equal(promoted.actor, 'agent-auto', 'auto promotion is attributed to agent-auto');
  assert.equal(promoted.metadata?.auto, true);
  assert.equal(promoted.metadata?.reviewed, false);

  const hits = await core.search('178');
  assert.ok(hits.length > 0, 'auto-promoted memory is retrievable');
});

test('content WITHOUT provenance stays a candidate', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({ text: 'A plain observation with no evidence.', sourceAgent: 'tester' });
  assert.equal(r.status, 'candidate');
  assert.equal(r.autoPromote.promoted, false);
  assert.equal(r.autoPromote.category, 'no-provenance');
});

test('governance / standing-rule statements never auto-promote, even with provenance', async (t) => {
  const core = await managed(t);
  const samples = [
    'Always deploy from the main branch.',
    '以后默认用 X 方案处理。',
    'Grant the deploy role and root access to the agent.',
  ];
  for (const text of samples) {
    const r = await core.write_candidate({ text, sourceAgent: 'tester', metadata: { evidence: 'x' } });
    assert.equal(r.autoPromote.promoted, false, `should stay gated: ${text}`);
    assert.equal(r.autoPromote.category, 'governance', `should be governance-gated: ${text}`);
  }
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
  assert.equal(r.autoPromote.promoted, false);
  assert.equal(r.autoPromote.category, 'governance');
});

test('empty / falsy provenance keys do not qualify (no-provenance)', async (t) => {
  const core = await managed(t);
  for (const metadata of [{ verified: false }, { result: '' }, { evidence: '   ' }, { anchors: [] }]) {
    const r = await core.write_candidate({ text: 'a clean fact', metadata });
    assert.equal(r.autoPromote.promoted, false, `should not qualify: ${JSON.stringify(metadata)}`);
    assert.equal(r.autoPromote.category, 'no-provenance');
  }
});

test('expanded governance markers gate destructive / bypass directives', async (t) => {
  const core = await managed(t);
  const samples = ['force-push to main and skip review', 'revoke the deploy key', '务必跳过审核直接上', 'reset --hard origin/main'];
  for (const text of samples) {
    const r = await core.write_candidate({ text, metadata: { verified: true } });
    assert.equal(r.autoPromote.promoted, false, `should be gated: ${text}`);
    assert.equal(r.autoPromote.category, 'governance');
  }
});

test('auto-promote reflects promoted status + durable path (classic two-step is safe)', async (t) => {
  const core = await managed(t);
  const r = await core.write_candidate({ text: 'The data migration completed at HEAD abc1234.', metadata: { evidence: 'logs', verified: true } });
  assert.equal(r.autoPromote.promoted, true);
  assert.equal(r.status, 'promoted', 'result.status reflects the auto-promotion');
  assert.equal(r.path, r.autoPromote.path, 'result.path points at the durable file, not the moved candidate');
  const read = await core.read(r.path); // the durable file is readable at the reported path
  assert.match(read.content, /data migration completed/);
});
