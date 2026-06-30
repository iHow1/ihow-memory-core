// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// alpha.4 layered journal (auto-capture lane) tests: append-only daily write + audit event,
// secret hard-reject on the auto path, and the load-bearing guarantee that journal entries are
// searchable but always ranked BELOW curated/promoted memory — so automatic capture can never
// pollute high-weight retrieval.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function managed(t) {
  const root = await mkdtempReal('ihow-journal-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return await openCore({ root, space: 'jtest' });
}

test('journal append writes an append-only daily file + audit event', async (t) => {
  const core = await managed(t);
  const r1 = await core.journal({ text: 'Session note: investigated the flaky retry path.', sourceAgent: 'tester' });
  assert.equal(r1.status, 'journaled');
  assert.match(r1.path, /memory\/journal\/\d{4}-\d{2}-\d{2}\.md$/);
  assert.ok(r1.eventId, 'should return an audit eventId');

  // a second append lands in the same daily file and keeps the first entry (append-only)
  const r2 = await core.journal({ text: 'Second note: confirmed the fix works.', sourceAgent: 'tester' });
  assert.equal(r2.path, r1.path);
  const abs = path.join(core.workspace.memoryDir, 'journal', `${r1.day}.md`);
  const content = await fs.readFile(abs, 'utf8');
  assert.match(content, /flaky retry path/);
  assert.match(content, /confirmed the fix works/);
  assert.match(content, /weight: "low"/);
});

test('journal hard-rejects secret-like content (auto path keeps the reject gate)', async (t) => {
  const core = await managed(t);
  await assert.rejects(
    core.journal({ text: 'api_key: ABCDEF0123456789', sourceAgent: 'tester' }),
    /secret/,
  );
});

test('journal entries are searchable but ranked below curated memory', async (t) => {
  const core = await managed(t);
  // auto-captured journal entry matching the query
  const j = await core.journal({ text: 'kafka consumer lag spike during the deploy window', sourceAgent: 'tester' });
  const hits1 = await core.search('kafka consumer lag deploy', { limit: 10 });
  assert.ok(hits1.some((h) => h.path === j.path), 'journal entry should be searchable');

  // a curated/promoted memory matching the same query
  const cand = await core.write_candidate({
    text: 'kafka consumer lag deploy decision: raise max.poll.interval.ms',
    sourceAgent: 'tester',
    title: 'kafka-lag',
    autoPromote: false,
  });
  await core.promote(cand.path, { scope: 'team' });

  const hits2 = await core.search('kafka consumer lag deploy', { limit: 10 });
  const curatedIdx = hits2.findIndex((h) => h.path.startsWith('memory/scopes/'));
  const journalIdx = hits2.findIndex((h) => h.path === j.path);
  assert.ok(curatedIdx !== -1, 'curated memory should be found');
  assert.ok(journalIdx === -1 || curatedIdx < journalIdx, 'curated must rank above the journal entry');
});

test('CLI journal command appends a journal entry', async (t) => {
  const root = await mkdtempReal('ihow-journal-cli-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const out = execFileSync(
    process.execPath,
    [CLI, 'journal', 'cli session note about the deploy', '--title', 'deploy', '--root', root, '--space', 'clitest'],
    { encoding: 'utf8' },
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, 'journaled');
  assert.match(parsed.path, /memory\/journal\/\d{4}-\d{2}-\d{2}\.md$/);
});
