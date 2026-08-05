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

const provider = fileURLToPath(new URL('../examples/ollama-embedding-provider.mjs', import.meta.url));
const MAX_EMBED_RESPONSE_BYTES = 256 * 1024;

async function runIndex(root, host, concurrency) {
  const memoryDir = path.join(root, 'memory');
  const indexPath = path.join(root, '.ihow', 'index.sqlite');
  await fs.mkdir(memoryDir, { recursive: true });
  await Promise.all(Array.from({ length: 10 }, (_, i) => (
    fs.writeFile(path.join(memoryDir, `doc-${i}.md`), `serial cpu corpus ${i}\n`, 'utf8')
  )));

  const env = { ...process.env, OLLAMA_HOST: host };
  delete env.OLLAMA_EMBED_CONCURRENCY;
  if (concurrency !== undefined) env.OLLAMA_EMBED_CONCURRENCY = concurrency;

  const child = spawn(process.execPath, [provider, 'index'], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    method: 'index',
    workspace: { root, memoryDir, indexPath },
    provider: { id: 'vector-gguf', model: 'deterministic-fake' },
  }));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  assert.equal(code, 0, stderr || stdout);
  assert.deepEqual(JSON.parse(stdout), { indexed: 10 });

  const sidecar = path.join(root, '.ihow', 'ollama-deterministic-fake-sidecar.json');
  const stored = JSON.parse(await fs.readFile(sidecar, 'utf8'));
  assert.equal(stored.model, 'deterministic-fake');
  assert.equal(stored.docs.length, 10);
}

async function runRawIndex(root, host, model = 'deterministic-invalid') {
  const memoryDir = path.join(root, 'memory');
  const indexPath = path.join(root, '.ihow', 'index.sqlite');
  const child = spawn(process.execPath, [provider, 'index'], {
    env: { ...process.env, OLLAMA_HOST: host },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    method: 'index',
    workspace: { root, memoryDir, indexPath },
    provider: { id: 'vector-gguf', model },
  }));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  return { code, stdout, stderr, sidecar: path.join(root, '.ihow', `ollama-${model}-sidecar.json`) };
}

test('Ollama indexing is serial by default and bounds explicit concurrency overrides', async (t) => {
  let pending = 0;
  let observedMax = 0;
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/embeddings');
    pending += 1;
    observedMax = Math.max(observedMax, pending);
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ embedding: [1, 0, 0] }));
        pending -= 1;
      }, 25);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const host = `http://127.0.0.1:${address.port}`;

  const cases = [
    { env: undefined, expected: 1, label: 'default' },
    { env: '3', expected: 3, label: 'positive override' },
    { env: '999', expected: 8, label: 'large override clamps to safe maximum' },
    { env: '1.5', expected: 1, label: 'fractional override falls back' },
    { env: 'garbage', expected: 1, label: 'malformed override falls back' },
    { env: '0', expected: 1, label: 'zero override falls back' },
    { env: '-2', expected: 1, label: 'negative override falls back' },
  ];

  for (const entry of cases) {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-ollama-index-')));
    try {
      observedMax = 0;
      await runIndex(root, host, entry.env);
      assert.equal(observedMax, entry.expected, entry.label);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test('Ollama indexing validates every embedding before replacing an existing sidecar', async (t) => {
  const responses = new Map();
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const prompt = JSON.parse(body).prompt;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embedding: responses.get(prompt) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const host = `http://127.0.0.1:${address.port}`;

  const cases = [
    { label: 'non-number element', vectors: [[1, 0, 0], [1, 'bad', 0]], code: 'ollama_embedding_invalid_vector' },
    { label: 'inconsistent dimensions', vectors: [[1, 0, 0], [1, 0]], code: 'ollama_embedding_dimension_mismatch' },
    { label: 'zero dimensions', vectors: [[1, 0, 0], []], code: 'ollama_embedding_invalid_dimension' },
    { label: 'oversized dimensions', vectors: [[1, 0, 0], Array(8193).fill(0)], code: 'ollama_embedding_invalid_dimension' },
  ];

  for (const item of cases) {
    await t.test(item.label, async () => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-ollama-invalid-index-')));
      try {
        await fs.mkdir(path.join(root, 'memory'), { recursive: true });
        await fs.writeFile(path.join(root, 'memory', 'a.md'), 'first document', 'utf8');
        await fs.writeFile(path.join(root, 'memory', 'b.md'), 'second document', 'utf8');
        responses.set('first document', item.vectors[0]);
        responses.set('second document', item.vectors[1]);
        const target = path.join(root, '.ihow', 'ollama-deterministic-invalid-sidecar.json');
        const oldBytes = Buffer.from('{"old":"sidecar bytes stay exact"}\n');
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, oldBytes);

        const result = await runRawIndex(root, host);
        assert.notEqual(result.code, 0, 'invalid embeddings must not report index success');
        assert.equal(JSON.parse(result.stdout).error, item.code);
        assert.deepEqual(await fs.readFile(target), oldBytes, 'existing sidecar bytes remain unchanged');
        const temps = (await fs.readdir(path.dirname(target))).filter((name) => name.endsWith('.tmp'));
        assert.deepEqual(temps, [], 'validation failure creates no temp sidecar');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

test('Ollama empty-corpus indexing atomically replaces a stale sidecar without embedding', async (t) => {
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests += 1;
    res.writeHead(500);
    res.end('embedding must not be requested');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const host = `http://127.0.0.1:${address.port}`;
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-ollama-empty-index-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  await fs.mkdir(path.join(root, 'memory', 'candidate'), { recursive: true });
  await fs.writeFile(path.join(root, 'memory', 'candidate', 'excluded.md'), 'not eligible', 'utf8');
  const target = path.join(root, '.ihow', 'ollama-empty-corpus-sidecar.json');
  const oldBytes = Buffer.from(JSON.stringify({
    model: 'empty-corpus',
    docs: [{ path: 'memory/old.md', vec: [1, 0, 0], preview: 'old current sidecar' }],
  }) + '\n');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, oldBytes);

  const result = await runRawIndex(root, host, 'empty-corpus');
  assert.equal(result.code, 0, result.stderr || result.stdout);
  assert.deepEqual(JSON.parse(result.stdout), { indexed: 0 });
  assert.equal(requests, 0, 'empty eligible corpus performs no embedding HTTP request');
  assert.deepEqual(
    await fs.readFile(target),
    Buffer.from('{"model":"empty-corpus","docs":[]}'),
    'stale sidecar is replaced by the canonical empty artifact',
  );
  const temps = (await fs.readdir(path.dirname(target))).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(temps, []);
});

test('Ollama embedding responses are byte-bounded before JSON parsing and preserve the old sidecar', async (t) => {
  let responseCase = null;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      if (responseCase === 'oversized-array-content-length') {
        const body = JSON.stringify({ embedding: Array(150_000).fill(0) });
        res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      if (responseCase === 'oversized-object-chunked') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"payload":"');
        res.write('x'.repeat(MAX_EMBED_RESPONSE_BYTES));
        res.end('"}');
        return;
      }
      if (responseCase === 'invalid-json') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{not-json');
        return;
      }
      const prefix = '{"embedding":[1,0,0]}';
      const body = prefix + ' '.repeat(MAX_EMBED_RESPONSE_BYTES - Buffer.byteLength(prefix));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const host = `http://127.0.0.1:${address.port}`;

  const cases = [
    { name: 'oversized JSON array with Content-Length', response: 'oversized-array-content-length', error: 'ollama_embedding_response_too_large' },
    { name: 'oversized non-embedding object without Content-Length', response: 'oversized-object-chunked', error: 'ollama_embedding_response_too_large' },
    { name: 'bounded malformed JSON', response: 'invalid-json', error: 'ollama_embedding_invalid_json' },
  ];
  for (const item of cases) {
    await t.test(item.name, async () => {
      const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-ollama-response-bound-')));
      try {
        await fs.mkdir(path.join(root, 'memory'), { recursive: true });
        await fs.writeFile(path.join(root, 'memory', 'a.md'), 'response bound document', 'utf8');
        const target = path.join(root, '.ihow', 'ollama-response-bound-sidecar.json');
        const oldBytes = Buffer.from('{"old":"sidecar bytes stay exact"}\n');
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, oldBytes);
        responseCase = item.response;

        const result = await runRawIndex(root, host, 'response-bound');
        assert.notEqual(result.code, 0);
        assert.equal(JSON.parse(result.stdout).error, item.error);
        assert.deepEqual(await fs.readFile(target), oldBytes);
        const temps = (await fs.readdir(path.dirname(target))).filter((name) => name.endsWith('.tmp'));
        assert.deepEqual(temps, []);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }

  await t.test('exactly-at-limit valid JSON remains accepted', async () => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-ollama-response-limit-')));
    try {
      await fs.mkdir(path.join(root, 'memory'), { recursive: true });
      await fs.writeFile(path.join(root, 'memory', 'a.md'), 'response bound document', 'utf8');
      responseCase = 'valid-at-limit';
      const result = await runRawIndex(root, host, 'response-bound');
      assert.equal(result.code, 0, result.stderr || result.stdout);
      assert.deepEqual(JSON.parse(result.stdout), { indexed: 1 });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
