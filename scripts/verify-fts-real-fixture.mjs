// Compare repaired FTS on copied historical corpora whose source bodies match.
// Writes only a new output directory. Original corpora and indexes are read-only.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { rebuildFtsIndex, searchFts } from '../src/engine/fts.ts';
import { resolveWorkspace } from '../src/workspace.ts';

const { values } = parseArgs({ options: {
  old: { type: 'string' }, new: { type: 'string' }, output: { type: 'string' },
} });
if (!values.old || !values.new || !values.output) throw new Error('--old --new --output required');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hashFile = async (p) => sha(await fs.readFile(p));
const readJson = async (p) => JSON.parse(await fs.readFile(p, 'utf8'));
const assert = (ok, reason) => { if (!ok) throw new Error(reason); };
const body = (s) => s.replace(/^\uFEFF?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '').trim();
const inputs = await Promise.all([values.old, values.new].map(async (raw) => {
  const dir = path.resolve(raw), run = await readJson(path.join(dir, 'run.json'));
  assert(run.status === 'complete' && run.split === 'dev' && run.system === 'ihow-full-read', 'completed dev full-read fixtures required');
  assert(run.system_settings.AML_SERIALIZATION === 'legacy' && run.system_settings.AML_READ_MODE === 'full', 'fixture factors differ');
  const file = path.join(dir, 'queries.jsonl');
  assert(await hashFile(file) === run.queries_jsonl_sha256, 'query artifact hash mismatch');
  const rows = (await fs.readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert(rows.length === 1586 && new Set(rows.map((r) => r.question_id)).size === 1586 && rows.every((r) => r.status === 'ok'), 'complete unique fixture queries required');
  return { dir, run, rows, state: path.join(path.dirname(dir), 'state', path.basename(dir), 'memory') };
}));
for (const key of ['histories_sha256', 'questions_sha256', 'request_namespace', 'selected_history_ids', 'selected_question_ids', 'runner_sha256', 'context_budget']) {
  assert(JSON.stringify(inputs[0].run[key]) === JSON.stringify(inputs[1].run[key]), `fixture mismatch: ${key}`);
}
assert(inputs[0].run.selected_history_ids.length === 8, 'eight development histories required');
const output = path.resolve(values.output);
await fs.mkdir(output, { recursive: false });
const sourceHashes = new Map(), originalBodies = new Map(), workspaces = [new Map(), new Map()];
let documents = 0;
for (let lane = 0; lane < 2; lane++) {
  const input = inputs[lane];
  for (const history of input.run.selected_history_ids) {
    const space = 'aml-user-' + sha(`${input.run.request_namespace}:${history}`).slice(0, 32);
    const origin = path.join(input.state, space);
    const workspace = resolveWorkspace({ root: path.join(output, lane ? 'new' : 'old'), space });
    workspaces[lane].set(history, workspace);
    const folder = path.join(origin, 'memory/scopes/sessions');
    const names = (await fs.readdir(folder)).filter((n) => n.endsWith('.md')).sort();
    await fs.mkdir(path.join(workspace.memoryDir, 'scopes/sessions'), { recursive: true });
    const expected = [];
    for (const name of names) {
      const from = path.join(folder, name);
      assert((await fs.lstat(from)).isFile(), 'fixture source must be a regular file');
      const bytes = await fs.readFile(from), key = `${history}/${name}`;
      sourceHashes.set(from, sha(bytes));
      if (!lane) { originalBodies.set(key, body(bytes.toString('utf8'))); documents++; }
      else assert(originalBodies.get(key) === body(bytes.toString('utf8')), 'source bodies differ');
      await fs.writeFile(path.join(workspace.memoryDir, 'scopes/sessions', name), bytes, { flag: 'wx' });
      expected.push(`memory/scopes/sessions/${name}`);
    }
    const originalIndex = path.join(origin, 'index.sqlite');
    for (const suffix of ['-wal', '-journal']) {
      const info = await fs.stat(originalIndex + suffix).catch((e) => e.code === 'ENOENT' ? null : Promise.reject(e));
      assert(!info || info.size === 0, 'fixture must have a checkpointed closed index');
    }
    sourceHashes.set(originalIndex, await hashFile(originalIndex));
    await fs.copyFile(originalIndex, workspace.indexPath);
    const manifest = path.join(origin, 'index-manifest.json');
    sourceHashes.set(manifest, await hashFile(manifest));
    await fs.copyFile(manifest, workspace.indexManifestPath);
    const before = new DatabaseSync(workspace.indexPath, { readOnly: true });
    try {
      const indexed = before.prepare('SELECT path FROM memory_fts ORDER BY path').all().map((r) => r.path);
      assert(JSON.stringify(indexed) === JSON.stringify(expected), 'copied fixture index/corpus differ');
    } finally { before.close(); }
    // Exercise automatic migration of a copied old-generation index.
    await searchFts(workspace, 'migration-probe', { limit: 1 });
  }
}
assert(documents === 326 && originalBodies.size === 326, 'expected 326 source documents per lane');
let projectedRows = 0;
for (const history of inputs[0].run.selected_history_ids) {
  const indexed = [];
  for (let lane = 0; lane < 2; lane++) {
    const ws = workspaces[lane].get(history), db = new DatabaseSync(ws.indexPath, { readOnly: true });
    try {
      const rows = db.prepare('SELECT path, content, orig, flagged, reviewed FROM memory_fts ORDER BY path').all();
      for (const row of rows) {
        const file = path.join(ws.memoryDir, row.path.replace(/^memory\//, ''));
        assert(row.orig === await fs.readFile(file, 'utf8'), 'orig no longer preserves stored source bytes');
      }
      indexed.push(rows.map(({ orig, ...row }) => row));
      if (history === 'conv-42') assert(db.prepare("SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH '\"25\"'").get().n === 0, 'operational seconds still match numeric query');
    } finally { db.close(); }
  }
  assert(JSON.stringify(indexed[0]) === JSON.stringify(indexed[1]), 'projected content/governance rows differ');
  projectedRows += indexed[0].length;
}
const lookup = new Map(inputs[1].rows.map((row) => [row.question_id, row]));
const mismatches = [];
for (const row of inputs[0].rows) {
  const right = lookup.get(row.question_id);
  assert(right && right.query === row.query && right.history_id === row.history_id, 'question identity mismatch');
  const result = await Promise.all([0, 1].map((lane) => searchFts(workspaces[lane].get(row.history_id), row.query, { limit: 25 })));
  if (JSON.stringify(result[0]) !== JSON.stringify(result[1])) mismatches.push(row.question_id);
}
// Explicit rebuild must produce the same projection as lazy migration.
for (const history of inputs[0].run.selected_history_ids) {
  const ws = workspaces[1].get(history);
  const probe = inputs[0].rows.find((r) => r.history_id === history).query;
  const before = await searchFts(ws, probe, { limit: 25 });
  await rebuildFtsIndex(ws);
  assert(JSON.stringify(before) === JSON.stringify(await searchFts(ws, probe, { limit: 25 })), 'explicit rebuild differs from lazy projection');
}
for (const [file, expected] of sourceHashes) assert(await hashFile(file) === expected, 'original fixture changed');
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sourceFiles = ['src/engine/fts.ts', 'src/engine/source-projection.ts'];
const hashes = {};
for (const file of sourceFiles) {
  const bytes = await fs.readFile(path.join(root, file)).catch((e) => e.code === 'ENOENT' ? null : Promise.reject(e));
  if (bytes) hashes[file] = sha(bytes);
}
const summary = { kind: 'core_fts_real_fixture_counterfactual', status: mismatches.length ? 'failed' : 'passed',
  copied_index_count: 16, documents_per_lane: documents, identical_projected_rows: projectedRows,
  compared_queries: 1586, queries_with_equal_paths_scores_snippets: 1586 - mismatches.length,
  mismatching_query_ids: mismatches, numeric_25_hits_in_conv42_each_lane: 0,
  original_source_and_index_hashes_unchanged: true, original_files_verified: sourceHashes.size,
  lazy_migration_and_explicit_rebuild_agree: true, orig_bytes_preserved: true,
  core_source_files_sha256: hashes, node_version: process.version,
  source_runs: inputs.map((i) => i.dir), model_calls: 0, holdout_used: false,
  limitations: ['FTS counterfactual repeatability, not adapter coverage or answer accuracy.',
    'The metadata is copied exactly from historical runs; no source metadata was rewritten.',
    'The candidate is local and unpublished; production indexes were not modified.'] };
await fs.writeFile(path.join(output, 'result.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(summary));
if (mismatches.length) process.exitCode = 1;
