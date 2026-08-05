// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

async function readManifest(core) {
  return JSON.parse(await fs.readFile(core.workspace.indexManifestPath, 'utf8'));
}

test('provider reachability cannot wash a failed vector index manifest green', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-index-truth-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const provider = path.join(root, 'fake-vector-provider.mjs');
  const successfulIndexMarker = path.join(root, 'allow-successful-index');
  const searchMarker = path.join(root, 'vector-search-called');
  await fs.writeFile(provider, `
import fs from 'node:fs';
const method = process.argv[process.argv.length - 1];
process.stdin.resume();
process.stdin.on('end', () => {
  if (method === 'status') {
    process.stdout.write(JSON.stringify({ id: 'vector-gguf', model: 'offline-fake', ready: true, cloud: false, dimension: 384 }));
    return;
  }
  if (method === 'index') {
    if (fs.existsSync(${JSON.stringify(successfulIndexMarker)})) {
      process.stdout.write(JSON.stringify({ indexed: 1 }));
      return;
    }
    process.stderr.write('deterministic_index_failure');
    process.exitCode = 17;
    return;
  }
  if (method === 'search') {
    fs.writeFileSync(${JSON.stringify(searchMarker)}, 'called');
    process.stdout.write(JSON.stringify({ hits: [{ path: 'memory/semantic-only.md', snippet: 'semantic only', score: 0.9 }] }));
    return;
  }
  process.stdout.write(JSON.stringify({ hits: [] }));
});
`, 'utf8');

  const core = await openCore({
    root,
    cwd: root,
    space: 'truth',
    engine: 'vector-gguf',
    vectorModel: 'offline-fake',
    vectorProviderCommand: `${process.execPath} ${provider}`,
  });
  const rawMemoryText = 'bounded offline corpus entry';
  const entry = await core.journal({ text: rawMemoryText, sourceAgent: 'test' });

  const indexed = await core.rebuild();
  assert.ok(indexed > 0, 'the lexical corpus is non-empty even though vector indexing failed');
  const failed = await readManifest(core);
  assert.equal(failed.status, 'fallback');
  assert.equal(failed.providerId, 'fts');
  assert.equal(failed.dims, null);
  assert.equal(failed.providers['vector-gguf'].ready, false);

  const status = await core.status();
  const afterStatus = await readManifest(core);
  assert.equal(afterStatus.status, 'fallback', 'provider status readiness must not rewrite a failed index manifest to ready');
  assert.equal(afterStatus.providerId, 'fts');
  assert.equal(afterStatus.dims, null);
  assert.equal(afterStatus.providers['vector-gguf'].ready, false);
  assert.equal(status.provider.id, 'fts');
  assert.equal(status.provider.fallback, true);
  assert.equal(status.provider.requested.id, 'vector-gguf');
  assert.equal(status.provider.requested.ready, false);
  assert.equal(status.capabilities.semantic, false);

  const failedBytes = await fs.readFile(core.workspace.indexManifestPath);
  const failedSearch = await core.search('bounded offline corpus', { limit: 5 });
  assert.ok(failedSearch.some((hit) => hit.path === entry.path), 'failed manifest keeps bounded lexical FTS available');
  await assert.rejects(fs.access(searchMarker), /ENOENT/, 'search must not call vector provider while index manifest is failed');
  assert.deepEqual(
    await fs.readFile(core.workspace.indexManifestPath),
    failedBytes,
    'search must not wash or rewrite the authoritative failed manifest',
  );

  const publicFailureSurface = JSON.stringify({
    manifestError: afterStatus.lastError,
    provider: status.provider,
    indexError: status.index.lastError,
  });
  assert.doesNotMatch(publicFailureSurface, new RegExp(rawMemoryText));
  assert.doesNotMatch(publicFailureSurface, new RegExp(entry.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  await fs.writeFile(successfulIndexMarker, 'ok', 'utf8');
  await core.rebuild();
  const recovered = await readManifest(core);
  const recoveredStatus = await core.status();
  assert.equal(recovered.status, 'ready', 'a later successful rebuild may recover vector readiness');
  assert.equal(recovered.providerId, 'vector-gguf');
  assert.equal(recovered.dims, 384);
  assert.equal(recovered.providers['vector-gguf'].dimension, 384);
  assert.equal(recoveredStatus.provider.id, 'vector-gguf');
  assert.equal(recoveredStatus.provider.ready, true);
  assert.equal(recoveredStatus.provider.dimension, 384);

  const readySearch = await core.search('semantic only', { limit: 5 });
  assert.ok(readySearch.some((hit) => hit.path === 'memory/semantic-only.md'), 'ready manifest allows semantic search');
  assert.equal(await fs.readFile(searchMarker, 'utf8'), 'called');
});

test('a successful zero-document vector rebuild honestly recovers manifest readiness', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-empty-index-truth-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const provider = path.join(root, 'fake-empty-vector-provider.mjs');
  const successfulIndexMarker = path.join(root, 'allow-empty-index');
  await fs.writeFile(provider, `
import fs from 'node:fs';
const method = process.argv[process.argv.length - 1];
process.stdin.resume();
process.stdin.on('end', () => {
  if (method === 'status') {
    process.stdout.write(JSON.stringify({ id: 'vector-gguf', model: 'offline-empty', ready: true, cloud: false }));
    return;
  }
  if (method === 'index') {
    if (!fs.existsSync(${JSON.stringify(successfulIndexMarker)})) process.exitCode = 17;
    else process.stdout.write(JSON.stringify({ indexed: 0 }));
    return;
  }
  process.exitCode = 19;
});
`, 'utf8');

  const core = await openCore({
    root,
    cwd: root,
    space: 'empty-truth',
    engine: 'vector-gguf',
    vectorModel: 'offline-empty',
    vectorProviderCommand: `${process.execPath} ${provider}`,
  });
  assert.equal(await core.rebuild(), 0);
  assert.equal((await readManifest(core)).status, 'fallback');

  await fs.writeFile(successfulIndexMarker, 'ok', 'utf8');
  assert.equal(await core.rebuild(), 0);
  const recovered = await readManifest(core);
  const status = await core.status();
  assert.equal(recovered.status, 'ready');
  assert.equal(recovered.providerId, 'vector-gguf');
  assert.equal(status.provider.id, 'vector-gguf');
  assert.equal(status.provider.ready, true);
  assert.equal(status.index.documents, 0);
});

test('provider dimensions fail closed without changing vector readiness', async (t) => {
  const cases = [
    { label: 'missing', statusField: '' },
    { label: 'zero', statusField: ', dimension: 0' },
    { label: 'negative', statusField: ', dimension: -1' },
    { label: 'fractional', statusField: ', dimension: 3.5' },
    { label: 'oversized', statusField: ', dimension: 8193' },
    { label: 'string', statusField: ", dimension: '384'" },
  ];

  for (const item of cases) {
    await t.test(item.label, async (t) => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-dimension-truth-')));
      t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
      const provider = path.join(root, 'fake-dimension-provider.mjs');
      await fs.writeFile(provider, `
const method = process.argv[process.argv.length - 1];
process.stdin.resume();
process.stdin.on('end', () => {
  if (method === 'status') {
    process.stdout.write(JSON.stringify({ id: 'vector-gguf', model: 'offline-dimension', ready: true, cloud: false${item.statusField} }));
    return;
  }
  if (method === 'index') {
    process.stdout.write(JSON.stringify({ indexed: 0 }));
    return;
  }
  process.stdout.write(JSON.stringify({ hits: [] }));
});
`, 'utf8');

      const core = await openCore({
        root,
        cwd: root,
        space: `dimension-${item.label}`,
        engine: 'vector-gguf',
        vectorModel: 'offline-dimension',
        vectorProviderCommand: `${process.execPath} ${provider}`,
      });
      assert.equal(await core.rebuild(), 0);
      const rebuilt = await readManifest(core);
      assert.equal(rebuilt.status, 'ready');
      assert.equal(rebuilt.dims, null);
      assert.equal(rebuilt.providers['vector-gguf'].dimension, undefined);

      const status = await core.status();
      assert.equal(status.provider.ready, true);
      assert.equal(status.provider.dimension, undefined);
      const afterStatus = await readManifest(core);
      assert.equal(afterStatus.status, 'ready');
      assert.equal(afterStatus.dims, null);
      assert.equal(afterStatus.providers['vector-gguf'].dimension, undefined);
    });
  }
});
