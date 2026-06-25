// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Upgrade propagation (#9 / go/no-go #5): connect freezes a dist copy into <space>/.runtime; `npm update`
// does NOT refresh it, so a connected runtime keeps running the old MCP server. `doctor` must flag the skew
// (frozen .runtime version vs installed package version) as a REQUIRED error — a soft warning let it pass
// with doctor still green — and `ihow-memory upgrade` must re-stamp + re-handshake (probe the new bundle)
// to clear it. The local, no-network half of the update-notification mechanism.
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
// doctor now EXITS NON-ZERO on a required failure (a skewed bundle), so capture stdout regardless of code.
const run = (args, root) => {
  try { return execFileSync(process.execPath, [CLI, ...args, '--root', root, '--space', 's'], { encoding: 'utf8' }); }
  catch (e) { return e.stdout ?? ''; }
};
const doctor = (root) => JSON.parse(run(['doctor', '--json'], root));
const skewCheck = (root) => doctor(root).checks.find((c) => c.name === 'runtime-bundle');

test('doctor flags runtime-bundle skew as a REQUIRED error; upgrade re-stamps + re-handshakes to clear it', async (t) => {
  const root = await mkdtempReal('ihow-upgrade-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  // materialize the frozen .runtime bundle (stamped with the current version) + re-handshake the new server
  const out = run(['upgrade'], root);
  assert.match(out, /runtime bundle (refreshed|upgraded)/);
  assert.match(out, /round-trips/, 'upgrade re-handshakes the freshly-stamped server (go/no-go #5)');
  assert.equal(skewCheck(root).ok, true, 'fresh bundle is not skewed');
  assert.equal(doctor(root).ok, true, 'doctor passes with a fresh bundle');

  // simulate npm-update-without-re-stamp: pin the .runtime to an old version
  const rtPkg = path.join(root, 's', '.runtime', 'package.json');
  const pkg = JSON.parse(await fs.readFile(rtPkg, 'utf8'));
  await fs.writeFile(rtPkg, JSON.stringify({ ...pkg, version: '0.0.0-stale' }), 'utf8');

  const skewed = skewCheck(root);
  assert.ok(skewed && skewed.ok === false && skewed.severity === 'error' && skewed.required === true, 'a stale connected server is a REQUIRED error, not a soft warning');
  assert.equal(doctor(root).ok, false, 'a skewed bundle FAILS doctor (go/no-go #5: no silent old-server)');
  assert.match(skewed.hint || '', /ihow-memory upgrade/);

  // upgrade re-stamps and clears the skew
  const up = run(['upgrade'], root);
  assert.match(up, /v0\.0\.0-stale/, 'reports the old version it replaced');
  assert.equal(skewCheck(root).ok, true, 'skew cleared after upgrade');
  assert.equal(doctor(root).ok, true, 'doctor passes again after upgrade');
});

test('doctor --runtime verifies MCP reachability as a REQUIRED check (go/no-go #2)', async (t) => {
  const root = await mkdtempReal('ihow-doctor-rt-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  run(['upgrade'], root); // materialize the .runtime bundle so the configured server can be round-tripped

  const doc = doctor(root); // no --runtime → runtime check is an info no-op, not required
  const none = doc.checks.find((c) => c.name === 'runtime');
  assert.equal(none.required, false, 'with no runtime named, the runtime check is not required');

  const withRt = JSON.parse(run(['doctor', '--runtime', 'cursor', '--json'], root));
  const rt = withRt.checks.find((c) => c.name === 'runtime');
  assert.equal(rt.required, true, 'naming a runtime makes its MCP-reachability check REQUIRED (no more Boolean(flag))');
  assert.equal(rt.ok, true, 'a materialized bundle round-trips → reachable');
  assert.match(rt.detail, /reachable/i, 'the detail reports actual reachability, not just "selected"');
});
