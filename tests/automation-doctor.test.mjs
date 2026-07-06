// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { classifyAutomationPath, worstAutomationStatus } from '../src/automation-doctor.ts';

test('automation path classifier detects tmp and missing command paths', () => {
  const tmp = classifyAutomationPath({ command: process.execPath, args: ['/tmp/ihow-memory/mcp/server.js'] });
  assert.equal(tmp.status, 'WARN');
  assert.ok(tmp.notes.some((note) => note.includes('temporary MCP path')));

  const missing = classifyAutomationPath({ command: path.join(process.cwd(), 'definitely-missing-node'), args: [] });
  assert.equal(missing.status, 'BROKEN');
  assert.ok(missing.notes.some((note) => note.includes('missing MCP command')));
});

test('automation path classifier treats unmaterialized runtime bundle as a warning, not a broken local store', () => {
  const result = classifyAutomationPath({ command: process.execPath, args: [path.join(process.cwd(), '.runtime', 'mcp', 'server.js')] });
  assert.equal(result.status, 'WARN');
  assert.ok(result.notes.some((note) => note.includes('runtime bundle not materialized')));
});

test('automation status aggregation preserves warnings without escalating them to broken', () => {
  assert.equal(worstAutomationStatus(['OK', 'WARN']), 'WARN');
  assert.equal(worstAutomationStatus(['WARN', 'BROKEN', 'OK']), 'BROKEN');
});
