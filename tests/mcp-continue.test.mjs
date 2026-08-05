// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// `memory.continue` MCP tool — the CROSS-RUNTIME resume primitive. Any MCP-connected runtime (Codex,
// Cursor, ...) can call it and get the same verify-first handoff packet, no Claude-specific CLI needed.
// Drives the real stdio JSON-RPC server with a seeded HOME and asserts the tool is listed + returns a
// structured packet with machine anchors and an UNVERIFIED narrative.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'mcp', 'server.ts');
const u = (c) => JSON.stringify({ type: 'user', message: { content: c } });
const a = (c) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: c }] } });
const big = (closing) => [u('开始任务'), a('第一步'), a('中间汇报'), a(closing)].join('\n') + '\n';

test('memory.continue: listed as a tool and returns a verify-first handoff packet over MCP', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-root-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  const cwd = '/tmp/mcp-continue-cwd';
  const encoded = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projDir = path.join(home, '.claude', 'projects', encoded);
  await fs.mkdir(projDir, { recursive: true });
  await fs.writeFile(path.join(projDir, 'sess.jsonl'), big('上一段工作 MCP-RESUME-OK,下一步继续。'.repeat(3)), 'utf8');

  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.continue', arguments: { cwd, limit: 3 } } }),
  ].join('\n') + '\n';

  const out = execFileSync(process.execPath, [SERVER, '--root', root, '--space', 't'], {
    encoding: 'utf8',
    input: lines,
    env: { ...process.env, HOME: home },
    timeout: 20000,
  });
  const msgs = out.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const list = msgs.find((m) => m.id === 2);
  assert.ok(list.result.tools.some((ttt) => ttt.name === 'memory.continue'), 'memory.continue is advertised in tools/list');

  const call = msgs.find((m) => m.id === 3);
  const pkt = call.result.structuredContent;
  assert.ok(Array.isArray(pkt.candidates) && pkt.candidates.length >= 1, 'returns candidate(s)');
  assert.equal(pkt.candidates[0].narrative.unverified, true, 'narrative is flagged UNVERIFIED');
  assert.match(pkt.candidates[0].narrative.text, /MCP-RESUME-OK/, 'carries the prior narrative verbatim');
  assert.ok(pkt.receiverProtocol.length > 0, 'includes the verify-first receiver protocol');
});
