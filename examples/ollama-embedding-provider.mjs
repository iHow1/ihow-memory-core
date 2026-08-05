#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// REAL-MODEL semantic provider (opt-in sidecar) — a genuine learned embedding model via local Ollama.
// ===================================================================================================
// This is the REAL-MODEL measurement path: it calls a learned embedding model (default
// `nomic-embed-text`, a
// learned-weights model, NOT a hashed-feature stand-in) running entirely on the user's machine via
// Ollama's localhost HTTP API — $0, offline-after-pull, no cloud, no third-party Node deps (uses
// only built-in `fetch`). A real model and a ready provider do not automatically imply a retrieval
// gain on any fixture: only an actual measured before/after delta may support a quality conclusion.
// The comparison harness reports zero or negative deltas honestly and keeps architecture-oracle
// results separate from learned-model evidence.
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
// The model the engine asks for (req.provider.model) is authoritative; env/default is only the fallback.
// Set once per invocation in main() after parsing the request so every method (status/index/search)
// embeds with the SAME model enable-semantic verified — no env-vs-engine divergence (red-team r-alpha18-2).
let activeModel = EMBED_MODEL;

// Explicit resource boundaries for the dependency-free JSON sidecar. These limits are intentionally
// conservative but comfortably above the frozen A1 fixture and common local embedding dimensions.
const MAX_SIDECAR_BYTES = 16 * 1024 * 1024;
const MAX_SIDECAR_DOCS = 10_000;
const MAX_VECTOR_DIMENSION = 8_192;
// 256 KiB accommodates 8,192 finite JSON numbers even at long decimal/exponent spellings plus the
// response object overhead, while preventing a local provider from making JSON.parse allocate from an
// unbounded body. The response is rejected from Content-Length when possible and otherwise while streaming.
const MAX_EMBED_RESPONSE_BYTES = 256 * 1024;
const MAX_PREVIEW_CHARS = 2_000;
const MAX_PREVIEW_UTF8_BYTES = 6_000;

function validateVector(vec, expectedDims = 0) {
  if (!Array.isArray(vec) || vec.length === 0 || vec.length > MAX_VECTOR_DIMENSION) {
    throw new Error('ollama_embedding_invalid_dimension');
  }
  if (!vec.every((value) => typeof value === 'number' && Number.isFinite(value))) {
    throw new Error('ollama_embedding_invalid_vector');
  }
  if (expectedDims && vec.length !== expectedDims) throw new Error('ollama_embedding_dimension_mismatch');
  return vec.length;
}

function isCanonicalMemoryMarkdownPath(value) {
  if (typeof value !== 'string' || !value.startsWith('memory/') || !value.endsWith('.md')) return false;
  if (value.includes('\\') || /[\0-\x1f\x7f]/.test(value) || path.posix.isAbsolute(value)) return false;
  const parts = value.split('/');
  if (parts.length < 2 || parts.some((part) => !part || part === '.' || part === '..')) return false;
  return path.posix.normalize(value) === value;
}

function validateStore(store, { allowEmpty = false } = {}) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) throw new Error('ollama_sidecar_invalid_structure');
  if (store.model !== activeModel) throw new Error('ollama_sidecar_model_mismatch');
  if (!Array.isArray(store.docs) || (!allowEmpty && store.docs.length === 0)) {
    throw new Error('ollama_sidecar_invalid_docs');
  }
  if (store.docs.length > MAX_SIDECAR_DOCS) throw new Error('ollama_sidecar_too_many_docs');

  let dims = 0;
  for (const doc of store.docs) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('ollama_sidecar_invalid_doc');
    if (!isCanonicalMemoryMarkdownPath(doc.path)) throw new Error('ollama_sidecar_invalid_path');
    if (typeof doc.preview !== 'string') throw new Error('ollama_sidecar_invalid_preview');
    if ([...doc.preview].length > MAX_PREVIEW_CHARS || Buffer.byteLength(doc.preview, 'utf8') > MAX_PREVIEW_UTF8_BYTES) {
      throw new Error('ollama_sidecar_preview_too_large');
    }
    try {
      dims = dims || validateVector(doc.vec);
      validateVector(doc.vec, dims);
    } catch (error) {
      if (error instanceof Error && error.message === 'ollama_embedding_invalid_dimension') {
        throw new Error('ollama_sidecar_invalid_dimension');
      }
      if (error instanceof Error && error.message === 'ollama_embedding_invalid_vector') {
        throw new Error('ollama_sidecar_invalid_vector');
      }
      throw new Error('ollama_sidecar_dimension_mismatch');
    }
  }
  return { docs: store.docs, dims };
}

async function readBoundedEmbeddingJson(res) {
  const declaredLength = res.headers.get('content-length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_EMBED_RESPONSE_BYTES) {
      await res.body?.cancel().catch(() => {});
      throw new Error('ollama_embedding_response_too_large');
    }
  }
  if (!res.body) throw new Error('ollama_embedding_invalid_json');

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_EMBED_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('ollama_embedding_response_too_large');
      }
      chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'ollama_embedding_response_too_large') throw error;
    throw new Error('ollama_embedding_invalid_json');
  }

  try {
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch {
    throw new Error('ollama_embedding_invalid_json');
  }
}

async function ollamaEmbed(text) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), EMBED_TIMEOUT_MS);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: activeModel, prompt: String(text || '') }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ollama_http_${res.status}`);
    const json = await readBoundedEmbeddingJson(res);
    const vec = json.embedding;
    validateVector(vec);
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
  return path.join(base, `ollama-${activeModel.replace(/[^a-z0-9]+/gi, '-')}-sidecar.json`);
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

// Bound concurrency for index embeds. The engine gives index() an independent
// `vectorIndexTimeoutMs` budget (10 minutes by default, configurable up to 1 hour), separate from the
// interactive status/search timeout. Default to serial work for CPU-only Ollama; an explicit positive
// integer override is capped at 8 so a malformed or aggressive value cannot create unbounded fan-out.
function indexConcurrency(value) {
  if (value === undefined || value === '') return 1;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) return 1;
  return Math.min(parsed, 8);
}

const INDEX_CONCURRENCY = indexConcurrency(process.env.OLLAMA_EMBED_CONCURRENCY);

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
    if (candidates.length > MAX_SIDECAR_DOCS) throw new Error('ollama_sidecar_too_many_docs');
  }
  const embedded = await mapLimit(candidates, INDEX_CONCURRENCY, async (c) => {
    return { path: c.rel, vec: await ollamaEmbed(c.body), preview: c.body.slice(0, MAX_PREVIEW_CHARS) };
  });
  let embeddingDims = 0;
  for (const doc of embedded) {
    validateVector(doc.vec, embeddingDims);
    embeddingDims ||= doc.vec.length;
  }
  const store = { model: activeModel, docs: embedded };
  validateStore(store, { allowEmpty: true });
  const serialized = JSON.stringify(store);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SIDECAR_BYTES) throw new Error('ollama_sidecar_too_large');
  const target = sidecarPath(ws);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fsp.mkdir(path.dirname(target), { recursive: true });
  } catch {
    throw new Error('ollama_sidecar_prepare_failed');
  }
  try {
    await fsp.writeFile(temp, serialized, 'utf8');
  } catch {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw new Error('ollama_sidecar_write_failed');
  }
  try {
    await fsp.rename(temp, target);
  } catch {
    await fsp.rm(temp, { force: true }).catch(() => {});
    throw new Error('ollama_sidecar_replace_failed');
  }
  return embedded.length;
}

function loadIndex(ws) {
  const target = sidecarPath(ws);
  let stat;
  try {
    stat = fs.statSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('ollama_sidecar_missing');
    throw new Error('ollama_sidecar_unreadable');
  }
  if (!stat.isFile()) throw new Error('ollama_sidecar_unreadable');
  if (stat.size > MAX_SIDECAR_BYTES) throw new Error('ollama_sidecar_too_large');
  let raw;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new Error('ollama_sidecar_missing');
    throw new Error('ollama_sidecar_unreadable');
  }
  let store;
  try {
    store = JSON.parse(raw);
  } catch {
    throw new Error('ollama_sidecar_invalid_json');
  }
  return validateStore(store);
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
  // The engine's selected model (req.provider.model) wins over env/default, so the model enable-semantic
  // verified is the one actually embedded with — no env-vs-engine divergence.
  if (req && req.provider && typeof req.provider.model === 'string' && req.provider.model) {
    activeModel = req.provider.model;
  }
  const ws = req.workspace || {};

  if (method === 'status') {
    // Probe Ollama reachability + model presence; ready:false makes the engine fall back to FTS.
    try {
      const probe = await ollamaEmbed('readiness probe');
      process.stdout.write(JSON.stringify({
        id: 'vector-gguf',
        model: activeModel,
        ready: true,
        cloud: false,
        dimension: probe.length,
      }) + '\n');
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          id: 'vector-gguf',
          model: activeModel,
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
    try {
      validateVector(qvec, store.dims);
    } catch {
      throw new Error('ollama_sidecar_dimension_mismatch');
    }
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
    if (hits.length === 0) throw new Error('ollama_sidecar_empty_search');
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
