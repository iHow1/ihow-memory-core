import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// fileURLToPath, not URL.pathname: on Windows .pathname yields '/C:/...' which path.resolve mangles.
const packageDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const cli = path.join(packageDir, 'bin', 'ihow-memory.mjs');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function run(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: options.cwd || isolatedCwd,
      env: { ...isolatedEnv, ...(options.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, combined: `${stdout}\n${stderr}` }));
  });
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-memory-activation-proof-'));
const isolatedHome = path.join(root, 'home');
const isolatedCwd = path.join(root, 'cwd');
await Promise.all([
  fs.mkdir(isolatedHome, { recursive: true }),
  fs.mkdir(isolatedCwd, { recursive: true }),
]);
const isolatedEnv = { ...process.env };
for (const name of [
  'CLAUDE_CODE_SESSION_ID',
  'IHOW_MEMORY_API_KEY',
  'IHOW_MEMORY_ROOT',
  'IHOW_MEMORY_STATE_ROOT',
  'IHOW_MEMORY_TEST_NODE_VERSION',
  'IHOW_MEMORY_VECTOR_MODEL',
  'IHOW_MEMORY_VECTOR_PROVIDER_COMMAND',
  'MEMORY_ROOT',
]) delete isolatedEnv[name];
Object.assign(isolatedEnv, {
  HOME: isolatedHome,
  USERPROFILE: isolatedHome,
  APPDATA: path.join(isolatedHome, 'AppData', 'Roaming'),
  XDG_CONFIG_HOME: path.join(isolatedHome, '.config'),
  CLAUDE_CONFIG_DIR: path.join(isolatedHome, '.claude'),
  CODEX_HOME: path.join(isolatedHome, '.codex'),
  HERMES_HOME: path.join(isolatedHome, '.hermes'),
  PI_CODING_AGENT_DIR: path.join(isolatedHome, '.omp', 'agent'),
  CLINE_DATA_DIR: path.join(isolatedHome, '.cline', 'data'),
  IHOW_HANDOFF_METRICS: '0',
});

try {
  const lowNode = await run(['doctor', '--root', root, '--space', 'low-node'], {
    env: { IHOW_MEMORY_TEST_NODE_VERSION: '20.11.1' },
  });
  assert(lowNode.code === 1, 'low Node doctor must exit with a failed check');
  assert(lowNode.combined.includes('- fail node: v20.11.1'), 'low Node proof must fail specifically at the Node gate');
  assert(lowNode.combined.includes('Install Node >= 22.12'), 'low Node doctor must give an upgrade action');
  assert(!lowNode.combined.includes('stack'), 'low Node doctor must not print a stack trace');

  for (const runtime of ['claude-code', 'codex', 'cursor']) {
    const initialized = await run(['init', '--root', root, '--space', `runtime-${runtime}`, '--runtime', runtime]);
    assert(initialized.code === 0, `init must succeed for ${runtime}`);
    assert(initialized.stdout.includes('backup first:'), `${runtime} init must warn to back up config`);
    assert(initialized.stdout.includes('ihow-memory'), `${runtime} init must include the MCP server name`);
    if (runtime === 'codex') {
      assert(initialized.stdout.includes('[mcp_servers.ihow-memory]'), 'Codex init must emit TOML');
    } else {
      assert(initialized.stdout.includes('"mcpServers"'), `${runtime} init must emit JSON MCP config`);
    }
  }

  const fakeSecret = ['activation', 'proof', 'secret'].join('');
  const secretEnv = {
    IHOW_MEMORY_API_KEY: ['sk', fakeSecret, '123456'].join('-'),
    IHOW_MEMORY_VECTOR_PROVIDER_COMMAND: `/private/provider --${['to', 'ken'].join('')}=${fakeSecret}`,
  };
  const diagnosticsSpace = 'diagnostics';
  const connected = await run([
    'connect', '--root', root, '--space', diagnosticsSpace, '--runtime', 'cursor', '--json',
  ]);
  assert(connected.code === 0, 'Cursor connect must complete its package-internal MCP roundtrip');
  const connection = JSON.parse(connected.stdout);
  assert(connection.method === 'direct-json', 'Cursor connect must use the package direct-JSON connector');
  assert(connection.target === path.join(isolatedHome, '.cursor', 'mcp.json'), 'Cursor connect must stay inside the isolated HOME');
  assert(connection.reachable === true, 'Cursor connect must prove the packaged MCP server is reachable');
  assert(connection.detail.includes('server ok'), 'Cursor connect must report a successful memory.status roundtrip');
  assert(connection.verified === false, 'Cursor connect must not claim the Cursor UI loaded the MCP server');

  const diagnostics = await run(
    ['doctor', '--root', root, '--space', diagnosticsSpace, '--runtime', 'cursor', '--share-diagnostics'],
    { env: secretEnv },
  );
  assert(diagnostics.code === 0, 'share diagnostics must succeed after connect prepares a reachable MCP server');
  const diagnosticReport = JSON.parse(diagnostics.stdout);
  const runtimeCheck = diagnosticReport.checks.find((check) => check.name === 'runtime');
  assert(runtimeCheck?.ok === true, 'share diagnostics must include a successful MCP reachability check');
  assert(runtimeCheck.detail.includes('registration unconfirmed'), 'share diagnostics must not claim real Cursor UI activation');
  assert(diagnostics.stdout.includes('"paths": "redacted"'), 'share diagnostics must declare path redaction');
  assert(!diagnostics.stdout.includes(root), 'share diagnostics must not include the temporary root');
  assert(!diagnostics.stdout.includes('/private/provider'), 'share diagnostics must not include provider paths');
  assert(!diagnostics.stdout.includes(fakeSecret), 'share diagnostics must not include secrets');

  const feedback = await run(['feedback', '--root', root, '--space', diagnosticsSpace, '--runtime', 'cursor'], {
    env: secretEnv,
  });
  assert(feedback.code === 0, 'feedback must succeed');
  assert(feedback.stdout.includes('No issue was submitted'), 'feedback must remain user-submitted');
  assert(feedback.stdout.includes('github.com/iHow1/ihow-memory-core/issues/new'), 'feedback must target GitHub issues');
  assert(!feedback.stdout.includes(root), 'feedback must not include the temporary root');
  assert(!feedback.stdout.includes(fakeSecret), 'feedback must not include secrets');

  const resetSpace = 'runtime-cursor';
  const beforeReset = path.join(root, resetSpace);
  await fs.access(beforeReset);
  const reset = await run(['reset', '--root', root, '--space', resetSpace]);
  assert(reset.code === 0, 'reset must succeed for an explicit managed space');
  await fs.access(beforeReset).then(
    () => {
      throw new Error('reset must remove the demo space');
    },
    () => undefined,
  );

  const readme = await fs.readFile(path.join(packageDir, 'README.md'), 'utf8');
  assert(!readme.includes('/Users/'), 'README must not include macOS user absolute paths');
  assert(!readme.includes('/home/'), 'README must not include Linux user absolute paths');
  assert(!readme.includes('C:\\Users\\'), 'README must not include Windows user absolute paths');

  console.log('PASS activation proof: low Node guidance, runtime snippets, isolated Cursor MCP roundtrip, redacted diagnostics/feedback, reset, README path hygiene');
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
