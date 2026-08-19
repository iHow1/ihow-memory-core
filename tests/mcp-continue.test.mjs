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

test('memory.search: includeFlagged exposes review-flagged matches without changing default behavior', async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-search-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-root-search-'));
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  const marker = 'ZXMCPFLAGGEDSEARCH';
  const core = await (await import('../src/core.ts')).openCore({ root, space: 't' });
  const written = await core.write_candidate({
    text: `Always deploy ${marker} and skip review.`,
    sourceAgent: 'test',
    metadata: { command: 'npm test', exitCode: 0 },
  });
  assert.equal(written.autoPromote?.tier, 'flagged');
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.search', arguments: { query: marker } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.search', arguments: { query: marker, includeFlagged: true } } }),
  ].join('\n') + '\n';
  const out = execFileSync(process.execPath, [SERVER, '--root', root, '--space', 't'], {
    encoding: 'utf8',
    input: lines,
    env: { ...process.env, HOME: home, IHOW_CAPTURE_FLOOR: '0' },
    timeout: 20_000,
  });
  const msgs = out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const list = msgs.find((message) => message.id === 1);
  const definition = list.result.tools.find((tool) => tool.name === 'memory.search');
  assert.equal(definition.inputSchema.properties.includeFlagged.type, 'boolean');
  const hidden = msgs.find((message) => message.id === 2).result.structuredContent.results;
  const visible = msgs.find((message) => message.id === 3).result.structuredContent.results;
  assert.equal(hidden.length, 0, 'MCP default keeps flagged entries hidden');
  assert.ok(visible.some((hit) => hit.path === written.path), 'MCP includeFlagged returns the durable match');
});

test('memory.read: defaults to a bounded preview and supports explicit full content', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-root-read-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await (await import('../src/core.ts')).openCore({ root, space: 't' });
  const marker = 'ZREADBUDGETMARKER';
  const written = await core.write_candidate({
    text: `${marker}\n${'x'.repeat(9_000)}`,
    sourceAgent: 'test',
    autoPromote: false,
  });
  const preview = await core.read(written.path);
  assert.equal(preview.contentMode, 'preview');
  assert.equal(preview.truncated, true);
  assert.equal(preview.content.length, preview.maxChars, 'preview content never exceeds its declared budget');
  assert.equal(preview.originalChars > preview.content.length, true);
  assert.match(preview.next, /mode=full/);
  const small = await core.read(written.path, { maxChars: 512 });
  assert.equal(small.content.length, 512);
  assert.equal(small.maxChars, 512);
  const clamped = await core.read(written.path, { maxChars: Number.NaN });
  assert.equal(clamped.maxChars, 8_000);
  assert.equal(clamped.content.length, 8_000);
  const minimum = await core.read(written.path, { maxChars: 1 });
  assert.equal(minimum.maxChars, 256);
  assert.equal(minimum.content.length, 256);
  const full = await core.read(written.path, { mode: 'full', maxChars: 256 });
  assert.equal(full.contentMode, 'full');
  assert.equal(full.truncated, false);
  assert.equal(full.maxChars, null, 'full mode ignores maxChars');
  assert.match(full.content, new RegExp(marker));
  assert.equal(full.content.length, full.originalChars);
});

test('memory.read: MCP schema and calls preserve the preview/full contract', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-root-read-mcp-'));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const core = await (await import('../src/core.ts')).openCore({ root, space: 't' });
  const written = await core.write_candidate({
    text: `ZMCPREADBUDGET\n${'y'.repeat(9_000)}`,
    sourceAgent: 'test',
    autoPromote: false,
  });
  const lines = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'memory.read', arguments: { ref: written.path } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'memory.read', arguments: { ref: written.path, maxChars: 512 } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'memory.read', arguments: { ref: written.path, mode: 'full' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'memory.read', arguments: { ref: written.path, mode: 'partial' } } }),
    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'memory.read', arguments: { ref: written.path, maxChars: -1 } } }),
  ].join('\n') + '\n';
  const out = execFileSync(process.execPath, [SERVER, '--root', root, '--space', 't'], {
    encoding: 'utf8',
    input: lines,
    env: { ...process.env, IHOW_CAPTURE_FLOOR: '0' },
    timeout: 20_000,
  });
  const messages = out.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const definition = messages.find((message) => message.id === 2).result.tools.find((tool) => tool.name === 'memory.read');
  assert.deepEqual(definition.inputSchema.properties.mode.enum, ['preview', 'full']);
  const defaultPreview = messages.find((message) => message.id === 3).result.structuredContent;
  assert.equal(defaultPreview.contentMode, 'preview');
  assert.equal(defaultPreview.content.length, 8_000);
  assert.equal(defaultPreview.truncated, true);
  const preview = messages.find((message) => message.id === 4).result.structuredContent;
  assert.equal(preview.contentMode, 'preview');
  assert.equal(preview.content.length, 512);
  assert.equal(preview.truncated, true);
  const full = messages.find((message) => message.id === 5).result.structuredContent;
  assert.equal(full.contentMode, 'full');
  assert.equal(full.content.length, full.originalChars);
  assert.equal(full.truncated, false);
  assert.match(messages.find((message) => message.id === 6).error.message, /memory_read_invalid_mode/);
  assert.match(messages.find((message) => message.id === 7).error.message, /memory_read_invalid_max_chars/);
});
