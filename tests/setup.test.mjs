// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// `setup` — the zero-config front door. One command detects runtimes → wires MCP + (Claude Code) skill
// + auto-capture hook → verifies with doctor → prints a crisp success state. Locks: a full claude-code
// setup writes skill+hook+MCP and reports success; re-running is idempotent (no new backups, "already"
// lines); --dry-run writes NOTHING; --json is clean & parseable (reused install prints suppressed); and
// "no runtime detected" is an honest exit-0 no-op. Runs src/cli.ts directly with HOME + a hermetic PATH
// (/usr/bin:/bin → git/which present, no `claude`/`codex` CLI) so claude-code falls back to direct-json
// (no real CLI spawn) and detection is deterministic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const HERMETIC_PATH = '/usr/bin:/bin';

function run(args, home, extraEnv = {}) {
  return execFileSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, PATH: HERMETIC_PATH, ...extraEnv },
  });
}
async function dirs(t) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-home-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-root-'));
  const proj = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-proj-'));
  t.after(async () => {
    for (const d of [home, root, proj]) await fs.rm(d, { recursive: true, force: true });
  });
  return { home, root, proj };
}
async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}
async function countBackups(...roots) {
  let n = 0;
  async function walk(dir) {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.name.includes('.ihow-bak-')) n += 1;
    }
  }
  for (const r of roots) await walk(r);
  return n;
}

test('setup --runtime claude-code: writes MCP + skill + hook and reports success', async (t) => {
  const { home, root, proj } = await dirs(t);
  const out = run(['setup', '--runtime', 'claude-code', '--root', root, '--space', 't', '--cwd', proj], home);
  assert.match(out, /Setup result — COMPLETE/, 'success result card');
  assert.match(out, /verifying \(doctor\)/, 'ran the doctor verification step');
  assert.match(out, /restart: required once for claude-code/, 'states the restart requirement');
  assert.match(out, /next: ihow-memory proof/, 'gives one next action');
  assert.ok(await exists(path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md')), 'memory skill installed');
  const settings = await fs.readFile(path.join(proj, '.claude', 'settings.local.json'), 'utf8');
  assert.match(settings, /hook-stop/, 'Stop hook wired into the project settings');
  assert.match(settings, /hook-session-start/, 'SessionStart hook wired into the project settings');
  assert.match(await fs.readFile(path.join(home, '.claude.json'), 'utf8'), /ihow-memory/, 'MCP entry written (direct-json fallback)');
});

test('setup is idempotent — re-running changes nothing and adds no new backups', async (t) => {
  const { home, root, proj } = await dirs(t);
  const args = ['setup', '--runtime', 'claude-code', '--root', root, '--space', 't', '--cwd', proj];
  run(args, home); // first run
  const backupsAfterFirstRun = await countBackups(home, proj);
  const out2 = run(args, home); // second run
  // The skill + hook are content-idempotent: a re-run re-affirms them in place, no duplicate install.
  assert.match(out2, /memory skill already current/, 'skill re-affirmed, not reinstalled');
  assert.match(out2, /hooks already present/, 'hooks re-affirmed, not duplicated');
  assert.match(out2, /Setup result — COMPLETE/, 'still succeeds on re-run');
  assert.match(out2, /restart: not required/, 'does not request a restart when no setup configuration changed');
  assert.equal(await countBackups(home, proj), backupsAfterFirstRun, 're-run adds no config backups');

  const json2 = JSON.parse(run([...args, '--json'], home));
  assert.equal(json2.applied, false, 'idempotent re-run truthfully reports that nothing was applied');
  assert.equal(json2.restart.required, false, 'idempotent re-run truthfully reports no restart');
  assert.deepEqual(json2.restart.runtimes, [], 'no runtime is listed for restart on an idempotent re-run');
});

test('setup --dry-run writes NOTHING', async (t) => {
  const { home, root, proj } = await dirs(t);
  const out = run(['setup', '--runtime', 'claude-code', '--dry-run', '--root', root, '--space', 't', '--cwd', proj], home);
  assert.match(out, /dry-run — nothing will be written/, 'announces dry-run');
  assert.match(out, /would install memory skill/, 'shows the plan');
  assert.equal(await exists(path.join(home, '.claude', 'skills', 'ihow-memory', 'SKILL.md')), false, 'no skill written');
  assert.equal(await exists(path.join(proj, '.claude', 'settings.local.json')), false, 'no hook settings written');
  assert.equal(await exists(path.join(home, '.claude.json')), false, 'no MCP config written');
  // zero-write means the workspace tree is NOT materialized either (no ensureWorkspace under dry-run)
  assert.equal(await exists(path.join(root, 't')), false, 'no workspace dir tree materialized under --root');
});

test('setup --json emits clean parseable output (install prints suppressed)', async (t) => {
  const { home, root, proj } = await dirs(t);
  const out = run(['setup', '--runtime', 'claude-code', '--json', '--root', root, '--space', 't', '--cwd', proj], home);
  const j = JSON.parse(out); // must parse — no leaked human lines from reused install functions
  for (const k of ['ok', 'detected', 'connected', 'unverified', 'skipped', 'skill', 'hook', 'doctor', 'nextSteps']) {
    assert.ok(k in j, `json has key ${k}`);
  }
  // verify-after-connect: the configured server round-trips, so claude-code is reachable (connected) and
  // nothing is left unverified — never "connected" on write-success alone (a broken server would land in
  // `unverified`). Each connected entry now carries a `verified` provenance flag: true only when the
  // runtime's OWN CLI cross-confirms registration, false for a reachable-but-unconfirmed direct write
  // (go/no-go #7). We don't pin the flag's value here — it depends on whether a claude CLI is present in
  // the env — but we lock that the provenance flag exists and the runtime is the requested one.
  assert.equal(j.connected.length, 1, 'one runtime connected');
  assert.equal(j.connected[0].runtime, 'claude-code', 'connected the requested runtime');
  assert.equal(typeof j.connected[0].verified, 'boolean', 'connected entries carry a verified provenance flag');
  assert.deepEqual(j.unverified, [], 'no runtime left unreachable');
  assert.equal(j.skill, 'installed');
  assert.equal(j.hook, 'installed');
  assert.equal(j.doctor.ok, true, 'doctor verified clean');
  assert.equal(j.applied, true, 'first run reports that setup configuration changed');
  assert.equal(j.restart.required, true, 'first run requests restart after applying setup configuration');
  assert.deepEqual(j.restart.runtimes, ['claude-code']);
});

test('setup --json is honest when the hook fails to wire (unparseable settings → ok:false, hook:failed)', async (t) => {
  const { home, root, proj } = await dirs(t);
  // a pre-existing broken settings file makes maybeInstallStopHook refuse to write (no hook wired)
  await fs.mkdir(path.join(proj, '.claude'), { recursive: true });
  await fs.writeFile(path.join(proj, '.claude', 'settings.local.json'), '{ not valid json', 'utf8');
  let out;
  try {
    out = run(['setup', '--runtime', 'claude-code', '--json', '--root', root, '--space', 't', '--cwd', proj], home);
  } catch (e) {
    out = e.stdout; // non-zero exit (hook failure) — read stdout from the error
  }
  const j = JSON.parse(out);
  assert.equal(j.hook, 'failed', 'reports the hook was NOT wired, not a flag-based "installed"');
  assert.equal(j.ok, false, 'ok is false — never contradicts the failure');
});

test('setup --runtime workbuddy wires cross-thread resume into BOOTSTRAP.md (idempotent, backed up)', async (t) => {
  const { home, root } = await dirs(t);
  const wbDir = path.join(home, '.workbuddy');
  await fs.mkdir(wbDir, { recursive: true });
  await fs.writeFile(path.join(wbDir, 'BOOTSTRAP.md'), '# BOOTSTRAP.md\n\n## The Conversation\nbe yourself.\n', 'utf8');
  const args = ['setup', '--runtime', 'workbuddy', '--root', root, '--space', 't'];

  run(args, home);
  const bootstrap = await fs.readFile(path.join(wbDir, 'BOOTSTRAP.md'), 'utf8');
  assert.match(bootstrap, /resume across threads/, 'resume instruction injected');
  assert.match(bootstrap, /memory\.continue/, 'tells the agent to call memory.continue');
  assert.match(bootstrap, /be yourself\./, 'existing BOOTSTRAP content is preserved');
  const wbBaks = async () => (await fs.readdir(wbDir)).filter((f) => f.startsWith('BOOTSTRAP.md.ihow-bak-')).length;
  assert.equal(await wbBaks(), 1, 'BOOTSTRAP backed up once before augmenting');

  run(args, home); // re-run
  const after = await fs.readFile(path.join(wbDir, 'BOOTSTRAP.md'), 'utf8');
  assert.equal((after.match(/resume across threads/g) || []).length, 1, 'idempotent — not duplicated on re-run');
  assert.equal(await wbBaks(), 1, 're-run does not re-back-up or re-augment BOOTSTRAP');
});

test('setup with no runtime detected is an honest exit-0 no-op', async (t) => {
  const { home, root } = await dirs(t); // empty HOME, hermetic PATH -> nothing detected
  const out = run(['setup', '--root', root, '--space', 't'], home);
  assert.match(out, /No AI runtime detected/, 'honest about finding nothing');
  assert.match(out, /copy-paste: ihow-memory setup/, 'tells the user how to retry after installing a runtime');
  assert.match(out, /next: ihow-memory proof/, 'still offers an immediate product proof');
});
