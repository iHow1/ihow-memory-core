// SPDX-License-Identifier: Apache-2.0
// Regression guard for the Windows packageDir path bug.
// On Windows, `new URL('..', import.meta.url).pathname` yields '/C:/...'
// (leading slash, %20-encoded), which path.resolve mangles, so the package
// can't find its own dist → setup fails with runtime_bundle_missing and
// --version reports 'unknown'. The fix is fileURLToPath, which handles drive
// letters + decoding. Verified end-to-end on a real Windows 11 ARM64 VM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Every place that resolves the package root from import.meta.url — none may use .pathname.
const PKG_ROOT_RESOLVERS = ['src/cli.ts', 'scripts/build-dist.mjs', 'scripts/activation-proof.mjs'];

test('no package-root resolver uses URL(import.meta.url).pathname (breaks on Windows)', () => {
  for (const rel of PKG_ROOT_RESOLVERS) {
    const src = readFileSync(path.join(ROOT, rel), 'utf8');
    assert.ok(
      !/import\.meta\.url\s*\)\s*\.pathname/.test(src),
      `${rel} must not resolve paths via new URL(import.meta.url).pathname — breaks on Windows; use fileURLToPath`,
    );
  }
  const cliSrc = readFileSync(path.join(ROOT, 'src', 'cli.ts'), 'utf8');
  assert.match(cliSrc, /fileURLToPath\(new URL\('\.\.', import\.meta\.url\)\)/, 'packageDir must resolve via fileURLToPath');
});

test('fileURLToPath resolves a Windows file URL to a drive path (not /C:/…)', () => {
  const winUrl = new URL('..', 'file:///C:/Program%20Files/ihow%20memory/dist/cli.js');
  const broken = winUrl.pathname; // '/C:/Program%20Files/ihow%20memory/'
  const fixed = fileURLToPath(winUrl, { windows: true });
  assert.match(broken, /^\/[A-Za-z]:/, 'sanity: .pathname keeps the broken leading-slash drive form');
  assert.ok(broken.includes('%20'), 'sanity: .pathname leaves %20 undecoded');
  assert.match(fixed, /^[A-Za-z]:\\/, 'fileURLToPath yields a real Windows drive path');
  assert.ok(fixed.includes(' ') && !fixed.includes('%20'), 'fileURLToPath decodes %20 to a space');
});
