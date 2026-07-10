// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Official-CLI setup paths must compare the existing normalized MCP spec before mutating it.
// These stateful CLI shims model the public Claude Code and Codex get/add/remove/list contracts;
// they never inspect or write the developer machine's real runtime configuration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'src', 'cli.ts');

async function realTemp(prefix) {
  return fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function writeExecutable(file, body) {
  await fs.writeFile(file, `#!${process.execPath}\n${body}`, 'utf8');
  await fs.chmod(file, 0o755);
}

const SHARED_STUB = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const statePath = process.env.IHOW_OFFICIAL_CLI_STATE;
const logPath = process.env.IHOW_OFFICIAL_CLI_LOG;
const load = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; } };
const save = (value) => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (value === null) { try { fs.unlinkSync(statePath); } catch {} return; }
  fs.writeFileSync(statePath, JSON.stringify(value));
};
const log = (op, spec = null) => fs.appendFileSync(logPath, JSON.stringify({ op, spec }) + '\n');
`;

async function makeClaudeStub(bin) {
  await writeExecutable(path.join(bin, 'claude'), `${SHARED_STUB}
const state = load();
if (argv[0] !== 'mcp') process.exit(0);
if (argv[1] === 'get') {
  if (!state) process.exit(1);
  const scope = state.scope || 'user';
  const scopeLabel = scope === 'project'
    ? 'Project config (shared via .mcp.json)'
    : scope === 'local'
      ? 'Local config (private to this project)'
      : scope === 'unknown'
        ? 'Inherited configuration (scope unavailable)'
        : 'User config (available in all your projects)';
  console.log('ihow-memory:');
  console.log('  Scope: ' + scopeLabel);
  console.log('  Status: ✓ Connected');
  console.log('  Type: stdio');
  console.log('  Command: ' + state.command);
  console.log('  Args: ' + state.args.join(' '));
  if (Object.keys(state.env || {}).length) {
    console.log('  Environment:');
    for (const [key, value] of Object.entries(state.env)) console.log('    ' + key + '=' + value);
  }
  process.exit(0);
}
if (argv[1] === 'list') {
  if (state) console.log('ihow-memory: connected');
  process.exit(0);
}
if (argv[1] === 'remove') {
  const scopeIndex = argv.indexOf('--scope');
  const requestedScope = scopeIndex >= 0 ? argv[scopeIndex + 1] : null;
  if (requestedScope === 'user' && state?.scope && state.scope !== 'user') {
    process.stderr.write('No user-scoped MCP server found with name: ihow-memory\\n');
    process.exit(1);
  }
  log('remove', state);
  save(null);
  const configPath = path.join(process.env.HOME, '.claude.json');
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    delete config.mcpServers?.['ihow-memory'];
    fs.writeFileSync(configPath, JSON.stringify(config));
  } catch {}
  process.exit(0);
}
if (argv[1] === 'add-json') {
  const spec = JSON.parse(argv.at(-1));
  const normalized = { command: spec.command, args: spec.args || [], env: spec.env || {} };
  log('add', normalized);
  save({ ...normalized, scope: 'user' });
  const configPath = path.join(process.env.HOME, '.claude.json');
  let config = {};
  try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  config.mcpServers ||= {};
  config.mcpServers['ihow-memory'] = { type: 'stdio', ...normalized };
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config));
  process.exit(0);
}
process.exit(0);
`);
}

async function makeCodexStub(bin) {
  await writeExecutable(path.join(bin, 'codex'), `${SHARED_STUB}
const state = load();
if (argv[0] !== 'mcp') process.exit(0);
if (argv[1] === 'get') {
  if (!state) process.exit(1);
  console.log(JSON.stringify({
    name: 'ihow-memory', enabled: true, disabled_reason: null,
    transport: { type: 'stdio', command: state.command, args: state.args, env: state.env || {}, env_vars: [], cwd: null },
  }));
  process.exit(0);
}
if (argv[1] === 'list') {
  if (state) console.log('ihow-memory');
  process.exit(0);
}
if (argv[1] === 'remove') {
  log('remove', state);
  save(null);
  process.exit(0);
}
if (argv[1] === 'add') {
  const separator = argv.indexOf('--');
  const normalized = { command: argv[separator + 1], args: argv.slice(separator + 2), env: {} };
  log('add', normalized);
  save(normalized);
  process.exit(0);
}
process.exit(0);
`);
}

async function makeHermesStub(bin) {
  await writeExecutable(path.join(bin, 'hermes'), String.raw`
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const configPath = path.join(process.env.HERMES_HOME, 'config.yaml');
const statePath = process.env.IHOW_OFFICIAL_CLI_STATE;
const logPath = process.env.IHOW_OFFICIAL_CLI_LOG;
const load = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; } };
const save = (spec) => {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  if (!spec) {
    try { fs.unlinkSync(statePath); } catch {}
    fs.writeFileSync(configPath, 'mcp_servers: {}\n');
    return;
  }
  fs.writeFileSync(statePath, JSON.stringify(spec));
  const args = spec.args.map((arg) => '    - ' + JSON.stringify(arg)).join('\n');
  const env = Object.entries(spec.env).map(([key, value]) => '      ' + key + ': ' + JSON.stringify(value)).join('\n');
  fs.writeFileSync(configPath, 'mcp_servers:\n  ihow-memory:\n    command: ' + JSON.stringify(spec.command) + '\n    args:\n' + args + '\n    env:\n' + env + '\n');
};
const log = (op, spec) => fs.appendFileSync(logPath, JSON.stringify({ op, spec }) + '\n');
if (argv[0] === 'gateway') process.exit(0);
if (argv[0] !== 'mcp') process.exit(0);
const state = load();
if (argv[1] === 'list') {
  if (state) console.log('ihow-memory  stdio  all  enabled');
  process.exit(0);
}
if (argv[1] === 'test') {
  if (state) console.log('✓ connected; tools discovered');
  else console.log('not found in config');
  process.exit(0);
}
if (argv[1] === 'remove') {
  log('remove', state);
  save(null);
  process.exit(0);
}
if (argv[1] === 'add') {
  const commandIndex = argv.indexOf('--command');
  const envIndex = argv.indexOf('--env');
  const argsIndex = argv.indexOf('--args');
  const env = {};
  for (const assignment of argv.slice(envIndex + 1, argsIndex)) {
    const split = assignment.indexOf('=');
    env[assignment.slice(0, split)] = assignment.slice(split + 1);
  }
  const spec = { command: argv[commandIndex + 1], args: argv.slice(argsIndex + 1), env };
  log('add', spec);
  save(spec);
  process.exit(0);
}
process.exit(0);
`);
}

async function mutations(logPath) {
  try {
    return (await fs.readFile(logPath, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function runJson({ runtime, home, bin, statePath, logPath, root, cwd, command = 'setup', extraEnv = {} }) {
  const args = [command, '--runtime', runtime, '--json', '--root', root, '--space', 'official-cli-idempotency'];
  if (cwd) args.push('--cwd', cwd);
  if (runtime === 'claude-code') args.push('--no-install-skill', '--no-install-hook');
  if (runtime === 'codex') args.push('--no-install-hook');
  let stdout;
  try {
    stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: 'utf8',
      cwd: cwd || REPO,
      env: {
        ...process.env,
        HOME: home,
        PATH: `${bin}:/usr/bin:/bin`,
        IHOW_HANDOFF_METRICS: '0',
        IHOW_OFFICIAL_CLI_STATE: statePath,
        IHOW_OFFICIAL_CLI_LOG: logPath,
        ...extraEnv,
      },
    });
  } catch (error) {
    throw new Error(`CLI failed: ${error.stderr || ''}\n${error.stdout || ''}`);
  }
  return JSON.parse(stdout);
}

async function makeClaudeFixture(t, prefix) {
  const home = await realTemp(`ihow-claude-${prefix}-home-`);
  const bin = await realTemp(`ihow-claude-${prefix}-bin-`);
  const root = await realTemp(`ihow-claude-${prefix}-root-`);
  const cwd = await realTemp(`ihow-claude-${prefix}-cwd-`);
  const statePath = path.join(home, '.stub', 'claude-state.json');
  const logPath = path.join(home, '.stub', 'claude-mutations.jsonl');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await makeClaudeStub(bin);
  t.after(async () => {
    for (const dir of [home, bin, root, cwd]) await fs.rm(dir, { recursive: true, force: true });
  });
  return { runtime: 'claude-code', home, bin, root, cwd, statePath, logPath };
}

async function primeClaudeFixture(fixture) {
  const first = runJson(fixture);
  assert.equal(first.applied, true);
  const desired = JSON.parse(await fs.readFile(fixture.statePath, 'utf8'));
  await fs.writeFile(fixture.logPath, '', 'utf8');
  return desired;
}

function assertConservativeClaudeReplacement(result, entries) {
  assert.equal(result.applied, true, 'parser uncertainty is applied conservatively');
  assert.notEqual(result.unchanged, true, 'setup never claims unchanged under parser uncertainty');
  assert.equal(result.restart.required, true, 'replacement requires restart');
  assert.deepEqual(result.restart.runtimes, ['claude-code']);
  assert.deepEqual(entries.map((entry) => entry.op), ['remove', 'add'], 'uncertainty triggers exactly one remove/add');
}

test('Claude canonical config missing cannot prove unchanged from ambiguous joined argv', async (t) => {
  const fixture = await makeClaudeFixture(t, 'ambiguous-argv');
  const desired = await primeClaudeFixture(fixture);
  assert.ok(desired.args.length >= 2);
  const ambiguous = {
    ...desired,
    args: [`${desired.args[0]} ${desired.args[1]}`, ...desired.args.slice(2)],
  };
  assert.equal(ambiguous.args.join(' '), desired.args.join(' '), 'human rendering is deliberately identical');
  assert.notDeepEqual(ambiguous.args, desired.args, 'actual argv boundaries differ');
  await fs.writeFile(fixture.statePath, JSON.stringify(ambiguous), 'utf8');
  await fs.rm(path.join(fixture.home, '.claude.json'), { force: true });

  const result = runJson(fixture);
  assertConservativeClaudeReplacement(result, await mutations(fixture.logPath));
});

test('Claude project/local-only entry installs user scope without an invalid user removal', async (t) => {
  const fixture = await makeClaudeFixture(t, 'project-scope');
  const desired = await primeClaudeFixture(fixture);
  await fs.writeFile(fixture.statePath, JSON.stringify({ ...desired, scope: 'project' }), 'utf8');
  await fs.writeFile(path.join(fixture.home, '.claude.json'), '{ not readable canonical JSON', 'utf8');

  const result = runJson(fixture);
  assert.equal(result.applied, true, 'project-only visibility installs the missing user entry');
  assert.notEqual(result.unchanged, true, 'project scope never proves user-scope unchanged');
  assert.equal(result.restart.required, true);
  assert.deepEqual(result.restart.runtimes, ['claude-code']);
  assert.deepEqual((await mutations(fixture.logPath)).map((entry) => entry.op), ['add'], 'project-only state skips invalid user removal and adds user scope');
  assert.equal(JSON.parse(await fs.readFile(fixture.statePath, 'utf8')).scope, 'user', 'stub models a successfully installed user entry');
});

test('Claude unknown effective scope tolerates a real user-scope-missing result and adds user scope', async (t) => {
  const fixture = await makeClaudeFixture(t, 'unknown-scope');
  const desired = await primeClaudeFixture(fixture);
  await fs.writeFile(fixture.statePath, JSON.stringify({ ...desired, scope: 'unknown' }), 'utf8');
  await fs.rm(path.join(fixture.home, '.claude.json'), { force: true });

  const result = runJson(fixture);
  assert.equal(result.applied, true, 'unknown effective scope still completes user installation');
  assert.notEqual(result.unchanged, true);
  assert.equal(result.restart.required, true);
  assert.deepEqual(result.restart.runtimes, ['claude-code']);
  assert.deepEqual((await mutations(fixture.logPath)).map((entry) => entry.op), ['add'], 'a user-scope-missing remove is tolerated and only user add mutates');
  assert.equal(JSON.parse(await fs.readFile(fixture.statePath, 'utf8')).scope, 'user');
});

test('Claude human parser uncertainty performs one replacement and never reports unchanged', async (t) => {
  const fixture = await makeClaudeFixture(t, 'human-output');
  await primeClaudeFixture(fixture);
  const canonicalPath = path.join(fixture.home, '.claude.json');
  await fs.rm(canonicalPath, { force: true });

  const connectResult = runJson({ ...fixture, command: 'connect' });
  assert.equal(connectResult.unchanged, false, 'explicit connect cannot claim human-output equality');
  assert.equal(connectResult.changed, true);
  assert.equal(connectResult.replaced, true);
  assert.deepEqual((await mutations(fixture.logPath)).map((entry) => entry.op), ['remove', 'add']);

  await fs.rm(canonicalPath, { force: true });
  await fs.writeFile(fixture.logPath, '', 'utf8');
  const setupResult = runJson(fixture);
  assertConservativeClaudeReplacement(setupResult, await mutations(fixture.logPath));
});

test('Hermes official CLI compares command/argv/env and replaces environment drift', async (t) => {
  const home = await realTemp('ihow-hermes-home-');
  const hermesHome = path.join(home, '.hermes-test');
  const bin = await realTemp('ihow-hermes-bin-');
  const root = await realTemp('ihow-hermes-root-');
  const statePath = path.join(home, '.unused-hermes-state.json');
  const logPath = path.join(home, '.stub', 'hermes-mutations.jsonl');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await makeHermesStub(bin);
  t.after(async () => {
    for (const dir of [home, bin, root]) await fs.rm(dir, { recursive: true, force: true });
  });

  const common = {
    runtime: 'hermes', home, bin, statePath, logPath, root, command: 'connect',
    extraEnv: { HERMES_HOME: hermesHome },
  };
  const first = runJson(common);
  assert.equal(first.changed, true);
  assert.deepEqual((await mutations(logPath)).map((entry) => entry.op), ['add']);

  const rerun = runJson(common);
  assert.equal(rerun.unchanged, true);
  assert.equal(rerun.changed, false);
  const afterFirst = await mutations(logPath);
  assert.deepEqual(afterFirst.map((entry) => entry.op), ['add'], 'matching Hermes spec performs zero mutations');

  const configPath = path.join(hermesHome, 'config.yaml');
  const config = await fs.readFile(configPath, 'utf8');
  await fs.writeFile(
    configPath,
    config.replace(/^\s+IHOW_MEMORY_STATE_ROOT:.*$/m, '      IHOW_MEMORY_STATE_ROOT: "/drifted/state/root"'),
    'utf8',
  );

  const replaced = runJson(common);
  assert.equal(replaced.changed, true);
  assert.equal(replaced.replaced, true);
  assert.deepEqual((await mutations(logPath)).map((entry) => entry.op), ['add', 'remove', 'add'], 'Hermes env drift triggers replacement');
});

for (const runtime of ['claude-code', 'codex']) {
  test(`${runtime} official CLI setup is mutation-free when unchanged and replaces a changed spec`, async (t) => {
    const home = await realTemp(`ihow-${runtime}-home-`);
    const bin = await realTemp(`ihow-${runtime}-bin-`);
    const rootA = await realTemp(`ihow-${runtime}-root-a-`);
    const rootB = await realTemp(`ihow-${runtime}-root-b-`);
    const cwd = await realTemp(`ihow-${runtime}-cwd-`);
    const statePath = path.join(home, '.stub', `${runtime}-state.json`);
    const logPath = path.join(home, '.stub', `${runtime}-mutations.jsonl`);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    if (runtime === 'claude-code') await makeClaudeStub(bin);
    else await makeCodexStub(bin);
    t.after(async () => {
      for (const dir of [home, bin, rootA, rootB, cwd]) await fs.rm(dir, { recursive: true, force: true });
    });

    const first = runJson({ runtime, home, bin, statePath, logPath, root: rootA, cwd });
    assert.equal(first.applied, true, 'first setup applies the missing MCP entry');
    assert.equal(first.restart.required, true, 'first setup requires one restart');
    assert.deepEqual(first.restart.runtimes, [runtime]);
    const afterFirst = await mutations(logPath);
    assert.deepEqual(afterFirst.map((entry) => entry.op), ['add'], 'first setup only adds');

    const rerun = runJson({ runtime, home, bin, statePath, logPath, root: rootA, cwd });
    assert.equal(rerun.applied, false, 'unchanged setup rerun is an explicit no-op');
    assert.equal(rerun.restart.required, false, 'unchanged setup rerun needs no restart');
    assert.deepEqual(rerun.restart.runtimes, []);
    assert.deepEqual(await mutations(logPath), afterFirst, 'unchanged rerun performs zero remove/add mutations');

    const connectResult = runJson({ runtime, home, bin, statePath, logPath, root: rootA, cwd, command: 'connect' });
    assert.equal(connectResult.unchanged, true, 'official connector returns explicit unchanged');
    assert.equal(connectResult.changed, false);
    assert.equal(connectResult.replaced, false);
    assert.deepEqual(await mutations(logPath), afterFirst, 'explicit unchanged connect also performs zero mutations');

    const changed = runJson({ runtime, home, bin, statePath, logPath, root: rootB, cwd });
    assert.equal(changed.applied, true, 'changed desired spec is applied');
    assert.equal(changed.restart.required, true, 'replacement requires restart');
    assert.deepEqual(changed.restart.runtimes, [runtime]);
    const afterChanged = await mutations(logPath);
    assert.deepEqual(afterChanged.map((entry) => entry.op), ['add', 'remove', 'add'], 'changed spec is replaced exactly once');
    assert.notDeepEqual(afterChanged[0].spec.args, afterChanged[2].spec.args, 'replacement carries the new desired argv');
  });
}
