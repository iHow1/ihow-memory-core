// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Release safety net. alpha.5/alpha.6 shipped a `files` whitelist that listed dist modules individually
// and missed dist/{transcript,handoff,anchors,envelope,handoff-metrics}.js — so a fresh `npm i` crashed
// with ERR_MODULE_NOT_FOUND the moment cli.js imported them. The unit suite passed (it runs the full local
// dist), and `npm pack --dry-run` looked fine, so nothing caught it until a real tarball install. This
// test reproduces the gap deterministically: pack the tarball and assert every relative import inside a
// packed module resolves to another packed file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('every relative import in a packed module is itself in the tarball (fresh install resolves)', () => {
  // --ignore-scripts: do NOT run prepack (which rebuilds dist) — that would race the other test files
  // reading dist concurrently. We pack the already-built dist and check the `files` whitelist vs imports.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  const report = JSON.parse(out);
  const packed = new Set((report[0].files || []).map((f) => f.path.replace(/\\/g, '/')));
  const jsFiles = [...packed].filter((p) => p.startsWith('dist/') && p.endsWith('.js'));
  assert.ok(jsFiles.length > 5, `tarball should contain the dist modules (got ${jsFiles.length})`);

  const missing = [];
  for (const rel of jsFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.endsWith('.js')) continue; // bare/dir specifiers aren't used in built output
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!packed.has(resolved)) missing.push(`${rel}  →  ${spec}  (resolved: ${resolved})`);
    }
  }
  assert.deepEqual(missing, [], `tarball is missing modules that packed code imports:\n  ${missing.join('\n  ')}`);
});
