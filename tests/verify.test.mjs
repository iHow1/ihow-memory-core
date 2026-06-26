// SPDX-License-Identifier: Apache-2.0
// B5 (alpha.13): `ihow-memory verify` — a REPRODUCIBLE self-proof receipt. The differentiator is not
// "trust our green check" but "here is the exact command, re-run it yourself, same result." It composes
// already-verified pieces (doctor / verifyConnection / continue verdict) and asserts nothing new. Every
// line carries a `↻ reproduce`. Exits non-zero if anything fails to round-trip.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
async function mkdtempReal(p) { return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p))); }
// verify exits non-zero when something doesn't round-trip, so capture stdout regardless of exit code.
const run = (args, root) => {
  try { return execFileSync(process.execPath, [CLI, ...args, '--root', root, '--space', 's'], { encoding: 'utf8' }); }
  catch (e) { return e.stdout ?? ''; }
};

test('verify: reproducible receipt — local store + runtime reachability + resume verdict, each with a reproduce line', async (t) => {
  const root = await mkdtempReal('ihow-verify-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  run(['upgrade'], root); // materialize the .runtime bundle so the configured server round-trips
  const out = run(['verify', '--runtime', 'cursor'], root);
  assert.match(out, /verify receipt/);
  assert.match(out, /reproducible/i);
  assert.match(out, /LOCAL STORE\s+✓ ok/);
  assert.match(out, /RUNTIME MCP REACHABILITY/);
  assert.match(out, /Cursor: (• reachable|✓ verified)/, 'a no-CLI runtime with a live bundle is reachable');
  assert.match(out, /↻ reproduce:\s+ihow-memory doctor --runtime cursor/, 'runtime line is independently re-runnable');
  assert.match(out, /RESUME VERDICT/);
  assert.match(out, /↻ reproduce:\s+ihow-memory continue/, 'the three-color verdict is re-runnable');
  assert.match(out, /OVERALL\s+✓ trustworthy/);
});

test('verify --json: clean structured receipt with a reproduce map; ok reflects reachability', async (t) => {
  const root = await mkdtempReal('ihow-verify-json-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  run(['upgrade'], root);
  const j = JSON.parse(run(['verify', '--runtime', 'cursor', '--json'], root));
  for (const k of ['ok', 'local', 'runtimes', 'verdict', 'reproduce']) assert.ok(k in j, `json has key ${k}`);
  assert.equal(j.runtimes[0].runtime, 'cursor');
  assert.equal(typeof j.runtimes[0].reachable, 'boolean');
  assert.ok(j.reproduce.local && j.reproduce.runtime && j.reproduce.verdict, 'every section carries a reproduce command');
  assert.equal(j.ok, j.local.ok && j.runtimes.every((r) => r.reachable), 'overall ok = local ok AND every runtime reachable');
});

test('verify: honest when not set up — a missing runtime bundle points at setup, never a raw crash', async (t) => {
  const root = await mkdtempReal('ihow-verify-nobundle-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const out = run(['verify', '--runtime', 'cursor'], root); // no upgrade/connect -> no .runtime bundle
  assert.match(out, /bundle not installed[^]*ihow-memory setup/, 'clean "run setup" guidance');
  assert.doesNotMatch(out, /cjs\/loader|MODULE_NOT_FOUND|Cannot find module/, 'no raw module-loader crash leaks into the receipt');
  assert.match(out, /OVERALL\s+✗/, 'not-set-up verifies as a failure, honestly');
});
