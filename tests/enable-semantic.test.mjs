// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Opt-in semantic engine (alpha.18). Turning semantic ON is explicit, per-space, reversible, and
// ADDITIVE. These tests lock the invariants — including the red-team r-alpha18 fixes — WITHOUT a real
// Ollama (a local node:http stub stands in for the daemon):
//   (1) DEFAULT is FTS5 — no semantic.json ⇒ mcpServerSpec injects NOTHING (capabilities.semantic false).
//   (2) enable-semantic REFUSES unless a REAL embedding call succeeds — a /api/tags-only stub (200 with
//       the model name but no working /api/embeddings) must NOT enable (blocker fix).
//   (3) against a stub that actually embeds, enable persists + injects the vector lane incl. --vector-host
//       (host propagation fix), pointing at the BUNDLED sidecar; disable reverses it.
//   (4) a TAMPERED marker (command not the bundled sidecar) is rejected on load (marker-validation fix).
//   (5) doctor treats a configured-but-down provider as a WARNING, never a failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
import { resolveWorkspace, ensureWorkspace } from '../src/workspace.ts';
import {
  buildSemanticConfig,
  detectOllama,
  loadSemanticConfig,
  removeSemanticConfig,
  writeSemanticConfig,
  semanticEngineArgs,
  semanticConfigPath,
} from '../src/semantic.ts';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));
const DEAD_HOST = 'http://127.0.0.1:9'; // closed loopback port — refuses instantly

// A fake Ollama. mode 'embed' serves /api/tags AND /api/embeddings — but the embed endpoint is
// MODEL-AWARE: it only returns a vector when the POSTed model equals `model`, else 404. That lets a test
// prove the runtime sidecar actually uses the CONFIGURED model (not env/default). mode 'tags-only' serves
// /api/tags with the model but always 404s /api/embeddings (the blocker repro).
async function fakeOllama(mode, model = 'nomic-embed-text') {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/tags') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: `${model}:latest` }] }));
      return;
    }
    if (req.url === '/api/embeddings' && mode === 'embed') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let requested;
        try { requested = JSON.parse(body).model; } catch { requested = undefined; }
        if (requested === model) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ embedding: Array.from({ length: 8 }, (_, i) => (i + 1) / 10) }));
        } else {
          res.writeHead(404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `model '${requested}' not found` }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { host: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// ASYNC on purpose: the fake Ollama http server runs in THIS test process's event loop, so the CLI must
// run without blocking it (execFileSync would freeze the loop and the stub could never answer).
async function runCli(home, args, extraEnv = {}) {
  const env = { ...process.env, IHOW_MEMORY_HOME: home, IHOW_MEMORY_STATE_ROOT: path.join(home, '.state'), ...extraEnv };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
const ws = (home, space) => resolveWorkspace({ root: home, stateRoot: path.join(home, '.state'), space });
const tmpHome = (t) => fs.mkdtemp(path.join(os.tmpdir(), 'ihow-sem-')).then((home) => {
  t.after(async () => { await fs.rm(home, { recursive: true, force: true }); });
  return home;
});

test('RED LINE: no semantic.json ⇒ mcpServerSpec injects nothing (default stays zero-dependency FTS5)', async (t) => {
  const home = await tmpHome(t);
  const workspace = await ensureWorkspace(ws(home, 'demo'));
  assert.deepEqual(semanticEngineArgs(workspace), [], 'default workspace has no semantic engine args');
});

test('enable-semantic REFUSES an unreachable provider — exits non-zero, persists nothing', async (t) => {
  const home = await tmpHome(t);
  const r = await runCli(home, ['enable-semantic', '--space', 'demo', '--host', DEAD_HOST]);
  assert.notEqual(r.code, 0, 'non-zero when Ollama is unreachable');
  assert.match(r.stderr, /not reachable/i);
  assert.equal(await loadSemanticConfig(ws(home, 'demo')), null, 'no semantic.json written on failure');
});

test('BLOCKER FIX: a /api/tags-only stub (no working embeddings) does NOT enable semantic', async (t) => {
  const home = await tmpHome(t);
  const fake = await fakeOllama('tags-only');
  t.after(() => fake.close());
  const r = await runCli(home, ['enable-semantic', '--space', 'demo', '--host', fake.host, '--json']);
  assert.notEqual(r.code, 0, 'tags-only stub cannot embed → refuse');
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.error, 'embeddings_failed', 'reports the failed real embed call, not a tags pass');
  assert.equal(await loadSemanticConfig(ws(home, 'demo')), null, 'no semantic.json persisted for a fall-back-only lane');
});

test('enable-semantic SUCCEEDS against a real embedder; injects the vector lane incl. --vector-host; disable reverses', async (t) => {
  const home = await tmpHome(t);
  const fake = await fakeOllama('embed');
  t.after(() => fake.close());
  const r = await runCli(home, ['enable-semantic', '--space', 'demo', '--host', fake.host, '--json']);
  assert.equal(r.code, 0, 'a working embedder enables');
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.host, fake.host);
  assert.equal(out.embeddingDims, 8, 'reports the verified embedding dimensionality');

  const workspace = ws(home, 'demo');
  const cfg = await loadSemanticConfig(workspace);
  assert.equal(cfg?.host, fake.host);
  assert.match(cfg.vectorProviderCommand, /dist\/providers\/ollama-embedding-provider\.mjs/, 'points at the bundled sidecar');

  const args = semanticEngineArgs(workspace);
  assert.equal(args[args.indexOf('--engine') + 1], 'vector');
  assert.equal(args[args.indexOf('--vector-host') + 1], fake.host, 'host is propagated to the server (→ sidecar OLLAMA_HOST)');
  assert.equal(args[args.indexOf('--vector-model') + 1], 'nomic-embed-text');

  assert.equal((await runCli(home, ['disable-semantic', '--space', 'demo'])).code, 0);
  assert.equal(await loadSemanticConfig(workspace), null, 'disable removes the marker');
  assert.deepEqual(semanticEngineArgs(workspace), [], 'default FTS restored');
});

test('MODEL PROPAGATION: a custom model reaches the runtime sidecar (no green-while-FTS-fallback split)', async (t) => {
  const home = await tmpHome(t);
  const fake = await fakeOllama('embed', 'custom-embed'); // ONLY embeds "custom-embed"
  t.after(() => fake.close());
  const e = await runCli(home, ['enable-semantic', '--space', 'demo', '--host', fake.host, '--model', 'custom-embed', '--json']);
  assert.equal(e.code, 0, 'enable succeeds for the custom model');
  // doctor evaluates the EFFECTIVE engine: the sidecar must embed with the configured model, so the
  // runtime engine is the vector lane — not a silent FTS fallback (which is what happened pre-fix, when
  // the sidecar ignored the engine model and used the env/default nomic-embed-text).
  const d = await runCli(home, ['doctor', '--space', 'demo', '--json']);
  const report = JSON.parse(d.stdout);
  const engine = report.checks.find((c) => c.name === 'engine');
  const semantic = report.checks.find((c) => c.name === 'semantic');
  assert.match(engine.detail, /active=vector-gguf/, 'runtime engine is the vector lane (sidecar used the configured model)');
  assert.doesNotMatch(engine.detail, /fallback/i, 'no silent FTS fallback for a custom model');
  assert.equal(semantic.ok, true, 'semantic check healthy and consistent with the active engine');
});

test('MARKER VALIDATION: only THIS package\'s exact bundled sidecar is honored — every tamper rejected', async (t) => {
  const home = await tmpHome(t);
  const workspace = await ensureWorkspace(ws(home, 'demo'));
  const p = semanticConfigPath(workspace);
  await fs.mkdir(path.dirname(p), { recursive: true });
  const write = (cmd) => fs.writeFile(p, JSON.stringify({ engine: 'vector', vectorProviderCommand: cmd, vectorModel: 'x', host: 'http://localhost:11434', vectorTimeoutMs: 20000 }), 'utf8');

  const tampered = [
    '/bin/sh -c "curl evil"', // non-node command
    '/bin/echo /tmp/providers/ollama-embedding-provider.mjs', // substring bypass: magic name as an ARG
    'node /tmp/providers/ollama-embedding-provider.mjs --extra evil', // extra args
    'node /evil/ollama-embedding-provider.mjs', // wrong parent dir
    'node /tmp/providers/ollama-embedding-provider.mjs', // same-named file under ANOTHER providers/ dir
    'node /tmp/lookalike/providers/ollama-embedding-provider.mjs', // nested lookalike providers/ dir
    'node "../providers/ollama-embedding-provider.mjs"', // quoted relative path
  ];
  for (const cmd of tampered) {
    await write(cmd);
    assert.equal(await loadSemanticConfig(workspace), null, `rejected: ${cmd}`);
    assert.deepEqual(semanticEngineArgs(workspace), [], `not injected: ${cmd}`);
  }

  // POSITIVE: the real, current bundled sidecar path (what buildSemanticConfig writes) IS honored.
  await write(buildSemanticConfig({ host: 'http://localhost:11434', model: 'nomic-embed-text' }).vectorProviderCommand);
  assert.ok(await loadSemanticConfig(workspace), 'the genuine bundled sidecar command is accepted');
  assert.ok(semanticEngineArgs(workspace).length > 0, 'and injected');
});

test('buildSemanticConfig points at the bundled sidecar with the chosen host/model', () => {
  const cfg = buildSemanticConfig({ host: 'http://localhost:11434', model: 'nomic-embed-text' });
  assert.equal(cfg.engine, 'vector');
  assert.match(cfg.vectorProviderCommand, /dist\/providers\/ollama-embedding-provider\.mjs/);
  assert.equal(cfg.vectorModel, 'nomic-embed-text');
});

test('detectOllama: real embed probe — unreachable is honest, a real embedder reports canEmbed + dims', async (t) => {
  const down = await detectOllama({ host: DEAD_HOST, timeoutMs: 1500 });
  assert.equal(down.reachable, false);
  assert.equal(down.canEmbed, false);
  assert.ok(typeof down.error === 'string' && down.error.length > 0);

  const fake = await fakeOllama('embed');
  t.after(() => fake.close());
  const up = await detectOllama({ host: fake.host });
  assert.equal(up.reachable, true);
  assert.equal(up.canEmbed, true);
  assert.equal(up.dims, 8);
});

test('doctor: a configured-but-down semantic provider is a WARNING, never a failure (additive lane)', async (t) => {
  const home = await tmpHome(t);
  const workspace = await ensureWorkspace(ws(home, 'demo'));
  await writeSemanticConfig(workspace, buildSemanticConfig({ host: DEAD_HOST, model: 'nomic-embed-text' }));

  const r = await runCli(home, ['doctor', '--space', 'demo', '--json']);
  const report = JSON.parse(r.stdout);
  const semantic = report.checks.find((c) => c.name === 'semantic');
  assert.ok(semantic, 'doctor emits a semantic check when enabled');
  assert.equal(semantic.ok, false, 'down provider is not ok');
  assert.equal(semantic.required, false, 'but it is NOT a required check');
  assert.match(semantic.detail, /falls back to FTS/i);
  assert.equal(report.ok, true, 'doctor still passes overall — semantic is additive, not load-bearing');
  assert.equal(r.code, 0);
});
