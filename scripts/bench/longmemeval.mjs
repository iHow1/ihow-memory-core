// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// LongMemEval (oracle variant) adapter + pinned downloader for the standard retrieval benchmark.
//
// Dataset: LongMemEval — Di Wu, Hongwei Wang, Wenhao Yu, Yuwei Zhang, Kai-Wei Chang, Dong Yu (2024),
//   "LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory", arXiv:2410.10813.
//   License: MIT. Oracle variant source (file longmemeval_oracle.json):
//   https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned
//   The oracle file is byte-identical across the -cleaned and original repos (same sha256), so we pin by
//   hash and either URL is safe.
//
// Mapping to OUR retrieval fixture ({docs:[{id,text}], queries:[{q,relevant,kind}]}) uses the SESSION
// granularity from the official eval (LongMemEval src/retrieval/run_retrieval.py): one document per
// session, document text = the concatenation of that session's USER turns (assistant turns are never
// indexed as documents); a session is GOLD iff it is listed in answer_session_ids AND contains a user
// turn with has_answer===true (mirrors the official "answer -> noans" id rewrite at session level).
//
// We build a GLOBAL corpus across the N sampled instances (every instance's sessions in one corpus) so
// lexical retrieval is genuinely exercised. This is HARDER than the paper's per-instance oracle setup
// (where k > #docs-in-one-haystack makes recall trivially 1.0) — we say so wherever the number is shown.
// Recall@k here is recall_any@k (>=1 gold session in top-k), the same reading as the official metric.
//
// Per the official eval we EXCLUDE abstention instances (question_id ending "_abs") and any instance with
// no has_answer user turn (no retrievable target) — the comparable denominator.

import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const ORACLE_URL =
  'https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_oracle.json';
export const ORACLE_SHA256 = '821a2034d219ab45846873dd14c14f12cfe7776e73527a483f9dac095d38620c';
export const ORACLE_SIZE = 15388478;

export function isAbstention(instance) {
  return typeof instance?.question_id === 'string' && instance.question_id.endsWith('_abs');
}

function userTurnsText(session) {
  if (!Array.isArray(session)) return '';
  return session
    .filter((t) => t && t.role === 'user' && typeof t.content === 'string')
    .map((t) => t.content)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasUserTarget(instance) {
  return (
    Array.isArray(instance?.haystack_sessions) &&
    instance.haystack_sessions.some((s) => Array.isArray(s) && s.some((t) => t && t.role === 'user' && t.has_answer === true))
  );
}

// The GOLD session ids for an instance: listed in answer_session_ids AND holding a has_answer user turn.
function goldSessionIds(instance) {
  const answer = new Set(instance.answer_session_ids || []);
  const ids = instance.haystack_session_ids || [];
  const sessions = instance.haystack_sessions || [];
  const gold = [];
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (!answer.has(id)) continue;
    const s = sessions[i] || [];
    if (s.some((t) => t && t.role === 'user' && t.has_answer === true)) gold.push(id);
  }
  return gold;
}

// Build a GLOBAL-corpus retrieval fixture from LongMemEval oracle instances.
// Returns {source, docs:[{id,text}], queries:[{q,relevant,kind}], meta}.
export function toFixture(instances, { limit = Infinity, source } = {}) {
  const docs = new Map(); // sessionId -> user-turn text (oracle session ids are globally unique)
  const queries = [];
  let used = 0;
  let skippedAbstention = 0;
  let skippedNoTarget = 0;
  for (const inst of instances) {
    if (used >= limit) break;
    if (isAbstention(inst)) { skippedAbstention += 1; continue; }
    if (!hasUserTarget(inst)) { skippedNoTarget += 1; continue; }
    const gold = goldSessionIds(inst);
    if (gold.length === 0) { skippedNoTarget += 1; continue; }
    const ids = inst.haystack_session_ids || [];
    const sessions = inst.haystack_sessions || [];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      const text = userTurnsText(sessions[i]);
      if (id && text && !docs.has(id)) docs.set(id, text);
    }
    queries.push({ q: inst.question, relevant: gold, kind: inst.question_type });
    used += 1;
  }
  return {
    source: source || `LongMemEval-oracle global-corpus (${used} instances; MIT, arXiv:2410.10813)`,
    docs: [...docs].map(([id, text]) => ({ id, text })),
    queries,
    meta: {
      instances: used,
      skippedAbstention,
      skippedNoTarget,
      granularity: 'session',
      metric: 'recall_any@k',
      corpus: 'global',
    },
  };
}

export async function loadInstances(filePath) {
  const data = JSON.parse(await fs.readFile(filePath, 'utf8'));
  if (!Array.isArray(data)) throw new Error('LongMemEval file is not a JSON array');
  return data;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Download the pinned oracle file, verifying size + sha256 BEFORE it is written. Any mismatch throws —
// a poisoned/truncated download must never silently become the benchmark corpus. Re-uses a cached file
// that already matches the pinned hash (no network).
export async function downloadOracle(destPath, { url = ORACLE_URL } = {}) {
  try {
    const existing = await fs.readFile(destPath);
    if (existing.length === ORACLE_SIZE && sha256(existing) === ORACLE_SHA256) {
      return { path: destPath, bytes: existing.length, cached: true };
    }
  } catch { /* not cached yet */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length !== ORACLE_SIZE) throw new Error(`size mismatch: got ${buf.length}, expected ${ORACLE_SIZE}`);
  const sum = sha256(buf);
  if (sum !== ORACLE_SHA256) throw new Error(`sha256 mismatch: got ${sum}, expected ${ORACLE_SHA256}`);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.writeFile(destPath, buf);
  return { path: destPath, bytes: buf.length, cached: false };
}
