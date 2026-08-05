// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const pluginSource = path.join(repo, 'integrations', 'hermes', 'ihow-memory');

async function copyPlugin(home) {
  const target = path.join(home, 'plugins', 'ihow-memory');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(pluginSource, target, { recursive: true });
  return target;
}

function runPython({ plugin, home, mode = 'success', badCwd = false }) {
  const script = String.raw`
import importlib.util, json, os, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
home = pathlib.Path(sys.argv[2])
mode = sys.argv[3]
spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Ctx:
    def __init__(self): self.hooks = {}
    def register_hook(self, name, callback): self.hooks[name] = callback
ctx = Ctx()
module.register(ctx)
assert set(ctx.hooks) == {
    "on_session_start", "on_session_reset", "pre_llm_call", "post_llm_call",
    "on_session_finalize", "on_session_end", "on_durable_transcript_revision",
}
os.environ["HERMES_HOME"] = str(home)
os.environ["IHOW_MEMORY_HERMES_EVENT_LOG"] = str(home / "events.ndjson")
os.environ["IHOW_MEMORY_HERMES_TEST_MODE"] = mode
if sys.argv[4] == "bad-cwd":
    module.os.getcwd = lambda: (_ for _ in ()).throw(OSError("cwd unavailable"))
    start = ctx.hooks["on_session_start"](session_id="s1", model="m", platform="cli")
else:
    start = ctx.hooks["on_session_start"](session_id="s1", model="m", platform="cli", cwd="/repo")
pre = ctx.hooks["pre_llm_call"](
    session_id="s1", user_message="fix activation truth", conversation_history=[{"role":"user","content":"secret body"}],
    is_first_turn=True, model="m", platform="cli", cwd="/repo",
)
post = ctx.hooks["post_llm_call"](
    session_id="s1", user_message="fix activation truth", assistant_response="password: hunter2",
    conversation_history=[{"role":"assistant","content":"password: hunter2"}], model="m", platform="cli", cwd="/repo",
)
finalize = ctx.hooks["on_session_finalize"](session_id="s1", platform="cli", cwd="/repo")
print(json.dumps({"start": start, "pre": pre, "post": post, "finalize": finalize}, sort_keys=True))
`;
  return spawnSync('python3', ['-c', script, plugin, home, mode, badCwd ? 'bad-cwd' : 'normal'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env },
  });
}

test('Hermes plugin registers the durable lifecycle hook and remains fail-open', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-plugin-'));
  const plugin = await copyPlugin(home);
  const run = runPython({ plugin, home, mode: 'failure' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.start, null);
  assert.equal(result.pre, null);
  assert.equal(result.post, null);
  assert.equal(result.finalize, null);
});

test('Hermes plugin fails open when metadata event construction raises', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-plugin-'));
  const plugin = await copyPlugin(home);
  const run = runPython({ plugin, home, mode: 'success', badCwd: true });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.start, null);
});

test('pre_llm_call returns bounded recall context while event logs stay metadata-only', async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-plugin-'));
  const plugin = await copyPlugin(home);
  const run = runPython({ plugin, home, mode: 'success' });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.deepEqual(result.pre, { context: 'Verified iHow Memory recall' });

  const log = await fs.readFile(path.join(home, 'events.ndjson'), 'utf8');
  assert.match(log, /runtime\.session_start/);
  assert.match(log, /runtime\.before_prompt/);
  assert.match(log, /runtime\.after_turn/);
  assert.match(log, /runtime\.session_finalize/);
  assert.doesNotMatch(log, /"prompt"|"promptDigest"|fix activation truth/);
  assert.doesNotMatch(log, /hunter2/);
  assert.doesNotMatch(log, /secret body/);
});

test('plugin manifest declares the exact hook contract', async () => {
  const manifest = await fs.readFile(path.join(pluginSource, 'plugin.yaml'), 'utf8');
  for (const hook of [
    'on_session_start', 'on_session_reset', 'pre_llm_call', 'post_llm_call',
    'on_session_finalize', 'on_session_end', 'on_durable_transcript_revision',
  ]) assert.match(manifest, new RegExp(`- ${hook}`));
  assert.doesNotMatch(manifest, /pre_compact/);
});
