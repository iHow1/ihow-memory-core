// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCore } from '../src/core.ts';

const repo = path.resolve(import.meta.dirname, '..');
const pluginSource = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');
const fakeGithubPat = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890'].join('_');

async function prepareMemory() {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-state-'));
  await fs.mkdir(path.join(memoryRoot, 'scopes'), { recursive: true });
  await fs.writeFile(
    path.join(memoryRoot, 'scopes', 'project.md'),
    '# Hermes continuity\n\nUse verified Hermes recall context for runtime adapter work.\n',
    'utf8',
  );
  const core = await openCore({ memoryRoot, stateRoot, cwd: '/repo' });
  await core.rebuild();
  return { memoryRoot, stateRoot };
}

async function copyPlugin(home) {
  const target = path.join(home, 'plugins', 'ihow-memory');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(pluginSource, target, { recursive: true });
  return target;
}

function invokePlugin({ plugin, home, memoryRoot, stateRoot, bridgePath = bridge, pathOverride, useDefaultBridge = false }) {
  const script = String.raw`
import importlib.util, json, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Ctx(); module.register(ctx)
result = ctx.hooks["pre_llm_call"](
    session_id="s1", user_message=(
      "Hermes continuity password is hunter2 "
      ${JSON.stringify(fakeGithubPat + ' ')}
      "AKIAIOSFODNN7EXAMPLE "
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123 "
      "密码：中文秘密值"
    ), conversation_history=[],
    is_first_turn=True, model="m", platform="cli", cwd="/repo",
)
print(json.dumps(result, sort_keys=True))
`;
  return spawnSync('python3', ['-c', script, plugin], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...(pathOverride ? { PATH: pathOverride } : {}),
      HERMES_HOME: home,
      MEMORY_ROOT: memoryRoot,
      IHOW_MEMORY_STATE_ROOT: stateRoot,
      ...(!useDefaultBridge && bridgePath ? { IHOW_MEMORY_HERMES_BRIDGE: bridgePath } : { IHOW_MEMORY_HERMES_BRIDGE: '' }),
      IHOW_MEMORY_HERMES_NODE: process.execPath,
      IHOW_MEMORY_HERMES_EVENT_LOG: path.join(home, 'events.ndjson'),
    },
  });
}

test('Hermes plugin discovers the packaged bridge command without an env override', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-home-'));
  const plugin = await copyPlugin(home);
  const { memoryRoot, stateRoot } = await prepareMemory();
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-bin-'));
  const command = path.join(bin, 'ihow-memory-hermes-bridge');
  await fs.writeFile(command, `#!/usr/bin/env node
process.stdin.resume();
let body = '';
process.stdin.on('data', chunk => body += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(body);
  if (!input.prompt) process.exit(4);
  process.stdout.write(JSON.stringify({ ok: true, context: 'packaged bridge recall' }) + '\\n');
});
`, { mode: 0o755 });
  const run = invokePlugin({
    plugin,
    home,
    memoryRoot,
    stateRoot,
    useDefaultBridge: true,
    pathOverride: `${bin}${path.delimiter}${process.env.PATH || ''}`,
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { context: 'packaged bridge recall' });
});

test('Hermes plugin calls the Node bridge and injects real bounded recall', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-home-'));
  const plugin = await copyPlugin(home);
  const { memoryRoot, stateRoot } = await prepareMemory();
  const run = invokePlugin({ plugin, home, memoryRoot, stateRoot });
  assert.equal(run.status, 0, run.stderr);
  const output = JSON.parse(run.stdout.trim());
  assert.equal(typeof output.context, 'string');
  assert.match(output.context, /Hermes continuity|verified Hermes recall/i);
  assert.ok(output.context.length <= 8000);
  const events = await fs.readFile(path.join(home, 'events.ndjson'), 'utf8');
  assert.doesNotMatch(events, /"prompt"|"promptDigest"/);
  for (const secret of [
    'hunter2', fakeGithubPat, 'AKIAIOSFODNN7EXAMPLE',
    'eyJhbGciOiJIUzI1NiJ9', '中文秘密值',
  ]) assert.doesNotMatch(events, new RegExp(secret));
});

test('Hermes plugin fails open when the Node bridge is unavailable', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-home-'));
  const plugin = await copyPlugin(home);
  const { memoryRoot, stateRoot } = await prepareMemory();
  const run = invokePlugin({
    plugin,
    home,
    memoryRoot,
    stateRoot,
    bridgePath: path.join(home, 'missing-bridge.ts'),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout.trim()), null);
});
