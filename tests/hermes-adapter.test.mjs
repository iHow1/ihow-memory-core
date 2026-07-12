// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyHermesMcpBindings } from '../src/hermes-adapter.ts';

const FULL_TOOLS = [
  'memory.continue',
  'memory.search',
  'memory.read',
  'memory.journal',
  'memory.write_candidate',
  'memory.context_probe',
  'memory.forget',
  'memory.remember',
];

const THIN_TOOLS = [
  'init_workspace',
  'refresh',
  'status',
  'read_memory',
  'write_memory',
  'append_daily',
];

test('classifies one canonical full Hermes binding', () => {
  const result = classifyHermesMcpBindings([
    {
      name: 'ihow-memory',
      command: '/opt/homebrew/bin/node',
      args: ['/workspace/.runtime/mcp/server.js'],
      env: {
        MEMORY_ROOT: '/workspace/memory',
        IHOW_MEMORY_STATE_ROOT: '/workspace/state',
      },
      tools: FULL_TOOLS,
    },
  ]);

  assert.equal(result.status, 'canonical-full');
  assert.equal(result.canonical?.name, 'ihow-memory');
  assert.deepEqual(result.issues, []);
});

test('detects the legacy ihowmemory alias and thin Python wrapper inventory', () => {
  const result = classifyHermesMcpBindings([
    {
      name: 'ihowmemory',
      command: '/venv/bin/python',
      args: ['/Users/test/.hermes/mcp-servers/ihowmemory_mcp.py'],
      env: { IHOW_MEMORY_ROOT: '/Users/test' },
      tools: THIN_TOOLS,
    },
  ]);

  assert.equal(result.status, 'legacy-thin-wrapper');
  assert.ok(result.issues.includes('LEGACY_ALIAS'));
  assert.ok(result.issues.includes('INCOMPLETE_TOOL_INVENTORY'));
});

test('detects conflicting duplicate bindings', () => {
  const result = classifyHermesMcpBindings([
    {
      name: 'ihow-memory',
      command: '/opt/homebrew/bin/node',
      args: ['/workspace/.runtime/mcp/server.js'],
      env: { MEMORY_ROOT: '/workspace/memory', IHOW_MEMORY_STATE_ROOT: '/workspace/state' },
      tools: FULL_TOOLS,
    },
    {
      name: 'ihowmemory',
      command: '/venv/bin/python',
      args: ['/Users/test/.hermes/mcp-servers/ihowmemory_mcp.py'],
      env: { IHOW_MEMORY_ROOT: '/Users/test' },
      tools: THIN_TOOLS,
    },
  ]);

  assert.equal(result.status, 'conflicting-bindings');
  assert.ok(result.issues.includes('DUPLICATE_BINDINGS'));
});

test('detects canonical name with incomplete tools or missing roots', () => {
  const result = classifyHermesMcpBindings([
    {
      name: 'ihow-memory',
      command: '/opt/homebrew/bin/node',
      args: ['/workspace/.runtime/mcp/server.js'],
      env: {},
      tools: ['memory.continue'],
    },
  ]);

  assert.equal(result.status, 'needs-repair');
  assert.ok(result.issues.includes('INCOMPLETE_TOOL_INVENTORY'));
  assert.ok(result.issues.includes('MISSING_ROOT_BINDING'));
});

test('returns absent when neither canonical nor legacy binding exists', () => {
  const result = classifyHermesMcpBindings([
    { name: 'other-server', command: 'other', args: [], env: {}, tools: [] },
  ]);

  assert.equal(result.status, 'absent');
  assert.equal(result.canonical, undefined);
  assert.deepEqual(result.issues, []);
});
