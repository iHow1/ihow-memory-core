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
  { id: 'internal-marker', re: new RegExp(['yun', 'tian'].join(''), 'g') },
  { id: 'machine-user-path', re: /\/Users\/[a-z]+\//g },
];

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

export function scanText(file, text) {
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

  for (const rule of SECRET_RULES) {
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
  return files.filter((file) => /(^|\/)\.claude\/|\.ihow-bak-/.test(file.replace(/\\/g, '/')));
}

export function scanRepository(cwd = process.cwd()) {
  const files = candidateFiles(cwd);
  const hits = [];
  for (const file of files) {
    if (file === 'package-lock.json') continue;
    const abs = path.join(cwd, file);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile() || stat.size > 5_000_000) continue;
    const buf = fs.readFileSync(abs);
    if (buf.includes(0)) continue;
    hits.push(...scanText(file, buf.toString('utf8')));
  }
  return { hits, forbidden: forbiddenTrackedPaths(files) };
}

function main() {
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
