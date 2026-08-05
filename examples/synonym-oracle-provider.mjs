#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// ARCHITECTURE-PROOF semantic provider (opt-in sidecar) — deterministic, offline, zero-dependency.
// =================================================================================================
// WHAT THIS IS — and is NOT. Read before you cite any number it produces.
//
//   This provider exists to prove ONE architectural claim and nothing else:
//
//       *When a semantic lane genuinely captures a synonym/paraphrase relation, the engine's RRF
//        fusion pulls the matching document into the top-K — even though pure FTS5 missed it
//        because the query and the doc share no surface tokens.*
//
//   It does NOT estimate how good a real embedding model is. It is NOT a quality benchmark. The
//   numbers it yields for the semantic lane are a CEILING-BY-CONSTRUCTION (a hand-curated oracle
//   that knows the right answer for the fixture's paraphrase queries), so they say only "the wiring
//   works", never "model X recalls Y% of real-world paraphrases". For a REAL quality number, run the
//   `ollama-embedding-provider.mjs` sidecar against a real local embedding model (see bench/README).
//
// WHY A CONTROLLED ORACLE INSTEAD OF A FAKE EMBEDDING. The other reference sidecar
// (`local-embedding-provider.mjs`) uses a hashed char-n-gram "embedding". On English paraphrase
// queries that share no surface tokens with the answer, char-n-grams DO NOT capture synonymy — they
// land the right doc only by accidental sub-word overlap (e.g. "process"↔"processes"), and on true
// synonym pairs ("credentials"↔"tokens", "invalid"↔"expire") they rank the answer behind unrelated
// docs. Reporting a "semantic gain" from that would be a fabricated, misleading number — exactly what
// this work refuses to do. So instead we make the semantic signal HONEST about what it is: a declared
// oracle. The semantic lane here returns the synonym match BECAUSE WE TOLD IT TO, and the bench labels
// every figure from it as ARCHITECTURE PROOF, not a model benchmark.
//
// Protocol (identical to VectorProcessEngine.callProvider in src/engine/retrieval.ts):
//   spawned as:  node synonym-oracle-provider.mjs <method>
//   stdin  (one JSON line): { method, workspace:{root,space,memoryDir,indexPath,...},
//                             provider:{id,model}, query?, opts? }
//   stdout (one JSON line):
//     status -> { id:'vector-gguf', model, ready:true, cloud:false }
//     index  -> { indexed }
//     search -> { hits: [{ path, snippet, score, source }] }   // score: higher = better
//
// SAFETY (same as every sidecar): this provider only RANKS. The engine fuses its hits with the
// always-on FTS lane via RRF; recall-eligibility (event-log / governance gate) is decided downstream
// and is unaffected by any score this oracle returns. A high score can reorder output but can NEVER
// make an un-promoted / unverified entry recall-eligible.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// --- the oracle: a SMALL, DECLARED synonym map keyed by content words that appear in the fixture's
//     paraphrase QUERIES, pointing at the content words that appear in the matching DOC. This is the
//     human-curated "ground-truth semantic relation" the proof is built on. It is deliberately tiny
//     and auditable — every entry below is a synonym/paraphrase relation a real embedding model would
//     also capture; we just hardcode it so the proof is deterministic and offline.
//
//     Read it as: "if the query mentions <key>, treat docs that mention any of <values> as a semantic
//     match." Keys/values are lowercased single words matched against word tokens.
const SYNONYMS = {
  // auth_expiry: "how long until login credentials become invalid" → "tokens expire"
  credentials: ['token', 'tokens'],
  login: ['auth', 'token', 'tokens'],
  invalid: ['expire', 'expires', 'expiry'],
  // markdown_store: "where is memory kept on the filesystem" → "stored as Markdown on disk"
  kept: ['stored', 'store'],
  filesystem: ['disk', 'markdown'],
  // lock_serialize: "preventing two processes from corrupting shared state" → "serialized ... file lock ... shared memory store"
  preventing: ['serialized', 'lock'],
  processes: ['agents', 'writes'],
  corrupting: ['clobber'],
  // handoff_packet: "how does handing off work between agents" → "a handoff is a candidate the next agent reads"
  handing: ['handoff'],
  // secret_redaction: "masking sensitive values before they get written" → "redacts secret-shaped substrings ... in place"
  masking: ['redacts', 'redaction'],
  sensitive: ['secret', 'secrets'],
};

function words(text) {
  return new Set(String(text || '').toLowerCase().match(/[a-z0-9_]+/g) || []);
}

// Semantic score = how many DECLARED synonym relations connect this query to this doc. Higher is a
// stronger, human-vouched semantic match. Purely a function of the oracle map + the two texts.
function oracleScore(queryWords, docWords) {
  let score = 0;
  for (const qw of queryWords) {
    const targets = SYNONYMS[qw];
    if (!targets) continue;
    for (const t of targets) {
      if (docWords.has(t)) score += 1;
    }
  }
  return score;
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
  return path.join(base, 'synonym-oracle-sidecar.json');
}

function stripFrontmatter(content) {
  return String(content || '').replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

function snippetFrom(content) {
  const body = stripFrontmatter(content).replace(/\s+/g, ' ').trim();
  return body.slice(0, 160) + (body.length > 160 ? '…' : '');
}

async function buildIndex(ws) {
  const memoryDir = ws.memoryDir;
  const files = await listMarkdown(memoryDir);
  const docs = [];
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
    const body = stripFrontmatter(content);
    docs.push({ path: rel, words: [...words(body)], preview: body.slice(0, 2000) });
  }
  await fsp.mkdir(path.dirname(sidecarPath(ws)), { recursive: true });
  await fsp.writeFile(sidecarPath(ws), JSON.stringify({ docs }), 'utf8');
  return docs.length;
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
  const model = (req.provider && req.provider.model) || 'synonym-oracle-architecture-proof';

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
    const qWords = words(req.query || '');
    const limit = Math.max(1, Math.min(Number((req.opts && req.opts.limit) || 5), 25));
    const scored = store.docs
      .map((d) => ({ path: d.path, score: oracleScore(qWords, new Set(d.words)), preview: d.preview }))
      .filter((d) => d.score > 0) // only DECLARED-synonym matches surface — no noise, no accidental hits
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    const hits = scored.map((d) => {
      const snippet = snippetFrom(d.preview);
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
