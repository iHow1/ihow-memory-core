// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// retrieval-bench — a DETERMINISTIC, stranger-reproducible retrieval benchmark for the DEFAULT
// shipped engine: zero-dependency `node:sqlite` FTS5 lexical search. No cloud, no network, no LLM,
// no third-party runtime deps — it drives the SAME engine functions the product uses (openCore ->
// write_candidate -> promote -> search), then scores R@5 / R@10 / MRR + tokens-per-query against a
// labeled fixture. Run it:
//
//     node scripts/retrieval-bench.mjs            # human scorecard
//     node scripts/retrieval-bench.mjs --json     # machine-readable result
//
// FIXTURE HONESTY (read this): the public LongMemEval_S dataset (~500 samples) is NOT vendored in
// this repo, so this harness runs a small, in-repo, representative fixture — 20 labeled memory
// documents across 12 distinct topics and 20 queries with ground-truth relevant-doc labels. It is
// NOT LongMemEval_S; it is a deterministic stand-in that anyone can audit (the fixture is the few
// dozen readable lines below) and that exercises the exact retrieval path. Query types are mixed on
// purpose to be honest about lexical retrieval's real shape: exact-keyword, partial-keyword, and
// PARAPHRASE / synonym queries that share no surface tokens with the answer (where pure FTS5 is
// expected to miss — that miss is the honest finding, not a bug). The numbers below are the DEFAULT
// FTS5 floor on THIS fixture; they are not comparable to, and do not restate, the experimental
// vector+lexical hybrid LongMemEval_S figure published in the README.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

// ── Fixture: in-repo, representative, labeled. Each doc has a stable `id` used as its scope, so a
//    search hit's path contains the id and we can match results to ground truth deterministically.
//    Source: hand-authored for this repo (agent-engineering memory facts), modeled on the SHAPE of
//    LongMemEval_S single-/multi-session recall items. Scale: 20 docs / 12 topics / 20 queries.
export const FIXTURE = {
  source: 'in-repo hand-authored representative fixture (NOT LongMemEval_S; modeled on its recall shape)',
  docs: [
    { id: 'auth_expiry', text: 'Auth tokens expire after 15 minutes in the staging environment; production tokens last 60 minutes.' },
    { id: 'pagination', text: 'Decision: adopt cursor-based pagination for the feed endpoint; offset pagination drifts on inserts.' },
    { id: 'postgres_tz', text: 'Postgres timestamptz stores values in UTC internally; always convert to local time at the application edge.' },
    { id: 'queue_sqs', text: 'We switched the message queue from Redis to Amazon SQS for at-least-once delivery semantics.' },
    { id: 'ratelimit', text: 'The vendor API now rate-limits at 500 requests per minute per key, raised from the old limit of 100.' },
    { id: 'mobile_breakpoint', text: 'The mobile app uses a 380px design breakpoint for the compact single-column layout.' },
    { id: 'deploy_rollback', text: 'Production deploys go out via blue-green; rollback is an instant traffic switch back to the previous slot.' },
    { id: 'cache_ttl', text: 'The product catalog cache has a 300 second time-to-live; stale-while-revalidate serves the old copy during refresh.' },
    { id: 'oauth_pkce', text: 'The OAuth login flow uses PKCE with the authorization code grant; the implicit grant was removed for security.' },
    { id: 'db_pool', text: 'The database connection pool is capped at 20 connections per service instance to avoid exhausting Postgres.' },
    { id: 'retry_backoff', text: 'Outbound HTTP retries use exponential backoff with full jitter, capped at five attempts before failing the request.' },
    { id: 'feature_flags', text: 'Feature flags are evaluated server-side and cached for ten seconds; a kill switch disables a flag globally within that window.' },
    { id: 'search_cjk', text: 'CJK full-text search indexes overlapping bigrams so that a two-character query matches the exact phrase, not a single shared character.' },
    { id: 'audit_log', text: 'Every promote is an append-only audit event written to an ndjson log; rollback removes the document and records a reversal event.' },
    { id: 'secret_redaction', text: 'The pre-write check redacts secret-shaped substrings such as API keys and bearer tokens in place rather than rejecting the whole note.' },
    { id: 'lock_serialize', text: 'Concurrent writes are serialized by a workspace file lock so two agents never clobber each other on the shared memory store.' },
    { id: 'index_rebuild', text: 'The FTS index is rebuilt from the Markdown source on every write; run reindex to force a full rebuild if it looks stale.' },
    { id: 'node_requirement', text: 'The runtime requires Node version 22.12 or newer because it depends on the built-in node:sqlite module for storage.' },
    { id: 'handoff_packet', text: 'A handoff is a candidate the next agent reads: current state, evidence, blockers, and the next step, with live git anchors.' },
    { id: 'markdown_store', text: 'Memory is stored as plain human-readable Markdown on disk so it can be read, diffed, and rolled back with ordinary git.' },
  ],
  // Each query labels the doc id(s) that SHOULD be recalled. `kind` documents the query shape so the
  // scorecard can break down where lexical retrieval is strong vs weak — it does not affect scoring.
  queries: [
    // exact / strong-keyword overlap — lexical retrieval should nail these
    { q: 'how long do auth tokens last in staging', relevant: ['auth_expiry'], kind: 'keyword' },
    { q: 'cursor based pagination for the feed endpoint', relevant: ['pagination'], kind: 'keyword' },
    { q: 'postgres timestamptz UTC timezone', relevant: ['postgres_tz'], kind: 'keyword' },
    { q: 'message queue Redis to SQS delivery', relevant: ['queue_sqs'], kind: 'keyword' },
    { q: 'vendor API rate limit requests per minute', relevant: ['ratelimit'], kind: 'keyword' },
    { q: 'mobile design breakpoint 380px layout', relevant: ['mobile_breakpoint'], kind: 'keyword' },
    { q: 'blue-green deploy rollback traffic switch', relevant: ['deploy_rollback'], kind: 'keyword' },
    { q: 'OAuth PKCE authorization code grant login', relevant: ['oauth_pkce'], kind: 'keyword' },
    { q: 'database connection pool size limit', relevant: ['db_pool'], kind: 'keyword' },
    { q: 'exponential backoff jitter retry attempts', relevant: ['retry_backoff'], kind: 'keyword' },
    { q: 'node sqlite version requirement', relevant: ['node_requirement'], kind: 'keyword' },
    { q: 'workspace lock serialize concurrent writes', relevant: ['lock_serialize'], kind: 'keyword' },
    // partial overlap — at least one strong content word is shared
    { q: 'catalog cache stale revalidate', relevant: ['cache_ttl'], kind: 'partial' },
    { q: 'feature flag kill switch', relevant: ['feature_flags'], kind: 'partial' },
    { q: 'audit event rollback reversal', relevant: ['audit_log'], kind: 'partial' },
    // paraphrase / synonym — share NO surface tokens with the answer doc; pure FTS5 is EXPECTED to
    // miss these. This is the honest weakness the semantic floor (P0-B) is meant to lift.
    { q: 'how long until login credentials become invalid', relevant: ['auth_expiry'], kind: 'paraphrase' },
    { q: 'where is memory kept on the filesystem', relevant: ['markdown_store'], kind: 'paraphrase' },
    { q: 'preventing two processes from corrupting shared state', relevant: ['lock_serialize'], kind: 'paraphrase' },
    { q: 'how does handing off work between agents', relevant: ['handoff_packet'], kind: 'paraphrase' },
    { q: 'masking sensitive values before they get written', relevant: ['secret_redaction'], kind: 'paraphrase' },
  ],
};

// Deterministic query token count (whitespace split, mirrors how a caller would budget tokens for a
// query). Pure function of the query string -> identical on every machine and every run.
function tokensOf(query) {
  return query.trim().split(/\s+/).filter(Boolean).length;
}

// Does a search-result path belong to the doc with this id? The id is the promote scope, so it is a
// path segment: memory/scopes/<id>/<ts>-<id>.md
function pathMatchesDoc(resultPath, docId) {
  return resultPath.includes(`/scopes/${docId}/`);
}

// Run the benchmark against the DEFAULT FTS5 engine. Returns the full scorecard (no console output),
// so tests can assert on it and the CLI can render it.
export async function runRetrievalBench({ fixture = FIXTURE } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-retrieval-bench-'));
  const space = 'bench';
  // Explicit engine:'fts' — the shipped default. No vector provider configured: this is the
  // zero-dependency floor exactly as published.
  const core = await openCore({ root, space, engine: 'fts' });
  try {
    // Seed the corpus through the real write -> promote path (same as the product). Promote scope =
    // doc id, so hits are matchable. --no-auto-promote equivalent: stage candidate, then promote.
    for (const doc of fixture.docs) {
      const cand = await core.write_candidate({ text: doc.text, autoPromote: false });
      await core.promote(cand.path, { scope: doc.id, title: doc.id });
    }

    const status = await core.status();
    if (status.provider.id !== 'fts') throw new Error(`expected default fts engine, got ${status.provider.id}`);
    if (status.provider.cloud !== false) throw new Error('default engine must be local / no-cloud');
    if (status.provider.model !== null) throw new Error('default engine must not use a model');

    const perQuery = [];
    let reciprocalRankSum = 0;
    let hitAt5 = 0;
    let hitAt10 = 0;
    let totalTokens = 0;

    for (const item of fixture.queries) {
      const hits = await core.search(item.q, { limit: 10 });
      const ranks = item.relevant.map((docId) => {
        const idx = hits.findIndex((h) => pathMatchesDoc(h.path, docId));
        return idx < 0 ? Infinity : idx + 1; // 1-based rank, Infinity = not found in top 10
      });
      const bestRank = Math.min(...ranks);
      const found5 = bestRank <= 5;
      const found10 = bestRank <= 10;
      const reciprocal = Number.isFinite(bestRank) ? 1 / bestRank : 0;
      const tokens = tokensOf(item.q);

      if (found5) hitAt5 += 1;
      if (found10) hitAt10 += 1;
      reciprocalRankSum += reciprocal;
      totalTokens += tokens;

      perQuery.push({
        query: item.q,
        kind: item.kind,
        relevant: item.relevant,
        bestRank: Number.isFinite(bestRank) ? bestRank : null,
        found5,
        found10,
        reciprocal,
        tokens,
      });
    }

    const n = fixture.queries.length;
    const round = (x) => Math.round(x * 1000) / 1000;
    const byKind = {};
    for (const row of perQuery) {
      const k = (byKind[row.kind] ||= { n: 0, hit5: 0, hit10: 0 });
      k.n += 1;
      if (row.found5) k.hit5 += 1;
      if (row.found10) k.hit10 += 1;
    }

    return {
      engine: { id: status.provider.id, cloud: status.provider.cloud, model: status.provider.model },
      fixture: { source: fixture.source, docs: fixture.docs.length, queries: n, topics: new Set(fixture.docs.map((d) => d.id)).size },
      metrics: {
        recall_at_5: round(hitAt5 / n),
        recall_at_10: round(hitAt10 / n),
        mrr: round(reciprocalRankSum / n),
        tokens_per_query: round(totalTokens / n),
      },
      byKind,
      perQuery,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

function renderScorecard(result) {
  const lines = [];
  const bar = '─'.repeat(76);
  lines.push('iHow Memory — retrieval benchmark · DEFAULT zero-dependency FTS5 engine');
  lines.push('(deterministic · local · no cloud / no LLM / no third-party deps — re-run for the same numbers)');
  lines.push(bar);
  lines.push(`engine:   ${result.engine.id}  (cloud=${result.engine.cloud}, model=${result.engine.model})`);
  lines.push(`fixture:  ${result.fixture.docs} docs · ${result.fixture.queries} queries`);
  lines.push(`          ${result.fixture.source}`);
  lines.push('');
  const m = result.metrics;
  lines.push(`R@5   = ${m.recall_at_5.toFixed(3)}     R@10 = ${m.recall_at_10.toFixed(3)}`);
  lines.push(`MRR   = ${m.mrr.toFixed(3)}     tokens/query = ${m.tokens_per_query.toFixed(1)}`);
  lines.push('');
  lines.push('by query kind (R@5 / R@10):');
  for (const [kind, k] of Object.entries(result.byKind)) {
    lines.push(`  ${kind.padEnd(11)} ${k.hit5}/${k.n}  ·  ${k.hit10}/${k.n}`);
  }
  lines.push('');
  lines.push('Honest read: keyword / partial queries recall well; PARAPHRASE queries (no shared surface');
  lines.push('tokens) are where pure lexical FTS5 misses — that gap is the floor the optional semantic');
  lines.push('provider is meant to lift. These are the DEFAULT-engine numbers on an in-repo fixture, NOT');
  lines.push('the experimental hybrid LongMemEval_S figure (see README · Retrieval-quality evidence).');
  lines.push(bar);
  return lines.join('\n');
}

// CLI entrypoint (only when run directly, not when imported by the test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const json = process.argv.includes('--json');
  const result = await runRetrievalBench();
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(renderScorecard(result));
  }
}
