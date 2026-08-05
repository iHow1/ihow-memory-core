// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// P1 sidecar packaging. The optional embedding-provider sidecar must SHIP in the npm tarball — examples/
// is NOT in package.json "files", dist/ IS, so build-dist copies it into dist/providers/. And it must
// stay OUT of the default module graph (RED LINE: the default engine is zero-dependency lexical FTS5,
// capabilities.semantic = false). This locks both: the file is packed + resolvable, and no default-graph
// module statically imports it (it is only ever SPAWNED as a subprocess on explicit opt-in).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { providerScriptPath, BUNDLED_PROVIDERS } from '../dist/provider-path.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('providerScriptPath resolves the bundled sidecar to a real packaged file', () => {
  const p = providerScriptPath();
  assert.ok(
    p.endsWith(path.join('dist', 'providers', 'ollama-embedding-provider.mjs')),
    `resolves under dist/providers/: ${p}`,
  );
  assert.ok(fs.existsSync(p), `bundled sidecar exists after build: ${p}`);
});

test('the sidecar ships in the npm tarball (examples/ not in files[]; dist/providers is)', () => {
  // --ignore-scripts: do NOT run prepack (rebuild) — that would race other test files reading dist.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  const packed = new Set((JSON.parse(out)[0].files || []).map((f) => f.path.replace(/\\/g, '/')));
  for (const name of BUNDLED_PROVIDERS) {
    assert.ok(packed.has(`dist/providers/${name}`), `tarball includes dist/providers/${name}`);
  }
});

test('RED LINE: no default-graph dist module statically imports the sidecar (semantic stays opt-in)', () => {
  // An `import`/`from`/dynamic-import whose specifier names the sidecar would mean it leaked into the
  // default graph. The resolver in provider-path.js only NAMES the file (path.join on a variable) and
  // never imports it, so a specifier-position match is the precise signal. We scan everything outside
  // dist/providers/ itself.
  const specifierRe = new RegExp(
    `(?:from|import)\\s*\\(?\\s*['"][^'"]*(${BUNDLED_PROVIDERS.map((n) => n.replace(/[.]/g, '\\.')).join('|')})['"]`,
  );
  const offenders = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'providers') walk(abs); continue; }
      if (!e.name.endsWith('.js')) continue;
      if (specifierRe.test(fs.readFileSync(abs, 'utf8'))) offenders.push(path.relative(ROOT, abs));
    }
  };
  walk(path.join(ROOT, 'dist'));
  assert.deepEqual(offenders, [], `sidecar must not be imported by default-graph modules:\n  ${offenders.join('\n  ')}`);
});
