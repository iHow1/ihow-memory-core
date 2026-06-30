#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// REFERENCE local semantic provider (opt-in sidecar) — zero third-party dependencies.
// ---------------------------------------------------------------------------------
// The default `ihow-memory` binary ships ZERO third-party runtime deps; bundling an
// ONNX / @xenova embedding model into it would break that moat. So semantic recall is
// an OPT-IN sidecar: this file is a *reference* external provider that speaks the same
// one-shot stdio protocol as the engine's `vector-gguf` provider branch
// (src/engine/retrieval.ts → VectorProcessEngine). It is NOT installed by default, not
// listed in package.json "files", and not imported by any runtime module — so the
// published binary's dependency graph and `capabilities.semantic=false` are unaffected
// until a user explicitly wires this in.
//
// It is offline, deterministic and $0: a dependency-free hashed character-n-gram
// embedding (the same family as agentmemory's all-MiniLM-L6-v2 384-dim bag-of-features,
// minus the learned weights — good enough to demonstrate the RRF fusion and to give a
// reproducible reference vector lane; swap in a real model behind the SAME protocol when
// you want quality). Cosine similarity over these vectors gives word-overlap-tolerant
// recall ("rollback" ↔ "revert", "重命名" ↔ "改名") that pure lexical FTS misses.
//
// Protocol (matches VectorProcessEngine.callProvider):
//   spawned as:  node local-embedding-provider.mjs <method>      (method also on argv)
//   stdin  (one JSON line): { method, workspace:{root,space,memoryDir,indexPath,...},
//                             provider:{id,model}, query?, opts? }
//   stdout (one JSON line):
//     status -> { id, model, ready, cloud:false }
//     index  -> { indexed }
//     search -> { hits: [{ path, snippet, score, source }] }   // score: higher = better
//
// SAFETY: this provider only RANKS. The engine fuses these hits with the always-on FTS
// lane via RRF; recall-eligibility (event-log / governance gate) is decided downstream
// and is unaffected by any score this sidecar returns. A high cosine score can reorder
// search output but can NEVER make an un-promoted / unverified entry recall-eligible.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const DIM = 384; // mirror agentmemory all-MiniLM-L6-v2 dimensionality for an apples-to-apples reference

// --- deterministic hashed embedding (no deps, no network, no model file) ---------------
// FNV-1a 32-bit; bucket char-3-grams + tokens into a fixed-dim vector, then L2-normalize.
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function tokenize(text) {
  const lower = String(text || '').toLowerCase();
  const feats = [];
  // latin / digit words
  for (const m of lower.match(/[\p{L}\p{N}_]+/gu) || []) {
    feats.push(m);
    // char 3-grams within the word: tolerate inflection / typos / morphological variants
    for (let i = 0; i + 3 <= m.length; i++) feats.push(`#${m.slice(i, i + 3)}`);
  }
  // CJK bigrams (a Han run is one FTS token; bigrams are the meaningful unit)
  for (const run of lower.match(/[㐀-鿿豈-﫿]+/g) || []) {
    for (let i = 0; i < run.length; i++) {
      feats.push(run[i]);
      if (i + 1 < run.length) feats.push(run[i] + run[i + 1]);
    }
  }
  return feats;
}

function embed(text) {
  const vec = new Float64Array(DIM);
  for (const feat of tokenize(text)) {
    const h = fnv1a(feat);
    const idx = h % DIM;
    const sign = (h >> 31) & 1 ? -1 : 1; // signed hashing: reduce collision bias
    vec[idx] += sign;
  }
  let norm = 0;
  for (let i = 0; i < DIM; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < DIM; i++) vec[i] /= norm;
  return Array.from(vec);
}

function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < DIM; i++) dot += a[i] * b[i];
  return dot; // both are L2-normalized -> dot product is cosine similarity
}

// --- corpus walk: mirror the FTS indexer's exclusions so the two lanes see the same docs --
async function listMarkdown(dir) {
  const out = [];
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listMarkdown(abs)));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs);
  }
  return out;
}

function sidecarPath(ws) {
  // park the vector store next to the FTS index, namespaced so it never collides with index.db
  const base = ws.indexPath ? path.dirname(ws.indexPath) : (ws.memoryDir || process.cwd());
  return path.join(base, 'vector-sidecar.json');
}

function stripFrontmatter(content) {
  return String(content || '').replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function snippetFrom(content, query) {
  const body = stripFrontmatter(content).replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const needle = (query || '').toLowerCase().match(/[\p{L}\p{N}_]{2,}|[㐀-鿿]{2,}/u)?.[0];
  const pos = needle ? body.toLowerCase().indexOf(needle) : -1;
  if (pos < 0) return body.slice(0, 160) + (body.length > 160 ? '…' : '');
  const start = Math.max(0, pos - 40);
  const end = Math.min(body.length, pos + 120);
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
}

async function buildIndex(ws) {
  const memoryDir = ws.memoryDir;
  const files = await listMarkdown(memoryDir);
  const docs = [];
  for (const abs of files) {
    const rel = path.relative(path.dirname(memoryDir), abs).split(path.sep).join('/');
    // mirror src/engine/fts.ts collectDocuments() exclusions
    if (rel.startsWith('memory/candidate/')) continue;
    if (rel.startsWith('memory/_mcp/_events/')) continue;
    if (rel.startsWith('memory/_mcp/history/')) continue;
    let content;
    try {
      content = await fsp.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    docs.push({ path: rel, vec: embed(content), preview: stripFrontmatter(content).slice(0, 2000) });
  }
  await fsp.mkdir(path.dirname(sidecarPath(ws)), { recursive: true });
  await fsp.writeFile(sidecarPath(ws), JSON.stringify({ dim: DIM, docs }), 'utf8');
  return docs.length;
}

function loadIndex(ws) {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(ws), 'utf8'));
  } catch {
    return { dim: DIM, docs: [] };
  }
}

async function main() {
  const method = process.argv[2] || 'status';
  const input = await new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    // status() may be called without a body; don't hang
    setTimeout(() => resolve(buf), 200);
  });
  let req = {};
  try {
    req = JSON.parse(input.trim() || '{}');
  } catch {
    req = {};
  }
  const ws = req.workspace || {};
  const model = (req.provider && req.provider.model) || 'local-hashed-384';

  if (method === 'status') {
    process.stdout.write(JSON.stringify({ id: 'vector-gguf', model, ready: true, cloud: false }) + '\n');
    return;
  }
  if (method === 'index') {
    const indexed = await buildIndex(ws);
    process.stdout.write(JSON.stringify({ indexed }) + '\n');
    return;
  }
  if (method === 'search') {
    const store = loadIndex(ws);
    const qvec = embed(req.query || '');
    const limit = Math.max(1, Math.min(Number((req.opts && req.opts.limit) || 5), 25));
    const scored = store.docs
      .map((d) => ({ path: d.path, score: cosine(qvec, d.vec), preview: d.preview }))
      .filter((d) => Number.isFinite(d.score) && d.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const hits = scored.map((d) => {
      const snippet = snippetFrom(d.preview, req.query || '');
      return { path: d.path, snippet, score: d.score, source: 'vector-gguf', citation: { path: d.path, snippet } };
    });
    process.stdout.write(JSON.stringify({ hits }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ error: `unknown_method:${method}` }) + '\n');
  process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(JSON.stringify({ error: String(error && error.message ? error.message : error) }) + '\n');
  process.exitCode = 1;
});
