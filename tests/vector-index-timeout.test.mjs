// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Gap-audit P0: the vector provider's index() call must NOT share the interactive search timeout. A slow
// embedding model indexing the whole corpus was SIGTERM-killed by the 1.5s/30s search ceiling, and the
// failure degraded SILENTLY to FTS while status could still look healthy — the exact "fake green" the floor
// exists to prevent. Fix: index() gets its own generous ceiling, and an index failure is LOUD in the manifest.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

// A fake vector provider whose index() sleeps `sleepMs`; status() is instant, search() returns nothing.
async function providerScript(dir, sleepMs) {
  const p = path.join(dir, `prov-${sleepMs}.mjs`);
  await fs.writeFile(p, `const m=process.argv[process.argv.length-1];const sleep=ms=>new Promise(r=>setTimeout(r,ms));let i='';process.stdin.on('data',c=>i+=c);process.stdin.on('end',async()=>{if(m==='status'){process.stdout.write(JSON.stringify({id:'vector-gguf',ready:true,cloud:false}));return}if(m==='index'){await sleep(${sleepMs});process.stdout.write(JSON.stringify({indexed:1}));return}if(m==='search'){process.stdout.write(JSON.stringify({hits:[]}));return}process.stdout.write('{}')});`);
  return p;
}
async function fresh(t, tag, opts) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-vit-${tag}-`)));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return { root, core: await openCore({ root, space: 'vit', cwd: root, ...opts }) };
}
async function readManifest(core) {
  try { return JSON.parse(await fs.readFile(core.workspace.indexManifestPath, 'utf8')); } catch { return null; }
}

test('vector index() uses its own ceiling — a slow index is NOT killed by the short search timeout', async (t) => {
  const dirRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-vit-prov-')));
  t.after(async () => { await fs.rm(dirRoot, { recursive: true, force: true }); });
  const prov = await providerScript(dirRoot, 700); // index sleeps 700ms
  // search timeout 200ms (would have killed a 700ms index under the old shared-timeout bug); index ceiling 4000ms
  const { core } = await fresh(t, 'sep', {
    engine: 'vector-gguf', vectorProviderCommand: `node ${prov}`, vectorTimeoutMs: 200, vectorIndexTimeoutMs: 4000,
  });
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 'u', autoPromote: false });
  await core.durable_promote(c.path, { realWrite: true, actor: 'u', target: { scope: 'general', title: 'ok' } });
  const m = await readManifest(core);
  assert.ok(m, 'a provider manifest is written');
  assert.equal(m.status, 'ready', `semantic index must SUCCEED (got status=${m && m.status}, reason=${m && m.lastError}) — index got its own 4000ms ceiling, not the 200ms search timeout`);
});

test('a vector index() that exceeds its own ceiling fails LOUDLY (manifest says lexical-only, not a silent green)', async (t) => {
  const dirRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-vit-prov2-')));
  t.after(async () => { await fs.rm(dirRoot, { recursive: true, force: true }); });
  const prov = await providerScript(dirRoot, 1500); // index sleeps 1500ms
  const { core } = await fresh(t, 'loud', {
    engine: 'vector-gguf', vectorProviderCommand: `node ${prov}`, vectorTimeoutMs: 200, vectorIndexTimeoutMs: 1000,
  });
  const c = await core.write_candidate({ text: 'clean body', sourceAgent: 'u', autoPromote: false });
  await core.durable_promote(c.path, { realWrite: true, actor: 'u', target: { scope: 'general', title: 'ok' } });
  const m = await readManifest(core);
  assert.ok(m, 'a provider manifest is written');
  assert.equal(m.status, 'fallback', 'an index timeout must record a fallback, not a healthy ready');
  assert.match(String(m.lastError || ''), /LEXICAL-ONLY|index FAILED/, 'the fallback reason must LOUDLY say the semantic index failed and search is lexical-only');
});
