// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Auto-memory recall-quality harness (§9b dogfood-gate PROXY). Measures the load-bearing question the
// Commander raised: if recall is allowed to surface AUTO-captured memory (not just 🟢 reviewed), is it a
// net GAIN (a real prior fact surfaces) or net HARM (noise/stale entries get injected, wasting tokens)?
//
// It is a PROXY, not the production hook: it seeds the labeled fixture through the real FTS engine, runs
// core.search per prompt, applies a relevance gate (shared meaningful term — approximating runRecallHook's
// recallSharesTerm), and scores hits against the fixture labels in two modes:
//   reviewed-only  — the current OpenClaw-signed default (only 🟢 reviewed surfaces).
//   include-auto   — the proposed relaxation (auto-tier entries may also surface).
// Deterministic, local, no network. Re-run for the same numbers.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../../src/core.ts';
import { FIXTURE } from './auto-memory-fixture.mjs';

// KEPT IN SYNC (verbatim) with cli.ts recallTerms / recallSharesTerm so the harness measures the SAME
// relevance gate production recall uses — otherwise the numbers are the harness's, not the product's.
const RECALL_STOPWORDS = new Set(['what', 'when', 'which', 'where', 'does', 'need', 'needs', 'with', 'from', 'that', 'this', 'have', 'work', 'works', 'about', 'into']);
const CJK_COMMON_BIGRAMS = new Set(['什么','怎么','怎样','为什','是什','为何','是否','多少','哪个','哪些','如何','现在','目前','最近','今天','明天','昨天','以后','以前','当时','后来','时候','时间','几点','问题','事情','东西','情况','地方','方面','方法','内容','意思','知道','觉得','认为','感觉','希望','想要','需要','应该','可能','已经','正在','一直','总是','经常','有时','开始','结束','继续','这样','那样','这些','那些','这里','那里','这是','那是','这个','那个','如果','因为','所以','但是','不过','而且','或者','虽然','然后','其实','就是','还是','只是','也是','都是','一个','一些','一下','一点','一样','一起','一首','我们','你们','他们','她们','咱们','大家','自己','可以','没有','不是','不能','不会','不用','不要','帮我','帮忙','请问','是的']);
function terms(s) {
  const out = new Set();
  for (const tok of String(s).toLowerCase().match(/[a-z0-9]+|[一-鿿]+/g) || []) {
    if (/[一-鿿]/.test(tok)) { // CJK bigrams (in sync with cli.ts recallTerms)
      if (tok.length === 2) { if (!CJK_COMMON_BIGRAMS.has(tok)) out.add(tok); }
      else for (let i = 0; i + 2 <= tok.length; i += 1) { const bg = tok.slice(i, i + 2); if (!CJK_COMMON_BIGRAMS.has(bg)) out.add(bg); }
    } else if (tok.length >= 4 && !RECALL_STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}
function sharesTerm(promptTerms, text) {
  const t = String(text).toLowerCase();
  for (const term of promptTerms) {
    if (/[一-鿿]/.test(term)) { if (t.includes(term)) return true; } // CJK substring
    else if (new RegExp(`\\b${term}`).test(t)) return true; // latin word-boundary, prefix-tolerant
  }
  return false;
}
const memRel = (p) => String(p || '').replace(/\\/g, '/').replace(/^memory\//, '');

async function run() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-amq-'));
  const space = 'amq';
  const pathToMem = new Map();
  try {
    const core = await openCore({ root, space, engine: 'fts' });
    for (const m of FIXTURE.memories) {
      if (m.lane === 'reviewed') {
        const wc = await core.write_candidate({ text: m.text, autoPromote: false });
        const pr = await core.promote(wc.path, { scope: m.id, title: m.id });
        pathToMem.set(memRel(pr.path), { ...m, tier: 'reviewed' });
      } else {
        // auto lane: default auto-promote → unverified tier (reviewed:false), tagged like a floor capture.
        const wc = await core.write_candidate({ text: m.text, sourceAgent: 'hook-floor' });
        const p = wc.autoPromote?.path || wc.path;
        pathToMem.set(memRel(p), { ...m, tier: 'auto' });
      }
    }

    const K = 5;
    let gain = 0; // prompts where a RELEVANT useful-auto entry surfaces (that reviewed-only would miss)
    let harm = 0; // (prompt × auto-entry) surfaced that is a trap / noise / misleading / off-topic
    let autoTokens = 0; // extra chars injected by surfaced auto entries (token-waste proxy)
    let reviewedOk = 0; // reviewed relevant entries that surface (sanity: default recall works)
    const rows = [];

    for (const p of FIXTURE.prompts) {
      const pTerms = terms(p.q);
      const hits = await core.search(p.q, { limit: K });
      const surfaced = hits
        .map((h) => ({ h, m: pathToMem.get(memRel(h.path)) }))
        .filter((x) => x.m && sharesTerm(pTerms, String(x.h.snippet ?? x.m.text)));

      const reviewedSurfaced = surfaced.filter((x) => x.m.tier === 'reviewed');
      const autoSurfaced = surfaced.filter((x) => x.m.tier === 'auto');
      reviewedOk += reviewedSurfaced.some((x) => p.relevant.includes(x.m.id)) ? 1 : 0;

      let pGain = 0;
      let pHarm = 0;
      for (const x of autoSurfaced) {
        const isRelevantUseful = p.relevant.includes(x.m.id) && x.m.quality === 'useful';
        const isTrap = p.traps.includes(x.m.id) || (!p.relevant.includes(x.m.id));
        if (isRelevantUseful) { pGain += 1; } // include-auto uniquely surfaces a wanted fact
        if (isTrap || x.m.quality === 'noise' || x.m.quality === 'misleading') {
          if (!isRelevantUseful) { pHarm += 1; autoTokens += String(x.h.snippet ?? x.m.text).length; }
        }
      }
      if (pGain) gain += 1;
      harm += pHarm;
      rows.push({ q: p.q.slice(0, 28), kind: p.kind, reviewed: reviewedSurfaced.length, autoGain: pGain, autoHarm: pHarm });
    }

    const nPrompts = FIXTURE.prompts.length;
    const round = (x) => Math.round(x * 100) / 100;
    return {
      engine: 'fts',
      prompts: nPrompts,
      reviewed_baseline_hit: `${reviewedOk}/${nPrompts}`,
      include_auto: { gain_prompts: gain, harm_injections: harm, wasted_chars: autoTokens },
      net_signal: round(gain - harm), // >0 helps, <0 hurts
      rows,
    };
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

run()
  .then((r) => {
    console.log('iHow Memory — AUTO-MEMORY recall-quality (reviewed-only vs include-auto) · default FTS5');
    console.log('─'.repeat(84));
    console.log(`reviewed baseline (relevant surfaced): ${r.reviewed_baseline_hit}`);
    console.log(`include-auto → GAIN prompts: ${r.include_auto.gain_prompts}   HARM injections: ${r.include_auto.harm_injections}   wasted chars: ${r.include_auto.wasted_chars}`);
    console.log(`NET SIGNAL (gain − harm): ${r.net_signal}   ${r.net_signal > 0 ? '(helps)' : r.net_signal < 0 ? '(HURTS — token waste > value)' : '(neutral)'}`);
    console.log('─'.repeat(84));
    for (const row of r.rows) {
      console.log(`  ${row.kind.padEnd(22)} rev=${row.reviewed} auto:+${row.autoGain}/-${row.autoHarm}  ${row.q}`);
    }
  })
  .catch((e) => { console.error(e?.stack || e); process.exitCode = 1; });
