#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Local/public-repo secret scan used by CI and release gates.
// It intentionally reports only path:line + rule id, never the matched value.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const SECRET_RULES = [
  { id: 'github-token', re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { id: 'aws-access-key', re: /\bAKIA[A-Z0-9]{16}\b/g },
  { id: 'private-key', re: /BEGIN[ A-Z]+PRIVATE KEY/g },
  { id: 'credential-uri', re: new RegExp([
    '\\b(?:mongodb(?:\\+srv)?|postgres(?:ql)?|redis|mysql)',
    '://',
    '[^\\s:/@]+',
    ':',
    '[^\\s/@]+',
    '@',
  ].join(''), 'giu') },
  { id: 'real-customer-relationship', re: new RegExp([
    ['real', "customer'?s", 'tool'].join('\\s+'),
    ["customer'?s", 'tool'].join('\\s+'),
    ['真实', '客户', '的?', '工具'].join(''),
  ].join('|'), 'giu') },
  { id: 'machine-user-path', re: new RegExp(['/Users', '/[^/\\s]+/'].join(''), 'g') },
  { id: 'operator-workspace', re: new RegExp(['\\.open', 'claw[\\\\/]workspace'].join(''), 'giu') },
  { id: 'private-product-map', re: new RegExp(['产品化', '总图'].join(''), 'gu') },
  { id: 'private-product-strategy', re: new RegExp(['产品化', '战略'].join(''), 'gu') },
  { id: 'private-business-model', re: new RegExp(['商业', '模式'].join(''), 'gu') },
  { id: 'private-deployment-positioning', re: new RegExp(['私有化', '部署'].join(''), 'gu') },
  { id: 'private-recovery-product', re: new RegExp(['恢复', '中心'].join(''), 'gu') },
  { id: 'private-continuity-tier', re: new RegExp(['Personal', '\\s+', 'Continuity'].join(''), 'giu') },
  { id: 'unratified-product-pivot', re: new RegExp(['产品转向', '尚未批准'].join(''), 'gu') },
  { id: 'private-product-strategy-en', re: new RegExp(['product', 'strategy'].join('\\s+'), 'giu') },
  { id: 'private-commercial-plan', re: new RegExp([
    ['business', 'model'].join('\\s+'),
    ['commercial', 'strategy'].join('\\s+'),
    ['go', 'to', 'market'].join('[-\\s]+'),
    ['pricing', 'strategy'].join('\\s+'),
    ['sales', 'strategy'].join('\\s+'),
    ['商业', '战略'].join(''),
    ['定价', '策略'].join(''),
    ['收费', '方案'].join(''),
    ['付费', '方案'].join(''),
    ['营收', '计划'].join(''),
    ['融资', '计划'].join(''),
  ].join('|'), 'giu') },
  { id: 'private-deployment-positioning-en', re: new RegExp(['private', 'deployment'].join('\\s+'), 'giu') },
];

const PRIVATE_DENYLIST_ENV = 'IHOW_PUBLIC_BOUNDARY_DENYLIST';

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function privateDenylistRules(raw = process.env[PRIVATE_DENYLIST_ENV] ?? '') {
  return Array.from(new Set(raw.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean)))
    .map((value) => ({ id: 'private-denylist', re: new RegExp(escapeRegExp(value), 'giu') }));
}

const fakeOpenAi = (suffix) => ['sk', suffix].join('-');
const fakeAws = ['AKIA', 'IOSFODNN7EXAMPLE'].join('');

const ALLOWED_FIXTURE_VALUES = new Set([
  // Deterministic fake OpenAI-key-shaped fixtures used to prove redaction/governance catches leaks.
  fakeOpenAi('abcdefghijklmnopqrstuvwxyz0123456789'),
  fakeOpenAi('ABCDEFGH1234567890IJKLMNOP'),
  fakeOpenAi('ABCDEFGH1234567890IJKL'),
  // AWS documentation example key used in tests; not a real credential.
  fakeAws,
]);

const FIXTURE_PATH = /^(tests|bench)\//;
const BENCHMARK_FIXTURE_PATH = /^src\/benchmark\.ts$/;

export function isAllowedFixtureHit({ file, value }) {
  const normalized = file.replace(/\\/g, '/');
  if (!ALLOWED_FIXTURE_VALUES.has(value)) return false;
  return FIXTURE_PATH.test(normalized) || BENCHMARK_FIXTURE_PATH.test(normalized);
}

export function scanText(file, text, rules = SECRET_RULES) {
  const hits = [];
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (index) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (lineStarts[mid] <= index) lo = mid + 1;
      else hi = mid - 1;
    }
    return hi + 1;
  };

  for (const rule of rules) {
    rule.re.lastIndex = 0;
    for (const match of text.matchAll(rule.re)) {
      const value = match[0];
      if (isAllowedFixtureHit({ file, value, rule: rule.id })) continue;
      hits.push({ file, line: lineOf(match.index ?? 0), rule: rule.id });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

function gitFiles(cwd, args) {
  const raw = execFileSync('git', args, { cwd, encoding: 'buffer' });
  return raw.toString('utf8').split('\0').filter(Boolean);
}

function trackedFiles(cwd) {
  return gitFiles(cwd, ['ls-files', '-z']);
}

function untrackedFiles(cwd) {
  // Include candidate files before they are staged/committed. Without this,
  // a local release-candidate can false-green while newly added scanner/tests
  // are invisible to the scan.
  return gitFiles(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
}

function candidateFiles(cwd) {
  return Array.from(new Set([...trackedFiles(cwd), ...untrackedFiles(cwd)])).sort();
}

function forbiddenTrackedPaths(files) {
  return files.filter((file) => /(^|\/)\.claude\/|\.ihow-bak-|(^|\/)\.openclaw\/workspace\//.test(file.replace(/\\/g, '/')));
}

export function scanRepository(cwd = process.cwd()) {
  const rules = [...SECRET_RULES, ...privateDenylistRules()];
  const files = candidateFiles(cwd);
  const hits = [];
  for (const file of files) {
    if (file === 'package-lock.json') continue;
    hits.push(...scanText(file, file, rules));
    const abs = path.join(cwd, file);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile() || stat.size > 5_000_000) continue;
    const buf = fs.readFileSync(abs);
    hits.push(...scanText(file, buf.toString('utf8'), rules));
  }
  return { hits, forbidden: forbiddenTrackedPaths(files) };
}

function main() {
  if (process.env.CI === 'true' && privateDenylistRules().length === 0) {
    console.error(`Secret scan failed: ${PRIVATE_DENYLIST_ENV} is required in CI.`);
    process.exitCode = 1;
    return;
  }
  const { hits, forbidden } = scanRepository(process.cwd());
  if (hits.length) {
    console.error('Secret scan failed (values redacted):');
    for (const hit of hits) console.error(`${hit.file}:${hit.line}: ${hit.rule}`);
  }
  if (forbidden.length) {
    console.error('Forbidden tracked paths (machine-local backup / .claude):');
    for (const file of forbidden) console.error(file);
  }
  if (hits.length || forbidden.length) process.exitCode = 1;
  else console.log('secret scan clean');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
