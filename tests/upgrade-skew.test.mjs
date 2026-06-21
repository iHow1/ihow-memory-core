// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Upgrade propagation (#9): connect freezes a dist copy into <space>/.runtime; `npm update` does NOT
// refresh it, so a connected runtime keeps running the old MCP server. `doctor` must FLAG the skew
// (running .runtime version vs installed package version) and `ihow-memory upgrade` must clear it — the
// local, no-network half of the update-notification mechanism.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

async function mkdtempReal(p) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
}
const run = (args, root) => execFileSync(process.execPath, [CLI, ...args, '--root', root, '--space', 's'], { encoding: 'utf8' });
const skewCheck = (root) => JSON.parse(run(['doctor', '--json'], root)).checks.find((c) => c.name === 'runtime-bundle');

test('doctor flags runtime-bundle skew; upgrade clears it', async (t) => {
  const root = await mkdtempReal('ihow-upgrade-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  // materialize the frozen .runtime bundle (stamped with the current version)
  const out = run(['upgrade'], root);
  assert.match(out, /runtime bundle (refreshed|upgraded)/);
  assert.ok((skewCheck(root) || {}).ok === true, 'fresh bundle is not skewed');

  // simulate an upgrade-without-re-stamp: pin the .runtime to an old version
  const rtPkg = path.join(root, 's', '.runtime', 'package.json');
  const pkg = JSON.parse(await fs.readFile(rtPkg, 'utf8'));
  await fs.writeFile(rtPkg, JSON.stringify({ ...pkg, version: '0.0.0-stale' }), 'utf8');

  const skewed = skewCheck(root);
  assert.ok(skewed && skewed.ok === false && skewed.severity === 'warning', 'doctor flags the stale connected server');
  assert.match(skewed.hint || '', /ihow-memory upgrade/);

  // upgrade re-stamps and clears the skew
  const up = run(['upgrade'], root);
  assert.match(up, /v0\.0\.0-stale/, 'reports the old version it replaced');
  assert.ok((skewCheck(root) || {}).ok === true, 'skew cleared after upgrade');
});
