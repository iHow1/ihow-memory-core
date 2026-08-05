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

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');

async function mkdtempReal(p) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
}
// doctor now EXITS NON-ZERO on a required failure (a skewed bundle), so capture stdout regardless of code.
const run = (args, root) => {
  const home = path.join(root, 'home');
  try {
    return execFileSync(process.execPath, [CLI, ...args, '--root', root, '--space', 's'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        HERMES_HOME: path.join(home, '.hermes'),
        CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
        IHOW_HANDOFF_METRICS: '0',
      },
    });
  }
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
  const previousDir = path.join(root, 's', '.runtime.previous');
  const previousPkg = JSON.parse(await fs.readFile(path.join(previousDir, 'package.json'), 'utf8'));
  assert.equal(previousPkg.version, '0.0.0-stale', 'the exact replaced bundle is retained as the one-generation rollback source');
  assert.ok(Object.keys(previousPkg.integrity?.files || {}).length > 0, 'previous bundle retains its content integrity manifest');
  for (const [relative, expectedSha] of Object.entries(previousPkg.integrity.files)) {
    const bytes = await fs.readFile(path.join(previousDir, ...relative.split('/')));
    const actualSha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
    assert.equal(actualSha, expectedSha, `previous bundle integrity holds for ${relative}`);
  }
  const trustedPreviousPackage = await fs.readFile(path.join(previousDir, 'package.json'), 'utf8');
  await fs.writeFile(path.join(root, 's', '.runtime', 'core.js'), '/* tampered live bundle */', 'utf8');
  run(['upgrade'], root);
  assert.equal(
    await fs.readFile(path.join(previousDir, 'package.json'), 'utf8'),
    trustedPreviousPackage,
    'a corrupted live bundle cannot replace the last self-verifying previous generation',
  );
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

test('rollback-runtime previews by default and atomically swaps only a self-verifying previous bundle with --apply', async (t) => {
  const root = await mkdtempReal('ihow-runtime-rollback-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  run(['upgrade'], root);
  const runtime = path.join(root, 's', '.runtime');
  const previous = path.join(root, 's', '.runtime.previous');
  const currentPkg = JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8'));
  await fs.writeFile(path.join(runtime, 'package.json'), JSON.stringify({ ...currentPkg, version: '0.0.0-previous' }), 'utf8');
  run(['upgrade'], root);

  const beforeCurrent = await fs.readFile(path.join(runtime, 'package.json'), 'utf8');
  const beforePrevious = await fs.readFile(path.join(previous, 'package.json'), 'utf8');
  const preview = JSON.parse(run(['rollback-runtime', '--json'], root));
  assert.deepEqual({ ok: preview.ok, applied: preview.applied, from: preview.from, to: preview.to }, { ok: true, applied: false, from: '0.1.0-alpha.31.2', to: '0.0.0-previous' });
  assert.equal(await fs.readFile(path.join(runtime, 'package.json'), 'utf8'), beforeCurrent, 'preview leaves current bytes unchanged');
  assert.equal(await fs.readFile(path.join(previous, 'package.json'), 'utf8'), beforePrevious, 'preview leaves previous bytes unchanged');

  const applied = JSON.parse(run(['rollback-runtime', '--apply', '--json'], root));
  assert.deepEqual({ ok: applied.ok, applied: applied.applied, from: applied.from, to: applied.to }, { ok: true, applied: true, from: '0.1.0-alpha.31.2', to: '0.0.0-previous' });
  assert.equal(JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8')).version, '0.0.0-previous');
  assert.equal(JSON.parse(await fs.readFile(path.join(previous, 'package.json'), 'utf8')).version, '0.1.0-alpha.31.2', 'the displaced current generation becomes the next recovery source');

  await fs.writeFile(path.join(previous, 'core.js'), 'tampered previous', 'utf8');
  const refused = JSON.parse(run(['rollback-runtime', '--apply', '--json'], root));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'previous_runtime_bundle_integrity_failed');
  assert.equal(JSON.parse(await fs.readFile(path.join(runtime, 'package.json'), 'utf8')).version, '0.0.0-previous', 'refused rollback leaves current generation active');
});

test('upgrade automatically restores the exact old generation when the fresh server probe fails', async (t) => {
  const sandbox = await mkdtempReal('ihow-upgrade-probe-fail-');
  const packageCopy = path.join(sandbox, 'package');
  const root = path.join(sandbox, 'root');
  await fs.cp(REPO, packageCopy, { recursive: true, filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}node_modules${path.sep}`) });
  t.after(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });
  const copiedCli = path.join(packageCopy, 'src', 'cli.ts');
  const args = ['upgrade', '--json', '--root', root, '--space', 's'];
  const env = { ...process.env, HOME: path.join(sandbox, 'home'), HERMES_HOME: path.join(sandbox, 'home', '.hermes'), IHOW_HANDOFF_METRICS: '0' };
  const first = JSON.parse(execFileSync(process.execPath, [copiedCli, ...args], { encoding: 'utf8', env }));
  assert.equal(first.ok, true);
  const runtime = path.join(root, 's', '.runtime');
  const goodManifest = await fs.readFile(path.join(runtime, 'package.json'), 'utf8');
  const goodServer = await fs.readFile(path.join(runtime, 'mcp', 'server.js'));

  await fs.writeFile(path.join(packageCopy, 'dist', 'mcp', 'server.js'), 'process.exit(23);\n', 'utf8');
  let failed;
  try { execFileSync(process.execPath, [copiedCli, ...args], { encoding: 'utf8', env }); }
  catch (error) { failed = JSON.parse(error.stdout); }
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(await fs.readFile(path.join(runtime, 'package.json'), 'utf8'), goodManifest, 'old manifest restored after failed probe');
  assert.deepEqual(await fs.readFile(path.join(runtime, 'mcp', 'server.js')), goodServer, 'old server bytes restored after failed probe');
});

test('first bootstrap upgrade migrates a legacy hook-bound CLI once without losing activation readiness', async (t) => {
  const sandbox = await mkdtempReal('ihow-upgrade-legacy-cli-');
  const packageCopy = path.join(sandbox, 'package');
  const root = path.join(sandbox, 'root');
  const home = path.join(sandbox, 'home');
  await fs.cp(REPO, packageCopy, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}node_modules${path.sep}`),
  });
  t.after(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

  const copiedCli = path.join(packageCopy, 'src', 'cli.ts');
  const distCli = path.join(packageCopy, 'dist', 'cli.js');
  const distRuntimeCli = path.join(packageCopy, 'dist', 'cli-runtime.js');
  const stableBootstrap = await fs.readFile(distCli);
  const legacyCli = await fs.readFile(distRuntimeCli);
  await fs.writeFile(distCli, legacyCli);
  await fs.rm(distRuntimeCli);

  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    HERMES_HOME: path.join(home, '.hermes'),
    IHOW_HANDOFF_METRICS: '0',
  };
  const runCopy = (args) => execFileSync(process.execPath, [copiedCli, ...args, '--root', root, '--space', 's'], {
    encoding: 'utf8',
    env,
  });

  runCopy(['install-hook', '--runtime', 'codex']);
  const hooksPath = path.join(home, '.codex', 'hooks.json');
  const legacyHooks = await fs.readFile(hooksPath, 'utf8');
  assert.deepEqual(await fs.readFile(path.join(root, 's', '.runtime', 'cli.js')), legacyCli);

  await fs.writeFile(distCli, stableBootstrap);
  await fs.writeFile(distRuntimeCli, legacyCli);
  const migrated = JSON.parse(runCopy(['upgrade', '--json']));
  assert.equal(migrated.ok, true);
  assert.equal(migrated.nativeHooks.codex.status, 'activation-refreshed', 'the one-time bootstrap transition refreshes activation evidence');
  assert.equal(await fs.readFile(hooksPath, 'utf8'), legacyHooks, 'bootstrap migration does not rewrite already-valid hook config');
  assert.deepEqual(await fs.readFile(path.join(root, 's', '.runtime', 'cli.js')), stableBootstrap);

  const afterDoctor = JSON.parse(runCopy(['doctor', '--json']));
  const afterCodex = afterDoctor.automationMatrix.find((row) => row.runtime === 'Codex');
  assert.equal(afterCodex.activationStatus, 'READY — WAITING FOR FIRST ACTIVITY');
});

test('upgrade keeps existing Codex hooks stable when only the release CLI implementation changes', async (t) => {
  const sandbox = await mkdtempReal('ihow-upgrade-codex-hooks-');
  const packageCopy = path.join(sandbox, 'package');
  const root = path.join(sandbox, 'root');
  const home = path.join(sandbox, 'home');
  await fs.cp(REPO, packageCopy, {
    recursive: true,
    filter: (source) => !source.includes(`${path.sep}.git${path.sep}`) && !source.includes(`${path.sep}node_modules${path.sep}`),
  });
  t.after(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

  const copiedCli = path.join(packageCopy, 'src', 'cli.ts');
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    HERMES_HOME: path.join(home, '.hermes'),
    IHOW_HANDOFF_METRICS: '0',
  };
  const runCopy = (args) => execFileSync(process.execPath, [copiedCli, ...args, '--root', root, '--space', 's'], {
    encoding: 'utf8',
    env,
  });

  runCopy(['install-hook', '--runtime', 'codex']);
  const hooksPath = path.join(home, '.codex', 'hooks.json');
  const beforeHooks = await fs.readFile(hooksPath, 'utf8');
  const runtimeCli = path.join(root, 's', '.runtime', 'cli.js');
  const beforeBootstrap = await fs.readFile(runtimeCli, 'utf8');
  const beforeDoctor = JSON.parse(runCopy(['doctor', '--json']));
  const beforeCodex = beforeDoctor.automationMatrix.find((row) => row.runtime === 'Codex');
  assert.equal(beforeCodex.activationStatus, 'READY — WAITING FOR FIRST ACTIVITY');

  await fs.appendFile(path.join(packageCopy, 'dist', 'cli-runtime.js'), '\n// upgraded release CLI identity\n', 'utf8');
  const upgraded = JSON.parse(runCopy(['upgrade', '--json']));
  assert.equal(upgraded.ok, true);
  assert.equal(upgraded.nativeHooks.codex.status, 'unchanged');
  assert.equal(await fs.readFile(hooksPath, 'utf8'), beforeHooks, 'ordinary upgrades do not rewrite managed hook config');
  assert.equal(await fs.readFile(runtimeCli, 'utf8'), beforeBootstrap, 'the hook-facing CLI bootstrap stays byte-stable');
  assert.match(
    await fs.readFile(path.join(root, 's', '.runtime', 'cli-runtime.js'), 'utf8'),
    /upgraded release CLI identity/,
    'the implementation bytes still activate inside the atomic runtime slot',
  );

  const afterDoctor = JSON.parse(runCopy(['doctor', '--json']));
  const afterCodex = afterDoctor.automationMatrix.find((row) => row.runtime === 'Codex');
  assert.equal(afterCodex.activationStatus, 'READY — WAITING FOR FIRST ACTIVITY');
  assert.notEqual(afterCodex.activationReasonCode, 'ACTIVATION_WIRING_GENERATION_UNCONFIRMED');
});

test('rescue is an out-of-band upgrade alias that restores a damaged active runtime', async (t) => {
  const root = await mkdtempReal('ihow-runtime-rescue-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const first = JSON.parse(run(['upgrade', '--json'], root));
  assert.equal(first.ok, true);

  const server = path.join(root, 's', '.runtime', 'mcp', 'server.js');
  await fs.writeFile(server, 'process.exit(91);\n', 'utf8');
  const rescued = JSON.parse(run(['rescue', '--json'], root));
  assert.equal(rescued.ok, true);
  assert.equal(rescued.mode, 'rescue');
  assert.equal(rescued.serverReachable, true);
  assert.equal(skewCheck(root).ok, true);
});

test('upgrade --runtime opencode repairs a stale registered server path without touching other entries', async (t) => {
  const sandbox = await mkdtempReal('ihow-upgrade-opencode-');
  const root = path.join(sandbox, 'root');
  const home = path.join(sandbox, 'home');
  const configPath = path.join(home, '.config', 'opencode', 'opencode.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify({
    theme: 'system',
    mcp: {
      playwright: { type: 'remote', url: 'http://127.0.0.1:7331' },
      'ihow-memory': {
        type: 'local',
        command: [process.execPath, path.join(sandbox, '--help', 'help-probe', '.runtime', 'mcp', 'server.js')],
        enabled: true,
      },
    },
  }, null, 2)}\n`, 'utf8');
  t.after(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

  const env = {
    ...process.env,
    HOME: home,
    HERMES_HOME: path.join(home, '.hermes'),
    IHOW_HANDOFF_METRICS: '0',
  };
  const result = JSON.parse(execFileSync(process.execPath, [
    CLI, 'upgrade', '--runtime', 'opencode', '--json', '--root', root, '--space', 's',
  ], { encoding: 'utf8', env }));
  assert.equal(result.ok, true);
  assert.equal(result.runtimeRepair.runtime, 'opencode');
  assert.equal(result.runtimeRepair.status, 'repaired');

  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(config.theme, 'system');
  assert.deepEqual(config.mcp.playwright, { type: 'remote', url: 'http://127.0.0.1:7331' });
  const command = config.mcp['ihow-memory'].command;
  assert.equal(command[0], process.execPath);
  assert.equal(command[1], path.join(root, 's', '.runtime', 'mcp', 'server.js'));
  assert.ok(command.includes('--memory-root'));
  assert.ok(command.includes('--state-root'));
  assert.ok(!command.some((part) => part.includes('help-probe')));

  const backups = (await fs.readdir(path.dirname(configPath))).filter((name) => name.startsWith('opencode.json.ihow-bak-'));
  assert.equal(backups.length, 1, 'stale config is backed up before repair');
});
