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
      args: ['/home/test/.hermes/mcp-servers/ihowmemory_mcp.py'],
      env: { IHOW_MEMORY_ROOT: '/home/test' },
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
      args: ['/home/test/.hermes/mcp-servers/ihowmemory_mcp.py'],
      env: { IHOW_MEMORY_ROOT: '/home/test' },
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

test('detects duplicate canonical entries instead of accepting the first one', () => {
  const result = classifyHermesMcpBindings([
    {
      name: 'ihow-memory',
      command: '/opt/homebrew/bin/node',
      args: ['/workspace/.runtime/mcp/server.js'],
      env: { MEMORY_ROOT: '/workspace/memory', IHOW_MEMORY_STATE_ROOT: '/workspace/state' },
      tools: FULL_TOOLS,
    },
    {
      name: 'ihow-memory',
      command: '/tmp/node',
      args: ['/tmp/stale-server.js'],
      env: { MEMORY_ROOT: '/tmp/memory', IHOW_MEMORY_STATE_ROOT: '/tmp/state' },
      tools: FULL_TOOLS,
    },
  ]);

  assert.equal(result.status, 'conflicting-bindings');
  assert.ok(result.issues.includes('DUPLICATE_BINDINGS'));
  assert.equal(result.bindings.length, 2);
});

test('accepts the documented IHOW_MEMORY_ROOT alias as a memory root binding', () => {
  const result = classifyHermesMcpBindings([
    {
      name: 'ihow-memory',
      command: '/opt/homebrew/bin/node',
      args: ['/workspace/.runtime/mcp/server.js'],
      env: {
        IHOW_MEMORY_ROOT: '/workspace/memory',
        IHOW_MEMORY_STATE_ROOT: '/workspace/state',
      },
      tools: FULL_TOOLS,
    },
  ]);

  assert.equal(result.status, 'canonical-full');
  assert.deepEqual(result.issues, []);
});

test('returns a detached immutable diagnosis rather than caller-owned mutable bindings', () => {
  const source = {
    name: 'ihow-memory',
    command: '/opt/homebrew/bin/node',
    args: ['/workspace/.runtime/mcp/server.js'],
    env: { MEMORY_ROOT: '/workspace/memory', IHOW_MEMORY_STATE_ROOT: '/workspace/state' },
    tools: [...FULL_TOOLS],
  };
  const result = classifyHermesMcpBindings([source]);
  source.args[0] = '/tmp/changed.js';
  source.env.MEMORY_ROOT = '/tmp/changed';
  source.tools.length = 0;

  assert.equal(result.canonical?.args[0], '/workspace/.runtime/mcp/server.js');
  assert.equal(result.canonical?.env?.MEMORY_ROOT, '/workspace/memory');
  assert.equal(result.canonical?.tools?.length, FULL_TOOLS.length);
  assert.throws(() => result.canonical?.args.push('x'), TypeError);
  assert.throws(() => { result.canonical.env.MEMORY_ROOT = '/tmp'; }, TypeError);
});
