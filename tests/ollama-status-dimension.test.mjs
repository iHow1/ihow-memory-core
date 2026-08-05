// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const provider = fileURLToPath(new URL('../examples/ollama-embedding-provider.mjs', import.meta.url));

test('Ollama status reports the measured embedding dimension', async (t) => {
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/embeddings');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ embedding: [0.25, -0.5, 0.75] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();

  const child = spawn(process.execPath, [provider, 'status'], {
    env: { ...process.env, OLLAMA_HOST: `http://127.0.0.1:${address.port}` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify({
    method: 'status',
    workspace: {},
    provider: { id: 'vector-gguf', model: 'measured-model' },
  }));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });

  assert.equal(code, 0, stderr || stdout);
  assert.deepEqual(JSON.parse(stdout), {
    id: 'vector-gguf',
    model: 'measured-model',
    ready: true,
    cloud: false,
    dimension: 3,
  });
});
