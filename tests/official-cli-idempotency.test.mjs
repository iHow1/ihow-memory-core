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
const controlPath = process.env.IHOW_OFFICIAL_CLI_CONTROL;
const load = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; } };
const loadControl = () => { try { return JSON.parse(fs.readFileSync(controlPath, 'utf8')); } catch { return {}; } };
const saveControl = (value) => { if (!controlPath) return; fs.mkdirSync(path.dirname(controlPath), { recursive: true }); fs.writeFileSync(controlPath, JSON.stringify(value)); };
const consumeAddFailure = () => { const control = loadControl(); if (!(control.addFailures > 0)) return false; control.addFailures -= 1; saveControl(control); return true; };
const consumeApprovalCorruption = () => { const control = loadControl(); if (!(control.approvalCorruptions > 0)) return false; control.approvalCorruptions -= 1; saveControl(control); return true; };
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
  if (state?.getFailure) {
    const failure = typeof state.getFailure === 'object'
      ? state.getFailure
      : { stderr: String(state.getFailure) + '\\n' };
    if (failure.stdout) process.stdout.write(String(failure.stdout));
    if (failure.stderr) process.stderr.write(String(failure.stderr));
    process.exit(Number.isInteger(failure.status) ? failure.status : 1);
  }
  if (!state || state.getMissing) {
    process.stderr.write('No MCP server found with name: "ihow-memory". No MCP servers are configured.\\n');
    process.exit(1);
  }
  const scope = state.scope || 'user';
  const defaultScopeLabel = scope === 'project'
    ? 'Project config (shared via .mcp.json)'
    : scope === 'local'
      ? 'Local config (private to this project)'
      : scope === 'unknown'
        ? 'Inherited configuration (scope unavailable)'
        : 'User config (available in all your projects)';
  const scopeLabel = state.scopeLabel || defaultScopeLabel;
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
  if (requestedScope === 'user' && state?.removeFailure) {
    const failure = typeof state.removeFailure === 'object'
      ? state.removeFailure
      : { stderr: String(state.removeFailure) + '\\n' };
    if (failure.stdout) process.stdout.write(String(failure.stdout));
    if (failure.stderr) process.stderr.write(String(failure.stderr));
    process.exit(Number.isInteger(failure.status) ? failure.status : 1);
  }
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
  if (consumeAddFailure()) { log('add-failed', normalized); process.stderr.write('simulated add failure\\n'); process.exit(2); }
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
  if (state.getRaw !== undefined) { process.stdout.write(String(state.getRaw)); process.exit(0); }
  console.log(JSON.stringify({
    name: 'ihow-memory', enabled: true, disabled_reason: null,
    transport: {
      type: 'stdio', command: state.command, args: state.args, env: state.env || {},
      env_vars: state.env_vars || [], cwd: state.cwd ?? null,
    },
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
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  try {
    const lines = fs.readFileSync(configPath, 'utf8').split('\\n');
    const start = lines.findIndex((line) => line.trim() === '[mcp_servers.ihow-memory]');
    if (start >= 0) {
      let end = start + 1;
      while (end < lines.length) {
        const header = lines[end].trim();
        if (header.startsWith('[') && !header.startsWith('[mcp_servers.ihow-memory.')) break;
        end += 1;
      }
      lines.splice(start, end - start);
      fs.writeFileSync(configPath, lines.join('\\n'));
    }
  } catch {}
  process.exit(0);
}
if (argv[1] === 'add') {
  const separator = argv.indexOf('--');
  const env = {};
  for (let index = 3; index < separator; index += 1) {
    if (argv[index] === '--env' && argv[index + 1]) {
      const split = argv[index + 1].indexOf('=');
      env[argv[index + 1].slice(0, split)] = argv[index + 1].slice(split + 1);
      index += 1;
    }
  }
  const normalized = { command: argv[separator + 1], args: argv.slice(separator + 2), env };
  if (consumeAddFailure()) { log('add-failed', normalized); process.stderr.write('simulated add failure\\n'); process.exit(2); }
  log('add', normalized);
  save(normalized);
  const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  let config = '';
  try { config = fs.readFileSync(configPath, 'utf8'); } catch {}
  const header = '[mcp_servers.ihow-memory]';
  if (!config.includes(header)) {
    config += (config && !config.endsWith('\\n') ? '\\n\\n' : config ? '\\n' : '')
      + header + '\\ncommand = ' + JSON.stringify(normalized.command) + '\\n';
  } else {
    const start = config.indexOf(header) + header.length;
    const next = config.indexOf('\\n[', start);
    const end = next < 0 ? config.length : next;
    const body = config.slice(start, end);
    const commandLine = 'command = ' + JSON.stringify(normalized.command);
    const updated = /^command\s*=.*$/m.test(body)
      ? body.replace(/^command\s*=.*$/m, commandLine)
      : '\\n' + commandLine + body;
    config = config.slice(0, start) + updated + config.slice(end);
  }
  fs.writeFileSync(configPath, config);
  if (consumeApprovalCorruption()) fs.appendFileSync(configPath, '\\n[broken-approval-edit');
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

const CODEX_READ_ONLY_TOOLS = [
  'memory.status',
  'memory.continue',
  'memory.search',
  'memory.read',
  'memory.context_probe',
];

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function runJson({ runtime, home, bin, statePath, logPath, root, cwd, command = 'setup', extraEnv = {}, extraArgs = [], allowFailure = false }) {
  const args = [command, '--runtime', runtime, '--json', '--root', root, '--space', 'official-cli-idempotency'];
  if (cwd) args.push('--cwd', cwd);
  if (runtime === 'claude-code') args.push('--no-install-skill', '--no-install-hook');
  if (runtime === 'codex') args.push('--no-install-hook');
  args.push(...extraArgs);
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
    if (allowFailure && error.stdout) return JSON.parse(error.stdout);
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

test('Claude canonical config missing refuses destructive replacement of ambiguous joined argv', async (t) => {
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

  const result = runJson({ ...fixture, allowFailure: true });
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.match(result.skipped[0].error, /visible_user_spec_unavailable_refusing_remove/);
  assert.deepEqual(await mutations(fixture.logPath), [], 'no reversible snapshot means no remove/add mutation');
  assert.deepEqual(JSON.parse(await fs.readFile(fixture.statePath, 'utf8')), ambiguous, 'existing visible registration remains untouched');
});

test('Claude project/local-only entry installs user scope without an invalid user removal', async (t) => {
  const fixture = await makeClaudeFixture(t, 'project-scope');
  const desired = await primeClaudeFixture(fixture);
  await fs.writeFile(fixture.statePath, JSON.stringify({ ...desired, scope: 'project' }), 'utf8');
  await fs.writeFile(path.join(fixture.home, '.claude.json'), JSON.stringify({ mcpServers: {} }), 'utf8');

  const result = runJson(fixture);
  assert.equal(result.applied, true, 'project-only visibility installs the missing user entry');
  assert.notEqual(result.unchanged, true, 'project scope never proves user-scope unchanged');
  assert.equal(result.restart.required, true);
  assert.deepEqual(result.restart.runtimes, ['claude-code']);
  assert.deepEqual((await mutations(fixture.logPath)).map((entry) => entry.op), ['add'], 'project-only state skips invalid user removal and adds user scope');
  assert.equal(JSON.parse(await fs.readFile(fixture.statePath, 'utf8')).scope, 'user', 'stub models a successfully installed user entry');
});

test('Claude local-only entry installs user scope without an invalid user removal', async (t) => {
  const fixture = await makeClaudeFixture(t, 'local-scope');
  const desired = await primeClaudeFixture(fixture);
  await fs.writeFile(fixture.statePath, JSON.stringify({ ...desired, scope: 'local' }), 'utf8');
  await fs.writeFile(path.join(fixture.home, '.claude.json'), JSON.stringify({ mcpServers: {} }), 'utf8');

  const result = runJson(fixture);
  assert.equal(result.applied, true, 'local-only visibility installs the missing user entry');
  assert.notEqual(result.unchanged, true, 'local scope never proves user-scope unchanged');
  assert.equal(result.restart.required, true);
  assert.deepEqual((await mutations(fixture.logPath)).map((entry) => entry.op), ['add'], 'local-only state skips invalid user removal and adds user scope');
  assert.equal(JSON.parse(await fs.readFile(fixture.statePath, 'utf8')).scope, 'user');
});

test('Claude unknown effective scope without canonical snapshot refuses destructive replacement', async (t) => {
  const fixture = await makeClaudeFixture(t, 'unknown-scope');
  const desired = await primeClaudeFixture(fixture);
  await fs.writeFile(fixture.statePath, JSON.stringify({ ...desired, scope: 'unknown' }), 'utf8');
  await fs.rm(path.join(fixture.home, '.claude.json'), { force: true });

  const result = runJson({ ...fixture, allowFailure: true });
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.match(result.skipped[0].error, /visible_user_spec_unavailable_refusing_remove/);
  assert.deepEqual(await mutations(fixture.logPath), [], 'unknown scope without exact snapshot is mutation-free');
  assert.equal(JSON.parse(await fs.readFile(fixture.statePath, 'utf8')).scope, 'unknown');
});

for (const [name, scopeLabel, removeFailure] of [
  ['unrelated remove failure', 'Inherited configuration (scope unavailable)', 'permission denied'],
  ['near-match absence text', 'Inherited configuration (scope unavailable)', 'No user MCP server found'],
  ['no-space absence suffix', 'Inherited configuration (scope unavailable)', 'No user-scoped MCP server found with name:ihow-memory'],
  ['mixed-stream absence and error', 'Inherited configuration (scope unavailable)', {
    stdout: 'permission denied\n',
    stderr: 'No user-scoped MCP server found with name: ihow-memory\n',
  }],
  ['extra line after absence', 'Inherited configuration (scope unavailable)', {
    stderr: 'No user-scoped MCP server found with name: ihow-memory\nunrelated error\n',
  }],
  ['extra blank line after absence', 'Inherited configuration (scope unavailable)', {
    stderr: 'No user-scoped MCP server found with name: ihow-memory\n\n',
  }],
  ['embedded absence text', 'Inherited configuration (scope unavailable)', {
    stderr: 'error: No user-scoped MCP server found with name: ihow-memory\n',
  }],
  ['wrong-status absence', 'Inherited configuration (scope unavailable)', {
    stderr: 'No user-scoped MCP server found with name: ihow-memory\n',
    status: 2,
  }],
  ['unfamiliar scope heading', 'Projected configuration (unrecognized)', 'permission denied'],
]) {
  test(`Claude ${name} fails closed before add`, async (t) => {
    const fixture = await makeClaudeFixture(t, name.replace(/\s+/g, '-'));
    const desired = await primeClaudeFixture(fixture);
    await fs.writeFile(
      fixture.statePath,
      JSON.stringify({ ...desired, scope: 'unknown', scopeLabel, removeFailure }),
      'utf8',
    );
    await fs.rm(path.join(fixture.home, '.claude.json'), { force: true });

    const result = runJson({ ...fixture, allowFailure: true });
    assert.equal(result.ok, false, 'setup reports the connector failure');
    assert.equal(result.applied, false, 'missing reversible snapshot never marks setup applied');
    assert.notEqual(result.unchanged, true, 'uncertain state never claims unchanged');
    assert.deepEqual(await mutations(fixture.logPath), [], 'missing canonical snapshot prevents both remove and add');
    assert.match(result.skipped[0].error, /visible_user_spec_unavailable_refusing_remove/i);
  });
}

test('Claude exact canonical user spec remains a setup no-op when get would fail arbitrarily', async (t) => {
  const fixture = await makeClaudeFixture(t, 'canonical-exact-get-failure');
  const desired = await primeClaudeFixture(fixture);
  await fs.writeFile(
    fixture.statePath,
    JSON.stringify({ ...desired, scope: 'user', getFailure: { stderr: 'permission denied\n' } }),
    'utf8',
  );

  const connectResult = runJson({ ...fixture, command: 'connect' });
  assert.equal(connectResult.unchanged, true, 'canonical equality is authoritative despite get failure');
  assert.equal(connectResult.changed, false);
  assert.equal(connectResult.replaced, false);

  const result = runJson(fixture);
  assert.equal(result.applied, false, 'exact canonical equality remains a zero-mutation setup rerun');
  assert.equal(result.restart.required, false, 'an unchanged canonical entry never requests restart');
  assert.deepEqual(result.restart.runtimes, []);
  assert.deepEqual(await mutations(fixture.logPath), [], 'arbitrary get failure cannot trigger remove/add');
});

test('Claude changed canonical user spec is replaced even when get would fail', async (t) => {
  const fixture = await makeClaudeFixture(t, 'canonical-changed-get-failure');
  const desired = await primeClaudeFixture(fixture);
  const canonicalPath = path.join(fixture.home, '.claude.json');
  const canonical = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
  canonical.mcpServers['ihow-memory'].args = ['/stale/server.js'];
  await fs.writeFile(canonicalPath, JSON.stringify(canonical), 'utf8');
  await fs.writeFile(
    fixture.statePath,
    JSON.stringify({ ...desired, scope: 'user', getFailure: { stderr: 'permission denied\n' } }),
    'utf8',
  );

  const result = runJson(fixture);
  assert.equal(result.applied, true);
  assert.equal(result.restart.required, true);
  assert.deepEqual(result.restart.runtimes, ['claude-code']);
  assert.deepEqual((await mutations(fixture.logPath)).map((entry) => entry.op), ['remove', 'add']);
});

test('Claude canonical absence plus the exact real get-missing result permits add', async (t) => {
  const fixture = await makeClaudeFixture(t, 'canonical-absent-get-missing');
  await fs.writeFile(fixture.statePath, JSON.stringify({ getMissing: true }), 'utf8');
  await fs.rm(path.join(fixture.home, '.claude.json'), { force: true });

  const result = runJson(fixture);
  assert.equal(result.applied, true);
  assert.equal(result.restart.required, true);
  assert.deepEqual((await mutations(fixture.logPath)).map((entry) => entry.op), ['add']);
});

test('Claude canonical absence plus arbitrary get failure fails before add', async (t) => {
  const fixture = await makeClaudeFixture(t, 'canonical-absent-get-failure');
  await fs.writeFile(
    fixture.statePath,
    JSON.stringify({ getFailure: { stderr: 'permission denied\n' } }),
    'utf8',
  );
  await fs.rm(path.join(fixture.home, '.claude.json'), { force: true });

  const result = runJson({ ...fixture, allowFailure: true });
  assert.equal(result.ok, false);
  assert.equal(result.applied, false);
  assert.equal(result.restart.required, false);
  assert.deepEqual(await mutations(fixture.logPath), [], 'unrecognized get failure must prevent add');
  assert.match(result.skipped[0].error, /claude_mcp_get_failed/i);
});

test('Claude human parser uncertainty without canonical snapshot is mutation-free and fail-closed', async (t) => {
  const fixture = await makeClaudeFixture(t, 'human-output');
  await primeClaudeFixture(fixture);
  const canonicalPath = path.join(fixture.home, '.claude.json');
  await fs.rm(canonicalPath, { force: true });

  const setupResult = runJson({ ...fixture, allowFailure: true });
  assert.equal(setupResult.ok, false);
  assert.equal(setupResult.applied, false);
  assert.match(setupResult.skipped[0].error, /visible_user_spec_unavailable_refusing_remove/);
  assert.deepEqual(await mutations(fixture.logPath), [], 'setup remains mutation-free under parser uncertainty');
});

test('codex official CLI adds per-tool approve only for the iHow read-only tools', async (t) => {
  const home = await realTemp('ihow-codex-approvals-home-');
  const codexHome = path.join(home, 'isolated-codex');
  const bin = await realTemp('ihow-codex-approvals-bin-');
  const root = await realTemp('ihow-codex-approvals-root-');
  const cwd = await realTemp('ihow-codex-approvals-cwd-');
  const statePath = path.join(home, '.stub', 'codex-state.json');
  const logPath = path.join(home, '.stub', 'codex-mutations.jsonl');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await makeCodexStub(bin);
  t.after(async () => {
    for (const dir of [home, bin, root, cwd]) await fs.rm(dir, { recursive: true, force: true });
  });

  const result = runJson({
    runtime: 'codex', home, bin, statePath, logPath, root, cwd,
    extraEnv: { CODEX_HOME: codexHome },
  });
  assert.equal(result.applied, true);
  const config = await fs.readFile(path.join(codexHome, 'config.toml'), 'utf8');
  for (const tool of CODEX_READ_ONLY_TOOLS) {
    assert.match(
      config,
      new RegExp(`\\[mcp_servers\\.ihow-memory\\.tools\\."${escapeRegex(tool)}"\\]\\napproval_mode = "approve"`),
      `${tool} is non-interactively usable`,
    );
  }
  assert.doesNotMatch(config, /default_tools_approval_mode\s*=\s*"approve"/, 'never approves a whole server');
  for (const tool of [
    'memory.forget', 'memory.promote', 'memory.durable_promote', 'memory.write_candidate',
    'memory.remember', 'memory.journal', 'memory.organize',
  ]) {
    assert.doesNotMatch(config, new RegExp(`tools\\."${escapeRegex(tool)}"`), `${tool} remains gated`);
  }
});

test('codex read-only approvals are idempotent and preserve stricter user policy', async (t) => {
  const home = await realTemp('ihow-codex-policy-home-');
  const codexHome = path.join(home, 'isolated-codex');
  const bin = await realTemp('ihow-codex-policy-bin-');
  const root = await realTemp('ihow-codex-policy-root-');
  const cwd = await realTemp('ihow-codex-policy-cwd-');
  const statePath = path.join(home, '.stub', 'codex-state.json');
  const logPath = path.join(home, '.stub', 'codex-mutations.jsonl');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await makeCodexStub(bin);
  t.after(async () => {
    for (const dir of [home, bin, root, cwd]) await fs.rm(dir, { recursive: true, force: true });
  });
  const common = { runtime: 'codex', home, bin, statePath, logPath, root, cwd, extraEnv: { CODEX_HOME: codexHome } };
  runJson({ ...common, command: 'connect' });
  const configPath = path.join(codexHome, 'config.toml');
  let seeded = await fs.readFile(configPath, 'utf8');
  seeded = seeded.replace(
    '[mcp_servers.ihow-memory.tools."memory.status"]\napproval_mode = "approve"',
    '[mcp_servers.ihow-memory.tools."memory.status"]\napproval_mode = "prompt"\nvendor_field = "preserve-me"',
  );
  seeded = seeded.replace(
    /\n\[mcp_servers\.ihow-memory\.tools\."memory\.read"\]\napproval_mode = "approve"\n?/,
    '\n',
  );
  await fs.writeFile(configPath, seeded);
  await fs.writeFile(logPath, '', 'utf8');

  const repaired = runJson({ ...common, command: 'connect' });
  const once = await fs.readFile(configPath, 'utf8');
  assert.equal(repaired.changed, true);
  assert.equal(repaired.approvalsChanged, true);
  assert.match(once, /approval_mode = "prompt"/);
  assert.match(once, /vendor_field = "preserve-me"/);
  assert.equal((once.match(/\[mcp_servers\.ihow-memory\.tools\."memory\.status"\]/g) || []).length, 1);
  assert.match(once, /\[mcp_servers\.ihow-memory\.tools\."memory\.read"\]\napproval_mode = "approve"/);
  assert.deepEqual(await mutations(logPath), [], 'approval repair does not replace the MCP registration');

  const rerun = runJson({ ...common, command: 'connect' });
  const twice = await fs.readFile(configPath, 'utf8');
  assert.equal(twice, once, 'second setup is byte-identical');
  assert.equal(rerun.changed, false, 'idempotent rerun reports no applied change');
  assert.equal(rerun.unchanged, true);
});

test('codex dry-run and malformed TOML are mutation-free', async (t) => {
  const home = await realTemp('ihow-codex-safe-edit-home-');
  const codexHome = path.join(home, 'isolated-codex');
  const bin = await realTemp('ihow-codex-safe-edit-bin-');
  const root = await realTemp('ihow-codex-safe-edit-root-');
  const cwd = await realTemp('ihow-codex-safe-edit-cwd-');
  const statePath = path.join(home, '.stub', 'codex-state.json');
  const logPath = path.join(home, '.stub', 'codex-mutations.jsonl');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await makeCodexStub(bin);
  t.after(async () => {
    for (const dir of [home, bin, root, cwd]) await fs.rm(dir, { recursive: true, force: true });
  });
  const common = { runtime: 'codex', home, bin, statePath, logPath, root, cwd, extraEnv: { CODEX_HOME: codexHome } };
  runJson({ ...common, command: 'connect' });
  const configPath = path.join(codexHome, 'config.toml');
  let withoutSearch = await fs.readFile(configPath, 'utf8');
  withoutSearch = withoutSearch.replace(
    /\n\[mcp_servers\.ihow-memory\.tools\."memory\.search"\]\napproval_mode = "approve"\n?/,
    '\n',
  );
  await fs.writeFile(configPath, withoutSearch);
  await fs.writeFile(logPath, '', 'utf8');
  const beforeDryRunFiles = (await fs.readdir(codexHome)).sort();
  const dry = runJson({
    ...common, command: 'connect', extraArgs: ['--dry-run'],
  });
  assert.equal(dry.changed, true);
  assert.equal(dry.approvalsChanged, true);
  assert.equal(await fs.readFile(configPath, 'utf8'), withoutSearch, 'dry-run preserves bytes');
  assert.deepEqual((await fs.readdir(codexHome)).sort(), beforeDryRunFiles, 'dry-run creates no backup/temp files');
  assert.deepEqual(await mutations(logPath), []);

  await fs.writeFile(configPath, '{ invalid toml');
  const before = await fs.readFile(configPath, 'utf8');
  const failed = runJson({
    ...common, allowFailure: true,
  });
  assert.equal(failed.ok, false);
  assert.equal(await fs.readFile(configPath, 'utf8'), before);
  assert.deepEqual(await mutations(logPath), [], 'malformed TOML fails before registration mutation');
});

test('codex rolls back a new registration when approval editing fails after add', async (t) => {
  const home = await realTemp('ihow-codex-approval-rollback-home-');
  const codexHome = path.join(home, 'isolated-codex');
  const bin = await realTemp('ihow-codex-approval-rollback-bin-');
  const root = await realTemp('ihow-codex-approval-rollback-root-');
  const cwd = await realTemp('ihow-codex-approval-rollback-cwd-');
  const statePath = path.join(home, '.stub', 'codex-state.json');
  const logPath = path.join(home, '.stub', 'codex-mutations.jsonl');
  const controlPath = path.join(home, '.stub', 'codex-control.json');
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.mkdir(codexHome, { recursive: true });
  await makeCodexStub(bin);
  t.after(async () => {
    for (const dir of [home, bin, root, cwd]) await fs.rm(dir, { recursive: true, force: true });
  });
  const configPath = path.join(codexHome, 'config.toml');
  const original = 'model = "keep-me"\n';
  await fs.writeFile(configPath, original);
  await fs.writeFile(controlPath, JSON.stringify({ approvalCorruptions: 1 }));

  const result = runJson({
    runtime: 'codex', home, bin, statePath, logPath, root, cwd, allowFailure: true,
    extraEnv: { CODEX_HOME: codexHome, IHOW_OFFICIAL_CLI_CONTROL: controlPath },
  });
  assert.equal(result.ok, false);
  assert.equal(result.applied, false, 'successful rollback leaves no applied config change');
  assert.equal(result.restart.required, false);
  assert.equal(await fs.readFile(configPath, 'utf8'), original, 'original config bytes restored');
  assert.equal(await fs.access(statePath).then(() => true, () => false), false, 'new registration removed');
  assert.deepEqual((await mutations(logPath)).map((entry) => entry.op), ['add', 'remove']);
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

  test(`${runtime} official CLI restores the previous registration when replacement add fails`, async (t) => {
    const home = await realTemp(`ihow-${runtime}-rollback-home-`);
    const bin = await realTemp(`ihow-${runtime}-rollback-bin-`);
    const rootA = await realTemp(`ihow-${runtime}-rollback-root-a-`);
    const rootB = await realTemp(`ihow-${runtime}-rollback-root-b-`);
    const cwd = await realTemp(`ihow-${runtime}-rollback-cwd-`);
    const statePath = path.join(home, '.stub', `${runtime}-state.json`);
    const logPath = path.join(home, '.stub', `${runtime}-mutations.jsonl`);
    const controlPath = path.join(home, '.stub', `${runtime}-control.json`);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    if (runtime === 'claude-code') await makeClaudeStub(bin);
    else await makeCodexStub(bin);
    t.after(async () => {
      for (const dir of [home, bin, rootA, rootB, cwd]) await fs.rm(dir, { recursive: true, force: true });
    });

    runJson({ runtime, home, bin, statePath, logPath, root: rootA, cwd });
    const previous = JSON.parse(await fs.readFile(statePath, 'utf8'));
    await fs.writeFile(logPath, '', 'utf8');
    await fs.writeFile(controlPath, JSON.stringify({ addFailures: 1 }), 'utf8');

    const result = runJson({
      runtime, home, bin, statePath, logPath, root: rootB, cwd, allowFailure: true,
      extraEnv: { IHOW_OFFICIAL_CLI_CONTROL: controlPath },
    });
    assert.equal(result.ok, false, 'setup reports the replacement failure');
    assert.equal(result.applied, false, 'successful rollback leaves no applied runtime mutation');
    assert.equal(result.restart.required, false, 'restored registration does not request a false restart');
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), previous, 'previous exact spec restored');
    assert.deepEqual((await mutations(logPath)).map((entry) => entry.op), ['remove', 'add-failed', 'add']);
  });

  test(`${runtime} bundle refresh remains applied when failed replacement rolls back to the same runtime bundle`, async (t) => {
    const home = await realTemp(`ihow-${runtime}-bundle-rollback-home-`);
    const bin = await realTemp(`ihow-${runtime}-bundle-rollback-bin-`);
    const root = await realTemp(`ihow-${runtime}-bundle-rollback-root-`);
    const cwd = await realTemp(`ihow-${runtime}-bundle-rollback-cwd-`);
    const statePath = path.join(home, '.stub', `${runtime}-state.json`);
    const logPath = path.join(home, '.stub', `${runtime}-mutations.jsonl`);
    const controlPath = path.join(home, '.stub', `${runtime}-control.json`);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    if (runtime === 'claude-code') await makeClaudeStub(bin);
    else await makeCodexStub(bin);
    t.after(async () => {
      for (const dir of [home, bin, root, cwd]) await fs.rm(dir, { recursive: true, force: true });
    });

    runJson({ runtime, home, bin, statePath, logPath, root, cwd });
    const previous = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const drifted = { ...previous, env: { ...(previous.env || {}), VENDOR_DRIFT: '1' } };
    await fs.writeFile(statePath, JSON.stringify(drifted), 'utf8');
    if (runtime === 'claude-code') {
      const canonicalPath = path.join(home, '.claude.json');
      const canonical = JSON.parse(await fs.readFile(canonicalPath, 'utf8'));
      canonical.mcpServers['ihow-memory'].env = drifted.env;
      await fs.writeFile(canonicalPath, JSON.stringify(canonical), 'utf8');
    }
    const core = path.join(root, 'official-cli-idempotency', '.runtime', 'core.js');
    await fs.writeFile(core, '/* corrupt current bundle */', 'utf8');
    await fs.writeFile(logPath, '', 'utf8');
    await fs.writeFile(controlPath, JSON.stringify({ addFailures: 1 }), 'utf8');

    const result = runJson({
      runtime, home, bin, statePath, logPath, root, cwd, allowFailure: true,
      extraEnv: { IHOW_OFFICIAL_CLI_CONTROL: controlPath },
    });
    assert.equal(result.ok, false);
    assert.equal(result.applied, true, 'repaired bundle remains an applied change after registration rollback');
    assert.equal(result.restart.required, true);
    assert.deepEqual(result.restart.runtimes, [runtime]);
    assert.deepEqual(JSON.parse(await fs.readFile(statePath, 'utf8')), drifted, 'drifted registration restored exactly');
    assert.doesNotMatch(await fs.readFile(core, 'utf8'), /corrupt current bundle/, 'bundle corruption repaired');
    assert.deepEqual((await mutations(logPath)).map((entry) => entry.op), ['remove', 'add-failed', 'add']);
  });

  test(`${runtime} official CLI reports an applied mutation when replacement and rollback both fail`, async (t) => {
    const home = await realTemp(`ihow-${runtime}-rollback-fail-home-`);
    const bin = await realTemp(`ihow-${runtime}-rollback-fail-bin-`);
    const rootA = await realTemp(`ihow-${runtime}-rollback-fail-root-a-`);
    const rootB = await realTemp(`ihow-${runtime}-rollback-fail-root-b-`);
    const cwd = await realTemp(`ihow-${runtime}-rollback-fail-cwd-`);
    const statePath = path.join(home, '.stub', `${runtime}-state.json`);
    const logPath = path.join(home, '.stub', `${runtime}-mutations.jsonl`);
    const controlPath = path.join(home, '.stub', `${runtime}-control.json`);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    if (runtime === 'claude-code') await makeClaudeStub(bin);
    else await makeCodexStub(bin);
    t.after(async () => {
      for (const dir of [home, bin, rootA, rootB, cwd]) await fs.rm(dir, { recursive: true, force: true });
    });

    runJson({ runtime, home, bin, statePath, logPath, root: rootA, cwd });
    await fs.writeFile(logPath, '', 'utf8');
    await fs.writeFile(controlPath, JSON.stringify({ addFailures: 2 }), 'utf8');
    const result = runJson({
      runtime, home, bin, statePath, logPath, root: rootB, cwd, allowFailure: true,
      extraEnv: { IHOW_OFFICIAL_CLI_CONTROL: controlPath },
    });
    assert.equal(result.ok, false);
    assert.equal(result.applied, true, 'lost registration is reported as a real applied mutation');
    assert.equal(result.restart.required, true);
    assert.deepEqual(result.restart.runtimes, [runtime]);
    assert.equal(await fs.access(statePath).then(() => true, () => false), false, 'failed rollback leaves registration absent in the stub');
    assert.deepEqual((await mutations(logPath)).map((entry) => entry.op), ['remove', 'add-failed', 'add-failed']);
  });
}

for (const [name, mutation, expected] of [
  ['unparseable transport', { getRaw: '{not-json' }, /existing_spec_unparseable_refusing_remove/],
  ['non-restorable cwd', { cwd: '/vendor/custom-cwd' }, /nonrestorable_cwd_or_env_vars_refusing_remove/],
  ['non-restorable env_vars', { env_vars: ['VENDOR_TOKEN'] }, /nonrestorable_cwd_or_env_vars_refusing_remove/],
]) {
  test(`codex fails closed without remove when existing ${name} cannot be exactly restored`, async (t) => {
    const home = await realTemp(`ihow-codex-nonrestorable-home-`);
    const bin = await realTemp(`ihow-codex-nonrestorable-bin-`);
    const rootA = await realTemp(`ihow-codex-nonrestorable-root-a-`);
    const rootB = await realTemp(`ihow-codex-nonrestorable-root-b-`);
    const cwd = await realTemp(`ihow-codex-nonrestorable-cwd-`);
    const statePath = path.join(home, '.stub', 'codex-state.json');
    const logPath = path.join(home, '.stub', 'codex-mutations.jsonl');
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await makeCodexStub(bin);
    t.after(async () => {
      for (const dir of [home, bin, rootA, rootB, cwd]) await fs.rm(dir, { recursive: true, force: true });
    });

    runJson({ runtime: 'codex', home, bin, statePath, logPath, root: rootA, cwd });
    const previous = JSON.parse(await fs.readFile(statePath, 'utf8'));
    await fs.writeFile(statePath, JSON.stringify({ ...previous, ...mutation }), 'utf8');
    await fs.writeFile(logPath, '', 'utf8');
    const result = runJson({ runtime: 'codex', home, bin, statePath, logPath, root: rootA, cwd, allowFailure: true });
    assert.equal(result.ok, false);
    assert.equal(result.applied, false);
    assert.match(result.skipped[0].error, expected);
    assert.deepEqual(await mutations(logPath), [], 'non-restorable registration is never removed');
  });
}
