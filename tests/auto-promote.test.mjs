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
