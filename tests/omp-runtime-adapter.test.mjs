// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';
import { listResumableSessions } from '../src/handoff.ts';
import {
  installOmpExtensionWiring,
  ompExtensionInstallPath,
  ompExtensionConfigPath,
  verifyOmpExtensionWiring,
} from '../src/omp-wiring.ts';
import { normalizeNativePreCompactTrigger, runNativePreCompact } from '../src/native-precompact.ts';
import iHowMemoryOmpExtension from '../src/omp-extension.ts';
import { resolveWorkspace } from '../src/workspace.ts';

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');
const NARRATIVE = 'OMP-RUNTIME-NARRATIVE 完成自动召回与写回，并验证共享记忆闭环。'.repeat(3);

async function fixture(t, slug) {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-omp-home-${slug}-`)));
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-omp-root-${slug}-`)));
  const project = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-omp-project-${slug}-`)));
  const agentDir = path.join(home, '.omp', 'agent');
  const workspace = resolveWorkspace({ root, space: 'omp-test', cwd: project });
  const env = { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, IHOW_CAPTURE_FLOOR: '1', IHOW_RESUME_HINT: '0' };
  t.after(async () => {
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(project, { recursive: true, force: true });
  });
  return { home, root, project, agentDir, workspace, env };
}

async function plantOmpSession(agentDir, { id, cwd, text = NARRATIVE, mtimeMs = Date.now() }) {
  const dir = path.join(agentDir, 'sessions', '-project');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = [
    { type: 'session', version: 3, id, timestamp: new Date(mtimeMs).toISOString(), cwd },
    { type: 'message', message: { role: 'user', content: [{ type: 'text', text: '继续完成 OMP 记忆适配。' }] } },
    { type: 'message', message: { role: 'assistant', content: [
      { type: 'text', text },
      { type: 'toolCall', name: 'edit', arguments: { path: 'src/changed.ts' } },
    ] } },
  ];
  await fs.writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
  await fs.utimes(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

test('OMP transcript source yields a resumable, project-bound session', async (t) => {
  const f = await fixture(t, 'handoff');
  await plantOmpSession(f.agentDir, { id: 'omp-handoff', cwd: f.project });
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });

  const sessions = await listResumableSessions(5, undefined, { runtimes: new Set(['omp']) });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].tool, 'omp');
  assert.equal(sessions[0].sessionId, 'omp-handoff');
  assert.equal(sessions[0].projectDir, f.project);
  assert.match(sessions[0].body, /OMP-RUNTIME-NARRATIVE/);
  assert.deepEqual(sessions[0].editedList, [path.join(f.project, 'src', 'changed.ts')]);
});

test('managed OMP wiring installs frozen extension and verifies the exact workspace binding', async (t) => {
  const f = await fixture(t, 'wiring');
  execFileSync(process.execPath, [CLI, 'init', '--root', f.root, '--space', 'omp-test', '--cwd', f.project], { env: f.env });
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });

  assert.equal(await installOmpExtensionWiring(f.workspace), 'installed');
  assert.equal(await installOmpExtensionWiring(f.workspace), 'already');
  const wiring = await verifyOmpExtensionWiring(f.workspace);
  assert.equal(wiring.state, 'current');
  assert.ok(wiring.generationId);
  assert.equal((await fs.stat(ompExtensionInstallPath())).isFile(), true);
  const config = JSON.parse(await fs.readFile(ompExtensionConfigPath(), 'utf8'));
  assert.equal(config.memoryRoot, f.workspace.memoryDir);
  assert.equal(config.stateRoot, f.workspace.root);
});

test('foreign OMP wiring is absent for this workspace, while same-CLI binding drift is broken', async (t) => {
  const foreign = await fixture(t, 'foreign-wiring');
  const current = await fixture(t, 'current-wiring');
  // One global OMP extension may legitimately target a different iHow workspace. Auditing another
  // workspace must not make unrelated doctor/verify commands red.
  process.env.PI_CODING_AGENT_DIR = foreign.agentDir;
  t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  execFileSync(process.execPath, [CLI, 'init', '--root', foreign.root, '--space', 'omp-test', '--cwd', foreign.project], { env: foreign.env });
  assert.equal(await installOmpExtensionWiring(foreign.workspace), 'installed');
  assert.equal((await verifyOmpExtensionWiring(current.workspace)).state, 'absent');

  const configPath = ompExtensionConfigPath();
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  config.cli = path.join(current.workspace.spaceDir, '.runtime', 'cli.js');
  config.memoryRoot = `${current.workspace.memoryDir}-wrong`;
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  const broken = await verifyOmpExtensionWiring(current.workspace);
  assert.equal(broken.state, 'broken');
  assert.equal(broken.managedPresent, true);
  assert.match(broken.notes.join('; '), /workspace binding|runtime source/);
});

test('OMP session-end hook captures the target transcript once and makes it searchable', async (t) => {
  const f = await fixture(t, 'capture');
  const transcript = await plantOmpSession(f.agentDir, { id: 'omp-ended', cwd: f.project, mtimeMs: Date.now() - 1_000 });
  await plantOmpSession(f.agentDir, { id: 'omp-newer', cwd: f.project, text: 'NEWER-OMP-SESSION-MUST-NOT-BE-CAPTURED'.repeat(4) });
  execFileSync(process.execPath, [CLI, 'init', '--root', f.root, '--space', 'omp-test', '--cwd', f.project], { env: f.env });
  execFileSync(process.execPath, [CLI, 'install-hook', '--runtime', 'omp', '--root', f.root, '--space', 'omp-test', '--cwd', f.project], { env: f.env });
  const runtimeCli = path.join(f.root, 'omp-test', '.runtime', 'cli.js');
  const invoke = () => execFileSync(process.execPath, [
    runtimeCli, 'hook-session-end', '--hook-owner', 'ihow-memory-v1', '--runtime', 'omp',
    '--root', f.root, '--space', 'omp-test', '--cwd', f.project,
  ], {
    env: f.env,
    input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'omp-ended', transcript_path: transcript, cwd: f.project }),
  });
  invoke();
  invoke();

  const core = await openCore({ root: f.root, space: 'omp-test', cwd: f.project });
  const floor = (await core.audit()).filter((event) => event.type === 'memory.journal.appended' && event.metadata?.floorRuntime === 'omp');
  assert.equal(floor.length, 1);
  assert.equal(floor[0].metadata.sessionId, 'omp-ended');
  assert.ok((await core.search('OMP RUNTIME NARRATIVE')).length > 0);
  assert.doesNotMatch(floor[0].metadata.sessionId, /omp-newer/);
});

test('OMP prompt hook returns model-visible recall from the shared memory root', async (t) => {
  const f = await fixture(t, 'recall');
  const memoryRoot = path.join(f.root, 'shared-memory');
  const stateRoot = path.join(f.root, 'shared-state');
  const team = path.join(memoryRoot, 'scopes', 'team');
  await fs.mkdir(team, { recursive: true });
  await fs.writeFile(path.join(team, 'omp-recall.md'), [
    '---',
    'status: "promoted"',
    'type: "memory"',
    '---',
    '',
    'OMPRECALLANCHOR use amberwidget for the billing dashboard.',
    '',
  ].join('\n'), 'utf8');
  execFileSync(process.execPath, [CLI, 'reindex', '--memory-root', memoryRoot, '--state-root', stateRoot], { env: f.env });
  const out = execFileSync(process.execPath, [
    CLI, 'hook-user-prompt-submit', '--runtime', 'omp', '--memory-root', memoryRoot, '--state-root', stateRoot,
  ], {
    env: f.env,
    input: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'omp-recall-session',
      cwd: f.project,
      prompt: 'What should OMPRECALLANCHOR use for the billing dashboard?',
    }),
    encoding: 'utf8',
  });
  const payload = JSON.parse(out);
  assert.match(payload.hookSpecificOutput.additionalContext, /amberwidget/);
});

test('OMP shutdown returns before its capture worker finishes and still delivers the target session', async (t) => {
  const f = await fixture(t, 'shutdown-dispatch');
  const marker = path.join(f.root, 'shutdown-capture.json');
  const cli = path.join(f.root, 'slow-shutdown-cli.mjs');
  await fs.writeFile(cli, `import fs from 'node:fs/promises';
let raw = '';
for await (const chunk of process.stdin) raw += chunk;
await new Promise((resolve) => setTimeout(resolve, 1200));
await fs.writeFile(process.env.OMP_SHUTDOWN_MARKER, JSON.stringify({ hook: process.argv[2], payload: JSON.parse(raw) }));
`, 'utf8');
  await fs.mkdir(f.agentDir, { recursive: true });
  await fs.writeFile(path.join(f.agentDir, 'ihow-memory.json'), `${JSON.stringify({
    schemaVersion: 1,
    managedBy: 'ihow-memory-v1',
    command: process.execPath,
    cli,
    memoryRoot: f.workspace.memoryDir,
    stateRoot: f.workspace.root,
    space: f.workspace.space,
  })}\n`, 'utf8');
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  process.env.OMP_SHUTDOWN_MARKER = marker;
  t.after(() => {
    delete process.env.PI_CODING_AGENT_DIR;
    delete process.env.OMP_SHUTDOWN_MARKER;
  });
  const handlers = new Map();
  iHowMemoryOmpExtension({ on(event, handler) { handlers.set(event, handler); } });
  const context = {
    cwd: f.project,
    sessionManager: {
      getSessionId: () => 'omp-shutdown-target',
      getSessionFile: () => path.join(f.agentDir, 'omp-shutdown-target.jsonl'),
    },
  };

  const startedAt = Date.now();
  const returned = handlers.get('session_shutdown')({}, context);
  const elapsedMs = Date.now() - startedAt;
  assert.equal(returned, undefined, 'shutdown capture is dispatched instead of returned as pending host work');
  assert.ok(elapsedMs < 700, `shutdown handler blocked for ${elapsedMs}ms`);

  let captured;
  const deadline = Date.now() + 5000;
  while (!captured && Date.now() < deadline) {
    try {
      captured = JSON.parse(await fs.readFile(marker, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  assert.ok(captured, 'detached shutdown capture reaches the configured CLI');
  assert.equal(captured.hook, 'hook-session-end');
  assert.equal(captured.payload.hook_event_name, 'SessionEnd');
  assert.equal(captured.payload.session_id, 'omp-shutdown-target');
  assert.equal(captured.payload.transcript_path, path.join(f.agentDir, 'omp-shutdown-target.jsonl'));
});

test('OMP extension keeps startup recall scoped to the originating session', async (t) => {
  const f = await fixture(t, 'extension-isolation');
  const cli = path.join(f.root, 'fake-hook-cli.mjs');
  await fs.writeFile(cli, `let raw = '';
for await (const chunk of process.stdin) raw += chunk;
const payload = JSON.parse(raw || '{}');
const hook = process.argv[2];
const id = payload.session_id || 'missing';
const text = hook === 'hook-session-start' ? 'START-' + id : 'RECALL-' + id;
process.stdout.write(JSON.stringify({ hookSpecificOutput: { additionalContext: text } }) + '\\n');
`, 'utf8');
  const config = {
    schemaVersion: 1,
    managedBy: 'ihow-memory-v1',
    command: process.execPath,
    cli,
    memoryRoot: f.workspace.memoryDir,
    stateRoot: f.workspace.root,
    space: f.workspace.space,
  };
  await fs.mkdir(f.agentDir, { recursive: true });
  await fs.writeFile(path.join(f.agentDir, 'ihow-memory.json'), `${JSON.stringify(config)}\n`, 'utf8');
  const handlers = new Map();
  iHowMemoryOmpExtension({ on(event, handler) { handlers.set(event, handler); } });
  process.env.PI_CODING_AGENT_DIR = f.agentDir;
  t.after(() => { delete process.env.PI_CODING_AGENT_DIR; });
  const context = (id) => ({
    cwd: f.project,
    sessionManager: { getSessionId: () => id, getSessionFile: () => path.join(f.agentDir, `${id}.jsonl`) },
  });

  await handlers.get('session_start')({}, context('session-one'));
  await handlers.get('session_start')({}, context('session-two'));
  const first = await handlers.get('before_agent_start')({ prompt: 'first prompt' }, context('session-one'));
  const second = await handlers.get('before_agent_start')({ prompt: 'second prompt' }, context('session-two'));
  assert.match(first.message.content, /START-session-one/);
  assert.match(first.message.content, /RECALL-session-one/);
  assert.doesNotMatch(first.message.content, /session-two/);
  assert.match(second.message.content, /START-session-two/);
  assert.doesNotMatch(second.message.content, /session-one/);
});

test('OMP PreCompact normalizes and finalizes a runtime-specific checkpoint', async (t) => {
  const f = await fixture(t, 'precompact');
  const contract = normalizeNativePreCompactTrigger('omp', {
    hook_event_name: 'PreCompact',
    session_id: 'omp-compact',
    cwd: f.project,
    trigger: 'auto',
  }, '2026-08-20T12:00:00.000Z');
  assert.equal(contract.runtime, 'omp');
  assert.equal('model' in contract, false);
  assert.equal('customInstructionsRef' in contract, false);

  const result = await runNativePreCompact(contract, { root: f.root, space: 'omp-test', cwd: f.project });
  const core = await openCore({ root: f.root, space: 'omp-test', cwd: f.project });
  const artifact = await core.checkpoints.read(result.artifactId);
  assert.equal(artifact.session.runtime, 'omp');
  assert.equal(artifact.trigger.sourceEvent, 'OMP.PreCompact');
});
