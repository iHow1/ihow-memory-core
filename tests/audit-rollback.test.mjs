// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.4 audit + rollback: `audit` lists the append-only event log; `rollback --event <id>` is the
// auto-write lane's undo — it removes exactly the one journal entry an event recorded and logs a
// memory.rolledback event. Durable/promote events are human-gated and out of scope for rollback.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}
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

test('audit --since filter is honored', async (t) => {
  const core = await managed(t);
  await core.journal({ text: 'a note', sourceAgent: 't' });
  const future = await core.audit({ since: '2999-01-01' });
  assert.equal(future.length, 0);
  const all = await core.audit({ since: '2000-01-01' });
  assert.ok(all.length >= 1);
});
