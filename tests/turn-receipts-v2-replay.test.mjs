// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openCore } from '../src/core.ts';

const repo = path.resolve(import.meta.dirname, '..');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');
const IDENTITY_DOMAIN = 'hermes-transcript-v1';
const PROJECT_ID = '1'.repeat(64);
const SESSION_HASH = '2'.repeat(64);
const TURN_ID = '3'.repeat(64);
const OTHER_TURN_ID = '9'.repeat(64);
const INPUT_SOURCE_HASH = `sha256:${'4'.repeat(64)}`;
const INPUT_CONTENT_SHA256 = '5'.repeat(64);
const FINAL_SOURCE_HASH = `sha256:${'6'.repeat(64)}`;
const FINAL_CONTENT_SHA256 = '7'.repeat(64);
const COMMITTED_AT_1 = '2026-07-18T12:34:56.123456Z';
const COMMITTED_AT_2 = '2026-07-18T12:35:56.123456Z';
const OPENED_AT = '2026-07-18T12:34:50.000Z';
const HOST_PATH_CANARY = 'raw-host-path-canary-7f3d';
const OUTSIDE_PATH_CANARY = 'raw-outside-path-canary-c81a';
const RAW_CANARIES = Object.freeze([
  'raw-session-canary-7ba1',
  'raw-hook-turn-canary-668e',
  'raw-user-body-canary-7ea5',
  'raw-final-body-canary-c251',
  'raw-secret-canary-9e6f',
  HOST_PATH_CANARY,
  OUTSIDE_PATH_CANARY,
]);

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortedJson(value[key])]));
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(`${JSON.stringify(sortedJson(value))}\n`, 'utf8');
}

function baseTurn(overrides = {}) {
  return {
    turnId: TURN_ID,
    inputSourceHash: INPUT_SOURCE_HASH,
    inputContentSha256: INPUT_CONTENT_SHA256,
    finalSourceHash: FINAL_SOURCE_HASH,
    finalContentSha256: FINAL_CONTENT_SHA256,
    deltaState: 'not_emitted',
    ...overrides,
  };
}

function additionalTurn() {
  return baseTurn({
    turnId: OTHER_TURN_ID,
    inputSourceHash: `sha256:${'a'.repeat(64)}`,
    inputContentSha256: 'b'.repeat(64),
    finalSourceHash: `sha256:${'c'.repeat(64)}`,
    finalContentSha256: 'd'.repeat(64),
  });
}

async function writePrivateFile(file, bytes) {
  await fs.writeFile(file, bytes, { mode: 0o600 });
  await fs.chmod(file, 0o600);
}

async function ensurePrivateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

async function createB3Fixture(t, revisionSpecs = [{ revision: 1, turns: [baseTurn()], committedAt: COMMITTED_AT_1 }]) {
  const hermesHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `${HOST_PATH_CANARY}-`)));
  t.after(async () => { await fs.rm(hermesHome, { recursive: true, force: true }); });

  const exportRoot = path.join(hermesHome, 'exports', 'transcripts', 'v1');
  const manifestsDirectory = path.join(exportRoot, 'manifests');
  const revisionsDirectory = path.join(exportRoot, 'revisions');
  const sessionDirectory = path.join(revisionsDirectory, SESSION_HASH);
  for (const directory of [hermesHome, path.join(hermesHome, 'exports'), path.join(hermesHome, 'exports', 'transcripts'), exportRoot, manifestsDirectory, revisionsDirectory, sessionDirectory]) {
    await ensurePrivateDirectory(directory);
  }

  const revisions = new Map();
  for (const spec of revisionSpecs) {
    assert.equal(spec.revision, revisions.size + 1, 'fixture revisions are contiguous and strictly monotonic');
    const object = {
      schemaVersion: 1,
      runtime: 'hermes',
      sessionHash: SESSION_HASH,
      revision: spec.revision,
      previousRevision: spec.revision - 1,
      turns: spec.turns,
    };
    const bytes = canonicalBytes(object);
    const file = path.join(sessionDirectory, `${spec.revision}.json`);
    await writePrivateFile(file, bytes);
    revisions.set(spec.revision, { ...spec, object, bytes, file });
  }

  const currentRevision = revisionSpecs.at(-1).revision;
  const current = revisions.get(currentRevision);
  const manifestPath = path.join(manifestsDirectory, `${SESSION_HASH}.json`);

  async function writeManifest(revision, pathOverride) {
    const selected = revisions.get(revision);
    assert.ok(selected, `fixture revision ${revision} exists`);
    const relative = pathOverride ?? `revisions/${SESSION_HASH}/${revision}.json`;
    const manifest = {
      schemaVersion: 1,
      runtime: 'hermes',
      sessionHash: SESSION_HASH,
      currentRevision: revision,
      current: {
        path: relative,
        contentSha256: sha256(selected.bytes),
        byteLength: selected.bytes.length,
        committedAt: selected.committedAt,
      },
    };
    const bytes = canonicalBytes(manifest);
    await writePrivateFile(manifestPath, bytes);
    return { object: manifest, bytes };
  }

  const manifest = await writeManifest(currentRevision);
  const publication = {
    schemaVersion: 1,
    sessionHash: SESSION_HASH,
    revision: currentRevision,
    manifestPath: `manifests/${SESSION_HASH}.json`,
    transcriptPath: `revisions/${SESSION_HASH}/${currentRevision}.json`,
    contentSha256: sha256(current.bytes),
    committedAt: current.committedAt,
  };

  return {
    hermesHome,
    exportRoot,
    manifestsDirectory,
    revisionsDirectory,
    sessionDirectory,
    manifestPath,
    revisions,
    manifest,
    publication,
    writeManifest,
  };
}

async function createTestCore(t, label) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-b6-${label}-`)));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const options = { root, cwd: root, space: label };
  return { root, options, core: await openCore(options) };
}

function nativeOpenInput(turn = baseTurn()) {
  return {
    schemaVersion: 2,
    runtime: 'hermes',
    identityDomain: IDENTITY_DOMAIN,
    origin: 'native-hook',
    projectId: PROJECT_ID,
    sessionHash: SESSION_HASH,
    turnId: turn.turnId,
    revision: 1,
    inputSourceHash: turn.inputSourceHash,
    inputContentSha256: turn.inputContentSha256,
    openedAt: OPENED_AT,
  };
}

function v2Projection() {
  return {
    schemaVersion: 2,
    identityDomain: IDENTITY_DOMAIN,
    runtime: 'hermes',
    projectId: PROJECT_ID,
    sessionHash: SESSION_HASH,
  };
}

async function listV2(service) {
  return await service.list(v2Projection());
}

function requiredMethod(service, name, redNumber) {
  const method = Reflect.get(service, name);
  assert.equal(
    typeof method,
    'function',
    `mandatory RED ${redNumber}: TurnReceiptService.${name} durable B3 capability is missing`,
  );
  return method.bind(service);
}

async function scan(service, fixture, redNumber) {
  const method = requiredMethod(service, 'scanDurableTranscriptRevisions', redNumber);
  return await method({ hermesHome: fixture.hermesHome, projectId: PROJECT_ID });
}

async function consume(service, fixture, redNumber) {
  const method = requiredMethod(service, 'consumeDurableTranscriptRevision', redNumber);
  return await method({
    hermesHome: fixture.hermesHome,
    projectId: PROJECT_ID,
    publication: fixture.publication,
  });
}

function assertCommittedV2(receipt, expected = baseTurn()) {
  assert.equal(receipt.schemaVersion, 2);
  assert.equal(receipt.state, 'COMMITTED');
  assert.equal(receipt.identityDomain, IDENTITY_DOMAIN);
  assert.equal(receipt.runtime, 'hermes');
  assert.equal(receipt.projectId, PROJECT_ID);
  assert.equal(receipt.sessionHash, SESSION_HASH);
  assert.equal(receipt.turnId, expected.turnId);
  assert.equal(receipt.revision, 1, 'receipt revision stays 1; B3 durable revision is separate');
  assert.equal(receipt.inputSourceHash, expected.inputSourceHash);
  assert.equal(receipt.inputContentSha256, expected.inputContentSha256);
  assert.equal(receipt.finalSourceHash, expected.finalSourceHash);
  assert.equal(receipt.finalContentSha256, expected.finalContentSha256);
}

function withoutReplayProvenance(receipt) {
  const copy = structuredClone(receipt);
  delete copy.origin;
  delete copy.replayedAt;
  delete copy.derivedFromRevision;
  return copy;
}

async function regularFileRecords(root) {
  const records = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join('/');
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        records.push({ path: relative, type: 'symlink', target: await fs.readlink(absolute) });
      } else if (stat.isDirectory()) {
        await visit(absolute);
      } else if (stat.isFile()) {
        const bytes = await fs.readFile(absolute);
        records.push({
          path: relative,
          type: 'file',
          mode: stat.mode & 0o777,
          size: bytes.length,
          sha256: sha256(bytes),
          bytes,
        });
      }
    }
  }
  await visit(root);
  return records;
}

async function stateFingerprint(root) {
  return (await regularFileRecords(root)).map(({ bytes, ...record }) => record);
}

async function assertNoRawCanaries(root, extra = '') {
  const records = await regularFileRecords(root);
  const persisted = Buffer.concat(records.filter((record) => record.type === 'file').map((record) => record.bytes)).toString('utf8');
  const observed = `${persisted}\n${extra}`;
  for (const canary of RAW_CANARIES) {
    assert.equal(observed.includes(canary), false, `raw canary ${canary} must not reach receipt/cursor/anomaly output`);
  }
}

function legacyOpenInput() {
  return {
    schemaVersion: 1,
    runtime: 'hermes',
    projectId: PROJECT_ID,
    sessionHash: SESSION_HASH,
    turnId: 'legacy-turn-001',
    revision: 1,
    inputSourceHash: `sha256:${'e'.repeat(64)}`,
    inputContentSha256: 'f'.repeat(64),
    openedAt: '2026-07-18T12:00:00.000Z',
  };
}

test('GREEN fixture: canonical B3 manifest/revision publication is self-consistent, relative, and owner-only', async (t) => {
  const fixture = await createB3Fixture(t);
  const current = fixture.revisions.get(1);
  const revisionBytes = await fs.readFile(current.file);
  const manifestBytes = await fs.readFile(fixture.manifestPath);

  assert.deepEqual(revisionBytes, canonicalBytes(JSON.parse(revisionBytes)));
  assert.deepEqual(manifestBytes, canonicalBytes(JSON.parse(manifestBytes)));
  assert.equal(fixture.manifest.object.current.contentSha256, sha256(revisionBytes));
  assert.equal(fixture.manifest.object.current.byteLength, revisionBytes.length);
  assert.equal(fixture.publication.contentSha256, sha256(revisionBytes));
  assert.deepEqual(Object.keys(fixture.publication).sort(), [
    'committedAt', 'contentSha256', 'manifestPath', 'revision', 'schemaVersion', 'sessionHash', 'transcriptPath',
  ]);
  assert.equal(path.isAbsolute(fixture.publication.manifestPath), false);
  assert.equal(path.isAbsolute(fixture.publication.transcriptPath), false);
  assert.equal(fixture.publication.manifestPath.includes('..'), false);
  assert.equal(fixture.publication.transcriptPath.includes('..'), false);
  assert.equal(JSON.stringify(fixture.publication).includes(fixture.hermesHome), false);

  for (const directory of [fixture.exportRoot, fixture.manifestsDirectory, fixture.revisionsDirectory, fixture.sessionDirectory]) {
    assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  }
  assert.equal((await fs.stat(current.file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(fixture.manifestPath)).mode & 0o777, 0o600);
});

test('mandatory RED 4: alias miss is recovered only by a valid durable revision as replay-origin schema v2', async (t) => {
  const fixture = await createB3Fixture(t);
  const { root, core } = await createTestCore(t, 'red4-alias-miss');

  const result = await scan(core.turnReceipts, fixture, 4);
  const page = await listV2(core.turnReceipts);
  assert.equal(page.total, 1);
  const [receipt] = page.items;
  assertCommittedV2(receipt);
  assert.equal(receipt.origin, 'durable-replay');
  assert.equal(receipt.deltaState, 'not_emitted');
  assert.equal(receipt.durableRevision, 1);
  assert.equal(receipt.transcriptPath, `revisions/${SESSION_HASH}/1.json`);
  assert.equal(JSON.stringify(result).includes('raw-hook-turn'), false);
  await assertNoRawCanaries(root, JSON.stringify(result));
});

test('Bridge RED: durable publication consumes Host evidence without entering lifecycle/context-probe paths', async (t) => {
  const fixture = await createB3Fixture(t);
  const memoryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-bridge-memory-')));
  const stateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-bridge-state-')));
  t.after(async () => Promise.all([memoryRoot, stateRoot].map(root => fs.rm(root, { recursive: true, force: true }))));

  const event = {
    schemaVersion: 1,
    event: 'runtime.durable_transcript_revision',
    runtime: 'hermes',
    projectId: PROJECT_ID,
    observedAt: '2026-07-18T12:34:56.123Z',
    publication: fixture.publication,
  };
  const run = spawnSync(process.execPath, ['--experimental-strip-types', bridge], {
    cwd: repo,
    encoding: 'utf8',
    input: `${JSON.stringify(event)}\n`,
    env: {
      ...process.env,
      HERMES_HOME: fixture.hermesHome,
      MEMORY_ROOT: memoryRoot,
      IHOW_MEMORY_STATE_ROOT: stateRoot,
    },
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const response = JSON.parse(run.stdout.trim());
  assert.deepEqual(response, {
    ok: true,
    replay: { status: 'ok', receiptsWritten: 1, cursorRevision: 1 },
  });

  const core = await openCore({ memoryRoot, stateRoot, cwd: repo });
  const page = await listV2(core.turnReceipts);
  assert.equal(page.total, 1);
  assertCommittedV2(page.items[0]);

  const persistedRecords = [
    ...await regularFileRecords(memoryRoot),
    ...await regularFileRecords(stateRoot),
  ];
  const persisted = Buffer.concat(persistedRecords
    .filter(record => record.type === 'file')
    .map(record => record.bytes)).toString('utf8');
  assert.equal(`${run.stdout}\n${persisted}`.includes(fixture.hermesHome), false, 'HERMES_HOME leaked to output/store');
  assert.equal(persisted.includes(HOST_PATH_CANARY), false, 'raw Host path canary reached state');
  assert.equal(persisted.includes('memory.context_probe'), false, 'durable publication forged a context probe');
  assert.equal(persistedRecords.some(record => /checkpoints\/artifacts\/cp_[a-f0-9]{64}\.json$/.test(record.path)), false);
});

test('Bridge durable envelope rejects extra fields before opening Core or persisting receipts', async (t) => {
  const fixture = await createB3Fixture(t);
  const memoryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-bridge-extra-memory-')));
  const stateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-bridge-extra-state-')));
  t.after(async () => Promise.all([memoryRoot, stateRoot].map(root => fs.rm(root, { recursive: true, force: true }))));
  const rawCanary = 'raw-durable-envelope-extra-canary';
  const run = spawnSync(process.execPath, ['--experimental-strip-types', bridge], {
    cwd: repo,
    encoding: 'utf8',
    input: `${JSON.stringify({
      schemaVersion: 1,
      event: 'runtime.durable_transcript_revision',
      runtime: 'hermes',
      projectId: PROJECT_ID,
      observedAt: '2026-07-18T12:34:56.123Z',
      publication: fixture.publication,
      extra: rawCanary,
    })}\n`,
    env: {
      ...process.env,
      HERMES_HOME: fixture.hermesHome,
      MEMORY_ROOT: memoryRoot,
      IHOW_MEMORY_STATE_ROOT: stateRoot,
    },
  });
  assert.notEqual(run.status, 0);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { ok: false, error: 'hermes_durable_revision_event_invalid' });
  assert.equal(run.stdout.includes(rawCanary), false);
  await assert.rejects(
    fs.access(path.join(memoryRoot, '_mcp', 'turn-receipts', 'v1.json')),
    { code: 'ENOENT' },
  );
});

test('Bridge missing HERMES_HOME fails open with bounded replay rejection and zero receipts', async (t) => {
  const fixture = await createB3Fixture(t);
  const memoryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-bridge-no-home-memory-')));
  const stateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-bridge-no-home-state-')));
  t.after(async () => Promise.all([memoryRoot, stateRoot].map(root => fs.rm(root, { recursive: true, force: true }))));
  const env = {
    ...process.env,
    MEMORY_ROOT: memoryRoot,
    IHOW_MEMORY_STATE_ROOT: stateRoot,
  };
  delete env.HERMES_HOME;
  const run = spawnSync(process.execPath, ['--experimental-strip-types', bridge], {
    cwd: repo,
    encoding: 'utf8',
    input: `${JSON.stringify({
      schemaVersion: 1,
      event: 'runtime.durable_transcript_revision',
      runtime: 'hermes',
      projectId: PROJECT_ID,
      observedAt: '2026-07-18T12:34:56.123Z',
      publication: fixture.publication,
    })}\n`,
    env,
  });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.deepEqual(JSON.parse(run.stdout.trim()), {
    ok: true,
    replay: { status: 'rejected', code: 'turn_receipt_replay_rejected', receiptsWritten: 0 },
  });
  assert.equal(run.stdout.includes(fixture.hermesHome), false);
  await assert.rejects(
    fs.access(path.join(memoryRoot, '_mcp', 'turn-receipts', 'v1.json')),
    { code: 'ENOENT' },
  );
});

test('mandatory RED 5: native v2 OPEN commits only from durable proof and records earliest proving revision', async (t) => {
  const fixture = await createB3Fixture(t, [
    { revision: 1, turns: [baseTurn()], committedAt: COMMITTED_AT_1 },
    { revision: 2, turns: [baseTurn(), additionalTurn()], committedAt: COMMITTED_AT_2 },
  ]);
  const { core } = await createTestCore(t, 'red5-proof-commit');

  const opened = await core.turnReceipts.open(nativeOpenInput());
  assert.equal(opened.schemaVersion, 2);
  assert.equal(opened.state, 'OPEN');
  assert.equal(opened.identityDomain, IDENTITY_DOMAIN);
  assert.equal(opened.sessionHash, SESSION_HASH);
  assert.equal(opened.turnId, TURN_ID);
  assert.equal(opened.inputSourceHash, INPUT_SOURCE_HASH);
  assert.equal(opened.inputContentSha256, INPUT_CONTENT_SHA256);

  await consume(core.turnReceipts, fixture, 5);
  const page = await listV2(core.turnReceipts);
  const receipt = page.items.find((item) => item.turnId === TURN_ID);
  assert.ok(receipt);
  assertCommittedV2(receipt);
  assert.equal(receipt.origin, 'native-hook');
  assert.equal(receipt.durableRevision, 1, 'earliest validated revision wins even when publication points at revision 2');
  assert.equal(receipt.transcriptPath, `revisions/${SESSION_HASH}/1.json`);
});

test('mandatory RED 6: divergent durable input evidence reports a bounded anomaly and never overwrites OPEN', async (t) => {
  const divergent = baseTurn({
    inputSourceHash: `sha256:${'8'.repeat(64)}`,
    inputContentSha256: 'a'.repeat(64),
  });
  const fixture = await createB3Fixture(t, [{ revision: 1, turns: [divergent], committedAt: COMMITTED_AT_1 }]);
  const { root, core } = await createTestCore(t, 'red6-divergence');
  const consumeRevision = requiredMethod(core.turnReceipts, 'consumeDurableTranscriptRevision', 6);
  const opened = await core.turnReceipts.open(nativeOpenInput());

  const result = await consumeRevision({
    hermesHome: fixture.hermesHome,
    projectId: PROJECT_ID,
    publication: fixture.publication,
  });
  assert.equal(result.status, 'anomaly');
  assert.equal(result.code, 'turn_receipt_replay_input_divergence');
  assert.equal(result.receiptsWritten, 0);
  const page = await listV2(core.turnReceipts);
  assert.deepEqual(page.items, [opened], 'divergence preserves the exact OPEN receipt');
  await assertNoRawCanaries(root, JSON.stringify(result));
});

test('mandatory RED 7: replay is zero-write idempotent and next-process completion converges with direct consume', async (t) => {
  const fixture = await createB3Fixture(t);
  const replayLane = await createTestCore(t, 'red7-replay');
  await replayLane.core.turnReceipts.open(nativeOpenInput());
  const reopened = await openCore(replayLane.options);

  await scan(reopened.turnReceipts, fixture, 7);
  const firstPage = await listV2(reopened.turnReceipts);
  const firstReceipt = firstPage.items[0];
  const afterFirst = await stateFingerprint(replayLane.root);
  const secondResult = await scan(reopened.turnReceipts, fixture, 7);
  const afterSecond = await stateFingerprint(replayLane.root);
  assert.deepEqual(afterSecond, afterFirst, 'identical second scan performs zero persistent writes');
  assert.equal(secondResult.receiptsWritten, 0);

  const directLane = await createTestCore(t, 'red7-direct');
  await directLane.core.turnReceipts.open(nativeOpenInput());
  await consume(directLane.core.turnReceipts, fixture, 7);
  const directPage = await listV2(directLane.core.turnReceipts);
  assert.deepEqual(withoutReplayProvenance(firstReceipt), withoutReplayProvenance(directPage.items[0]));
});

test('mandatory RED 9: legacy v1 is immutable and excluded from exact B3/schema-v2 queries', async (t) => {
  const fixture = await createB3Fixture(t);
  const { root, core } = await createTestCore(t, 'red9-legacy');
  const legacy = await core.turnReceipts.open(legacyOpenInput());
  const legacyCanonicalBefore = canonicalBytes(legacy);

  const emptyV2 = await listV2(core.turnReceipts);
  assert.equal(emptyV2.total, 0);
  await scan(core.turnReceipts, fixture, 9);

  const legacyAfter = await core.turnReceipts.read({
    runtime: legacy.runtime,
    projectId: legacy.projectId,
    sessionHash: legacy.sessionHash,
    turnId: legacy.turnId,
    revision: legacy.revision,
  });
  assert.deepEqual(canonicalBytes(legacyAfter), legacyCanonicalBefore, 'legacy record fields and identity never migrate');
  const v2 = await listV2(core.turnReceipts);
  assert.ok(v2.items.length >= 1);
  assert.ok(v2.items.every((receipt) => receipt.schemaVersion === 2 && receipt.identityDomain === IDENTITY_DOMAIN));
  assert.equal(v2.items.some((receipt) => receipt.turnId === legacy.turnId), false);
  await assertNoRawCanaries(root);
});

test('mandatory RED 11: per-session replay cursor rejects manifest rollback and never regresses', async (t) => {
  const fixture = await createB3Fixture(t, [
    { revision: 1, turns: [baseTurn()], committedAt: COMMITTED_AT_1 },
    { revision: 2, turns: [baseTurn(), additionalTurn()], committedAt: COMMITTED_AT_2 },
  ]);
  const { root, core } = await createTestCore(t, 'red11-cursor');

  const first = await scan(core.turnReceipts, fixture, 11);
  assert.equal(first.cursorRevision, 2);
  await fixture.writeManifest(1);
  const rollback = await scan(core.turnReceipts, fixture, 11);
  assert.equal(rollback.status, 'rejected');
  assert.equal(rollback.code, 'turn_receipt_replay_cursor_regression');
  assert.equal(rollback.cursorRevision, 2);
  assert.equal(rollback.receiptsWritten, 0);

  await fixture.writeManifest(2);
  const restored = await scan(core.turnReceipts, fixture, 11);
  assert.equal(restored.cursorRevision, 2);
  assert.equal(restored.receiptsWritten, 0);
  await assertNoRawCanaries(root, JSON.stringify({ first, rollback, restored }));
});

test('security RED: manifest traversal is rejected without receipt writes or raw path leakage', async (t) => {
  const fixture = await createB3Fixture(t);
  const { root, core } = await createTestCore(t, 'red-path-traversal');
  await fixture.writeManifest(1, `../../${OUTSIDE_PATH_CANARY}`);
  const scanRevisions = requiredMethod(core.turnReceipts, 'scanDurableTranscriptRevisions', 'security');

  let observed;
  try {
    observed = await scanRevisions({ hermesHome: fixture.hermesHome, projectId: PROJECT_ID });
  } catch (error) {
    observed = { status: 'rejected', code: error instanceof Error ? error.message : String(error) };
  }
  assert.equal(observed.status, 'rejected');
  assert.equal(observed.code, 'turn_receipt_replay_rejected');
  assert.equal((await core.turnReceipts.list()).total, 0);
  await assertNoRawCanaries(root, JSON.stringify(observed));
});

test('security RED: hostile maximum revision is rejected without an attacker-sized Array.from allocation', async (t) => {
  const fixture = await createB3Fixture(t);
  const { core } = await createTestCore(t, 'red-max-revision-allocation');
  const hostileRevision = 2_147_483_647;
  await writePrivateFile(fixture.manifestPath, canonicalBytes({
    schemaVersion: 1,
    runtime: 'hermes',
    sessionHash: SESSION_HASH,
    currentRevision: hostileRevision,
    current: {
      path: `revisions/${SESSION_HASH}/${hostileRevision}.json`,
      contentSha256: 'a'.repeat(64),
      byteLength: 1,
      committedAt: COMMITTED_AT_1,
    },
  }));

  const originalArrayFrom = Array.from;
  let attackerSizedAllocations = 0;
  Array.from = function guardedArrayFrom(value, ...rest) {
    if (value && typeof value === 'object' && value.length === hostileRevision) {
      attackerSizedAllocations += 1;
      return [];
    }
    return originalArrayFrom.call(Array, value, ...rest);
  };
  let result;
  try {
    result = await scan(core.turnReceipts, fixture, 'security-max-revision');
  } finally {
    Array.from = originalArrayFrom;
  }
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'turn_receipt_replay_rejected');
  assert.equal(result.receiptsWritten, 0);
  assert.equal(attackerSizedAllocations, 0, 'untrusted currentRevision must not size an Array allocation');
});

test('Host schema RED: emitted deltaState is rejected because B3 publishes only not_emitted', async (t) => {
  const fixture = await createB3Fixture(t, [{
    revision: 1,
    turns: [baseTurn({ deltaState: 'emitted' })],
    committedAt: COMMITTED_AT_1,
  }]);
  const { core } = await createTestCore(t, 'red-host-delta-state');

  const result = await scan(core.turnReceipts, fixture, 'host-delta-state');
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'turn_receipt_replay_rejected');
  assert.equal(result.receiptsWritten, 0);
  assert.equal((await listV2(core.turnReceipts)).total, 0);
});

test('Host schema RED: impossible six-digit committedAt is rejected instead of Date.parse normalization', async (t) => {
  const fixture = await createB3Fixture(t);
  const { core } = await createTestCore(t, 'red-host-calendar-date');
  const impossible = '2026-02-31T00:00:00.000000Z';
  const current = fixture.revisions.get(1);
  await writePrivateFile(fixture.manifestPath, canonicalBytes({
    schemaVersion: 1,
    runtime: 'hermes',
    sessionHash: SESSION_HASH,
    currentRevision: 1,
    current: {
      path: `revisions/${SESSION_HASH}/1.json`,
      contentSha256: sha256(current.bytes),
      byteLength: current.bytes.length,
      committedAt: impossible,
    },
  }));

  const result = await scan(core.turnReceipts, fixture, 'host-calendar-date');
  assert.equal(result.status, 'rejected');
  assert.equal(result.code, 'turn_receipt_replay_rejected');
  assert.equal(result.receiptsWritten, 0);
  assert.equal((await listV2(core.turnReceipts)).total, 0);
});
