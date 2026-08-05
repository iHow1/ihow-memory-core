// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';
import { resolveEngineConfig, searchWithEngineFallback } from '../src/engine/retrieval.ts';

const provider = fileURLToPath(new URL('../examples/ollama-embedding-provider.mjs', import.meta.url));
const model = 'deterministic-sidecar-test';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-sidecar-validation-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/embeddings');
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embedding: [1, 0, 0] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const host = `http://127.0.0.1:${address.port}`;

  const lexicalCore = await openCore({ root, cwd: root, space: 'truth' });
  const entry = await lexicalCore.journal({ text: 'bounded fallback evidence corpus', sourceAgent: 'test' });
  const indexed = await lexicalCore.rebuild();
  assert.ok(indexed > 0, 'FTS corpus must be non-empty');

  const vectorCore = await openCore({
    root,
    cwd: root,
    space: 'truth',
    engine: 'vector-gguf',
    vectorModel: model,
    vectorProviderCommand: `${process.execPath} ${provider}`,
    vectorTimeoutMs: 5000,
  });
  const config = resolveEngineConfig({
    engine: 'vector-gguf',
    vectorModel: model,
    vectorProviderCommand: `${process.execPath} ${provider}`,
    vectorTimeoutMs: 5000,
  });
  const sidecar = path.join(path.dirname(vectorCore.workspace.indexPath), `ollama-${model}-sidecar.json`);
  return { vectorCore, config, sidecar, entry, host };
}

async function withOllamaHost(host, fn) {
  const previous = process.env.OLLAMA_HOST;
  process.env.OLLAMA_HOST = host;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = previous;
  }
}

async function runProviderSearch(fx) {
  const child = spawn(process.execPath, [provider, 'search'], {
    env: { ...process.env, OLLAMA_HOST: fx.host },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    method: 'search',
    workspace: {
      root: fx.vectorCore.workspace.root,
      memoryDir: fx.vectorCore.workspace.memoryDir,
      indexPath: fx.vectorCore.workspace.indexPath,
    },
    provider: { id: 'vector-gguf', model },
    query: 'bounded fallback evidence',
    opts: { limit: 5 },
  }));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout, stderr };
}

async function assertProviderCode(fx, expected) {
  const result = await runProviderSearch(fx);
  assert.notEqual(result.code, 0);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).error, expected);
}

test('missing Ollama sidecar fails explicitly and falls back to non-empty FTS', async (t) => {
  const fx = await fixture(t);
  const result = await withOllamaHost(fx.host, () => (
    searchWithEngineFallback(fx.vectorCore.workspace, fx.config, 'bounded fallback evidence', { limit: 5 })
  ));

  assert.ok(result.hits.length > 0);
  assert.equal(result.hits[0].path, fx.entry.path);
  assert.deepEqual(result.fallback?.from, 'vector-gguf');
  assert.equal(result.fallback?.to, 'fts');
  assert.match(result.fallback?.reason || '', /^vector_provider_exit_1:search$/);
  assert.deepEqual(result.hits[0].fallback, result.fallback);

  const manifest = JSON.parse(await fs.readFile(fx.vectorCore.workspace.indexManifestPath, 'utf8'));
  assert.equal(manifest.status, 'fallback');
  assert.equal(manifest.providerId, 'fts');
  assert.equal(manifest.providers['vector-gguf'].ready, false);
  assert.doesNotMatch(JSON.stringify({ fallback: result.fallback, manifest }), /bounded fallback evidence corpus/);
  const escapedPath = fx.entry.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.doesNotMatch(JSON.stringify({ fallback: result.fallback, manifest }), new RegExp(escapedPath));
});

test('malformed JSON Ollama sidecar fails explicitly instead of succeeding empty', async (t) => {
  const fx = await fixture(t);
  await fs.writeFile(fx.sidecar, '{not-json', 'utf8');
  const result = await withOllamaHost(fx.host, () => (
    searchWithEngineFallback(fx.vectorCore.workspace, fx.config, 'bounded fallback evidence', { limit: 5 })
  ));
  assert.ok(result.hits.length > 0);
  assert.equal(result.hits[0].path, fx.entry.path);
  assert.match(result.fallback?.reason || '', /^vector_provider_exit_1:search$/);
});

test('empty-docs Ollama sidecar fails when the FTS corpus is non-empty', async (t) => {
  const fx = await fixture(t);
  await fs.writeFile(fx.sidecar, JSON.stringify({ model, docs: [] }), 'utf8');
  const result = await withOllamaHost(fx.host, () => (
    searchWithEngineFallback(fx.vectorCore.workspace, fx.config, 'bounded fallback evidence', { limit: 5 })
  ));
  assert.ok(result.hits.length > 0);
  assert.match(result.fallback?.reason || '', /^vector_provider_exit_1:search$/);
});

test('model-mismatched Ollama sidecar fails explicitly', async (t) => {
  const fx = await fixture(t);
  await fs.writeFile(fx.sidecar, JSON.stringify({
    model: 'wrong-model',
    docs: [{ path: fx.entry.path, vec: [1, 0, 0], preview: 'semantic preview' }],
  }), 'utf8');
  const result = await withOllamaHost(fx.host, () => (
    searchWithEngineFallback(fx.vectorCore.workspace, fx.config, 'bounded fallback evidence', { limit: 5 })
  ));
  assert.ok(result.hits.length > 0);
  assert.match(result.fallback?.reason || '', /^vector_provider_exit_1:search$/);
});

test('invalid Ollama docs/vector structure and dimensions fail explicitly', async (t) => {
  const cases = [
    { label: 'docs is not an array', store: { model, docs: {} } },
    { label: 'doc path is missing', store: { model, docs: [{ vec: [1, 0, 0], preview: 'x' }] } },
    { label: 'vector is empty', store: { model, docs: [{ path: 'memory/x.md', vec: [], preview: 'x' }] } },
    { label: 'vector has non-finite data', store: { model, docs: [{ path: 'memory/x.md', vec: [1, 'bad', 0], preview: 'x' }] } },
    { label: 'stored dimensions disagree', store: {
      model,
      docs: [
        { path: 'memory/x.md', vec: [1, 0, 0], preview: 'x' },
        { path: 'memory/y.md', vec: [1, 0], preview: 'y' },
      ],
    } },
    { label: 'query dimensions disagree with stored vectors', store: {
      model,
      docs: [{ path: 'memory/x.md', vec: [1, 0], preview: 'x' }],
    } },
  ];

  for (const item of cases) {
    await t.test(item.label, async (t) => {
      const fx = await fixture(t);
      await fs.writeFile(fx.sidecar, JSON.stringify(item.store), 'utf8');
      const result = await withOllamaHost(fx.host, () => (
        searchWithEngineFallback(fx.vectorCore.workspace, fx.config, 'bounded fallback evidence', { limit: 5 })
      ));
      assert.ok(result.hits.length > 0);
      assert.match(result.fallback?.reason || '', /^vector_provider_exit_1:search$/);
    });
  }
});

test('Ollama sidecar enforces bounded resources and canonical memory Markdown paths', async (t) => {
  const validDoc = { path: 'memory/x.md', vec: [1, 0, 0], preview: 'x' };
  const cases = [
    { label: 'too many docs', code: 'ollama_sidecar_too_many_docs', store: { model, docs: Array.from({ length: 10001 }, () => validDoc) } },
    { label: 'oversized vector dimension', code: 'ollama_sidecar_invalid_dimension', store: { model, docs: [{ ...validDoc, vec: Array(8193).fill(0) }] } },
    { label: 'preview character bound', code: 'ollama_sidecar_preview_too_large', store: { model, docs: [{ ...validDoc, preview: 'x'.repeat(2001) }] } },
    { label: 'preview UTF-8 byte bound', code: 'ollama_sidecar_preview_too_large', store: { model, docs: [{ ...validDoc, preview: '😀'.repeat(1600) }] } },
    ...[
      '/memory/x.md',
      '../memory/x.md',
      'memory/../x.md',
      'memory\\x.md',
      'memory/x\0.md',
      'memory/x\n.md',
      'other/x.md',
      'memory/x.txt',
      'memory//x.md',
      'memory/./x.md',
    ].map((badPath) => ({
      label: `invalid path ${JSON.stringify(badPath)}`,
      code: 'ollama_sidecar_invalid_path',
      store: { model, docs: [{ ...validDoc, path: badPath }] },
    })),
  ];

  for (const item of cases) {
    await t.test(item.label, async (t) => {
      const fx = await fixture(t);
      await fs.writeFile(fx.sidecar, JSON.stringify(item.store), 'utf8');
      await assertProviderCode(fx, item.code);
    });
  }
});

test('Ollama sidecar rejects oversized and unreadable targets before JSON parsing', async (t) => {
  await t.test('oversized file', async (t) => {
    const fx = await fixture(t);
    const handle = await fs.open(fx.sidecar, 'w');
    await handle.truncate(16 * 1024 * 1024 + 1);
    await handle.close();
    await assertProviderCode(fx, 'ollama_sidecar_too_large');
  });

  await t.test('non-file target', async (t) => {
    const fx = await fixture(t);
    await fs.mkdir(fx.sidecar, { recursive: true });
    await assertProviderCode(fx, 'ollama_sidecar_unreadable');
  });
});

test('valid matching Ollama sidecar returns semantic evidence without fallback', async (t) => {
  const fx = await fixture(t);
  await fs.writeFile(fx.sidecar, JSON.stringify({
    model,
    docs: [{ path: fx.entry.path, vec: [1, 0, 0], preview: 'semantic preview' }],
  }), 'utf8');
  const result = await withOllamaHost(fx.host, () => (
    searchWithEngineFallback(fx.vectorCore.workspace, fx.config, 'bounded fallback evidence', { limit: 5 })
  ));

  assert.equal(result.fallback, undefined);
  assert.equal(result.hits[0].path, fx.entry.path);
  assert.equal(result.hits[0].semanticScore, 1);
  const manifest = JSON.parse(await fs.readFile(fx.vectorCore.workspace.indexManifestPath, 'utf8'));
  assert.equal(manifest.status, 'ready');
  assert.equal(manifest.providerId, 'vector-gguf');
});

test('an empty semantic hit set is not treated as a successful vector lane', async (t) => {
  const fx = await fixture(t);
  await fs.writeFile(fx.sidecar, JSON.stringify({
    model,
    docs: [{ path: fx.entry.path, vec: [0, 1, 0], preview: 'orthogonal semantic preview' }],
  }), 'utf8');
  const result = await withOllamaHost(fx.host, () => (
    searchWithEngineFallback(fx.vectorCore.workspace, fx.config, 'bounded fallback evidence', { limit: 5 })
  ));
  assert.ok(result.hits.length > 0);
  assert.match(result.fallback?.reason || '', /^vector_provider_exit_1:search$/);
});
