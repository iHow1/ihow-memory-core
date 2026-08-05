// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALLOWED_TELEMETRY_EVENTS,
  createTelemetry,
  promptForTelemetryConsent,
} from '../src/telemetry.ts';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');
const ROOT = path.dirname(path.dirname(CLI));

async function fixture(t, overrides = {}) {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-telemetry-'));
  t.after(async () => { await fs.rm(stateDir, { recursive: true, force: true }); });
  const client = createTelemetry({
    stateDir,
    now: () => new Date('2026-08-03T12:00:00.000Z'),
    randomUUID: () => '11111111-2222-4333-8444-555555555555',
    ...overrides,
  });
  return { client, stateDir };
}

async function exists(file) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function queueRows(stateDir) {
  const raw = await fs.readFile(path.join(stateDir, 'telemetry-queue.ndjson'), 'utf8');
  return raw.trim() ? raw.trim().split('\n').map((line) => JSON.parse(line)) : [];
}

async function runCli(args, env) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  return { code, stdout, stderr };
}

test('consent is explicit and non-preselected: later writes nothing, no-send has no ID, opt-in creates only a random installation ID', async (t) => {
  const { client, stateDir } = await fixture(t);
  const configPath = path.join(stateDir, 'telemetry.json');

  assert.equal(await client.applyConsent('later'), 'later');
  assert.equal(await exists(configPath), false, 'ask-later does not create telemetry state');

  assert.equal(await client.applyConsent('no-send'), 'no-send');
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, 'utf8')), {
    schemaVersion: 1,
    enabled: false,
    asked: true,
  });

  assert.equal(await client.applyConsent('opt-in'), 'opt-in');
  const enabled = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(enabled.installationId, '11111111-2222-4333-8444-555555555555');
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.asked, true);
  assert.deepEqual(Object.keys(enabled).sort(), ['asked', 'enabled', 'installationId', 'schemaVersion']);
});

test('disabled recording creates no queue and performs zero network requests', async (t) => {
  let networkCalls = 0;
  const { client, stateDir } = await fixture(t, {
    endpoint: 'http://127.0.0.1:9/metrics',
    sendBatch: async () => { networkCalls += 1; return { accepted: 1 }; },
  });

  assert.equal(await client.record('setup_completed'), false);
  assert.equal(await client.flush(), false);
  assert.equal(networkCalls, 0);
  assert.equal(await exists(path.join(stateDir, 'telemetry-queue.ndjson')), false);
  assert.equal(await exists(path.join(stateDir, 'telemetry.json')), false);
});

test('only versioned allowlisted events and categorical dimensions reach disk', async (t) => {
  const { client, stateDir } = await fixture(t);
  await client.enable();

  assert.deepEqual([...ALLOWED_TELEMETRY_EVENTS], [
    'setup_completed',
    'activation_completed',
    'checkpoint_created',
    'continue_attempted',
    'continue_verified_green',
    'continue_verified_yellow',
    'continue_verified_red',
    'active_week',
    'upgrade_completed',
    'error_class',
  ]);
  assert.equal(await client.record('not_allowlisted', { cwd: '/private/project' }), false);
  assert.equal(await client.record('activation_completed', {
    runtime: 'codex',
    cwd: '/private/project',
    hostname: 'secret-host',
    username: 'private-user',
    prompt: 'do not serialize me',
    gitRemote: 'git@example.test:private/repo.git',
    arbitrary: { nested: 'secret' },
  }), true);

  const raw = await fs.readFile(path.join(stateDir, 'telemetry-queue.ndjson'), 'utf8');
  const event = JSON.parse(raw.trim());
  assert.deepEqual(event, {
    schemaVersion: 1,
    event: 'activation_completed',
    installationId: '11111111-2222-4333-8444-555555555555',
    occurredAt: '2026-08-03T12:00:00.000Z',
    dimensions: { runtime: 'codex' },
  });
  assert.doesNotMatch(raw, /private|secret|project|prompt|gitRemote|hostname|username|cwd/);
});

test('off removes the queue and installation ID; re-enabling rotates the ID', async (t) => {
  let nextId = 0;
  const { client, stateDir } = await fixture(t, {
    randomUUID: () => `11111111-2222-4333-8444-${String(++nextId).padStart(12, '0')}`,
  });
  await client.enable();
  await client.record('setup_completed');
  const first = (await client.status()).installationId;

  await client.disable();
  assert.equal(await exists(path.join(stateDir, 'telemetry-queue.ndjson')), false);
  const disabled = JSON.parse(await fs.readFile(path.join(stateDir, 'telemetry.json'), 'utf8'));
  assert.equal(Object.hasOwn(disabled, 'installationId'), false);

  await client.enable();
  const second = (await client.status()).installationId;
  assert.notEqual(second, first, 'opt-out destroys the old ID so a later opt-in gets a fresh one');
});

test('off removes telemetry atomic-write and orphan-lock crash remnants', async (t) => {
  const { client, stateDir } = await fixture(t);
  await client.enable();
  const id = (await client.status()).installationId;
  const remnants = [
    ['telemetry.json.tmp-999999', JSON.stringify({ installationId: id })],
    ['telemetry-queue.ndjson.tmp-999999', JSON.stringify({ installationId: id, event: 'setup_completed' })],
    ['.telemetry.lock.orphan-999999-11111111-2222-4333-8444-555555555555', '999999\n'],
  ];
  await Promise.all(remnants.map(([name, contents]) => fs.writeFile(path.join(stateDir, name), contents, { mode: 0o600 })));
  await client.disable();

  for (const [name] of remnants) assert.equal(await exists(path.join(stateDir, name)), false, `${name} is removed on opt-out`);
  assert.equal(await exists(path.join(stateDir, 'telemetry-queue.ndjson')), false);
});

test('off wins over an in-flight record and leaves no queue or installation ID', async (t) => {
  let releaseWrite;
  let writeStarted;
  const writeGate = new Promise((resolve) => { writeStarted = resolve; });
  const writeRelease = new Promise((resolve) => { releaseWrite = resolve; });
  const { client, stateDir } = await fixture(t, {
    beforeQueueWrite: async () => {
      writeStarted();
      await writeRelease;
    },
  });
  await client.enable();
  const recording = client.record('setup_completed');
  await writeGate;
  const disabling = client.disable();
  releaseWrite();
  await Promise.all([recording, disabling]);

  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'telemetry.json'), 'utf8')), {
    schemaVersion: 1,
    enabled: false,
    asked: true,
  });
  assert.equal(await exists(path.join(stateDir, 'telemetry-queue.ndjson')), false);
});

test('off waits for an in-flight flush and no send occurs after off returns', async (t) => {
  let releaseSend;
  let sendStarted;
  let sends = 0;
  const sendGate = new Promise((resolve) => { sendStarted = resolve; });
  const sendRelease = new Promise((resolve) => { releaseSend = resolve; });
  const { client, stateDir } = await fixture(t, {
    endpoint: 'http://127.0.0.1:4318/v1/events',
    beforeSend: async () => {
      sendStarted();
      await sendRelease;
    },
    sendBatch: async (_endpoint, body) => {
      sends += 1;
      return { accepted: JSON.parse(body).events.length };
    },
  });
  await client.enable();
  await client.record('setup_completed');
  const flushing = client.flush();
  await sendGate;
  const disabling = client.disable();
  releaseSend();
  await Promise.all([flushing, disabling]);
  const sendsWhenDisabled = sends;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(sends, sendsWhenDisabled, 'no queued transport continues after off resolves');
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(stateDir, 'telemetry.json'), 'utf8')), {
    schemaVersion: 1,
    enabled: false,
    asked: true,
  });
  assert.equal(await exists(path.join(stateDir, 'telemetry-queue.ndjson')), false);
});

test('a dead telemetry lock fails closed instead of risking a live-owner lock takeover', async (t) => {
  const { client, stateDir } = await fixture(t);
  await fs.writeFile(path.join(stateDir, '.telemetry.lock'), '2147483647\n', { mode: 0o600 });
  await assert.rejects(client.enable(), /telemetry_lock_timeout/);
  assert.equal((await client.status()).enabled, false);
  assert.equal(await exists(path.join(stateDir, '.telemetry.lock')), true, 'recovery requires an explicit repair step');
});

test('queue and upload are bounded, batched, and accepted only by the versioned server contract', async (t) => {
  const received = [];
  const { client, stateDir } = await fixture(t, {
    endpoint: 'http://127.0.0.1:4318/v1/events',
    maxQueueEvents: 5,
    batchSize: 2,
    sendBatch: async (endpoint, body, timeoutMs) => {
      received.push({ endpoint: endpoint.toString(), body: JSON.parse(body), timeoutMs });
      return { accepted: received.at(-1).body.events.length };
    },
  });
  await client.enable();
  for (let index = 0; index < 7; index += 1) await client.record('continue_attempted');

  assert.equal((await queueRows(stateDir)).length, 5, 'oldest entries are dropped at the hard queue cap');
  assert.equal(await client.flush(), true);
  assert.equal(received.length, 1);
  assert.equal(received[0].endpoint, 'http://127.0.0.1:4318/v1/events');
  assert.ok(received[0].timeoutMs > 0);
  assert.equal(received[0].body.schemaVersion, 1);
  assert.equal(received[0].body.events.length, 2, 'one flush sends at most one bounded batch');
  assert.equal((await queueRows(stateDir)).length, 3, 'only server-accepted events leave the queue');
});

test('server failures and malformed acknowledgements preserve the queue and apply backoff', async (t) => {
  let calls = 0;
  let clock = new Date('2026-08-03T12:00:00.000Z');
  const { client, stateDir } = await fixture(t, {
    endpoint: 'http://127.0.0.1:4318/v1/events',
    now: () => clock,
    baseBackoffMs: 100,
    sendBatch: async () => {
      calls += 1;
      if (calls === 1) throw new Error('telemetry_http_status_503');
      return { accepted: 0 };
    },
  });
  await client.enable();
  await client.record('setup_completed');

  assert.equal(await client.flush(), false);
  assert.equal((await queueRows(stateDir)).length, 1);
  assert.equal(await client.flush(), false, 'backoff suppresses an immediate retry');
  assert.equal(calls, 1);

  clock = new Date(clock.getTime() + 101);
  assert.equal(await client.flush(), false, 'accepted count mismatch is a malformed acknowledgement');
  assert.equal(calls, 2);
  assert.equal((await queueRows(stateDir)).length, 1, 'malformed acknowledgement never drops queued data');
});

test('transport timeout fails open and preserves queued events', async (t) => {
  const { client, stateDir } = await fixture(t, {
    endpoint: 'http://127.0.0.1:4318/v1/events',
    timeoutMs: 25,
    baseBackoffMs: 10,
    sendBatch: async () => new Promise(() => {}),
  });
  await client.enable();
  await client.record('active_week');

  const started = Date.now();
  assert.equal(await client.flush(), false);
  assert.ok(Date.now() - started < 500, 'timeout is bounded');
  assert.equal((await queueRows(stateDir)).length, 1);
});

test('malformed local rows are never uploaded and queue repair remains bounded', async (t) => {
  let uploaded;
  const { client, stateDir } = await fixture(t, {
    endpoint: 'http://127.0.0.1:4318/v1/events',
    maxQueueEvents: 3,
    sendBatch: async (_endpoint, body) => {
      uploaded = JSON.parse(body);
      return { accepted: uploaded.events.length };
    },
  });
  await client.enable();
  await fs.writeFile(path.join(stateDir, 'telemetry-queue.ndjson'), [
    '{not-json',
    JSON.stringify({ schemaVersion: 1, event: 'made_up', installationId: '11111111-2222-4333-8444-555555555555', occurredAt: '2026-08-03T12:00:00.000Z', prompt: 'secret' }),
  ].join('\n') + '\n');
  await client.record('continue_attempted');

  assert.equal((await queueRows(stateDir)).length, 1, 'record compacts away malformed and disallowed rows');
  assert.equal(await client.flush(), true);
  assert.deepEqual(uploaded.events.map((event) => event.event), ['continue_attempted']);
  assert.doesNotMatch(JSON.stringify(uploaded), /secret|prompt|made_up/);
});

test('queue parser rejects extra fields and event-incompatible dimensions before upload', async (t) => {
  let uploaded;
  const { client, stateDir } = await fixture(t, {
    endpoint: 'http://127.0.0.1:4318/v1/events',
    sendBatch: async (_endpoint, body) => {
      uploaded = JSON.parse(body);
      return { accepted: uploaded.events.length };
    },
  });
  await client.enable();
  const row = {
    schemaVersion: 1,
    installationId: '11111111-2222-4333-8444-555555555555',
    occurredAt: '2026-08-03T12:00:00.000Z',
  };
  await fs.writeFile(path.join(stateDir, 'telemetry-queue.ndjson'), [
    JSON.stringify({ ...row, event: 'continue_attempted' }),
    JSON.stringify({ ...row, event: 'setup_completed', prompt: 'must-not-upload' }),
    JSON.stringify({ ...row, event: 'setup_completed', dimensions: { runtime: 'codex' } }),
    JSON.stringify({ ...row, event: 'error_class', dimensions: { runtime: 'codex' } }),
    JSON.stringify({ ...row, event: ['setup_completed'] }),
    JSON.stringify({ ...row, event: 'activation_completed', dimensions: { runtime: ['codex'] } }),
    JSON.stringify({ ...row, event: 'error_class', dimensions: { errorClass: ['timeout'] } }),
  ].join('\n') + '\n');

  assert.equal(await client.flush(), true);
  assert.deepEqual(uploaded.events.map((event) => event.event), ['continue_attempted']);
  assert.doesNotMatch(JSON.stringify(uploaded), /must-not-upload|prompt/);
});

test('queue parser accepts only canonical UTC timestamps before upload', async (t) => {
  let uploaded;
  const { client, stateDir } = await fixture(t, {
    endpoint: 'http://127.0.0.1:4318/v1/events',
    sendBatch: async (_endpoint, body) => {
      uploaded = JSON.parse(body);
      return { accepted: uploaded.events.length };
    },
  });
  await client.enable();
  const row = {
    schemaVersion: 1,
    event: 'setup_completed',
    installationId: '11111111-2222-4333-8444-555555555555',
  };
  await fs.writeFile(path.join(stateDir, 'telemetry-queue.ndjson'), [
    JSON.stringify({ ...row, occurredAt: '2026-08-03T12:00:00.000Z' }),
    JSON.stringify({ ...row, occurredAt: 'Mon, 03 Aug 2026 12:00:00 GMT (private-secret)' }),
    JSON.stringify({ ...row, occurredAt: '2026-08-03T12:00:00+00:00' }),
    JSON.stringify({ ...row, occurredAt: '2026-02-30T12:00:00.000Z' }),
  ].join('\n') + '\n');

  assert.equal(await client.flush(), true);
  assert.deepEqual(uploaded.events.map((event) => event.occurredAt), ['2026-08-03T12:00:00.000Z']);
  assert.doesNotMatch(JSON.stringify(uploaded), /private-secret|Mon, 03 Aug|\+00:00|2026-02-30/);
});

test('events with categorical dimensions require their matching dimension before queueing', async (t) => {
  const { client, stateDir } = await fixture(t);
  await client.enable();

  assert.equal(await client.record('activation_completed'), false);
  assert.equal(await client.record('checkpoint_created', { runtime: 'not-a-runtime' }), false);
  assert.equal(await client.record('error_class'), false);
  assert.equal(await client.record('error_class', { errorClass: 'not-an-error-class' }), false);
  assert.equal(await client.record('activation_completed', { runtime: 'codex' }), true);

  assert.deepEqual((await queueRows(stateDir)).map((row) => ({
    event: row.event,
    dimensions: row.dimensions,
  })), [{ event: 'activation_completed', dimensions: { runtime: 'codex' } }]);
});

test('config reads reconstruct only validated fields and fail closed on invalid dedupe state', async (t) => {
  const { client, stateDir } = await fixture(t);
  await client.enable();
  const configPath = path.join(stateDir, 'telemetry.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  await fs.writeFile(configPath, `${JSON.stringify({ ...config, prompt: 'do not retain me' })}\n`, 'utf8');
  await client.record('activation_completed', { runtime: 'codex' });
  assert.doesNotMatch(await fs.readFile(configPath, 'utf8'), /prompt|retain/);

  await fs.writeFile(configPath, `${JSON.stringify({ ...config, activationDedupe: ['/private/path'] })}\n`, 'utf8');
  assert.equal(await client.record('activation_completed', { runtime: 'claude-code' }), false);
  assert.deepEqual((await queueRows(stateDir)).map((row) => row.dimensions?.runtime), ['codex']);
});

test('endpoint configuration is explicit and rejects unsafe URL forms', async (t) => {
  const { client } = await fixture(t);
  assert.throws(() => createTelemetry({ endpoint: 'file:///tmp/metrics' }), /telemetry_endpoint_invalid/);
  await assert.rejects(client.enable('https://user:pass@example.test/events'), /telemetry_endpoint_invalid/);
  assert.throws(() => createTelemetry({ endpoint: 'https://example.test/events?token=must-not-persist' }), /telemetry_endpoint_invalid/);
  const status = await client.status();
  assert.equal(status.endpoint, null, 'there is no implicit upload destination');
});

test('only explicit telemetry flush uploads a queued batch to a configured loopback endpoint', async (t) => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-telemetry-flush-'));
  const home = path.join(sandbox, 'home');
  const stateDir = path.join(home, '.ihow-memory');
  const received = [];
  const server = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push({ method: request.method, url: request.url, body: JSON.parse(body) });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ schemaVersion: 1, accepted: received.at(-1).body.events.length }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}/v1/events`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(sandbox, { recursive: true, force: true });
  });

  const client = createTelemetry({ stateDir });
  await client.enable();
  assert.equal(await client.record('setup_completed'), true);
  assert.equal(received.length, 0, 'recording stays local until the user invokes flush');

  const run = await runCli(['telemetry', 'flush'], {
    ...process.env,
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    HERMES_HOME: path.join(home, '.hermes'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    MEMORY_ROOT: '',
    IHOW_MEMORY_ROOT: '',
    IHOW_MEMORY_HOME: '',
    IHOW_MEMORY_STATE_ROOT: '',
    IHOW_MEMORY_HERMES_BRIDGE: '',
    IHOW_MEMORY_HERMES_NODE: '',
    IHOW_TELEMETRY_ENDPOINT: endpoint,
  });
  assert.equal(run.code, 0, run.stderr || run.stdout);
  assert.match(run.stdout, /sent/i);
  assert.equal(received.length, 1);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].url, '/v1/events');
  assert.deepEqual(received[0].body.events.map((event) => event.event), ['setup_completed']);
  assert.equal(await exists(path.join(stateDir, 'telemetry-queue.ndjson')), false, 'accepted queue rows are removed');
});

test('a malformed inherited endpoint disables transport without affecting local recording', async (t) => {
  const prior = process.env.IHOW_TELEMETRY_ENDPOINT;
  process.env.IHOW_TELEMETRY_ENDPOINT = 'file:///not-a-network-endpoint';
  t.after(() => {
    if (prior === undefined) delete process.env.IHOW_TELEMETRY_ENDPOINT;
    else process.env.IHOW_TELEMETRY_ENDPOINT = prior;
  });
  const { client, stateDir } = await fixture(t);
  await client.enable();
  assert.equal(await client.record('setup_completed'), true);
  assert.equal((await client.status()).endpoint, null);
  assert.deepEqual((await queueRows(stateDir)).map((row) => row.event), ['setup_completed']);
});

test('consent prompt is one-shot, explicit, three-way, and has no preselected answer', async () => {
  let asks = 0;
  let question = '';
  const choice = await promptForTelemetryConsent({
    interactive: true,
    ask: async (text) => { asks += 1; question = text; return '3'; },
  });
  assert.equal(choice, 'later');
  assert.equal(asks, 1);
  assert.match(question, /1\) Opt in/);
  assert.match(question, /2\) No send/);
  assert.match(question, /3\) Ask me later/);
  assert.doesNotMatch(question, /\[[YyNn]\/[YyNn]\]|default/i);

  let noninteractiveAsks = 0;
  assert.equal(await promptForTelemetryConsent({
    interactive: false,
    ask: async () => { noninteractiveAsks += 1; return '1'; },
  }), null);
  assert.equal(noninteractiveAsks, 0, 'CI/noninteractive mode never presents a prompt');
});

test('activation and active-week metrics dedupe across repeated calls', async (t) => {
  let clock = new Date('2026-08-03T12:00:00.000Z');
  const { client, stateDir } = await fixture(t, { now: () => clock });
  await client.enable();
  assert.equal(await client.record('activation_completed', { runtime: 'codex' }), true);
  assert.equal(await client.record('activation_completed', { runtime: 'codex' }), false);
  assert.equal(await client.record('active_week'), true);
  assert.equal(await client.record('active_week'), false);
  clock = new Date('2026-08-10T12:00:00.000Z');
  assert.equal(await client.record('active_week'), true, 'a new ISO week emits a new event');
  assert.deepEqual((await queueRows(stateDir)).map((row) => row.event), [
    'activation_completed', 'active_week', 'active_week',
  ]);
});

test('activation metric documentation reserves the event until host-authenticated provenance exists', async () => {
  const privacy = await fs.readFile(path.join(ROOT, 'docs', 'telemetry-privacy.md'), 'utf8');
  const security = await fs.readFile(path.join(ROOT, 'SECURITY.md'), 'utf8');
  assert.match(privacy, /activation_completed[^\n]*(?:reserved|no production producer)/i);
  assert.match(privacy, /cannot[^\n]*(?:authenticate|attest)[^\n]*host/i);
  assert.match(privacy, /does not[^\n]*(?:emit|queue)[^\n]*activation_completed/i);
  assert.match(privacy, /does not[^\n]*(?:promote|upgrade)[^\n]*ACTIVE/i);
  assert.match(security, /already-compromised local user account or arbitrary local code execution/i);
});
