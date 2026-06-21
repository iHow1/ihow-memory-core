// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// The read-only console serves ALL memory with no auth; its safety rests on being loopback-only. Two guards:
// a bind-time refusal of non-loopback hosts, and a request-time loopback Host-header allowlist that defeats
// DNS-rebinding (a remote page whose domain resolves to 127.0.0.1 making the victim's browser read memory).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createConsoleServer, assertLoopbackBindHost, isLoopbackHost } from '../src/http/console.ts';

async function mkdtempReal(p) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
}

function get(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('console: loopback Host allowed; foreign Host (DNS-rebind) and cross-site Origin rejected', async (t) => {
  const root = await mkdtempReal('ihow-console-');
  const server = await createConsoleServer({ root, space: 'c' });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  t.after(async () => { server.close(); await fs.rm(root, { recursive: true, force: true }); });

  assert.equal((await get(port, '/health', { Host: `127.0.0.1:${port}` })).status, 200, 'loopback IP Host ok');
  assert.equal((await get(port, '/health', { Host: 'localhost' })).status, 200, 'localhost Host ok');

  const rebind = await get(port, '/api/status', { Host: 'evil.example.com' });
  assert.equal(rebind.status, 403, 'foreign Host (DNS-rebinding) blocked');
  assert.match(rebind.body, /bad_host/);

  const xorigin = await get(port, '/health', { Host: '127.0.0.1', Origin: 'http://evil.example.com' });
  assert.equal(xorigin.status, 403, 'cross-site Origin blocked');
  assert.match(xorigin.body, /bad_origin/);
});

test('assertLoopbackBindHost refuses non-loopback bind hosts', () => {
  for (const ok of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.1:8788']) {
    assert.doesNotThrow(() => assertLoopbackBindHost(ok), `${ok} should be allowed`);
  }
  for (const bad of ['0.0.0.0', '192.168.1.5', 'example.com', '::']) {
    assert.throws(() => assertLoopbackBindHost(bad), /non-loopback/, `${bad} must be refused`);
  }
  assert.equal(isLoopbackHost('localhost:8788'), true);
  assert.equal(isLoopbackHost('evil.com'), false);
});
