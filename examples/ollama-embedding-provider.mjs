#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// REAL-MODEL semantic provider (opt-in sidecar) — a genuine learned embedding model via local Ollama.
// ===================================================================================================
// This is the HONEST quality path: it calls a REAL embedding model (default `nomic-embed-text`, a
// learned-weights model, NOT a hashed-feature stand-in) running entirely on the user's machine via
// Ollama's localhost HTTP API — $0, offline-after-pull, no cloud, no third-party Node deps (uses
// only built-in `fetch`). Cosine similarity over its vectors captures TRUE synonymy/paraphrase
// ("login credentials"↔"auth tokens", "kept on the filesystem"↔"stored on disk") that pure lexical
// FTS5 cannot — so the gain it shows in the bench is a REAL retrieval-quality number, not an
// architecture demo.
//
// REQUIREMENTS (this sidecar is OPT-IN precisely because it has them):
//   - Ollama running locally:            https://ollama.com      (default http://localhost:11434)
//   - the embedding model pulled once:   `ollama pull nomic-embed-text`
//   Override host/model via env: OLLAMA_HOST, OLLAMA_EMBED_MODEL.
//   If Ollama is unreachable, `status` reports ready:false and the engine TRANSPARENTLY FALLS BACK to
//   the FTS floor (see searchWithEngineFallback) — semantic is additive, never load-bearing.
//
// The default `ihow-memory` binary still ships ZERO third-party deps and `capabilities.semantic=false`;
// this file is a reference sidecar, not installed, not in package.json "files", not imported by any
// runtime module. It speaks the same one-shot stdio protocol as the engine's `vector-gguf` branch.
//
// Protocol (matches VectorProcessEngine.callProvider):
//   spawned as:  node ollama-embedding-provider.mjs <method>
//   stdin  (one JSON line): { method, workspace:{root,space,memoryDir,indexPath,...},
//                             provider:{id,model}, query?, opts? }
//   stdout (one JSON line):
//     status -> { id:'vector-gguf', model, ready, cloud:false, lastError? }
//     index  -> { indexed }
//     search -> { hits: [{ path, snippet, score, source }] }   // score: higher = better (cosine)
//
// SAFETY: this provider only RANKS. The engine fuses its hits with the always-on FTS lane via RRF;
// recall-eligibility is decided downstream and is unaffected by any score returned here.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const EMBED_MODEL = process.env.OLLAMA_EMBED_MODEL || 'nomic-embed-text';
const EMBED_TIMEOUT_MS = Number(process.env.OLLAMA_EMBED_TIMEOUT_MS || 20000);

async function ollamaEmbed(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, prompt: String(text || '') }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama_http_${res.status}`);
    const json = await res.json();
    const vec = json.embedding;
    if (!Array.isArray(vec) || vec.length === 0) throw new Error('ollama_empty_embedding');
    return vec;
  } finally {
    clearTimeout(timer);
  }
}

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

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
  const base = ws.indexPath ? path.dirname(ws.indexPath) : (ws.memoryDir || process.cwd());
  return path.join(base, `ollama-${EMBED_MODEL.replace(/[^a-z0-9]+/gi, '-')}-sidecar.json`);
}

function stripFrontmatter(content) {
  return String(content || '').replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function snippetFrom(content, query) {
  const body = stripFrontmatter(content).replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const needle = (query || '').toLowerCase().match(/[\p{L}\p{N}_]{2,}/u)?.[0];
  const pos = needle ? body.toLowerCase().indexOf(needle) : -1;
  if (pos < 0) return body.slice(0, 160) + (body.length > 160 ? '…' : '');
  const start = Math.max(0, pos - 40);
  const end = Math.min(body.length, pos + 120);
  return (start > 0 ? '…' : '') + body.slice(start, end) + (end < body.length ? '…' : '');
}

// Bound concurrency for index embeds. The engine applies ONE timeout (vectorTimeoutMs, default 1.5s,
// capped at 30s) to the WHOLE index call — so a sequential embed of N docs against a real network model
// blows the budget on even a modest corpus (20 docs ≈ 37s > 30s → the engine SIGTERMs index and the
// sidecar is never written, silently degrading search to FTS-only). Embedding concurrently brings a
// 20-doc index well under the cap. Ollama serves concurrent /api/embeddings fine; keep the fan-out
// modest so we don't thrash a small box.
const INDEX_CONCURRENCY = Number(process.env.OLLAMA_EMBED_CONCURRENCY || 8);

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function buildIndex(ws) {
  const memoryDir = ws.memoryDir;
  const files = await listMarkdown(memoryDir);
  const candidates = [];
  for (const abs of files) {
    const rel = path.relative(path.dirname(memoryDir), abs).split(path.sep).join('/');
    // mirror src/engine/fts.ts collectDocuments() exclusions so both lanes see the same corpus
    if (rel.startsWith('memory/candidate/')) continue;
    if (rel.startsWith('memory/_mcp/_events/')) continue;
    if (rel.startsWith('memory/_mcp/history/')) continue;
    let content;
    try {
      content = await fsp.readFile(abs, 'utf8');
    } catch {
      continue;
    }
    candidates.push({ rel, body: stripFrontmatter(content) });
  }
  const embedded = await mapLimit(candidates, INDEX_CONCURRENCY, async (c) => {
    return { path: c.rel, vec: await ollamaEmbed(c.body), preview: c.body.slice(0, 2000) };
  });
  await fsp.mkdir(path.dirname(sidecarPath(ws)), { recursive: true });
  await fsp.writeFile(sidecarPath(ws), JSON.stringify({ model: EMBED_MODEL, docs: embedded }), 'utf8');
  return embedded.length;
}

function loadIndex(ws) {
  try {
    return JSON.parse(fs.readFileSync(sidecarPath(ws), 'utf8'));
  } catch {
    return { docs: [] };
  }
}

async function main() {
  const method = process.argv[2] || 'status';
  const input = await new Promise((resolve) => {
    let buf = '';
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    setTimeout(() => resolve(buf), 200);
  });
  let req = {};
  try {
    req = JSON.parse(input.trim() || '{}');
  } catch {
    req = {};
  }
  const ws = req.workspace || {};

  if (method === 'status') {
    // Probe Ollama reachability + model presence; ready:false makes the engine fall back to FTS.
    try {
      await ollamaEmbed('readiness probe');
      process.stdout.write(JSON.stringify({ id: 'vector-gguf', model: EMBED_MODEL, ready: true, cloud: false }) + '\n');
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          id: 'vector-gguf',
          model: EMBED_MODEL,
          ready: false,
          cloud: false,
          lastError: `ollama_unreachable:${String(error && error.message ? error.message : error)}`,
        }) + '\n',
      );
    }
    return;
  }
  if (method === 'index') {
    const indexed = await buildIndex(ws);
    process.stdout.write(JSON.stringify({ indexed }) + '\n');
    return;
  }
  if (method === 'search') {
    const store = loadIndex(ws);
    const qvec = await ollamaEmbed(req.query || '');
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
