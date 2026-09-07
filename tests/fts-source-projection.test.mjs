// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveWorkspace } from '../src/workspace.ts';
import { searchFts, rebuildFtsIndex, loadDatabaseSync } from '../src/engine/fts.ts';
import { resolveEngineConfig, searchWithEngineFallback } from '../src/engine/retrieval.ts';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-fts-projection-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = resolveWorkspace({ root, space: 'test', cwd: root });
  await fs.mkdir(workspace.memoryDir, { recursive: true });
  return workspace;
}
async function write(workspace, name, content) {
  await fs.writeFile(path.join(workspace.memoryDir, name), content);
}
const snapshot = (hits) => hits.map(({ path, score }) => ({ path, score }));
const CORE_FIELDS = 'type: memory\nstatus: promoted\nsource_agent: fixture\ncandidate_id: "aaaaaaaa-1111-4111-8111-111111111111"\ncreated_at: "2000-01-01T00:00:00.000Z"';
const operational = (time, id) => `---\ntype: memory\nstatus: promoted\nsource_agent: fixture\ncreated_at: "${time}"\npromoted_at: "${time}"\ncandidate_id: "${id}"\ndurable_write_fingerprint: "internaldigest"\n---\n`;

test('runtime timestamp/UUID changes cannot create matches or alter scores/order', async (t) => {
  const ws = await fixture(t);
  const body = '# Project plan\n\nCedar deployment is scheduled on 25 May 2022.';
  await write(ws, 'a.md', operational('2081-11-19T01:40:25.000Z', 'aaaaaaaa-1111-4111-8111-111111111111') + body);
  await write(ws, 'b.md', operational('2082-11-19T01:40:24.000Z', 'bbbbbbbb-2222-4222-8222-222222222222') + '# Notes\n\nCedar deployment plan.');
  const before = snapshot(await searchFts(ws, 'Cedar 25', { limit: 25 }));
  assert.deepEqual(await searchFts(ws, '2081'), [], 'runtime year must not become source evidence');
  assert.deepEqual(await searchFts(ws, 'aaaaaaaa'), [], 'candidate UUID must not become source evidence');
  assert.deepEqual(await searchFts(ws, 'internaldigest'), []);
  await write(ws, 'a.md', operational('2197-01-02T09:59:01.111Z', 'cccccccc-3333-4333-8333-333333333333') + body);
  await write(ws, 'b.md', operational('2198-01-02T09:59:25.111Z', 'dddddddd-4444-4444-8444-444444444444') + '# Notes\n\nCedar deployment plan.');
  await rebuildFtsIndex(ws);
  assert.deepEqual(snapshot(await searchFts(ws, 'Cedar 25', { limit: 25 })), before);
  assert.deepEqual((await searchFts(ws, '25')).map((hit) => hit.path), ['memory/a.md']);
});

test('semantic frontmatter, nested user fields, original dates and orig bytes remain available', async (t) => {
  const ws = await fixture(t);
  const content = `\uFEFF---\r\n${CORE_FIELDS.replace(/\n/g, '\r\n')}\r\npromoted_at: "2199-01-01T00:00:00Z"\r\ntitle: "银杏计划"\r\nevent_date: "2037-08-12"\r\ntags:\r\n  - uniqueprojecttag\r\nmetadata:\r\n  description: "nestedsemantic"\r\n  created_at: "usernestedtime"\r\n---\r\n# User heading\r\n\r\nMeeting happened on 17 June 2024.\r\n`;
  await write(ws, 'semantic.md', content);
  for (const query of ['银杏', '2037', 'uniqueprojecttag', 'nestedsemantic', 'usernestedtime', '2024', 'User heading']) {
    assert.equal((await searchFts(ws, query)).length, 1, query);
  }
  assert.deepEqual(await searchFts(ws, '2199'), []);
  const db = new (loadDatabaseSync())(ws.indexPath);
  try { assert.equal(db.prepare('SELECT orig FROM memory_fts').get().orig, content); }
  finally { db.close(); }
  assert.equal(await fs.readFile(path.join(ws.memoryDir, 'semantic.md'), 'utf8'), content);
});

test('generated leading Candidate UUID heading is not indexed; body text and later headings are preserved', async (t) => {
  const ws = await fixture(t);
  await write(ws, 'candidate.md', `---\n${CORE_FIELDS}\n---\n\n# Candidate aaaaaaaa-1111-4111-8111-111111111111\n\nCedar body.\n# Candidate businessheading\nBusiness UUID bbbbbbbb-2222-4222-8222-222222222222.`);
  assert.deepEqual(await searchFts(ws, 'aaaaaaaa'), []);
  for (const query of ['Cedar', 'businessheading', 'bbbbbbbb']) assert.equal((await searchFts(ws, query)).length, 1);
});

test('projection leaves flag exclusion and unreviewed demotion driven by original metadata', async (t) => {
  const ws = await fixture(t);
  await write(ws, 'a-unreviewed.md', `---\n${CORE_FIELDS}\nreviewed: false\ntier: auto-promoted\n---\n\nCedar equal source.`);
  await write(ws, 'z-reviewed.md', `---\n${CORE_FIELDS}\nreviewed: true\n---\n\nCedar equal source.`);
  await write(ws, 'flagged.md', `---\n${CORE_FIELDS}\nflagged: true\n---\n\nCedar equal source.`);
  const hits = await searchFts(ws, 'Cedar', { limit: 25 });
  assert.deepEqual(hits.map((hit) => hit.path), ['memory/z-reviewed.md', 'memory/a-unreviewed.md']);
  assert.equal(hits[0].score, hits[1].score, 'operational fields do not influence lexical score');
  assert.equal((await searchFts(ws, 'Cedar', { includeFlagged: true, limit: 25 })).length, 3);
});

test('existing pre-projection indexes rebuild automatically without changing other tables or user_version', async (t) => {
  const ws = await fixture(t);
  const original = operational('2097-01-01T00:00:00Z', 'aaaaaaaa-1111-4111-8111-111111111111') + 'Cedar original source.';
  await write(ws, 'old.md', original);
  const db = new (loadDatabaseSync())(ws.indexPath);
  db.exec("CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, content, orig UNINDEXED, flagged UNINDEXED, reviewed UNINDEXED); CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep'); PRAGMA user_version=42;");
  db.prepare('INSERT INTO memory_fts VALUES (?,?,?,?,?)').run('memory/old.md', original, original, 0, 1);
  db.close();
  assert.deepEqual(await searchFts(ws, '2097'), [], 'an existing valid legacy schema is not sufficient');
  assert.equal((await searchFts(ws, 'Cedar')).length, 1);
  const current = new (loadDatabaseSync())(ws.indexPath);
  try {
    assert.equal(current.prepare('PRAGMA user_version').get().user_version, 42);
    assert.equal(current.prepare('SELECT value FROM unrelated').get().value, 'keep');
    assert.equal(current.prepare('SELECT orig FROM memory_fts').get().orig, original);
    assert.equal(current.prepare('SELECT source_text_v1 FROM memory_fts').get().source_text_v1, 1);
    // An old process rebuilds its own legacy schema, so current code must detect
    // the downgrade even if other tables/markers are unchanged.
    current.exec('DROP TABLE memory_fts; CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, content, orig UNINDEXED, flagged UNINDEXED, reviewed UNINDEXED)');
    current.prepare('INSERT INTO memory_fts VALUES (?,?,?,?,?)').run('memory/old.md', 'obsoleteindexneedle', original, 0, 1);
  } finally { current.close(); }
  assert.deepEqual(await searchFts(ws, 'obsoleteindexneedle'), []);
  assert.equal((await searchFts(ws, 'Cedar')).length, 1);
});

test('equal FTS scores use path order independent of insertion rowids', async (t) => {
  const ws = await fixture(t);
  await write(ws, 'a.md', 'Cedar identical source.');
  await write(ws, 'z.md', 'Cedar identical source.');
  await rebuildFtsIndex(ws);
  const db = new (loadDatabaseSync())(ws.indexPath);
  try {
    const rows = db.prepare('SELECT path,content,orig,flagged,reviewed FROM memory_fts ORDER BY path DESC').all();
    db.exec('DELETE FROM memory_fts');
    for (const row of rows) db.prepare('INSERT INTO memory_fts(path,content,orig,flagged,reviewed) VALUES (?,?,?,?,?)').run(row.path, row.content, row.orig, row.flagged, row.reviewed);
  } finally { db.close(); }
  assert.deepEqual((await searchFts(ws, 'Cedar', { limit: 25 })).map((hit) => hit.path), ['memory/a.md', 'memory/z.md']);
});

test('field projection preserves business type/status, near matches and nested fields; drops whole operational blocks', async (t) => {
  const ws = await fixture(t);
  await write(ws, 'fields.md', `---
${CORE_FIELDS}
"PROMOTED_AT": |
  excludedblocktime
auto_tier:
  - excludedblockuuid
durable_write_flags:
  - excludedpolicyvalue
created_at_notes: nearfield
appointment_at: businesstime
valid_from: validitydate
entity_aliases: [entityalias]
metadata:
  created_at: nesteddate
description: |
  semanticblock
---
Literal created_at bodydate stays.
`);
  for (const query of ['excludedblocktime', 'excludedblockuuid', 'excludedpolicyvalue']) assert.deepEqual(await searchFts(ws, query), []);
  for (const query of ['nearfield', 'businesstime', 'validitydate', 'entityalias', 'nesteddate', 'semanticblock', 'bodydate']) {
    assert.equal((await searchFts(ws, query)).length, 1, query);
  }
  await write(ws, 'malformed.md', '---\ncreated_at: preservedmalformed\n---notafence\nCedar.');
  assert.equal((await searchFts(ws, 'preservedmalformed', { rebuild: true })).length, 1, 'malformed block remains literal source');
});

test('lazy projection migration preserves vector failure manifest and cannot reactivate a provider', async (t) => {
  const ws = await fixture(t);
  await write(ws, 'memory.md', 'Cedar retained source.');
  const manifest = JSON.stringify({ providerId: 'fts', status: 'fallback', fallbackFrom: 'vector-gguf',
    lastError: 'previous_index_failure', providers: { 'vector-gguf': { ready: false } } });
  await fs.writeFile(ws.indexManifestPath, manifest);
  const config = resolveEngineConfig({ engine: 'vector-gguf', vectorProviderCommand: 'nonexistent-provider-must-not-run' });
  const result = await searchWithEngineFallback(ws, config, 'Cedar');
  assert.equal(result.fallback.reason, 'previous_index_failure');
  assert.equal(result.hits.length, 1);
  assert.equal(await fs.readFile(ws.indexManifestPath, 'utf8'), manifest);
});

test('failed projected rebuild rolls schema and source rows back atomically', async (t) => {
  const ws = await fixture(t);
  await write(ws, 'memory.md', 'Cedar old source.');
  await rebuildFtsIndex(ws);
  const manifest = await fs.readFile(ws.indexManifestPath, 'utf8');
  await write(ws, 'memory.md', 'Cedar new source.');
  const DB = loadDatabaseSync();
  const prepare = DB.prototype.prepare;
  DB.prototype.prepare = function(sql) {
    if (sql.startsWith('INSERT INTO memory_fts')) throw new Error('injected_rebuild_failure');
    return prepare.call(this, sql);
  };
  try { await assert.rejects(rebuildFtsIndex(ws), /injected_rebuild_failure/); }
  finally { DB.prototype.prepare = prepare; }
  const db = new DB(ws.indexPath);
  try {
    assert.equal(db.prepare('SELECT orig FROM memory_fts').get().orig, 'Cedar old source.');
    assert.equal(db.prepare('SELECT source_text_v1 FROM memory_fts').get().source_text_v1, 1);
  } finally { db.close(); }
  assert.equal(await fs.readFile(ws.indexManifestPath, 'utf8'), manifest);
});

test('old-writer schema replacement after readiness check fails visibly instead of searching legacy content', async (t) => {
  const ws = await fixture(t);
  await write(ws, 'memory.md', 'Cedar source.');
  await rebuildFtsIndex(ws);
  const DB = loadDatabaseSync();
  const prepare = DB.prototype.prepare;
  let replaced = false;
  DB.prototype.prepare = function(sql) {
    if (!replaced && sql.includes('bm25(memory_fts) AS rank')) {
      replaced = true;
      this.exec('DROP TABLE memory_fts; CREATE VIRTUAL TABLE memory_fts USING fts5(path UNINDEXED, content, orig UNINDEXED, flagged UNINDEXED, reviewed UNINDEXED)');
      prepare.call(this, 'INSERT INTO memory_fts VALUES (?,?,?,?,?)').run('memory/memory.md', 'legacyruntimeword', 'Cedar source.', 0, 1);
    }
    return prepare.call(this, sql);
  };
  try { await assert.rejects(searchFts(ws, 'legacyruntimeword'), /source_text_v1/); }
  finally { DB.prototype.prepare = prepare; }
  assert.equal(replaced, true);
  assert.deepEqual(await searchFts(ws, 'legacyruntimeword'), [], 'next call detects old writer and rebuilds');
});

test('ordinary user frontmatter dates and generic fields are searchable without a Core envelope', async (t) => {
  const ws = await fixture(t);
  await write(ws, 'business.md', '---\ncreated_at: "1987-04-23"\npromoted_at: "businesspromotion"\ncandidate_id: "businessidentifier"\ntype: book\nstatus: blocked\n---\nUser-authored business record.');
  for (const query of ['1987', 'businesspromotion', 'businessidentifier', 'book', 'blocked']) {
    assert.equal((await searchFts(ws, query)).length, 1, query);
  }
});

test('semantic activation evidence identity changes when the source projection changes', async (t) => {
  const { CANDIDATE_IDENTITY_FILES, candidateCodeIdentity } = await import('../scripts/semantic-activation-gate.mjs');
  const ws = await fixture(t);
  for (const relative of new Set([...CANDIDATE_IDENTITY_FILES, 'src/engine/source-projection.ts'])) {
    const file = path.join(ws.root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `bound:${relative}\n`);
  }
  const git = path.join(ws.root, 'fake-git.mjs');
  await fs.writeFile(git, "#!/usr/bin/env node\nprocess.stdout.write('0123456789abcdef0123456789abcdef01234567\\n');\n");
  await fs.chmod(git, 0o755);
  const before = await candidateCodeIdentity({ repoRoot: ws.root, gitCommand: git });
  await fs.appendFile(path.join(ws.root, 'src/engine/source-projection.ts'), 'projection changed\n');
  assert.notEqual(await candidateCodeIdentity({ repoRoot: ws.root, gitCommand: git }), before);
});
