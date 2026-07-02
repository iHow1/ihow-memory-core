// SPDX-License-Identifier: Apache-2.0
// Diagnostic: is CJK memory dropped at the SEARCH layer (FTS bigram misses it) or the GATE layer
// (search finds it but recallSharesTerm drops it)? Seeds a few CJK + latin memories, then per query
// prints: search hits, and for each hit whether the production relevance gate would pass it.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../../src/core.ts';

const RECALL_STOPWORDS = new Set(['what','when','which','does','need','with','work','works']);
const CJK_COMMON_BIGRAMS = new Set(['什么','怎么','一个','我们','你们','他们','这个','那个','可以','没有','一首','请问','帮我','帮忙','是的','就是','还是','一下','一样','这是','那是','为什','是什']);
function recallTerms(s) {
  const out = new Set();
  for (const tok of String(s).toLowerCase().match(/[a-z0-9]+|[一-鿿]+/g) || []) {
    if (/[一-鿿]/.test(tok)) { if (tok.length === 2) { if (!CJK_COMMON_BIGRAMS.has(tok)) out.add(tok); } else for (let i=0;i+2<=tok.length;i++){const bg=tok.slice(i,i+2); if(!CJK_COMMON_BIGRAMS.has(bg)) out.add(bg);} }
    else if (tok.length >= 4 && !RECALL_STOPWORDS.has(tok)) out.add(tok);
  }
  return out;
}
function sharesTerm(pt, text) {
  const t = String(text).toLowerCase();
  for (const term of pt) {
    if (/[一-鿿]/.test(term)) { if (t.includes(term)) return true; }
    else if (new RegExp(`\\b${term}`).test(t)) return true;
  }
  return false;
}

const MEMS = [
  { id: 'pref_cold', text: '用户偏好：配色用低饱和冷色调，不要高对比荧光色。' },
  { id: 'pref_font', text: '中文 SVG 默认用鸿蒙字体（HarmonyOS Sans SC），回退苹方。' },
  { id: 'pg_tz', text: 'Postgres timestamptz stores UTC internally; convert at the app edge.' },
];
const QUERIES = ['配色偏好是什么', '配色', '中文 svg 用什么字体', '字体', '鸿蒙'];

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-cjk-'));
try {
  const core = await openCore({ root, space: 'cjk', engine: 'fts' });
  const rel = new Map();
  for (const m of MEMS) {
    const wc = await core.write_candidate({ text: m.text, autoPromote: false });
    const pr = await core.promote(wc.path, { scope: m.id, title: m.id });
    rel.set(String(pr.path).replace(/^memory\//, ''), m.id);
  }
  for (const q of QUERIES) {
    const hits = await core.search(q, { limit: 5 });
    const pt = recallTerms(q);
    console.log(`\nQ: "${q}"   recallTerms=${JSON.stringify([...pt])}`);
    if (!hits.length) { console.log('  SEARCH: (no hits)'); continue; }
    for (const h of hits) {
      const id = rel.get(String(h.path).replace(/^memory\//, '')) || '?';
      const src = MEMS.find((m) => m.id === id);
      const gate = src ? sharesTerm(pt, src.text) : false;
      console.log(`  SEARCH→ ${id.padEnd(10)} | GATE ${gate ? 'PASS' : 'DROP'} | ${String(h.snippet ?? '').replace(/\s+/g, ' ').slice(0, 40)}`);
    }
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
