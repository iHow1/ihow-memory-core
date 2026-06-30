// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.4 audit + rollback: `audit` lists the append-only event log; `rollback --event <id>` is the
// engine's undo. It removes exactly the one journal entry an event recorded, OR — as of go/no-go #6 —
// an AUTO-promoted durable memory (machine-judged, no human gate, so it MUST be reversible). A
// human-CONFIRMED promotion is deliberate and stays out of scope (refused). Logs a memory.rolledback event.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}
const exists = async (p) => { try { await fs.access(p); return true; } catch { return false; } };
async function managed(t) {
  const root = await mkdtempReal('ihow-audit-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, space: 'atest' });
}

test('audit lists events; rollback removes exactly one journal entry and logs it', async (t) => {
  const core = await managed(t);
  const j1 = await core.journal({ text: 'first journal note alpha', sourceAgent: 't' });
  const j2 = await core.journal({ text: 'second journal note beta', sourceAgent: 't' });

  const events1 = await core.audit();
  const journalEvents = events1.filter((e) => e.type === 'memory.journal.appended');
  assert.equal(journalEvents.length, 2);
  assert.ok(journalEvents.some((e) => e.id === j1.eventId));

  const r = await core.rollback(j1.eventId);
  assert.equal(r.removed, true);
  assert.ok(r.rolledbackEventId);

  // first entry gone, second remains (both share one daily file)
  const abs = path.join(core.workspace.memoryDir, 'journal', `${j1.day}.md`);
  const content = await fs.readFile(abs, 'utf8');
  assert.doesNotMatch(content, /first journal note alpha/);
  assert.match(content, /second journal note beta/);
  assert.equal(j1.day, j2.day);

  const events2 = await core.audit();
  assert.ok(events2.some((e) => e.type === 'memory.rolledback'), 'a rollback event should be logged');
});

test('rollback rejects an unknown event id', async (t) => {
  const core = await managed(t);
  await assert.rejects(core.rollback('nonexistent-id'), /rollback_event_not_found/);
});

// Hardening regression: two journal appends in the SAME millisecond share one ISO `entryAt`. Rolling
// back ONE must remove EXACTLY that entry — not both. The content-addressed entryHash disambiguates;
// the old timestamp-only removal over-removed every same-stamp block (a replay/idempotency hazard).
test('rollback of one of two same-millisecond entries removes exactly the targeted one (entryHash)', async (t) => {
  const core = await managed(t);
  const realISO = Date.prototype.toISOString;
  const frozen = '2026-06-30T12:00:00.000Z';
  // Freeze the wall clock so both appends stamp the identical entryAt (forces the collision).
  // eslint-disable-next-line no-extend-native
  Date.prototype.toISOString = function () { return frozen; };
  let a, b;
  try {
    a = await core.journal({ text: 'same-ms entry AAA distinguishable', sourceAgent: 't' });
    b = await core.journal({ text: 'same-ms entry BBB distinguishable', sourceAgent: 't' });
  } finally {
    Date.prototype.toISOString = realISO;
  }
  const abs = path.join(core.workspace.memoryDir, 'journal', `${a.day}.md`);
  // both landed under the same ISO timestamp
  const before = await fs.readFile(abs, 'utf8');
  assert.match(before, /same-ms entry AAA/);
  assert.match(before, /same-ms entry BBB/);

  // rolling back A must leave B intact (timestamp alone could not have told them apart)
  const r = await core.rollback(a.eventId);
  assert.equal(r.removed, true, 'the targeted entry was removed');
  const after = await fs.readFile(abs, 'utf8');
  assert.doesNotMatch(after, /same-ms entry AAA/, 'the targeted same-ms entry is gone');
  assert.match(after, /same-ms entry BBB/, 'the OTHER same-ms entry survives (no over-removal)');
  void b;
});

test('managed-space audit + rollback span the MCP auto-capture (_mcp) lane', async (t) => {
  // CLI view of a managed space (events on the MAIN lane: memory/_events).
  const cli = await managed(t);
  const stateRoot = await mkdtempReal('ihow-audit-mcp-');
  t.after(async () => { await fs.rm(stateRoot, { recursive: true, force: true }); });
  // MCP-server view over the SAME memory dir → existing-memory-root mode → writes to memory/_mcp/*,
  // exactly like the registered MCP server (`--memory-root <space>/memory`) does in production.
  const mcp = await openCore({ memoryRoot: cli.workspace.memoryDir, stateRoot });
  const j = await mcp.journal({ text: 'auto-captured note in the _mcp lane', sourceAgent: 'mcp' });

  // the CLI's managed-space audit must surface the _mcp-lane event (and its id, for rollback)
  const events = await cli.audit();
  assert.ok(
    events.some((e) => e.type === 'memory.journal.appended' && e.id === j.eventId),
    'managed-space audit surfaces the _mcp journal.appended event',
  );

  // and the CLI must be able to roll it back across lanes
  const r = await cli.rollback(j.eventId);
  assert.equal(r.removed, true);
  const after = await cli.audit();
  assert.ok(after.some((e) => e.type === 'memory.rolledback'), 'cross-lane rollback is logged');
  const abs = path.join(cli.workspace.memoryDir, '_mcp', 'journal', `${j.day}.md`);
  assert.doesNotMatch(await fs.readFile(abs, 'utf8'), /auto-captured note in the _mcp lane/);
});

test('rollback undoes an AUTO-promoted durable memory and logs it (go/no-go #6)', async (t) => {
  const core = await managed(t);
  // Provenance (verified + command + exitCode + repo) clears the floor → auto-promoted, no human gate.
  const w = await core.write_candidate({
    title: 'build-passed',
    text: 'the build passed and the tests are green on this commit',
    sourceAgent: 't',
    metadata: { verified: true, command: 'npm test', exitCode: 0, repo: 'demo' },
  });
  assert.equal(w.autoPromote?.promoted, true, `should auto-promote with provenance: ${JSON.stringify(w.autoPromote)}`);
  const eventId = w.autoPromote.eventId;

  // the auto-promoted durable file is on disk before rollback
  const promotedEv = (await core.audit()).find((e) => e.id === eventId);
  assert.ok(promotedEv && promotedEv.type === 'memory.promoted', 'promoted event present in audit');
  const rel = promotedEv.metadata?.targetMemoryPath;
  assert.ok(rel, 'promoted event carries targetMemoryPath');
  const abs = path.join(core.workspace.memoryDir, rel);
  assert.equal(await exists(abs), true, 'auto-promoted file exists before rollback');

  // rollback removes the durable file and logs a memory.rolledback (auto) event — no longer
  // rollback_unsupported_event_type (the regression the audit caught)
  const r = await core.rollback(eventId);
  assert.equal(r.removed, true);
  assert.equal(await exists(abs), false, 'auto-promoted durable file is gone after rollback');
  assert.ok((await core.audit()).some((e) => e.type === 'memory.rolledback' && e.metadata?.auto === true), 'auto rollback is logged');
});

test('rollback is idempotent: replaying a stale auto id cannot delete a later human-confirmed promote', async (t) => {
  const core = await managed(t);
  const w = await core.write_candidate({ title: 'replay-fact', text: 'a verified fact used for the replay test', sourceAgent: 't', metadata: { command: 'npm test', exitCode: 0 } });
  assert.equal(w.autoPromote?.promoted, true);
  const autoId = w.autoPromote.eventId;
  const promotedEv = (await core.audit()).find((e) => e.id === autoId);
  const candidatePath = promotedEv.candidatePath; // the candidate that will be restored to the inbox

  // 1) roll the auto-promote back → the candidate returns to the inbox for review
  assert.equal((await core.rollback(autoId)).removed, true);

  // 2) a human deliberately re-promotes the restored candidate (same slug/target), NOT auto
  await core.promote(candidatePath);
  const humanEv = (await core.audit()).find((e) => e.type === 'memory.promoted' && !e.metadata?.auto);
  assert.ok(humanEv, 'a human (non-auto) promote event exists');
  const humanAbs = path.join(core.workspace.memoryDir, humanEv.metadata.targetMemoryPath);
  assert.equal(await exists(humanAbs), true, 'the human-confirmed durable file exists');

  // 3) replaying the STALE auto id (still in the append-only log) must be REFUSED — it must not
  //    blind-delete the now human-confirmed file at the same target (silently reversing a deliberate promote)
  await assert.rejects(core.rollback(autoId), /rollback_already_rolled_back/);
  assert.equal(await exists(humanAbs), true, 'the deliberate human promote survives the replayed rollback');
});

test('rollback REFUSES a human-confirmed promotion (governance moat preserved)', async (t) => {
  const core = await managed(t);
  const c = await core.write_candidate({ title: 'manual-fact', text: 'a fact promoted by a human on purpose', sourceAgent: 't', autoPromote: false });
  assert.equal(c.autoPromote, undefined, 'autoPromote:false leaves it a candidate, not auto-promoted');
  await core.promote(c.path); // explicit, human-gated promote → memory.promoted WITHOUT metadata.auto
  const ev = (await core.audit()).find((e) => e.type === 'memory.promoted' && !e.metadata?.auto);
  assert.ok(ev, 'a human (non-auto) promote event exists');
  await assert.rejects(core.rollback(ev.id), /rollback_human_promote_out_of_scope/, 'deliberate promotes are not silently reversible');
});

test('audit --since filter is honored', async (t) => {
  const core = await managed(t);
  await core.journal({ text: 'a note', sourceAgent: 't' });
  const future = await core.audit({ since: '2999-01-01' });
  assert.equal(future.length, 0);
  const all = await core.audit({ since: '2000-01-01' });
  assert.ok(all.length >= 1);
});
