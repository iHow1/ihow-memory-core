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
import { EventEmitter } from 'node:events';
import { createConsoleServer, assertLoopbackBindHost, isLoopbackHost } from '../src/http/console.ts';

async function mkdtempReal(p) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
}

function request(server, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter();
    req.method = 'GET';
    req.url = pathname;
    req.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    req.socket = { remoteAddress: '127.0.0.1' };

    const res = new EventEmitter();
    res.statusCode = 200;
    res.writeHead = (status, responseHeaders) => {
      res.statusCode = status;
      res.headers = responseHeaders;
      return res;
    };
    res.end = (chunk = '') => {
      resolve({ status: res.statusCode, body: String(chunk) });
      return res;
    };
    res.write = () => true;

    try {
      server.emit('request', req, res);
    } catch (error) {
      reject(error);
    }
  });
}

test('console: loopback Host allowed; foreign Host (DNS-rebind) and cross-site Origin rejected', async (t) => {
  const root = await mkdtempReal('ihow-console-');
  const server = await createConsoleServer({ root, space: 'c' });
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  assert.equal((await request(server, '/health', { Host: '127.0.0.1:8788' })).status, 200, 'loopback IP Host ok');
  assert.equal((await request(server, '/health', { Host: 'localhost' })).status, 200, 'localhost Host ok');

  const rebind = await request(server, '/api/status', { Host: 'evil.example.com' });
  assert.equal(rebind.status, 403, 'foreign Host (DNS-rebinding) blocked');
  assert.match(rebind.body, /bad_host/);

  const xorigin = await request(server, '/health', { Host: '127.0.0.1', Origin: 'http://evil.example.com' });
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
