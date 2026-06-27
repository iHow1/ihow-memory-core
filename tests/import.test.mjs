// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// C2 import tests: parse foreign memory (Claude Code native MEMORY.md + fact files; generic markdown)
// into the LOW-WEIGHT journal lane — searchable, idempotent, reversible — plus the load-bearing
// honesty/safety guarantees hardened after the adversarial audit:
//   • verify round-trip proves a write by its UNIQUE marker at its EXACT path (no curated-file false-green)
//   • secret-like content in the BODY *or the TITLE* is refused at write, never stored
//   • an EDITED fact is recognized as changed (no silent double); --update supersedes the stale copy
//   • binary / non-UTF8 .md files are skipped with a reason, not ingested as junk
//   • an empty source yields zero items (the CLI maps that to a non-zero exit, never a vacuous green)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';
import {
  planImport,
  applyImport,
  collectExistingImports,
  splitFrontmatter,
  contentMarker,
  identityMarker,
} from '../src/import.ts';

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function managed(t) {
  const root = await mkdtempReal('ihow-import-store-');
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return await openCore({ root, space: 'imptest' });
}

// Build a Claude-Code-style native auto-memory dir: a MEMORY.md index + per-fact files with nested
// frontmatter (the REAL Claude Code layout), plus an empty fact file (must be skipped, not imported).
async function claudeMemoryFixture(t) {
  const dir = await mkdtempReal('ihow-import-src-');
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(path.join(dir, 'MEMORY.md'), '# Memory Index\n- [Postgres tz](pg.md) — store UTC\n- [Deploy](deploy.md) — blue/green\n', 'utf8');
  await fs.writeFile(
    path.join(dir, 'pg.md'),
    '---\nname: pg-tz-gotcha\ndescription: store timestamps in UTC\nmetadata:\n  type: reference\n---\nPostgres timestamptz stores UTC internally. Convert at the edge. See [[deploy-runbook]].\n',
    'utf8',
  );
  await fs.writeFile(
    path.join(dir, 'deploy.md'),
    '---\nname: deploy-runbook\nmetadata:\n  type: project\n---\nBlue/green deploy: bring up green, drain old 30s, flip the LB.\n',
    'utf8',
  );
  await fs.writeFile(path.join(dir, 'empty.md'), '---\nname: empty\n---\n', 'utf8');
  return dir;
}

test('splitFrontmatter parses flat AND nested (dotted) keys; body untouched', () => {
  const { meta, body } = splitFrontmatter('---\nname: foo\ndescription: "a bar"\nmetadata:\n  type: reference\n---\nthe body line\n');
  assert.equal(meta.name, 'foo');
  assert.equal(meta.description, 'a bar'); // quotes stripped
  assert.equal(meta['metadata.type'], 'reference'); // nested -> dotted (the real Claude Code format)
  assert.equal(body.trim(), 'the body line');

  const plain = splitFrontmatter('# just markdown\ntext');
  assert.deepEqual(plain.meta, {});
  assert.match(plain.body, /just markdown/);

  // Unterminated fence -> treated as body, not silently swallowed.
  const unterminated = splitFrontmatter('---\nname: x\nno closing fence here\n');
  assert.deepEqual(unterminated.meta, {});
  assert.match(unterminated.body, /no closing fence/);
});

test('content marker changes on edit; identity marker is stable across edits', () => {
  const v1 = { sourceKind: 'claude-code', sourceFile: '/m/deploy.md', title: 'deploy', text: 'drain 30s' };
  const v2 = { ...v1, text: 'drain 90s' };
  assert.equal(identityMarker(v1), identityMarker(v2), 'identity stable across a body edit');
  assert.notEqual(contentMarker(v1), contentMarker(v2), 'content marker differs after a body edit');
  assert.equal(contentMarker(v1), contentMarker({ ...v1 }), 'content marker stable for identical content');
});

test('planImport detects claude-code, imports fact files, excludes MEMORY.md, skips empty, tags from nested metadata', async (t) => {
  const dir = await claudeMemoryFixture(t);
  const plan = await planImport({ from: dir });
  assert.equal(plan.source, 'claude-code');
  assert.deepEqual(plan.items.map((i) => i.title).sort(), ['deploy-runbook', 'pg-tz-gotcha']);
  assert.ok(!plan.items.some((i) => path.basename(i.sourceFile) === 'MEMORY.md'), 'MEMORY.md excluded');
  assert.ok(plan.skipped.some((s) => path.basename(s.file) === 'empty.md' && /empty/.test(s.reason)));
  const pg = plan.items.find((i) => i.title === 'pg-tz-gotcha');
  assert.ok(pg.tags.includes('reference'), 'type tag derived from nested metadata.type');
});

test('a MEMORY.md path resolves to its directory and imports the sibling fact files', async (t) => {
  const dir = await claudeMemoryFixture(t);
  const plan = await planImport({ from: path.join(dir, 'MEMORY.md') });
  assert.equal(plan.source, 'claude-code');
  assert.equal(plan.items.length, 2);
});

test('applyImport writes to the journal lane, is findable by its UNIQUE marker at its EXACT path, and is idempotent', async (t) => {
  const core = await managed(t);
  const dir = await claudeMemoryFixture(t);
  const plan = await planImport({ from: dir });
  const jdirs = [core.workspace.journalDir];

  const applied = await applyImport(core.workspace, plan.items, { journalDirs: jdirs });
  assert.equal(applied.filter((a) => a.status === 'written').length, 2);
  for (const a of applied) assert.match(a.path, /memory\/journal\/\d{4}-\d{2}-\d{2}\.md$/);
  await core.rebuild();

  // The ship-blocker fix: verify by the unique content marker, matched on the EXACT journal path —
  // never a title word (saturable past the search limit) and never a basename (collides with a curated
  // daily). search(marker) must return precisely this entry's path.
  for (const a of applied) {
    const hits = await core.search(a.contentMarker, { limit: 25 });
    assert.ok(hits.some((h) => h.path === a.path), `marker round-trips to exact path for ${a.title}`);
  }

  // Idempotent: re-running with the existing markers skips every item as a duplicate, never doubles.
  const existing = await collectExistingImports(jdirs);
  assert.equal(existing.content.size, 2);
  assert.equal(existing.identity.size, 2);
  const again = await applyImport(core.workspace, plan.items, { existing, journalDirs: jdirs });
  assert.equal(again.filter((a) => a.status === 'written').length, 0);
  assert.equal(again.filter((a) => a.status === 'skipped-duplicate').length, 2);
});

test('applyImport is reversible — a written entry can be rolled back by its audit eventId', async (t) => {
  const core = await managed(t);
  const dir = await claudeMemoryFixture(t);
  const plan = await planImport({ from: dir });
  const applied = await applyImport(core.workspace, plan.items, { journalDirs: [core.workspace.journalDir] });
  await core.rebuild();

  const target = applied.find((a) => a.status === 'written');
  const abs = path.join(core.workspace.memoryDir, target.path.replace(/^memory\//, ''));
  assert.match(await fs.readFile(abs, 'utf8'), new RegExp(target.contentMarker));

  const result = await core.rollback(target.eventId);
  assert.equal(result.removed, true);
  assert.ok(!(await fs.readFile(abs, 'utf8')).includes(target.contentMarker), 'rolled-back entry is gone');
});

test('secret-like content in the BODY or the TITLE is refused and never stored', async (t) => {
  const core = await managed(t);
  const dir = await mkdtempReal('ihow-import-secret-');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  await fs.writeFile(path.join(dir, 'MEMORY.md'), '# idx\n', 'utf8');
  // secret only in the BODY
  await fs.writeFile(path.join(dir, 'body.md'), '---\nname: aws-body\n---\nKey AKIAIOSFODNN7EXAMPLE must be kept safe.\n', 'utf8');
  // secret only in the TITLE (frontmatter name) — the channel appendJournal does NOT scan
  await fs.writeFile(path.join(dir, 'title.md'), '---\nname: prod key AKIAIOSFODNN7EXAMPLE\n---\nrotate quarterly\n', 'utf8');

  const plan = await planImport({ from: dir });
  const applied = await applyImport(core.workspace, plan.items, { journalDirs: [core.workspace.journalDir] });
  assert.equal(applied.filter((a) => a.status === 'skipped-secret').length, 2, 'both body- and title-secret items refused');

  let leaked = false;
  async function scan(d) {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await scan(p);
      else if ((await fs.readFile(p, 'utf8')).includes('AKIAIOSFODNN7EXAMPLE')) leaked = true;
    }
  }
  await scan(core.workspace.spaceDir);
  assert.equal(leaked, false, 'secret value never written to disk');
});

test('an EDITED fact is not silently doubled; --update supersedes the stale copy', async (t) => {
  const core = await managed(t);
  const dir = await mkdtempReal('ihow-import-edit-');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const jdirs = [core.workspace.journalDir];
  await fs.writeFile(path.join(dir, 'MEMORY.md'), '# idx\n', 'utf8');
  const fact = path.join(dir, 'deploy.md');
  await fs.writeFile(fact, '---\nname: deploy-runbook\n---\nBlue green drain old 30s flip LB.\n', 'utf8');

  let plan = await planImport({ from: dir });
  let applied = await applyImport(core.workspace, plan.items, { existing: await collectExistingImports(jdirs), journalDirs: jdirs });
  await core.rebuild();
  assert.equal(applied[0].status, 'written');

  // edit the SAME fact's body
  await fs.writeFile(fact, '---\nname: deploy-runbook\n---\nBlue green drain old 90s corrected flip LB.\n', 'utf8');
  plan = await planImport({ from: dir });

  // without --update: reported as changed, NOT written (no silent double)
  applied = await applyImport(core.workspace, plan.items, { existing: await collectExistingImports(jdirs), journalDirs: jdirs });
  assert.equal(applied[0].status, 'skipped-changed');
  await core.rebuild();
  assert.equal((await core.search('90s', { limit: 10 })).length, 0, 'new version NOT written without --update');

  // with --update: supersedes the stale entry and writes the new one
  applied = await applyImport(core.workspace, plan.items, { existing: await collectExistingImports(jdirs), journalDirs: jdirs, update: true });
  assert.equal(applied[0].status, 'updated');
  assert.ok((applied[0].supersededCount ?? 0) >= 1, 'stale entry superseded');
  await core.rebuild();
  assert.equal((await core.search('30s', { limit: 10 })).length, 0, 'stale version no longer searchable');
  assert.ok((await core.search('90s', { limit: 10 })).length >= 1, 'new version searchable');

  // keep-history (borrowed from ai-memory, adapted): the stale version is ARCHIVED to historyDir
  // (outside the index), preserved for audit but never searchable/recalled — not destroyed.
  const hist = await fs.readFile(path.join(core.workspace.historyDir, 'superseded-import.md'), 'utf8');
  assert.match(hist, /30s/, 'stale version preserved in off-index history');
  assert.match(hist, /NOT indexed/, 'history entry marked non-indexed');
});

test('binary / non-UTF8 .md is skipped with a reason, not ingested', async (t) => {
  const dir = await mkdtempReal('ihow-import-bin-');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  await fs.writeFile(path.join(dir, 'MEMORY.md'), '# idx\n', 'utf8');
  await fs.writeFile(path.join(dir, 'good.md'), '---\nname: ok\n---\nreal note here\n', 'utf8');
  await fs.writeFile(path.join(dir, 'bin.md'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xff]));

  const plan = await planImport({ from: dir });
  assert.deepEqual(plan.items.map((i) => i.title), ['ok']);
  assert.ok(plan.skipped.some((s) => path.basename(s.file) === 'bin.md' && /UTF-8|NUL/.test(s.reason)), 'binary skipped with a reason');
});

test('generic markdown source: one item per .md file', async (t) => {
  const dir = await mkdtempReal('ihow-import-md-');
  t.after(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  await fs.writeFile(path.join(dir, 'a.md'), '# Cursor pagination\nUse opaque next_cursor for the feed.\n', 'utf8');
  await fs.writeFile(path.join(dir, 'b.md'), 'no heading, just a note about retries\n', 'utf8');

  const plan = await planImport({ from: dir, source: 'markdown' });
  assert.equal(plan.source, 'markdown');
  assert.equal(plan.items.length, 2);
  assert.equal(plan.items.find((i) => path.basename(i.sourceFile) === 'a.md').title, 'Cursor pagination');
  assert.equal(plan.items.find((i) => path.basename(i.sourceFile) === 'b.md').title, 'b');
});

test('empty / missing source yields zero items (the CLI maps this to a non-zero exit)', async (t) => {
  const empty = await mkdtempReal('ihow-import-empty-');
  t.after(async () => { await fs.rm(empty, { recursive: true, force: true }); });
  assert.equal((await planImport({ from: empty })).items.length, 0);
  assert.equal((await planImport({ from: path.join(empty, 'nope', 'gone') })).items.length, 0, 'non-existent path is zero items, not a crash');
});
