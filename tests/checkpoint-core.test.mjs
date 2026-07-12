// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHECKPOINT_ARTIFACT_MAX_BYTES,
  CHECKPOINT_DRAFT_MAX_BYTES,
  buildCheckpointArtifact,
  canonicalCheckpointJson,
  computeCheckpointContentSha256,
  computeCheckpointSemanticSha256,
  normalizeCheckpointClaimsInput,
  normalizeMachineAnchors,
  validateCheckpointDraft,
} from '../src/checkpoint-schema.ts';
import { openCore } from '../src/core.ts';
import {
  appendCheckpointAuditUnlocked,
  checkpointStorePaths,
  linkCheckpointArtifactWriteClaimUnlocked,
  prepareCheckpointArtifactWriteClaimUnlocked,
  removeCheckpointArtifactWriteClaimUnlocked,
  writeCheckpointArtifactNewUnlocked,
  writeCheckpointDraftUnlocked,
  writeCheckpointFinalizationIntentUnlocked,
} from '../src/store/checkpoints.ts';

const ZERO_HASH = '0'.repeat(64);

async function tempCore(t, label = 'checkpoint') {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `ihow-${label}-`)));
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root: path.join(root, 'store'), space: 'checkpoint-test', cwd: project });
}

function anchorProvider(overrides = {}) {
  return async () => ({
    git: { repo: 'demo', branch: 'main', head: 'abc123', dirty: false, statusHash: ZERO_HASH },
    files: [{ path: 'src/core.ts', sha256: ZERO_HASH, mtime: '2026-07-12T08:00:00.000Z' }],
    commands: [{ label: 'npm test', exitCode: 0, outputHash: ZERO_HASH }],
    ...overrides,
  });
}

function rehashArtifact(value) {
  const artifact = structuredClone(value);
  const hash = computeCheckpointContentSha256(artifact);
  artifact.id = `cp_${hash}`;
  artifact.integrity.contentSha256 = hash;
  return artifact;
}

const explicit = { trigger: { kind: 'explicit', signal: 'native', sourceEvent: 'unit-test', reasonCode: 'test_checkpoint' } };

function finalizationBuild(anchors, createdAt, request = explicit) {
  return {
    createdAt,
    trigger: request.trigger,
    anchors: anchors.anchors,
    anchorOmittedCounts: anchors.omittedCounts,
    anchorRedaction: anchors.redaction,
    ...(request.supersedes ? { supersedes: request.supersedes } : {}),
  };
}

function artifactForDraft(draft, createdAt = '2026-07-12T08:00:00.000Z') {
  const anchors = normalizeMachineAnchors({ files: [], commands: [] });
  return buildCheckpointArtifact({
    project: draft.project,
    session: draft.session,
    createdAt,
    trigger: explicit.trigger,
    state: draft.claims,
    anchors: anchors.anchors,
    evidence: draft.evidence,
    coverage: draft.coverage,
    redaction: draft.redaction,
    anchorOmittedCounts: anchors.omittedCounts,
    anchorRedaction: anchors.redaction,
  });
}

async function waitForFile(file, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fs.access(file);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${path.basename(file)}`);
}

const PARENT_BOUNDARY_PRELOAD = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const originalSpawn = cp.spawn;
let attacked = false;
cp.spawn = function patchedSpawn(command, args, options) {
  const child = originalSpawn.apply(this, arguments);
  const argv = Array.isArray(args) ? args.map(String) : [];
  const isReaper = argv.includes('--reaper');
  const isGuard = argv.includes('--guard');
  const isFileWorker = argv.some((arg) => /checkpoint-file-worker\.(?:ts|js)$/.test(arg));
  const isClaimWorker = argv.some((arg) => /checkpoint-claim-worker\.(?:ts|js)$/.test(arg));
  if (!attacked && child.stdout && options && typeof options.cwd === 'string') {
    child.stdout.prependListener('data', (chunk) => {
      const output = String(chunk);
      if (attacked) return;
      if (process.env.IHOW_ATTACK_KIND === 'file' && isFileWorker && !isReaper && output.includes('"event":"ready"')) {
        attacked = true;
        const pinnedDirectory = options.cwd;
        const names = fs.readdirSync(pinnedDirectory).filter((name) => /^draft_[a-f0-9-]+\.json$/.test(name));
        if (names.length !== 1) throw new Error('expected one draft target, got ' + names.join(','));
        const basename = names[0];
        const target = path.join(pinnedDirectory, basename);
        const hardlink = path.join(pinnedDirectory, 'round7c-file-owned-hardlink');
        const renamed = path.join(pinnedDirectory, 'round7c-file-owned-renamed');
        fs.linkSync(target, hardlink);
        fs.renameSync(target, renamed);
        const owned = fs.statSync(renamed, { bigint: true });
        const movedDirectory = pinnedDirectory + '.round7c-pinned';
        fs.renameSync(pinnedDirectory, movedDirectory);
        fs.mkdirSync(pinnedDirectory, { mode: 0o700 });
        const replacementTarget = path.join(pinnedDirectory, basename);
        fs.writeFileSync(replacementTarget, 'THIRD_PARTY_REPLACEMENT');
        const replacement = fs.statSync(replacementTarget, { bigint: true });
        fs.writeFileSync(process.env.IHOW_ATTACK_EVIDENCE, JSON.stringify({
          kind: 'file', target: replacementTarget, pinnedDirectory: movedDirectory,
          replacementDirectory: pinnedDirectory, owned: { dev: owned.dev.toString(), ino: owned.ino.toString() },
          replacement: { dev: replacement.dev.toString(), ino: replacement.ino.toString() },
        }));
        return;
      }
      if (process.env.IHOW_ATTACK_KIND === 'claim' && isClaimWorker && !isReaper && !isGuard && output.includes('"ok":true,"result":"created"')) {
        attacked = true;
        const directory = options.cwd;
        const finals = fs.readdirSync(directory).filter((name) => /^cp_[a-f0-9]{64}\.json$/.test(name));
        const claims = fs.readdirSync(directory).filter((name) => /^\.cp_[a-f0-9]{64}\.claim-[a-f0-9-]+\.tmp$/.test(name));
        if (finals.length !== 1 || claims.length !== 1) throw new Error('unexpected claim boundary names');
        const target = path.join(directory, finals[0]);
        const hardlink = path.join(directory, 'round7c-claim-owned-hardlink');
        const renamed = path.join(directory, 'round7c-claim-owned-renamed');
        fs.linkSync(target, hardlink);
        fs.renameSync(target, renamed);
        const owned = fs.statSync(renamed, { bigint: true });
        fs.writeFileSync(target, 'THIRD_PARTY_CLAIM_REPLACEMENT');
        const replacement = fs.statSync(target, { bigint: true });
        fs.writeFileSync(process.env.IHOW_ATTACK_EVIDENCE, JSON.stringify({
          kind: 'claim', target, claim: path.join(directory, claims[0]), pinnedDirectory: directory,
          replacementDirectory: directory, owned: { dev: owned.dev.toString(), ino: owned.ino.toString() },
          replacement: { dev: replacement.dev.toString(), ino: replacement.ino.toString() },
        }));
      }
    });
  }
  return child;
};
syncBuiltinESMExports();
`;

const PARENT_BOUNDARY_SCENARIO = String.raw`
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function aliasesFor(directory, expected) {
  const aliases = [];
  for (const name of await fs.readdir(directory)) {
    const stat = await fs.lstat(path.join(directory, name), { bigint: true });
    if (stat.isFile() && stat.dev.toString() === expected.dev && stat.ino.toString() === expected.ino) aliases.push(name);
  }
  return aliases.sort();
}

const { openCore } = await import(pathToFileURL(path.join(process.env.IHOW_REPO_ROOT, 'src/core.ts')).href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-parent-boundary-api-'));
let result;
try {
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const core = await openCore({ root: path.join(root, 'store'), space: 'round7c', cwd: project });
  let apiReturned = false;
  let rejection;
  try {
    if (process.env.IHOW_ATTACK_KIND === 'file') {
      await core.checkpoints.createDraft({ runtime: 'round7c', claims: { completed: ['file parent boundary'] } });
    } else {
      const draft = await core.checkpoints.createDraft({ runtime: 'round7c', claims: { completed: ['claim parent boundary'] } });
      await core.checkpoints.finalizeDraft(
        draft.draftId,
        { trigger: { kind: 'explicit', signal: 'native', sourceEvent: 'round7c', reasonCode: 'test_checkpoint' } },
        async () => ({ files: [], commands: [] }),
      );
    }
    apiReturned = true;
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error);
  }
  const evidence = JSON.parse(await fs.readFile(process.env.IHOW_ATTACK_EVIDENCE, 'utf8'));
  const canonicalStat = await fs.stat(evidence.target, { bigint: true });
  const pinnedAliases = await aliasesFor(evidence.pinnedDirectory, evidence.owned);
  const replacementAliases = evidence.replacementDirectory === evidence.pinnedDirectory
    ? pinnedAliases
    : await aliasesFor(evidence.replacementDirectory, evidence.owned);
  result = {
    apiReturned,
    rejection,
    canonicalBytes: await fs.readFile(evidence.target, 'utf8'),
    canonicalIdentity: { dev: canonicalStat.dev.toString(), ino: canonicalStat.ino.toString() },
    replacementIdentity: evidence.replacement,
    ownedIdentity: evidence.owned,
    pinnedAliases,
    replacementAliases,
    injectedAliases: [...new Set([...pinnedAliases, ...replacementAliases])].filter((name) => name.startsWith('round7c-')).sort(),
    claimBasename: evidence.claim ? path.basename(evidence.claim) : undefined,
  };
} finally {
  console.log(JSON.stringify(result));
  await fs.rm(root, { recursive: true, force: true });
}
`;

const PARENT_OWNED_ALIAS_PRELOAD = String.raw`
const cp = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const originalSpawn = cp.spawn;
let attacked = false;
cp.spawn = function patchedSpawn(command, args, options) {
  const child = originalSpawn.apply(this, arguments);
  const argv = Array.isArray(args) ? args.map(String) : [];
  const isReaper = argv.includes('--reaper');
  const isGuard = argv.includes('--guard');
  const isFileWorker = argv.some((arg) => /checkpoint-file-worker\.(?:ts|js)$/.test(arg));
  const isClaimWorker = argv.some((arg) => /checkpoint-claim-worker\.(?:ts|js)$/.test(arg));
  if (!attacked && child.stdout && options && typeof options.cwd === 'string') {
    child.stdout.prependListener('data', (chunk) => {
      const output = String(chunk);
      if (attacked) return;
      if (
        (process.env.IHOW_ATTACK_KIND === 'file-alias' || process.env.IHOW_ATTACK_KIND === 'file-external-alias')
        && isFileWorker
        && !isReaper
        && output.includes('"event":"ready"')
      ) {
        attacked = true;
        const names = fs.readdirSync(options.cwd).filter((name) => /^draft_[a-f0-9-]+\.json$/.test(name));
        if (names.length !== 1) throw new Error('expected one draft target');
        const target = path.join(options.cwd, names[0]);
        const alias = process.env.IHOW_ATTACK_KIND === 'file-external-alias'
          ? path.join(path.dirname(options.cwd), 'round8-external-owned-alias')
          : path.join(options.cwd, 'round8-injected-owned-alias');
        fs.linkSync(target, alias);
        const owned = fs.statSync(target, { bigint: true });
        fs.writeFileSync(process.env.IHOW_ATTACK_EVIDENCE, JSON.stringify({
          directory: options.cwd,
          target,
          alias,
          owned: { dev: owned.dev.toString(), ino: owned.ino.toString() },
        }));
        return;
      }
      if (
        process.env.IHOW_ATTACK_KIND === 'claim-prepare-final'
        && isClaimWorker
        && !isReaper
        && !isGuard
        && output.includes('"ok":true,"result":"prepared"')
      ) {
        attacked = true;
        const claims = fs.readdirSync(options.cwd).filter((name) => /^\.cp_[a-f0-9]{64}\.claim-[a-f0-9-]+\.tmp$/.test(name));
        if (claims.length !== 1) throw new Error('unexpected prepare claim boundary names');
        const claim = path.join(options.cwd, claims[0]);
        const artifactId = claims[0].slice(1, claims[0].indexOf('.claim-'));
        const target = path.join(options.cwd, artifactId + '.json');
        fs.linkSync(claim, target);
        const owned = fs.statSync(claim, { bigint: true });
        fs.writeFileSync(process.env.IHOW_ATTACK_EVIDENCE, JSON.stringify({
          directory: options.cwd,
          target,
          claim,
          alias: target,
          owned: { dev: owned.dev.toString(), ino: owned.ino.toString() },
        }));
        return;
      }
      if (
        process.env.IHOW_ATTACK_KIND === 'claim-alias'
        && isClaimWorker
        && !isReaper
        && !isGuard
        && output.includes('"ok":true,"result":"created"')
      ) {
        attacked = true;
        const finals = fs.readdirSync(options.cwd).filter((name) => /^cp_[a-f0-9]{64}\.json$/.test(name));
        const claims = fs.readdirSync(options.cwd).filter((name) => /^\.cp_[a-f0-9]{64}\.claim-[a-f0-9-]+\.tmp$/.test(name));
        if (finals.length !== 1 || claims.length !== 1) throw new Error('unexpected claim boundary names');
        const target = path.join(options.cwd, finals[0]);
        const claim = path.join(options.cwd, claims[0]);
        const alias = path.join(options.cwd, 'round8-injected-claim-owned-alias');
        fs.linkSync(target, alias);
        const owned = fs.statSync(target, { bigint: true });
        fs.writeFileSync(process.env.IHOW_ATTACK_EVIDENCE, JSON.stringify({
          directory: options.cwd,
          target,
          claim,
          alias,
          owned: { dev: owned.dev.toString(), ino: owned.ino.toString() },
        }));
      }
    });
  }
  return child;
};
syncBuiltinESMExports();
`;

const PARENT_OWNED_ALIAS_SCENARIO = String.raw`
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

async function exists(file) {
  try { await fs.lstat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function aliasesFor(directory, expected) {
  const aliases = [];
  for (const name of await fs.readdir(directory)) {
    const stat = await fs.lstat(path.join(directory, name), { bigint: true });
    if (stat.isFile() && stat.dev.toString() === expected.dev && stat.ino.toString() === expected.ino) aliases.push(name);
  }
  return aliases.sort();
}

const { openCore } = await import(pathToFileURL(path.join(process.env.IHOW_REPO_ROOT, 'src/core.ts')).href);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-parent-owned-alias-api-'));
let result;
try {
  const project = path.join(root, 'project');
  await fs.mkdir(project);
  const core = await openCore({ root: path.join(root, 'store'), space: 'round8', cwd: project });
  let apiReturned = false;
  let rejection;
  try {
    const draft = await core.checkpoints.createDraft({ runtime: 'round8', claims: { completed: ['owned alias boundary'] } });
    if (process.env.IHOW_ATTACK_KIND === 'claim-alias' || process.env.IHOW_ATTACK_KIND === 'claim-prepare-final') {
      await core.checkpoints.finalizeDraft(
        draft.draftId,
        { trigger: { kind: 'explicit', signal: 'native', sourceEvent: 'round8', reasonCode: 'test_checkpoint' } },
        async () => ({ files: [], commands: [] }),
      );
    }
    apiReturned = true;
  } catch (error) {
    rejection = error instanceof Error ? error.message : String(error);
  }
  const evidence = JSON.parse(await fs.readFile(process.env.IHOW_ATTACK_EVIDENCE, 'utf8'));
  result = {
    apiReturned,
    rejection,
    pinnedAliases: await aliasesFor(evidence.directory, evidence.owned),
    canonicalExists: await exists(evidence.target),
    claimExists: evidence.claim ? await exists(evidence.claim) : undefined,
    injectedAliasExists: await exists(evidence.alias),
    externalAlias: process.env.IHOW_ATTACK_KIND === 'file-external-alias',
  };
} finally {
  console.log(JSON.stringify(result));
  await fs.rm(root, { recursive: true, force: true });
}
`;

async function runParentBoundaryScenario(t, label, preloadSource, scenarioSource, env = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `ihow-${label}-`));
  const preload = path.join(directory, 'spawn-preload.cjs');
  const scenario = path.join(directory, 'scenario.mjs');
  const evidence = path.join(directory, 'evidence.json');
  await Promise.all([
    fs.writeFile(preload, preloadSource, 'utf8'),
    fs.writeFile(scenario, scenarioSource, 'utf8'),
  ]);
  t.after(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', scenario], {
    env: {
      ...process.env,
      ...env,
      IHOW_REPO_ROOT: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
      IHOW_ATTACK_EVIDENCE: evidence,
      NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(' '),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const output = Buffer.concat(stdout).toString('utf8');
  const errors = Buffer.concat(stderr).toString('utf8');
  assert.deepEqual(status, { exitCode: 0, signal: null }, `scenario failed\nstdout:\n${output}\nstderr:\n${errors}`);
  assert.equal(errors, '');
  const lines = output.trim().split('\n');
  return JSON.parse(lines.at(-1));
}

test('parent createDraft ready-to-commit boundary rejects replacement and reaps every owned alias', async (t) => {
  const result = await runParentBoundaryScenario(
    t,
    'checkpoint-parent-file-boundary',
    PARENT_BOUNDARY_PRELOAD,
    PARENT_BOUNDARY_SCENARIO,
    { IHOW_ATTACK_KIND: 'file' },
  );
  assert.equal(result.apiReturned, false);
  assert.equal(result.rejection, 'checkpoint_path_outside_store');
  assert.equal(result.canonicalBytes, 'THIRD_PARTY_REPLACEMENT');
  assert.deepEqual(result.canonicalIdentity, result.replacementIdentity);
  assert.notDeepEqual(result.canonicalIdentity, result.ownedIdentity);
  assert.deepEqual(result.pinnedAliases, []);
  assert.deepEqual(result.replacementAliases, []);
});

test('parent finalizeDraft claim boundary rejects replacement and removes every injected owned alias', async (t) => {
  const result = await runParentBoundaryScenario(
    t,
    'checkpoint-parent-claim-boundary',
    PARENT_BOUNDARY_PRELOAD,
    PARENT_BOUNDARY_SCENARIO,
    { IHOW_ATTACK_KIND: 'claim' },
  );
  assert.equal(result.apiReturned, false);
  assert.equal(result.rejection, 'checkpoint_internal_failure');
  assert.equal(result.canonicalBytes, 'THIRD_PARTY_CLAIM_REPLACEMENT');
  assert.deepEqual(result.canonicalIdentity, result.replacementIdentity);
  assert.notDeepEqual(result.canonicalIdentity, result.ownedIdentity);
  assert.deepEqual(result.injectedAliases, []);
  assert.deepEqual(result.pinnedAliases, [result.claimBasename], 'only the durable canonical claim receipt remains');
});

test('parent createDraft rejects a pre-commit owned alias and reaps every pinned-directory link', async (t) => {
  const result = await runParentBoundaryScenario(
    t,
    'checkpoint-parent-file-owned-alias',
    PARENT_OWNED_ALIAS_PRELOAD,
    PARENT_OWNED_ALIAS_SCENARIO,
    { IHOW_ATTACK_KIND: 'file-alias' },
  );
  assert.equal(result.apiReturned, false);
  assert.equal(result.rejection, 'checkpoint_internal_failure');
  assert.deepEqual(result.pinnedAliases, []);
  assert.equal(result.canonicalExists, false);
  assert.equal(result.injectedAliasExists, false);
});

test('parent finalizeDraft rejects a pre-commit third owned alias and removes the failed durable receipt', async (t) => {
  const result = await runParentBoundaryScenario(
    t,
    'checkpoint-parent-claim-owned-alias',
    PARENT_OWNED_ALIAS_PRELOAD,
    PARENT_OWNED_ALIAS_SCENARIO,
    { IHOW_ATTACK_KIND: 'claim-alias' },
  );
  assert.equal(result.apiReturned, false);
  assert.equal(result.rejection, 'checkpoint_internal_failure');
  assert.deepEqual(result.pinnedAliases, []);
  assert.equal(result.canonicalExists, false);
  assert.equal(result.claimExists, false);
  assert.equal(result.injectedAliasExists, false);
});

test('parent finalizeDraft rejects a final hardlink injected before the first prepare commit', async (t) => {
  const result = await runParentBoundaryScenario(
    t,
    'checkpoint-parent-prepare-final-alias',
    PARENT_OWNED_ALIAS_PRELOAD,
    PARENT_OWNED_ALIAS_SCENARIO,
    { IHOW_ATTACK_KIND: 'claim-prepare-final' },
  );
  assert.equal(result.apiReturned, false);
  assert.equal(result.rejection, 'checkpoint_internal_failure');
  assert.deepEqual(result.pinnedAliases, []);
  assert.equal(result.canonicalExists, false);
  assert.equal(result.claimExists, false);
  assert.equal(result.injectedAliasExists, false);
});

test('parent createDraft fails closed when nlink exceeds the enumerable allowed basename set', async (t) => {
  const result = await runParentBoundaryScenario(
    t,
    'checkpoint-parent-file-external-owned-alias',
    PARENT_OWNED_ALIAS_PRELOAD,
    PARENT_OWNED_ALIAS_SCENARIO,
    { IHOW_ATTACK_KIND: 'file-external-alias' },
  );
  assert.equal(result.apiReturned, false);
  assert.equal(result.rejection, 'checkpoint_internal_failure');
  assert.deepEqual(result.pinnedAliases, []);
  assert.equal(result.canonicalExists, false);
  assert.equal(result.injectedAliasExists, true, 'the external hardlink is intentionally not located or removed');
});

test('normal API success retains the exact owned hardlink cardinality', async (t) => {
  const core = await tempCore(t, 'checkpoint-owned-link-cardinality');
  const draft = await core.checkpoints.createDraft({ runtime: 'round8', claims: { completed: ['exact file link'] } });
  const paths = checkpointStorePaths(core.workspace);
  const draftStat = await fs.stat(path.join(paths.drafts, `${draft.draftId}.json`), { bigint: true });
  assert.equal(draftStat.nlink, 1n);

  const finalized = await core.checkpoints.finalizeDraft(
    draft.draftId,
    explicit,
    async () => ({ files: [], commands: [] }),
  );
  const artifactIdentity = await fs.stat(path.join(paths.artifacts, `${finalized.artifact.id}.json`), { bigint: true });
  assert.equal(artifactIdentity.nlink, 2n);
  const aliases = [];
  for (const name of await fs.readdir(paths.artifacts)) {
    const stat = await fs.lstat(path.join(paths.artifacts, name), { bigint: true });
    if (stat.isFile() && stat.dev === artifactIdentity.dev && stat.ino === artifactIdentity.ino) aliases.push(name);
  }
  assert.equal(aliases.length, 2);
  assert.ok(aliases.includes(`${finalized.artifact.id}.json`));
  assert.ok(aliases.some((name) => name.startsWith(`.${finalized.artifact.id}.claim-`)));
});

test('prepare refuses an existing receipt that is already linked to the final basename', async (t) => {
  const core = await tempCore(t, 'checkpoint-round9-reprepare');
  const draft = await core.checkpoints.createDraft({ runtime: 'round9', claims: { completed: ['strict prepared binding'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const finalName = `${artifact.id}.json`;

  await prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId);
  assert.equal(await linkCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId), 'created');
  const owned = await fs.stat(path.join(paths.artifacts, claimName), { bigint: true });
  assert.equal(owned.nlink, 2n);

  let returned = false;
  await assert.rejects(
    prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId).then(() => { returned = true; }),
    /checkpoint_internal_failure/,
  );
  assert.equal(returned, false);
  const aliases = [];
  for (const name of await fs.readdir(paths.artifacts)) {
    const stat = await fs.lstat(path.join(paths.artifacts, name), { bigint: true });
    if (stat.isFile() && stat.dev === owned.dev && stat.ino === owned.ino) aliases.push(name);
  }
  assert.deepEqual(aliases, []);
  await assert.rejects(fs.access(path.join(paths.artifacts, claimName)), /ENOENT/);
  await assert.rejects(fs.access(path.join(paths.artifacts, finalName)), /ENOENT/);
});

async function runAtClaimWorkerPhase(operation, controlDirectory, phase, action) {
  const outcome = operation().then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', error }),
  );
  const ready = path.join(controlDirectory, `${phase}.ready`);
  const release = path.join(controlDirectory, `${phase}.release`);
  await Promise.race([
    waitForFile(ready),
    outcome.then((result) => {
      throw result.status === 'rejected'
        ? result.error
        : new Error(`claim worker completed before ${phase}`);
    }),
  ]);
  await action();
  await fs.writeFile(release, '', { flag: 'wx' });
  const result = await outcome;
  if (result.status === 'rejected') throw result.error;
  return result.value;
}

async function stageCreatedFinalization(core, draft, artifact, build, link = false) {
  const writeClaimId = crypto.randomUUID();
  await prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId);
  await writeCheckpointFinalizationIntentUnlocked(core.workspace, {
    schemaVersion: 1,
    draftId: draft.draftId,
    artifactId: artifact.id,
    creationProvenance: 'created',
    writeClaimId,
    build,
  });
  if (link) {
    assert.equal(await linkCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId), 'created');
  }
  return writeClaimId;
}

async function createAndFinalize(core, claims = {}, request = explicit, provider = anchorProvider()) {
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'session-1', claims });
  const result = await core.checkpoints.finalizeDraft(draft.draftId, request, provider);
  return { draft, ...result };
}

test('property-style bounds are deterministic, canonical, hash-addressed, and <= 32 KiB', () => {
  const project = { cwdHash: '2'.repeat(64), workspaceId: '3'.repeat(64), projectId: '1'.repeat(64) };
  const session = { runtime: 'unit', sessionIdHash: '4'.repeat(64) };
  for (const size of [0, 1, 20, 21, 80]) {
    const long = '🧪'.repeat(700);
    const claimsInput = {
      objective: long,
      completed: Array.from({ length: size }, (_, i) => `completed-${i}-${long}`),
      pending: Array.from({ length: size }, (_, i) => `pending-${i}-${long}`),
      decisions: Array.from({ length: size }, (_, i) => `decision-${i}-${long}`),
      blockers: Array.from({ length: size }, (_, i) => `blocker-${i}-${long}`),
      nextActions: Array.from({ length: size }, (_, i) => `next-${i}-${long}`),
      evidence: Array.from({ length: size + 10 }, (_, i) => ({ kind: `kind-${i}`, ref: `ref-${i}-${long}`, sha256: ZERO_HASH })),
      coverage: { complete: false, eventCount: size },
    };
    const normalized = normalizeCheckpointClaimsInput(claimsInput);
    const anchors = normalizeMachineAnchors({
      files: Array.from({ length: size + 20 }, (_, i) => ({ path: `src/${i}-${long}`, sha256: ZERO_HASH })),
      commands: Array.from({ length: size + 10 }, (_, i) => ({ label: `command-${i}-${long}`, exitCode: i })),
    });
    const make = () => buildCheckpointArtifact({
      project,
      session,
      createdAt: '2026-07-12T08:00:00.000Z',
      trigger: explicit.trigger,
      state: normalized.claims,
      anchors: anchors.anchors,
      evidence: normalized.evidence,
      coverage: normalized.coverage,
      redaction: normalized.redaction,
      anchorOmittedCounts: anchors.omittedCounts,
      anchorRedaction: anchors.redaction,
    });
    const a = make();
    const b = make();
    assert.equal(a.id, b.id);
    assert.equal(a.integrity.contentSha256, a.id.slice(3));
    const semanticSha256 = computeCheckpointSemanticSha256(a);
    const laterEquivalent = structuredClone(a);
    laterEquivalent.createdAt = '2026-07-12T09:00:00.000Z';
    assert.equal(computeCheckpointSemanticSha256(laterEquivalent), semanticSha256);
    assert.notEqual(computeCheckpointContentSha256(laterEquivalent), a.integrity.contentSha256);
    assert.equal(canonicalCheckpointJson(a), canonicalCheckpointJson(b));
    assert.ok(Buffer.byteLength(canonicalCheckpointJson(a), 'utf8') <= CHECKPOINT_ARTIFACT_MAX_BYTES);
    assert.ok(a.state.completed.length <= 20);
    assert.ok(a.evidence.length <= 24);
    assert.ok(a.anchors.files.length <= 32);
    for (const item of [...a.state.completed, ...a.state.pending, ...a.state.decisions, ...a.state.blockers, ...a.state.nextActions]) {
      assert.ok(Array.from(item).length <= 512);
    }
    if (size > 20) assert.ok(Object.keys(a.coverage.omittedCounts).length > 0);
    if (Object.keys(a.coverage.omittedCounts).length > 0) assert.equal(a.coverage.complete, false);
  }
});

test('semantic fingerprint excludes createdAt and deduplicates equivalent drafts', async (t) => {
  const core = await tempCore(t, 'checkpoint-semantic-dedup');
  const claims = {
    completed: ['same semantic checkpoint'],
    evidence: [{ kind: 'test', ref: 'same evidence', sha256: ZERO_HASH }],
    coverage: { complete: true, eventCount: 7 },
  };
  const firstDraft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'same-session', claims });
  const first = await core.checkpoints.finalizeDraft(firstDraft.draftId, explicit, anchorProvider());
  await new Promise((resolve) => setTimeout(resolve, 10));
  const secondDraft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'same-session', claims });
  const second = await core.checkpoints.finalizeDraft(secondDraft.draftId, explicit, anchorProvider());

  assert.notEqual(firstDraft.draftId, secondDraft.draftId);
  assert.equal(second.deduplicated, true);
  assert.equal(second.artifact.id, first.artifact.id);
  assert.deepEqual(Object.keys(second.artifact.integrity), ['contentSha256']);
  assert.equal(Object.hasOwn(second.artifact, 'sourceDraftId'), false, 'public artifact keeps the documented v1 schema');
  assert.equal((await core.checkpoints.list()).length, 1);

  const paths = checkpointStorePaths(core.workspace);
  const storedSecondDraft = JSON.parse(await fs.readFile(path.join(paths.drafts, `${secondDraft.draftId}.json`), 'utf8'));
  assert.equal(storedSecondDraft.finalization.artifactId, first.artifact.id);
});

test('dedup finalization intent prevents replacement anchors after audit-before-marker crash', async (t) => {
  const core = await tempCore(t, 'checkpoint-dedup-crash-recovery');
  const claims = { completed: ['stable semantic state'], coverage: { complete: true, eventCount: 1 } };
  const firstDraft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'dedup-crash', claims });
  const first = await core.checkpoints.finalizeDraft(firstDraft.draftId, explicit, anchorProvider());
  const secondDraft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'dedup-crash', claims });
  const dedupAnchors = normalizeMachineAnchors(await anchorProvider()());
  await writeCheckpointFinalizationIntentUnlocked(core.workspace, {
    schemaVersion: 1,
    draftId: secondDraft.draftId,
    artifactId: first.artifact.id,
    creationProvenance: 'deduplicated',
    build: finalizationBuild(dedupAnchors, first.artifact.createdAt),
  });
  await appendCheckpointAuditUnlocked(core.workspace, {
    type: 'checkpoint.artifact.deduplicated',
    operation: 'artifact.finalize',
    draftId: secondDraft.draftId,
    artifactId: first.artifact.id,
  });

  let providerCalls = 0;
  const recovered = await core.checkpoints.finalizeDraft(secondDraft.draftId, explicit, async () => {
    providerCalls += 1;
    return { files: [{ path: 'replacement-anchor-must-not-land.ts', sha256: ZERO_HASH }], commands: [] };
  });
  assert.equal(providerCalls, 0);
  assert.equal(recovered.deduplicated, true);
  assert.equal(recovered.artifact.id, first.artifact.id);
  assert.equal((await core.checkpoints.list()).length, 1);
  const events = (await core.checkpoints.audit()).filter((event) => event.operation === 'artifact.finalize' && event.draftId === secondDraft.draftId);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'checkpoint.artifact.deduplicated');
});

test('finalization-intent crash recovery lands the exact artifact before collecting replacement anchors', async (t) => {
  const core = await tempCore(t, 'checkpoint-crash-recovery');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'crash-session', claims: { completed: ['land once'] } });
  const oldAnchors = normalizeMachineAnchors(await anchorProvider()());
  const landed = buildCheckpointArtifact({
    project: draft.project,
    session: draft.session,
    createdAt: '2026-07-12T08:00:00.000Z',
    trigger: explicit.trigger,
    state: draft.claims,
    anchors: oldAnchors.anchors,
    evidence: draft.evidence,
    coverage: draft.coverage,
    redaction: draft.redaction,
    anchorOmittedCounts: oldAnchors.omittedCounts,
    anchorRedaction: oldAnchors.redaction,
  });
  await stageCreatedFinalization(core, draft, landed, finalizationBuild(oldAnchors, landed.createdAt));

  let providerCalls = 0;
  const retry = await core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
    providerCalls += 1;
    return { files: [{ path: 'new-anchor-must-not-mix.ts', sha256: ZERO_HASH }], commands: [] };
  });
  assert.equal(providerCalls, 0, 'recovery happens before replacement anchor collection');
  assert.equal(retry.deduplicated, true);
  assert.equal(retry.artifact.id, landed.id);
  assert.deepEqual(retry.artifact.anchors, landed.anchors);
  assert.equal((await core.checkpoints.list()).length, 1);

  const paths = checkpointStorePaths(core.workspace);
  const healedDraft = JSON.parse(await fs.readFile(path.join(paths.drafts, `${draft.draftId}.json`), 'utf8'));
  assert.deepEqual(healedDraft.finalization, { artifactId: landed.id });
  assert.equal((await core.checkpoints.audit()).filter((event) => event.type === 'checkpoint.artifact.created').length, 1);
  await assert.rejects(fs.access(path.join(paths.finalizations, `${draft.draftId}.json`)));
});

test('finalize-middle recovery does not duplicate an audit event that landed before the draft marker', async (t) => {
  const core = await tempCore(t, 'checkpoint-crash-audit');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'crash-audit', claims: { completed: ['audit once'] } });
  const anchors = normalizeMachineAnchors(await anchorProvider()());
  const artifact = buildCheckpointArtifact({
    project: draft.project,
    session: draft.session,
    createdAt: '2026-07-12T08:00:00.000Z',
    trigger: explicit.trigger,
    state: draft.claims,
    anchors: anchors.anchors,
    evidence: draft.evidence,
    coverage: draft.coverage,
    redaction: draft.redaction,
    anchorOmittedCounts: anchors.omittedCounts,
    anchorRedaction: anchors.redaction,
  });
  await stageCreatedFinalization(core, draft, artifact, finalizationBuild(anchors, artifact.createdAt), true);
  await appendCheckpointAuditUnlocked(core.workspace, {
    type: 'checkpoint.artifact.created',
    operation: 'artifact.finalize',
    draftId: draft.draftId,
    artifactId: artifact.id,
  });

  let providerCalls = 0;
  const recovered = await core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
    providerCalls += 1;
    return { files: [], commands: [] };
  });
  assert.equal(providerCalls, 0);
  assert.equal(recovered.artifact.id, artifact.id);
  const events = (await core.checkpoints.audit()).filter((event) => event.operation === 'artifact.finalize' && event.draftId === draft.draftId);
  assert.equal(events.length, 1);
});

test('hard-kill after immutable artifact creation but before audit recovers a factual created event', async (t) => {
  const core = await tempCore(t, 'checkpoint-crash-created-provenance');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'crash-created', claims: { completed: ['created before kill'] } });
  const anchors = normalizeMachineAnchors(await anchorProvider()());
  const artifact = buildCheckpointArtifact({
    project: draft.project,
    session: draft.session,
    createdAt: '2026-07-12T08:00:00.000Z',
    trigger: explicit.trigger,
    state: draft.claims,
    anchors: anchors.anchors,
    evidence: draft.evidence,
    coverage: draft.coverage,
    redaction: draft.redaction,
    anchorOmittedCounts: anchors.omittedCounts,
    anchorRedaction: anchors.redaction,
  });
  const writeClaimId = await stageCreatedFinalization(core, draft, artifact, finalizationBuild(anchors, artifact.createdAt), true);

  let providerCalls = 0;
  const recovered = await core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
    providerCalls += 1;
    return { files: [], commands: [] };
  });
  assert.equal(providerCalls, 0);
  assert.equal(recovered.deduplicated, true, 'API retry reused the already-created artifact');
  const events = (await core.checkpoints.audit()).filter((event) => event.operation === 'artifact.finalize' && event.draftId === draft.draftId);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'checkpoint.artifact.created', 'audit records the original filesystem creation, not retry deduplication');

  await core.checkpoints.finalizeDraft(draft.draftId, explicit, anchorProvider());
  const afterRetry = (await core.checkpoints.audit()).filter((event) => event.operation === 'artifact.finalize' && event.draftId === draft.draftId);
  assert.equal(afterRetry.length, 1, 'audit healing remains idempotent');
  const paths = checkpointStorePaths(core.workspace);
  const claimPath = path.join(paths.artifacts, `.${artifact.id}.claim-${writeClaimId}.tmp`);
  const [claimStat, artifactStat] = await Promise.all([
    fs.stat(claimPath),
    fs.stat(path.join(paths.artifacts, `${artifact.id}.json`)),
  ]);
  assert.equal(claimStat.ino, artifactStat.ino, 'completed recovery retains its private claim as a hardlink receipt');
  assert.equal(claimStat.dev, artifactStat.dev);
});

test('drafts are deterministically bounded and oversized out-of-band drafts fail closed before read', async (t) => {
  const core = await tempCore(t, 'checkpoint-draft-bounds');
  const long = '界'.repeat(700);
  const claims = {
    objective: long,
    completed: Array.from({ length: 80 }, (_, i) => `completed-${i}-${long}`),
    pending: Array.from({ length: 80 }, (_, i) => `pending-${i}-${long}`),
    decisions: Array.from({ length: 80 }, (_, i) => `decision-${i}-${long}`),
    blockers: Array.from({ length: 80 }, (_, i) => `blocker-${i}-${long}`),
    nextActions: Array.from({ length: 80 }, (_, i) => `next-${i}-${long}`),
    evidence: Array.from({ length: 80 }, (_, i) => ({ kind: `kind-${i}`, ref: `${long}-${i}` })),
  };
  const one = await core.checkpoints.createDraft({ runtime: 'unit', claims });
  const two = await core.checkpoints.createDraft({ runtime: 'unit', claims });
  assert.ok(Buffer.byteLength(canonicalCheckpointJson(one), 'utf8') <= CHECKPOINT_DRAFT_MAX_BYTES - 256);
  assert.deepEqual(one.claims, two.claims);
  assert.deepEqual(one.evidence, two.evidence);
  assert.deepEqual(one.coverage.omittedCounts, two.coverage.omittedCounts);
  assert.ok(Object.keys(one.coverage.omittedCounts).length > 0);
  assert.equal(one.coverage.complete, false);

  const oversized = structuredClone(one);
  const item = 'x'.repeat(512);
  oversized.claims = {
    objective: item,
    completed: Array(20).fill(item),
    pending: Array(20).fill(item),
    decisions: Array(20).fill(item),
    blockers: Array(20).fill(item),
    nextActions: Array(20).fill(item),
  };
  assert.ok(Buffer.byteLength(canonicalCheckpointJson(oversized), 'utf8') > CHECKPOINT_DRAFT_MAX_BYTES);
  assert.throws(() => validateCheckpointDraft(oversized), /checkpoint_draft_too_large/);

  const paths = checkpointStorePaths(core.workspace);
  await fs.writeFile(path.join(paths.drafts, `${one.draftId}.json`), canonicalCheckpointJson(oversized), 'utf8');
  await assert.rejects(
    core.checkpoints.updateDraft(one.draftId, { claims: { completed: ['must not read oversized draft'] } }),
    /checkpoint_draft_too_large/,
  );
});

test('artifact and draft reads reject over-limit files by stat before JSON parsing', async (t) => {
  const core = await tempCore(t, 'checkpoint-stat-bounds');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['safe'] } });
  const paths = checkpointStorePaths(core.workspace);
  const huge = 'x'.repeat(CHECKPOINT_ARTIFACT_MAX_BYTES + 1);
  const artifactId = `cp_${'a'.repeat(64)}`;
  await fs.writeFile(path.join(paths.artifacts, `${artifactId}.json`), huge, 'utf8');
  await assert.rejects(core.checkpoints.read(artifactId), /checkpoint_artifact_too_large/);

  await fs.writeFile(path.join(paths.drafts, `${draft.draftId}.json`), huge, 'utf8');
  await assert.rejects(
    core.checkpoints.updateDraft(draft.draftId, { claims: { pending: ['still safe'] } }),
    /checkpoint_draft_too_large/,
  );
});

test('audit reads reconstruct only strict whitelisted events', async (t) => {
  const core = await tempCore(t, 'checkpoint-audit-whitelist');
  await core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['safe'] } });
  const before = await core.checkpoints.audit();
  const paths = checkpointStorePaths(core.workspace);
  const at = '2026-07-12T08:00:00.000Z';
  const malicious = [
    { schemaVersion: 1, id: '00000000-0000-4000-8000-000000000001', at, type: 'checkpoint.rejected', operation: 'artifact.read', reasonCode: 'checkpoint_bad', raw: 'api_key: ABCDEF0123456789' },
    { schemaVersion: 1, id: 'not-a-uuid', at, type: 'checkpoint.rejected', operation: 'artifact.read', reasonCode: 'checkpoint_bad' },
    { schemaVersion: 1, id: '00000000-0000-4000-8000-000000000002', at, type: 'checkpoint.rejected', operation: 'artifact.read', reasonCode: 'checkpoint_api_key_abcdef0123456789' },
    { schemaVersion: 1, id: '00000000-0000-4000-8000-000000000003', at, type: 'checkpoint.artifact.created', operation: 'artifact.finalize', draftId: 'draft_invalid', artifactId: `cp_${'b'.repeat(64)}` },
  ];
  await fs.appendFile(paths.audit, `${malicious.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
  const after = await core.checkpoints.audit();
  assert.deepEqual(after, before);
  assert.doesNotMatch(JSON.stringify(after), /ABCDEF0123456789|api_key|raw/);
});

test('draft is mutable and separate; artifact is immutable and core list/read/inspect do not promote', async (t) => {
  const core = await tempCore(t, 'checkpoint-separation');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['first'] } });
  const updated = await core.checkpoints.updateDraft(draft.draftId, { claims: { completed: ['first'], nextActions: ['second'] } });
  assert.deepEqual(updated.claims.completed, ['first']);
  assert.notEqual(updated.updatedAt, undefined);

  const first = await core.checkpoints.finalizeDraft(draft.draftId, explicit, anchorProvider());
  assert.equal(first.deduplicated, false);
  await assert.rejects(core.checkpoints.updateDraft(draft.draftId, { claims: { pending: ['must not overwrite'] } }), /checkpoint_draft_finalization_started/);

  const before = canonicalCheckpointJson(first.artifact);
  const retry = await core.checkpoints.finalizeDraft(draft.draftId, explicit, anchorProvider({ files: [{ path: 'different.ts' }] }));
  assert.equal(retry.deduplicated, true);
  assert.equal(canonicalCheckpointJson(retry.artifact), before, 'retry returns the already immutable artifact');

  const listed = await core.checkpoints.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, first.artifact.id);
  assert.deepEqual(await core.checkpoints.read(first.artifact.id), first.artifact);
  const inspected = await core.checkpoints.inspect(first.artifact.id);
  assert.equal(inspected.integrity.valid, true);
  assert.equal(inspected.canonical, true);

  const markdown = await fs.readdir(core.workspace.memoryDir, { recursive: true });
  assert.equal(markdown.some((name) => String(name).endsWith('.md') && String(name).includes('checkpoint')), false, 'checkpoint never enters curated/promoted memory');
});

test('planted checkpoint-store symlinks are rejected before any outside write', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-symlink-')));
  const project = path.join(root, 'project');
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-outside-')));
  await fs.mkdir(project);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  const core = await openCore({ root: path.join(root, 'store'), space: 'checkpoint-test', cwd: project });
  const paths = checkpointStorePaths(core.workspace);
  await fs.mkdir(path.dirname(paths.root), { recursive: true });
  await fs.symlink(outside, paths.root, 'dir');

  await assert.rejects(
    core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['must stay inside'] } }),
    /checkpoint_path_outside_store/,
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('secret and schema failures are fail-closed and persist only minimal raw-free rejection audit', async (t) => {
  const core = await tempCore(t, 'checkpoint-secret');
  const secret = 'api_key: ' + 'ABCDEF0123456789';
  await assert.rejects(
    core.checkpoints.createDraft({ runtime: 'unit', claims: { objective: `do not persist ${secret}` } }),
    /checkpoint_secret_rejected/,
  );
  // Model-facing claims input cannot inject machine facts through an `anchors` property.
  await assert.rejects(
    core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['safe'] }, anchors: { git: { head: 'invented' } } }),
    /checkpoint_schema_draft_create_unknown_field/,
  );
  await assert.rejects(
    core.checkpoints.createDraft({ runtime: 'operator@example.com', claims: { pending: ['safe'] } }),
    /checkpoint_schema_session_runtime_requires_non_sensitive_code/,
  );
  const paths = checkpointStorePaths(core.workspace);
  const drafts = await fs.readdir(paths.drafts);
  const artifacts = await fs.readdir(paths.artifacts);
  assert.deepEqual(drafts, []);
  assert.deepEqual(artifacts, []);
  const auditRaw = await fs.readFile(paths.audit, 'utf8');
  assert.doesNotMatch(auditRaw, /ABCDEF0123456789|api_key|do not persist|invented|operator@example\.com/);
  const safeDraft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['safe before anchor rejection'] } });
  await assert.rejects(
    core.checkpoints.finalizeDraft(safeDraft.draftId, explicit, async () => ({ files: [{ path: `token=${'Z'.repeat(24)}` }], commands: [] })),
    /checkpoint_secret_rejected/,
  );
  assert.deepEqual(await fs.readdir(paths.artifacts), []);
  const auditRawAfterAnchorRejection = await fs.readFile(paths.audit, 'utf8');
  assert.doesNotMatch(auditRawAfterAnchorRejection, /ZZZZZZ|token=/);
  const audit = await core.checkpoints.audit();
  assert.equal(audit.filter((event) => event.type === 'checkpoint.rejected').length, 4);
  assert.deepEqual(Object.keys(audit.find((event) => event.type === 'checkpoint.rejected')).sort(), ['at', 'id', 'operation', 'reasonCode', 'schemaVersion', 'type']);
});

test('checkpoint-only natural-language secret assignments reject drafts, anchors, and validly rehashed out-of-band artifacts', async (t) => {
  const core = await tempCore(t, 'checkpoint-natural-secret');
  const naturalSecrets = [
    'password is x',
    'password is ab',
    'password is xyz',
    'password is !',
    'password is ,',
    'password is ;',
    'password is :',
    'api key is VALUE1234',
    'the password is hunter2',
    'secret was OPENSESAME',
    'client secret is "correct-horse-battery-staple"',
    'the password is "required" before deployment',
    'the API key is `stored` in the external vault',
    "the secret was 'disclosed' during incident review",
    'the password is valid',
  ];
  for (const text of naturalSecrets) {
    await assert.rejects(
      core.checkpoints.createDraft({ runtime: 'unit', claims: { objective: text } }),
      /checkpoint_secret_rejected/,
      text,
    );
  }

  const prose = await core.checkpoints.createDraft({
    runtime: 'unit',
    claims: {
      pending: [
        'The password is required before deployment.',
        'The API key is stored in the external vault.',
        'The secret was disclosed during incident review.',
      ],
    },
  });
  assert.equal(prose.claims.pending.length, 3, 'ordinary status prose is not mistaken for a secret value');

  await assert.rejects(
    core.checkpoints.updateDraft(prose.draftId, { claims: { pending: ['password is xy'] } }),
    /checkpoint_secret_rejected/,
  );

  await assert.rejects(
    core.checkpoints.finalizeDraft(prose.draftId, explicit, async () => ({
      files: [{ path: 'the password is `stored` in the external vault' }],
      commands: [],
    })),
    /checkpoint_secret_rejected/,
  );

  const safe = await createAndFinalize(core, { completed: ['safe persisted checkpoint'] });
  const tampered = structuredClone(safe.artifact);
  tampered.state.completed = ['the password is xy'];
  const rehashed = rehashArtifact(tampered);
  const paths = checkpointStorePaths(core.workspace);
  await fs.writeFile(path.join(paths.artifacts, `${rehashed.id}.json`), canonicalCheckpointJson(rehashed), 'utf8');
  await assert.rejects(core.checkpoints.read(rehashed.id), /checkpoint_secret_rejected/);
  const inspection = await core.checkpoints.inspect(rehashed.id);
  assert.equal(inspection.integrity.valid, false);
  assert.equal(inspection.integrity.reasonCode, 'checkpoint_secret_rejected');

  const poisonedDraft = structuredClone(prose);
  poisonedDraft.claims.pending = ['api key is z'];
  await fs.writeFile(path.join(paths.drafts, `${prose.draftId}.json`), canonicalCheckpointJson(poisonedDraft), 'utf8');
  await assert.rejects(
    core.checkpoints.updateDraft(prose.draftId, { claims: { pending: ['replacement'] } }),
    /checkpoint_secret_rejected/,
  );

  const intentDraft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'intent-secret', claims: { pending: ['safe intent'] } });
  const intentAnchors = normalizeMachineAnchors({ files: [], commands: [] });
  const poisonedBuild = finalizationBuild(intentAnchors, '2026-07-12T08:00:00.000Z');
  poisonedBuild.anchors.files = [{ path: 'password is q' }];
  await assert.rejects(
    writeCheckpointFinalizationIntentUnlocked(core.workspace, {
      schemaVersion: 1,
      draftId: intentDraft.draftId,
      artifactId: `cp_${'e'.repeat(64)}`,
      creationProvenance: 'created',
      writeClaimId: crypto.randomUUID(),
      build: poisonedBuild,
    }),
    /checkpoint_secret_rejected/,
  );
});

test('coverage complete is forced false on generated omissions and rejected when persisted out of band', async (t) => {
  const normalized = normalizeCheckpointClaimsInput({
    completed: Array.from({ length: 21 }, (_, index) => `item-${index}`),
    coverage: { complete: true, eventCount: 21 },
  });
  assert.ok(Object.keys(normalized.coverage.omittedCounts).length > 0);
  assert.equal(normalized.coverage.complete, false);

  const core = await tempCore(t, 'checkpoint-coverage-omissions');
  const draft = await core.checkpoints.createDraft({
    runtime: 'unit',
    claims: {
      completed: Array.from({ length: 21 }, (_, index) => `item-${index}`),
      coverage: { complete: true, eventCount: 21 },
    },
  });
  assert.equal(draft.coverage.complete, false);
  const artifact = await core.checkpoints.finalizeDraft(draft.draftId, explicit, anchorProvider({
    files: Array.from({ length: 33 }, (_, index) => ({ path: `src/${index}.ts`, sha256: ZERO_HASH })),
  }));
  assert.equal(artifact.artifact.coverage.complete, false);

  const anchorOnlyDraft = await core.checkpoints.createDraft({
    runtime: 'unit',
    sessionId: 'anchor-only-omissions',
    claims: { completed: ['claims are complete'], coverage: { complete: true, eventCount: 1 } },
  });
  assert.equal(anchorOnlyDraft.coverage.complete, true);
  const anchorOnly = await core.checkpoints.finalizeDraft(anchorOnlyDraft.draftId, explicit, anchorProvider({
    files: Array.from({ length: 33 }, (_, index) => ({ path: `anchors/${index}.ts`, sha256: ZERO_HASH })),
  }));
  assert.equal(anchorOnly.artifact.coverage.complete, false);
  assert.ok(Object.hasOwn(anchorOnly.artifact.coverage.omittedCounts, 'anchors.files.items'));
  const anchorOnlyRetry = await core.checkpoints.finalizeDraft(anchorOnlyDraft.draftId, explicit, anchorProvider());
  assert.equal(anchorOnlyRetry.artifact.id, anchorOnly.artifact.id, 'marker validation accepts the generated complete→incomplete coverage transition');

  const invalidDraft = structuredClone(draft);
  invalidDraft.coverage.complete = true;
  assert.throws(() => validateCheckpointDraft(invalidDraft), /checkpoint_schema_coverage_complete_with_omissions/);
  const paths = checkpointStorePaths(core.workspace);
  await fs.writeFile(path.join(paths.drafts, `${draft.draftId}.json`), canonicalCheckpointJson(invalidDraft), 'utf8');
  await assert.rejects(
    core.checkpoints.updateDraft(draft.draftId, { claims: { completed: ['must not normalize persisted corruption'] } }),
    /checkpoint_schema_coverage_complete_with_omissions/,
  );

  const invalidArtifact = structuredClone(artifact.artifact);
  invalidArtifact.coverage.complete = true;
  const rehashed = rehashArtifact(invalidArtifact);
  await fs.writeFile(path.join(paths.artifacts, `${rehashed.id}.json`), canonicalCheckpointJson(rehashed), 'utf8');
  await assert.rejects(core.checkpoints.read(rehashed.id), /checkpoint_schema_coverage_complete_with_omissions/);
});

test('PII is redacted across claims, evidence, and engine-provided anchors with metadata recorded', async (t) => {
  const core = await tempCore(t, 'checkpoint-pii');
  const result = await createAndFinalize(
    core,
    {
      objective: 'Contact alice@example.com after the test.',
      evidence: [{ kind: 'message', ref: 'mail bob@example.net' }],
    },
    explicit,
    anchorProvider({ files: [{ path: '/Users/carol@example.org/project/file.ts', sha256: ZERO_HASH }], commands: [] }),
  );
  const raw = canonicalCheckpointJson(result.artifact);
  assert.doesNotMatch(raw, /alice@example\.com|bob@example\.net|carol@example\.org/);
  assert.match(raw, /\[redacted\]/);
  assert.equal(result.artifact.redaction.applied, true);
  assert.ok(result.artifact.redaction.count >= 3);
});

test('machine anchors come only from the provider; finalize payload anchor injection is rejected', async (t) => {
  const core = await tempCore(t, 'checkpoint-anchor-injection');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['model says git is clean'] } });
  let providerCalled = false;
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, { ...explicit, anchors: { git: { repo: 'fake', head: 'fake' } } }, async () => {
      providerCalled = true;
      return { files: [], commands: [] };
    }),
    /checkpoint_schema_finalize_unknown_field/,
  );
  assert.equal(providerCalled, false, 'schema rejection happens before any anchor collection');
  assert.deepEqual(await core.checkpoints.list(), []);

  const finalized = await core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => ({ git: { repo: 'engine-repo', head: 'engine-head', dirty: true }, files: [], commands: [] }));
  assert.equal(finalized.artifact.anchors.git.repo, 'engine-repo');
  assert.equal(finalized.artifact.anchors.git.head, 'engine-head');
  assert.equal(finalized.artifact.state.completed[0], 'model says git is clean');
});

test('supersedes is explicit, validated, same-project, and never overwrites the prior artifact', async (t) => {
  const core = await tempCore(t, 'checkpoint-supersedes');
  const one = await createAndFinalize(core, { completed: ['phase one'] });
  const oneRawBefore = canonicalCheckpointJson(one.artifact);
  const two = await createAndFinalize(core, { completed: ['phase two'] }, { ...explicit, supersedes: one.artifact.id });
  assert.equal(two.artifact.supersedes, one.artifact.id);
  assert.notEqual(two.artifact.id, one.artifact.id);
  assert.equal(canonicalCheckpointJson(await core.checkpoints.read(one.artifact.id)), oneRawBefore);
  assert.equal((await core.checkpoints.list()).length, 2);

  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['bad parent'] } });
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, { ...explicit, supersedes: `cp_${'f'.repeat(64)}` }, anchorProvider()),
    /checkpoint_artifact_not_found/,
  );
  assert.equal((await core.checkpoints.list()).length, 2, 'missing supersedes creates no artifact');
});

test('supersedes cannot cross project identities in a shared checkpoint store', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-cross-project-')));
  const firstProject = path.join(root, 'project-one');
  const secondProject = path.join(root, 'project-two');
  await fs.mkdir(firstProject);
  await fs.mkdir(secondProject);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const options = { root: path.join(root, 'store'), space: 'shared-checkpoints' };
  const firstCore = await openCore({ ...options, cwd: firstProject });
  const secondCore = await openCore({ ...options, cwd: secondProject });
  const first = await createAndFinalize(firstCore, { completed: ['project one'] });
  const secondDraft = await secondCore.checkpoints.createDraft({ runtime: 'unit', sessionId: 'session-1', claims: { completed: ['project two'] } });

  await assert.rejects(
    secondCore.checkpoints.finalizeDraft(secondDraft.draftId, { ...explicit, supersedes: first.artifact.id }, anchorProvider()),
    /checkpoint_supersedes_project_mismatch/,
  );
  assert.equal((await firstCore.checkpoints.list()).length, 1);
});

test('finalization recovery reconciles the current trigger and supersedes before provider calls', async (t) => {
  const core = await tempCore(t, 'checkpoint-recovery-request-binding');
  const prior = await createAndFinalize(core, { completed: ['prior'] });
  const request = { ...explicit, supersedes: prior.artifact.id };
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'request-intent', claims: { completed: ['intent-bound'] } });
  const anchors = normalizeMachineAnchors(await anchorProvider()());
  const build = finalizationBuild(anchors, '2026-07-12T08:00:00.000Z', request);
  const artifact = buildCheckpointArtifact({
    project: draft.project,
    session: draft.session,
    createdAt: build.createdAt,
    trigger: build.trigger,
    state: draft.claims,
    anchors: build.anchors,
    evidence: draft.evidence,
    coverage: draft.coverage,
    redaction: draft.redaction,
    supersedes: build.supersedes,
    anchorOmittedCounts: build.anchorOmittedCounts,
    anchorRedaction: build.anchorRedaction,
  });
  await stageCreatedFinalization(core, draft, artifact, build);

  let providerCalls = 0;
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
      providerCalls += 1;
      return { files: [], commands: [] };
    }),
    /checkpoint_finalization_request_mismatch/,
  );
  assert.equal(providerCalls, 0, 'supersedes conflict fails before provider collection');

  const recovered = await core.checkpoints.finalizeDraft(draft.draftId, request, async () => {
    providerCalls += 1;
    return { files: [], commands: [] };
  });
  assert.equal(providerCalls, 0);
  assert.equal(recovered.artifact.id, artifact.id);

  const conflictingTrigger = {
    ...request,
    trigger: { ...request.trigger, reasonCode: 'different_reason' },
  };
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, conflictingTrigger, async () => {
      providerCalls += 1;
      return { files: [], commands: [] };
    }),
    /checkpoint_finalization_request_mismatch/,
  );
  assert.equal(providerCalls, 0, 'marker trigger conflict also fails before provider collection');
});

test('draft update and finalization are bound to the current service project identity', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-draft-project-binding-')));
  const firstProject = path.join(root, 'project-one');
  const secondProject = path.join(root, 'project-two');
  await fs.mkdir(firstProject);
  await fs.mkdir(secondProject);
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const options = { root: path.join(root, 'store'), space: 'shared-checkpoints' };
  const firstCore = await openCore({ ...options, cwd: firstProject });
  const secondCore = await openCore({ ...options, cwd: secondProject });
  const firstDraft = await firstCore.checkpoints.createDraft({ runtime: 'unit', sessionId: 'bound', claims: { completed: ['project one'] } });

  await assert.rejects(
    secondCore.checkpoints.updateDraft(firstDraft.draftId, { claims: { completed: ['project two takeover'] } }),
    /checkpoint_draft_project_mismatch/,
  );
  let providerCalls = 0;
  await assert.rejects(
    secondCore.checkpoints.finalizeDraft(firstDraft.draftId, explicit, async () => {
      providerCalls += 1;
      return { files: [], commands: [] };
    }),
    /checkpoint_draft_project_mismatch/,
  );
  assert.equal(providerCalls, 0);
  const stillOwned = await firstCore.checkpoints.updateDraft(firstDraft.draftId, { claims: { completed: ['project one retained'] } });
  assert.deepEqual(stillOwned.claims.completed, ['project one retained']);
});

test('draft finalization markers re-bind the artifact to draft project, session, state, evidence, and coverage', async (t) => {
  const core = await tempCore(t, 'checkpoint-marker-binding');
  const paths = checkpointStorePaths(core.workspace);
  const cases = [
    ['project', (input) => { input.project = { ...input.project, projectId: 'f'.repeat(64) }; }],
    ['session', (input) => { input.session = { ...input.session, runtime: 'other-runtime' }; }],
    ['state', (input) => { input.state = { ...input.state, completed: ['other state'] }; }],
    ['evidence', (input) => { input.evidence = [{ kind: 'test', ref: 'other evidence', sha256: ZERO_HASH }]; }],
    ['coverage', (input) => { input.coverage = { ...input.coverage, eventCount: 999 }; }],
  ];

  for (const [label, mutate] of cases) {
    const draft = await core.checkpoints.createDraft({
      runtime: 'unit',
      sessionId: `marker-${label}`,
      claims: {
        completed: [`original ${label}`],
        evidence: [{ kind: 'test', ref: `evidence ${label}`, sha256: ZERO_HASH }],
        coverage: { complete: false, eventCount: 1 },
      },
    });
    const anchors = normalizeMachineAnchors(await anchorProvider()());
    const input = {
      project: structuredClone(draft.project),
      session: structuredClone(draft.session),
      createdAt: '2026-07-12T08:00:00.000Z',
      trigger: explicit.trigger,
      state: structuredClone(draft.claims),
      anchors: anchors.anchors,
      evidence: structuredClone(draft.evidence),
      coverage: structuredClone(draft.coverage),
      redaction: structuredClone(draft.redaction),
      anchorOmittedCounts: anchors.omittedCounts,
      anchorRedaction: anchors.redaction,
    };
    mutate(input);
    const foreignArtifact = buildCheckpointArtifact(input);
    assert.equal(await writeCheckpointArtifactNewUnlocked(core.workspace, foreignArtifact), 'created');
    const poisonedMarker = { ...draft, finalization: { artifactId: foreignArtifact.id } };
    await fs.writeFile(path.join(paths.drafts, `${draft.draftId}.json`), canonicalCheckpointJson(poisonedMarker), 'utf8');

    let providerCalls = 0;
    await assert.rejects(
      core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
        providerCalls += 1;
        return { files: [], commands: [] };
      }),
      /checkpoint_draft_artifact_mismatch/,
      label,
    );
    assert.equal(providerCalls, 0, `${label} mismatch fails before anchor collection`);
  }
});

test('marker-only recovery deterministically rejects prefix-plus-omission artifacts', async (t) => {
  const core = await tempCore(t, 'checkpoint-marker-deterministic-prefix');
  const draft = await core.checkpoints.createDraft({
    runtime: 'unit',
    sessionId: 'marker-prefix',
    claims: {
      completed: ['deterministic source value'],
      evidence: [{ kind: 'test-kind', ref: 'deterministic evidence', sha256: ZERO_HASH }],
      coverage: { complete: true, eventCount: 1 },
    },
  });
  const anchors = normalizeMachineAnchors(await anchorProvider()());
  const forged = buildCheckpointArtifact({
    project: draft.project,
    session: draft.session,
    createdAt: '2026-07-12T08:00:00.000Z',
    trigger: explicit.trigger,
    state: { ...draft.claims, completed: ['deterministic'] },
    anchors: anchors.anchors,
    evidence: [{ ...draft.evidence[0], ref: 'deterministic' }],
    coverage: {
      ...draft.coverage,
      complete: false,
      omittedCounts: {
        ...draft.coverage.omittedCounts,
        'state.completed.characters': 13,
        'evidence.ref.characters': 9,
      },
    },
    redaction: draft.redaction,
    anchorOmittedCounts: anchors.omittedCounts,
    anchorRedaction: anchors.redaction,
  });
  assert.equal(await writeCheckpointArtifactNewUnlocked(core.workspace, forged), 'created');
  await appendCheckpointAuditUnlocked(core.workspace, {
    type: 'checkpoint.artifact.created',
    operation: 'artifact.finalize',
    draftId: draft.draftId,
    artifactId: forged.id,
  });
  const paths = checkpointStorePaths(core.workspace);
  await fs.writeFile(
    path.join(paths.drafts, `${draft.draftId}.json`),
    canonicalCheckpointJson({ ...draft, finalization: { artifactId: forged.id } }),
    'utf8',
  );

  let providerCalls = 0;
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
      providerCalls += 1;
      return { files: [], commands: [] };
    }),
    /checkpoint_draft_artifact_mismatch/,
  );
  assert.equal(providerCalls, 0);
});

test('finalization intent is a deterministic build proof, not an artifact-id assertion', async (t) => {
  const core = await tempCore(t, 'checkpoint-intent-deterministic-proof');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', sessionId: 'intent-proof', claims: { completed: ['original value'] } });
  const anchors = normalizeMachineAnchors(await anchorProvider()());
  const other = buildCheckpointArtifact({
    project: draft.project,
    session: draft.session,
    createdAt: '2026-07-12T08:00:00.000Z',
    trigger: explicit.trigger,
    state: { ...draft.claims, completed: ['other value'] },
    anchors: anchors.anchors,
    evidence: draft.evidence,
    coverage: draft.coverage,
    redaction: draft.redaction,
    anchorOmittedCounts: anchors.omittedCounts,
    anchorRedaction: anchors.redaction,
  });
  await writeCheckpointFinalizationIntentUnlocked(core.workspace, {
    schemaVersion: 1,
    draftId: draft.draftId,
    artifactId: other.id,
    creationProvenance: 'created',
    writeClaimId: crypto.randomUUID(),
    build: finalizationBuild(anchors, other.createdAt),
  });

  let providerCalls = 0;
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
      providerCalls += 1;
      return { files: [], commands: [] };
    }),
    /checkpoint_finalization_intent_mismatch/,
  );
  assert.equal(providerCalls, 0);
  assert.deepEqual(await core.checkpoints.list(), []);
});

test('maximal service artifacts preserve draft fields and marker-only retries rebuild exactly', async (t) => {
  const core = await tempCore(t, 'checkpoint-marker-max-size');
  const text = 'x'.repeat(512);
  const draft = await core.checkpoints.createDraft({
    runtime: 'unit',
    sessionId: 'marker-max-size',
    claims: {
      objective: text,
      completed: Array.from({ length: 20 }, (_, index) => `${index}`.padStart(3, '0') + text.slice(3)),
      pending: Array.from({ length: 20 }, (_, index) => `p${index}`.padEnd(512, 'p')),
      decisions: Array.from({ length: 20 }, (_, index) => `d${index}`.padEnd(512, 'd')),
      blockers: Array.from({ length: 20 }, (_, index) => `b${index}`.padEnd(512, 'b')),
      nextActions: Array.from({ length: 20 }, (_, index) => `n${index}`.padEnd(512, 'n')),
      evidence: Array.from({ length: 24 }, (_, index) => ({ kind: `kind-${index}`, ref: `ref-${index}`.padEnd(512, 'r'), sha256: ZERO_HASH })),
      coverage: { complete: true, eventCount: 100 },
    },
  });
  const result = await core.checkpoints.finalizeDraft(draft.draftId, explicit, anchorProvider({
    git: { repo: text, branch: text, head: 'a'.repeat(128), dirty: true, statusHash: ZERO_HASH },
    files: Array.from({ length: 32 }, (_, index) => ({ path: `file-${index}`.padEnd(512, 'f'), sha256: ZERO_HASH })),
    commands: Array.from({ length: 20 }, (_, index) => ({ label: `command-${index}`.padEnd(512, 'c'), exitCode: 0, outputHash: ZERO_HASH })),
  }));
  assert.deepEqual(result.artifact.state, draft.claims);
  assert.deepEqual(result.artifact.evidence, draft.evidence);
  assert.ok(Buffer.byteLength(canonicalCheckpointJson(result.artifact), 'utf8') <= CHECKPOINT_ARTIFACT_MAX_BYTES);
  assert.ok(Object.keys(result.artifact.coverage.omittedCounts).some((key) => key.startsWith('anchors.')));

  let providerCalls = 0;
  const retry = await core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
    providerCalls += 1;
    return { files: [], commands: [] };
  });
  assert.equal(providerCalls, 0);
  assert.equal(retry.artifact.id, result.artifact.id);
});

test('concurrent finalizers serialize under the workspace lock and converge on one artifact', async (t) => {
  const core = await tempCore(t, 'checkpoint-concurrency');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['concurrent'] } });
  const results = await Promise.all(Array.from({ length: 24 }, () => core.checkpoints.finalizeDraft(draft.draftId, explicit, anchorProvider())));
  assert.equal(new Set(results.map((result) => result.artifact.id)).size, 1);
  assert.equal((await core.checkpoints.list()).length, 1);
  const audit = await core.checkpoints.audit();
  assert.equal(audit.filter((event) => event.type === 'checkpoint.artifact.created').length, 1);
});

test('audit-only finalization state fails closed before provider collection without healing writes', async (t) => {
  const core = await tempCore(t, 'checkpoint-audit-only-fail-closed');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['must remain unfinalized'] } });
  await appendCheckpointAuditUnlocked(core.workspace, {
    type: 'checkpoint.artifact.created',
    operation: 'artifact.finalize',
    draftId: draft.draftId,
    artifactId: `cp_${'a'.repeat(64)}`,
  });
  const paths = checkpointStorePaths(core.workspace);
  const beforeAudit = await core.checkpoints.audit();
  const beforeArtifacts = await core.checkpoints.list();
  let providerCalls = 0;

  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
      providerCalls += 1;
      return { files: [], commands: [] };
    }),
    /checkpoint_finalization_audit_outcome_mismatch/,
  );

  assert.equal(providerCalls, 0);
  assert.deepEqual(await core.checkpoints.list(), beforeArtifacts, 'no artifact is created');
  assert.deepEqual(await core.checkpoints.audit(), beforeAudit, 'no rejection or healing audit is appended');
  const storedDraft = JSON.parse(await fs.readFile(path.join(paths.drafts, `${draft.draftId}.json`), 'utf8'));
  assert.equal(Object.hasOwn(storedDraft, 'finalization'), false);
  await assert.rejects(fs.access(path.join(paths.finalizations, `${draft.draftId}.json`)));
});

test('second locked preflight rejects an audit-only state introduced during provider collection', async (t) => {
  const core = await tempCore(t, 'checkpoint-audit-only-second-preflight');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['race-safe'] } });
  let providerCalls = 0;
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
      providerCalls += 1;
      await appendCheckpointAuditUnlocked(core.workspace, {
        type: 'checkpoint.artifact.deduplicated',
        operation: 'artifact.finalize',
        draftId: draft.draftId,
        artifactId: `cp_${'b'.repeat(64)}`,
      });
      return { files: [], commands: [] };
    }),
    /checkpoint_finalization_audit_outcome_mismatch/,
  );
  assert.equal(providerCalls, 1);
  assert.deepEqual(await core.checkpoints.list(), []);
  const finalizationEvents = (await core.checkpoints.audit()).filter((event) => event.operation === 'artifact.finalize' && event.draftId === draft.draftId);
  assert.equal(finalizationEvents.length, 1, 'the conflict is not healed or supplemented');
  const paths = checkpointStorePaths(core.workspace);
  await assert.rejects(fs.access(path.join(paths.finalizations, `${draft.draftId}.json`)));
});

test('provider throw still performs locked reconciliation and preserves an audit-only outcome', async (t) => {
  const core = await tempCore(t, 'checkpoint-provider-throw-audit-only');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['provider throw race'] } });
  const beforeAuditCount = (await core.checkpoints.audit()).length;
  let providerCalls = 0;

  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
      providerCalls += 1;
      await appendCheckpointAuditUnlocked(core.workspace, {
        type: 'checkpoint.artifact.created',
        operation: 'artifact.finalize',
        draftId: draft.draftId,
        artifactId: `cp_${'c'.repeat(64)}`,
      });
      throw new Error('provider exploded after its side effect');
    }),
    /checkpoint_finalization_audit_outcome_mismatch/,
  );

  assert.equal(providerCalls, 1);
  assert.deepEqual(await core.checkpoints.list(), []);
  const audit = await core.checkpoints.audit();
  assert.equal(audit.length, beforeAuditCount + 1, 'only the provider-injected audit is present');
  assert.equal(audit.at(-1).type, 'checkpoint.artifact.created');
  const paths = checkpointStorePaths(core.workspace);
  await assert.rejects(fs.access(path.join(paths.finalizations, `${draft.draftId}.json`)));
  const storedDraft = JSON.parse(await fs.readFile(path.join(paths.drafts, `${draft.draftId}.json`), 'utf8'));
  assert.equal(Object.hasOwn(storedDraft, 'finalization'), false);
});

test('provider throw returns the exact intent recovery result from the second locked reconciliation', async (t) => {
  const core = await tempCore(t, 'checkpoint-provider-throw-intent-recovery');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['provider completed intent'] } });
  const anchors = normalizeMachineAnchors({ files: [], commands: [] });
  const artifact = artifactForDraft(draft);
  let providerCalls = 0;

  const recovered = await core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
    providerCalls += 1;
    await stageCreatedFinalization(core, draft, artifact, finalizationBuild(anchors, artifact.createdAt));
    throw new Error('provider threw after persisting the intent');
  });

  assert.equal(providerCalls, 1);
  assert.equal(recovered.deduplicated, true);
  assert.equal(recovered.artifact.id, artifact.id);
  assert.deepEqual((await core.checkpoints.list()).map((entry) => entry.id), [artifact.id]);
  const finalizationEvents = (await core.checkpoints.audit()).filter((event) => event.operation === 'artifact.finalize' && event.draftId === draft.draftId);
  assert.equal(finalizationEvents.length, 1);
  assert.equal(finalizationEvents[0].type, 'checkpoint.artifact.created');
  const paths = checkpointStorePaths(core.workspace);
  await assert.rejects(fs.access(path.join(paths.finalizations, `${draft.draftId}.json`)));
});

test('anchor normalization failure still performs locked reconciliation and preserves an audit-only outcome', async (t) => {
  const core = await tempCore(t, 'checkpoint-normalize-failure-audit-only');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['normalize race'] } });
  const beforeAuditCount = (await core.checkpoints.audit()).length;
  let providerCalls = 0;
  let getterCalls = 0;

  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
      providerCalls += 1;
      await appendCheckpointAuditUnlocked(core.workspace, {
        type: 'checkpoint.artifact.deduplicated',
        operation: 'artifact.finalize',
        draftId: draft.draftId,
        artifactId: `cp_${'d'.repeat(64)}`,
      });
      return {
        get files() {
          getterCalls += 1;
          return 'not-an-array';
        },
        commands: [],
      };
    }),
    /checkpoint_finalization_audit_outcome_mismatch/,
  );

  assert.equal(providerCalls, 1);
  assert.ok(getterCalls >= 1, 'normalization evaluated the failing getter');
  assert.deepEqual(await core.checkpoints.list(), []);
  const audit = await core.checkpoints.audit();
  assert.equal(audit.length, beforeAuditCount + 1, 'normalization rejection adds no audit after the injected outcome');
  assert.equal(audit.at(-1).type, 'checkpoint.artifact.deduplicated');
  const paths = checkpointStorePaths(core.workspace);
  await assert.rejects(fs.access(path.join(paths.finalizations, `${draft.draftId}.json`)));
  const storedDraft = JSON.parse(await fs.readFile(path.join(paths.drafts, `${draft.draftId}.json`), 'utf8'));
  assert.equal(Object.hasOwn(storedDraft, 'finalization'), false);
});

test('second locked reconciliation rethrows the original anchor failure when no finalization state appeared', async (t) => {
  const core = await tempCore(t, 'checkpoint-anchor-failure-no-recovery');
  const collectionDraft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['collection failure'] } });
  await assert.rejects(
    core.checkpoints.finalizeDraft(collectionDraft.draftId, explicit, async () => {
      throw new Error('raw provider detail must not escape');
    }),
    /checkpoint_anchor_collection_failed/,
  );

  const normalizationDraft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['normalization failure'] } });
  await assert.rejects(
    core.checkpoints.finalizeDraft(normalizationDraft.draftId, explicit, async () => ({ files: 'invalid', commands: [] })),
    /checkpoint_schema_anchor_files_array_required/,
  );

  const rejections = (await core.checkpoints.audit()).filter((event) => event.type === 'checkpoint.rejected' && event.operation === 'artifact.finalize');
  assert.deepEqual(rejections.map((event) => event.reasonCode), [
    'checkpoint_anchor_collection_failed',
    'checkpoint_schema_anchor_files_array_required',
  ]);
});

test('write claim makes a pre-link unexpected-existing conflict durable across retries', async (t) => {
  const core = await tempCore(t, 'checkpoint-unexpected-existing-claim');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['claim ownership'] } });
  const artifact = artifactForDraft(draft);
  const anchors = normalizeMachineAnchors({ files: [], commands: [] });
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const finalName = `${artifact.id}.json`;
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-unexpected-control-'));
  t.after(async () => { await fs.rm(controlDirectory, { recursive: true, force: true }); });

  await prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId);
  await writeCheckpointFinalizationIntentUnlocked(core.workspace, {
    schemaVersion: 1,
    draftId: draft.draftId,
    artifactId: artifact.id,
    creationProvenance: 'created',
    writeClaimId,
    build: finalizationBuild(anchors, artifact.createdAt),
  });
  assert.equal(
    await runAtClaimWorkerPhase(
      () => linkCheckpointArtifactWriteClaimUnlocked(
        core.workspace,
        artifact,
        writeClaimId,
        { testControlDirectory: controlDirectory, testPhase: 'after-claim-verified-before-link' },
      ),
      controlDirectory,
      'after-claim-verified-before-link',
      async () => {
        await fs.copyFile(
          path.join(paths.artifacts, claimName),
          path.join(paths.artifacts, finalName),
          fsConstants.COPYFILE_EXCL,
        );
      },
    ),
    'unexpected-existing',
  );

  await fs.access(path.join(paths.artifacts, claimName));
  assert.equal((await core.checkpoints.list()).length, 1, 'the pre-existing final is visible, not the private claim');
  assert.equal((await fs.readdir(paths.artifacts)).filter((name) => /^cp_[a-f0-9]{64}\.json$/.test(name)).length, 1);

  let retryProviderCalls = 0;
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, explicit, async () => {
      retryProviderCalls += 1;
      return { files: [], commands: [] };
    }),
    /checkpoint_artifact_unexpected_existing/,
  );
  assert.equal(retryProviderCalls, 0, 'retry resolves the durable intent and claim before provider collection');
  assert.equal((await core.checkpoints.audit()).filter((event) => event.type === 'checkpoint.artifact.created' && event.draftId === draft.draftId).length, 0);
  await fs.access(path.join(paths.finalizations, `${draft.draftId}.json`));
  await fs.access(path.join(paths.artifacts, claimName));
});

test('claim worker removes canonical bytes from its moved cwd after the opened artifacts directory is renamed', async (t) => {
  const core = await tempCore(t, 'checkpoint-claim-worker-moved-cwd');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['rollback the moved claim inode'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-claim-worker-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-claim-worker-control-'));
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    runAtClaimWorkerPhase(
      () => prepareCheckpointArtifactWriteClaimUnlocked(
        core.workspace,
        artifact,
        writeClaimId,
        { testControlDirectory: controlDirectory, testPhase: 'after-write-before-final-check' },
      ),
      controlDirectory,
      'after-write-before-final-check',
      async () => {
        await fs.rename(paths.artifacts, movedArtifacts);
        await fs.mkdir(paths.artifacts, { mode: 0o700 });
      },
    ),
    /checkpoint_path_outside_store/,
  );

  assert.deepEqual(await fs.readdir(movedArtifacts), [], 'cwd-relative rollback removes the moved claim');
  assert.deepEqual(await fs.readdir(paths.artifacts), [], 'replacement canonical directory remains empty');
  await assert.rejects(fs.access(path.join(movedArtifacts, claimName)), /ENOENT/);
});

test('claim worker removes only its moved final hardlink after artifacts is renamed and replaced', async (t) => {
  const core = await tempCore(t, 'checkpoint-link-worker-moved-cwd');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['rollback the moved final inode'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const finalName = `${artifact.id}.json`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-link-worker-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-link-worker-control-'));
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });
  await prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId);

  await assert.rejects(
    runAtClaimWorkerPhase(
      () => linkCheckpointArtifactWriteClaimUnlocked(
        core.workspace,
        artifact,
        writeClaimId,
        { testControlDirectory: controlDirectory, testPhase: 'after-link-before-final-check' },
      ),
      controlDirectory,
      'after-link-before-final-check',
      async () => {
        await fs.rename(paths.artifacts, movedArtifacts);
        await fs.mkdir(paths.artifacts, { mode: 0o700 });
      },
    ),
    /checkpoint_path_outside_store/,
  );

  assert.deepEqual(await fs.readdir(movedArtifacts), [], 'cwd-relative rollback removes both canonical-byte names outside');
  assert.deepEqual(await fs.readdir(paths.artifacts), [], 'replacement canonical directory remains empty');
  await assert.rejects(fs.access(path.join(movedArtifacts, finalName)), /ENOENT/);
  await assert.rejects(fs.access(path.join(movedArtifacts, claimName)), /ENOENT/);
});

test('SIGKILL after prepare write is reconciled by the pinned guardian without touching the replacement path', async (t) => {
  const core = await tempCore(t, 'checkpoint-prepare-sigkill-guardian');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['guardian prepare rollback'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const finalName = `${artifact.id}.json`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-prepare-kill-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-prepare-kill-control-'));
  const replacementClaim = 'replacement-claim-must-survive';
  const replacementFinal = 'replacement-final-must-survive';
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });

  const operation = prepareCheckpointArtifactWriteClaimUnlocked(
    core.workspace,
    artifact,
    writeClaimId,
    { testControlDirectory: controlDirectory, testPhase: 'after-write-before-final-check' },
  );
  const ready = path.join(controlDirectory, 'after-write-before-final-check.ready');
  await waitForFile(ready);
  const { pid } = JSON.parse(await fs.readFile(ready, 'utf8'));
  await fs.rename(path.join(paths.artifacts, claimName), path.join(paths.artifacts, 'attacker-stash'));
  await fs.rename(paths.artifacts, movedArtifacts);
  await fs.mkdir(paths.artifacts, { mode: 0o700 });
  await fs.writeFile(path.join(paths.artifacts, claimName), replacementClaim, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(paths.artifacts, finalName), replacementFinal, { flag: 'wx', mode: 0o600 });
  process.kill(pid, 'SIGKILL');

  await assert.rejects(operation, /checkpoint_internal_failure/);
  assert.deepEqual(await fs.readdir(movedArtifacts), [], 'guardian removes the exact claim from the moved inode');
  assert.equal(await fs.readFile(path.join(paths.artifacts, claimName), 'utf8'), replacementClaim);
  assert.equal(await fs.readFile(path.join(paths.artifacts, finalName), 'utf8'), replacementFinal);
});

test('SIGKILL after link is reconciled by the pinned guardian without deleting replacement names', async (t) => {
  const core = await tempCore(t, 'checkpoint-link-sigkill-guardian');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['guardian link rollback'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const finalName = `${artifact.id}.json`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-link-kill-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-link-kill-control-'));
  const replacementClaim = 'replacement-link-claim-must-survive';
  const replacementFinal = 'replacement-link-final-must-survive';
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });
  await prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId);

  const operation = linkCheckpointArtifactWriteClaimUnlocked(
    core.workspace,
    artifact,
    writeClaimId,
    { testControlDirectory: controlDirectory, testPhase: 'after-link-before-final-check' },
  );
  const ready = path.join(controlDirectory, 'after-link-before-final-check.ready');
  await waitForFile(ready);
  const { pid } = JSON.parse(await fs.readFile(ready, 'utf8'));
  await fs.rename(path.join(paths.artifacts, claimName), path.join(paths.artifacts, 'attacker-stash'));
  await fs.rename(paths.artifacts, movedArtifacts);
  await fs.mkdir(paths.artifacts, { mode: 0o700 });
  await fs.writeFile(path.join(paths.artifacts, claimName), replacementClaim, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(paths.artifacts, finalName), replacementFinal, { flag: 'wx', mode: 0o600 });
  process.kill(pid, 'SIGKILL');

  await assert.rejects(operation, /checkpoint_internal_failure/);
  assert.deepEqual(await fs.readdir(movedArtifacts), [], 'guardian removes both hardlink names from the moved inode');
  assert.equal(await fs.readFile(path.join(paths.artifacts, claimName), 'utf8'), replacementClaim);
  assert.equal(await fs.readFile(path.join(paths.artifacts, finalName), 'utf8'), replacementFinal);
});

test('parent timeout SIGKILL still waits for pinned-guardian cleanup after the artifacts directory moves', async (t) => {
  const core = await tempCore(t, 'checkpoint-timeout-guardian');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['guardian timeout rollback'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-timeout-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-timeout-control-'));
  const replacement = 'timeout-replacement-must-survive';
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });

  const operation = prepareCheckpointArtifactWriteClaimUnlocked(
    core.workspace,
    artifact,
    writeClaimId,
    {
      testControlDirectory: controlDirectory,
      testPhase: 'after-write-before-final-check',
      testTimeoutMs: 200,
    },
  );
  await waitForFile(path.join(controlDirectory, 'after-write-before-final-check.ready'));
  await fs.rename(path.join(paths.artifacts, claimName), path.join(paths.artifacts, 'attacker-stash'));
  await fs.rename(paths.artifacts, movedArtifacts);
  await fs.mkdir(paths.artifacts, { mode: 0o700 });
  await fs.writeFile(path.join(paths.artifacts, claimName), replacement, { flag: 'wx', mode: 0o600 });

  await assert.rejects(operation, /checkpoint_internal_failure/);
  assert.deepEqual(await fs.readdir(movedArtifacts), [], 'timeout rejection is delayed until guardian cleanup completes');
  assert.equal(await fs.readFile(path.join(paths.artifacts, claimName), 'utf8'), replacement);
});

test('claim worker cleans an empty claim when artifacts is renamed before the first byte write', async (t) => {
  const core = await tempCore(t, 'checkpoint-claim-empty-open-move');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['never write after cwd move'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-empty-open-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-empty-open-control-'));
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    runAtClaimWorkerPhase(
      () => prepareCheckpointArtifactWriteClaimUnlocked(
        core.workspace,
        artifact,
        writeClaimId,
        { testControlDirectory: controlDirectory, testPhase: 'after-empty-open-before-write' },
      ),
      controlDirectory,
      'after-empty-open-before-write',
      async () => {
        await fs.rename(paths.artifacts, movedArtifacts);
        await fs.mkdir(paths.artifacts, { mode: 0o700 });
      },
    ),
    /checkpoint_path_outside_store/,
  );
  assert.deepEqual(await fs.readdir(movedArtifacts), []);
  assert.deepEqual(await fs.readdir(paths.artifacts), []);
});

test('claim worker refuses to link after its cwd is renamed before link', async (t) => {
  const core = await tempCore(t, 'checkpoint-link-before-directory-move');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['do not link after cwd move'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const finalName = `${artifact.id}.json`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-prelink-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-prelink-control-'));
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });
  await prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId);

  await assert.rejects(
    runAtClaimWorkerPhase(
      () => linkCheckpointArtifactWriteClaimUnlocked(
        core.workspace,
        artifact,
        writeClaimId,
        { testControlDirectory: controlDirectory, testPhase: 'after-claim-verified-before-link' },
      ),
      controlDirectory,
      'after-claim-verified-before-link',
      async () => {
        await fs.rename(paths.artifacts, movedArtifacts);
        await fs.mkdir(paths.artifacts, { mode: 0o700 });
      },
    ),
    /checkpoint_path_outside_store/,
  );
  assert.deepEqual(await fs.readdir(movedArtifacts), [], 'the moved claim is removed once the cwd identity fails');
  assert.deepEqual(await fs.readdir(paths.artifacts), []);
  await assert.rejects(fs.access(path.join(movedArtifacts, finalName)), /ENOENT/);
  await assert.rejects(fs.access(path.join(movedArtifacts, claimName)), /ENOENT/);
});

test('a post-link worker failure rolls back only the final name created by this call', async (t) => {
  const core = await tempCore(t, 'checkpoint-link-failure-rollback');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['rollback failed link'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const finalPath = path.join(paths.artifacts, `${artifact.id}.json`);
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-link-failure-control-'));
  t.after(async () => { await fs.rm(controlDirectory, { recursive: true, force: true }); });
  await prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId);

  await assert.rejects(
    runAtClaimWorkerPhase(
      () => linkCheckpointArtifactWriteClaimUnlocked(
        core.workspace,
        artifact,
        writeClaimId,
        {
          testControlDirectory: controlDirectory,
          testPhase: 'after-final-check-before-directory-sync',
          testFailAfterPhase: true,
        },
      ),
      controlDirectory,
      'after-final-check-before-directory-sync',
      async () => {},
    ),
    /checkpoint_internal_failure/,
  );
  await assert.rejects(fs.access(finalPath), /ENOENT/);
  await fs.access(path.join(paths.artifacts, claimName));
});

test('EEXIST link handling never removes a pre-existing destination sentinel', async (t) => {
  const core = await tempCore(t, 'checkpoint-link-eexist-sentinel');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['preserve sentinel'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const finalPath = path.join(paths.artifacts, `${artifact.id}.json`);
  const sentinel = 'pre-existing-sentinel-must-survive';
  await prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId);
  await fs.writeFile(finalPath, sentinel, { flag: 'wx', mode: 0o600 });

  assert.equal(
    await linkCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId),
    'unexpected-existing',
  );
  assert.equal(await fs.readFile(finalPath, 'utf8'), sentinel);
});

test('successful write claims are persistent receipts and cleanup cannot delete an outside sentinel', async (t) => {
  const core = await tempCore(t, 'checkpoint-claim-cleanup-outside-sentinel');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['persistent receipt'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-cleanup-outside-')));
  const backup = `${paths.artifacts}.cleanup-backup`;
  const sentinel = 'cleanup-must-not-delete-me';
  t.after(async () => { await fs.rm(outside, { recursive: true, force: true }); });
  await prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId);
  await fs.writeFile(path.join(outside, claimName), sentinel, 'utf8');
  await fs.rename(paths.artifacts, backup);
  await fs.symlink(outside, paths.artifacts, 'dir');
  try {
    await removeCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact.id, writeClaimId);
    assert.equal(await fs.readFile(path.join(outside, claimName), 'utf8'), sentinel);
  } finally {
    await fs.rm(paths.artifacts, { force: true });
    await fs.rename(backup, paths.artifacts);
  }
  await fs.access(path.join(paths.artifacts, claimName));
});

test('audit reconciliation rejects every competing finalization artifact or outcome for a draft', async (t) => {
  const core = await tempCore(t, 'checkpoint-audit-finalization-uniqueness');
  const first = await createAndFinalize(core, { completed: ['first audit outcome'] });
  await appendCheckpointAuditUnlocked(core.workspace, {
    type: 'checkpoint.artifact.created',
    operation: 'artifact.finalize',
    draftId: first.draft.draftId,
    artifactId: first.artifact.id,
  });
  assert.equal(
    (await core.checkpoints.audit()).filter((event) => event.operation === 'artifact.finalize' && event.draftId === first.draft.draftId).length,
    1,
    'same audit healing write is idempotent',
  );
  const other = await createAndFinalize(core, { completed: ['other artifact'] });
  const paths = checkpointStorePaths(core.workspace);
  await fs.appendFile(paths.audit, `${canonicalCheckpointJson({
    schemaVersion: 1,
    id: '00000000-0000-4000-8000-000000000099',
    at: '2026-07-12T08:00:00.000Z',
    type: 'checkpoint.artifact.deduplicated',
    operation: 'artifact.finalize',
    draftId: first.draft.draftId,
    artifactId: other.artifact.id,
  })}\n`, 'utf8');

  let providerCalls = 0;
  await assert.rejects(
    core.checkpoints.finalizeDraft(first.draft.draftId, explicit, async () => {
      providerCalls += 1;
      return { files: [], commands: [] };
    }),
    /checkpoint_finalization_audit_outcome_mismatch/,
  );
  assert.equal(providerCalls, 0);
  const events = (await core.checkpoints.audit()).filter((event) => event.operation === 'artifact.finalize' && event.draftId === first.draft.draftId);
  assert.equal(events.length, 2, 'reconciliation fails closed instead of appending a third healing event');
});

test('audit event supersedes must exactly match the immutable artifact and healing stays idempotent', async (t) => {
  const core = await tempCore(t, 'checkpoint-audit-supersedes-exact');
  const prior = await createAndFinalize(core, { completed: ['parent'] });
  const childRequest = { ...explicit, supersedes: prior.artifact.id };
  const child = await createAndFinalize(core, { completed: ['child'] }, childRequest);
  const paths = checkpointStorePaths(core.workspace);
  const lines = (await fs.readFile(paths.audit, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  const event = lines.find((entry) => entry.operation === 'artifact.finalize' && entry.draftId === child.draft.draftId);
  delete event.supersedes;
  await fs.writeFile(paths.audit, `${lines.map((entry) => canonicalCheckpointJson(entry)).join('\n')}\n`, 'utf8');

  let providerCalls = 0;
  await assert.rejects(
    core.checkpoints.finalizeDraft(child.draft.draftId, childRequest, async () => {
      providerCalls += 1;
      return { files: [], commands: [] };
    }),
    /checkpoint_finalization_audit_outcome_mismatch/,
  );
  assert.equal(providerCalls, 0);
  assert.equal(
    (await core.checkpoints.audit()).filter((entry) => entry.operation === 'artifact.finalize' && entry.draftId === child.draft.draftId).length,
    1,
  );
});

test('torn temp files are ignored; finalized artifacts are complete canonical JSON', async (t) => {
  const core = await tempCore(t, 'checkpoint-torn-temp');
  const result = await createAndFinalize(core, { completed: ['atomic'] });
  const paths = checkpointStorePaths(core.workspace);
  await fs.writeFile(path.join(paths.artifacts, `.${result.artifact.id}.crashed.tmp`), '{"torn":', 'utf8');
  await fs.writeFile(path.join(paths.artifacts, '.orphan.tmp'), 'secret-shaped-but-unlinked', 'utf8');
  const listed = await core.checkpoints.list();
  assert.deepEqual(listed.map((item) => item.id), [result.artifact.id]);
  const finalRaw = await fs.readFile(path.join(paths.artifacts, `${result.artifact.id}.json`), 'utf8');
  assert.doesNotThrow(() => JSON.parse(finalRaw));
  assert.equal(finalRaw, canonicalCheckpointJson(result.artifact));
});

test('tampered artifact fails schema/integrity closed for read and supersede inspection', async (t) => {
  const core = await tempCore(t, 'checkpoint-integrity');
  const first = await createAndFinalize(core, { completed: ['untampered'] });
  const paths = checkpointStorePaths(core.workspace);
  const artifactPath = path.join(paths.artifacts, `${first.artifact.id}.json`);
  const tampered = structuredClone(first.artifact);
  tampered.state.completed = ['tampered without rehash'];
  await fs.writeFile(artifactPath, canonicalCheckpointJson(tampered), 'utf8');

  await assert.rejects(core.checkpoints.read(first.artifact.id), /checkpoint_integrity_mismatch/);
  const inspection = await core.checkpoints.inspect(first.artifact.id);
  assert.equal(inspection.integrity.valid, false);
  assert.equal(inspection.integrity.reasonCode, 'checkpoint_integrity_mismatch');
  const listed = await core.checkpoints.list();
  assert.equal(listed[0].integrity, 'invalid');

  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['must not land'] } });
  await assert.rejects(
    core.checkpoints.finalizeDraft(draft.draftId, { ...explicit, supersedes: first.artifact.id }, anchorProvider()),
    /checkpoint_integrity_mismatch/,
  );
  assert.equal((await fs.readdir(paths.artifacts)).filter((name) => /^cp_.*\.json$/.test(name)).length, 1, 'integrity failure writes no new artifact');
  const rejection = (await core.checkpoints.audit()).at(-1);
  assert.equal(rejection.type, 'checkpoint.rejected');
  assert.equal(rejection.reasonCode, 'checkpoint_integrity_mismatch');
});

test('default list limit is 20 and explicit limits are bounded', async (t) => {
  const core = await tempCore(t, 'checkpoint-list-limit');
  for (let i = 0; i < 23; i += 1) await createAndFinalize(core, { completed: [`item-${i}`] });
  assert.equal((await core.checkpoints.list()).length, 20);
  assert.equal((await core.checkpoints.list({ limit: 5 })).length, 5);
  await assert.rejects(core.checkpoints.list({ limit: 0 }), /checkpoint_list_limit_invalid/);
  await assert.rejects(core.checkpoints.list({ limit: 101 }), /checkpoint_list_limit_invalid/);
});


test('renamed claim inode is reclaimed from a moved artifacts directory without touching replacement or third-party files', async (t) => {
  const core = await tempCore(t, 'checkpoint-renamed-claim-reclaim');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['rename-resistant cleanup'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-renamed-claim-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-renamed-claim-control-'));
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    runAtClaimWorkerPhase(
      () => prepareCheckpointArtifactWriteClaimUnlocked(
        core.workspace,
        artifact,
        writeClaimId,
        { testControlDirectory: controlDirectory, testPhase: 'after-write-before-final-check' },
      ),
      controlDirectory,
      'after-write-before-final-check',
      async () => {
        await fs.rename(path.join(paths.artifacts, claimName), path.join(paths.artifacts, 'attacker-stash'));
        await fs.writeFile(path.join(paths.artifacts, 'third-party.txt'), 'third-party-must-survive', 'utf8');
        await fs.rename(paths.artifacts, movedArtifacts);
        await fs.mkdir(paths.artifacts);
        await fs.writeFile(path.join(paths.artifacts, claimName), 'replacement-must-survive', 'utf8');
      },
    ),
    /checkpoint_path_outside_store/,
  );

  assert.deepEqual(await fs.readdir(movedArtifacts), ['third-party.txt']);
  assert.equal(await fs.readFile(path.join(movedArtifacts, 'third-party.txt'), 'utf8'), 'third-party-must-survive');
  assert.equal(await fs.readFile(path.join(paths.artifacts, claimName), 'utf8'), 'replacement-must-survive');
  await assert.rejects(fs.access(path.join(movedArtifacts, 'attacker-stash')), /ENOENT/);
});

async function raceCheckpointWriteDirectory({ operation, directory, replacementSetup, phase = 'after-write-before-finalize' }) {
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-write-race-outside-')));
  const moved = path.join(outsideParent, 'moved');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-write-race-control-'));
  const outcome = operation(controlDirectory).then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', error }),
  );
  await Promise.race([
    waitForFile(path.join(controlDirectory, `${phase}.ready`)),
    outcome.then((result) => {
      throw result.status === 'rejected' ? result.error : new Error(`checkpoint file worker completed before ${phase}`);
    }),
  ]);
  await fs.writeFile(path.join(directory, 'third-party.txt'), 'third-party-must-survive', 'utf8');
  await fs.rename(directory, moved);
  await replacementSetup();
  await fs.writeFile(path.join(controlDirectory, `${phase}.release`), '', { flag: 'wx' });
  const result = await outcome;
  return { result, outsideParent, moved, controlDirectory };
}

test('checkpoint draft replacement fails closed under directory swap and removes every outside owned byte', async (t) => {
  const core = await tempCore(t, 'checkpoint-draft-directory-swap');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['original'] } });
  const updated = structuredClone(draft);
  updated.updatedAt = new Date(Date.parse(draft.updatedAt) + 1_000).toISOString();
  updated.claims.pending = ['updated bytes must not escape'];
  const paths = checkpointStorePaths(core.workspace);
  const raced = await raceCheckpointWriteDirectory({
    directory: paths.drafts,
    operation: (controlDirectory) => writeCheckpointDraftUnlocked(core.workspace, updated, {
      testControlDirectory: controlDirectory,
      testPhase: 'after-write-before-finalize',
    }),
    replacementSetup: async () => {
      await fs.mkdir(paths.drafts);
      await fs.writeFile(path.join(paths.drafts, `${draft.draftId}.json`), 'replacement-draft-must-survive', 'utf8');
    },
  });
  t.after(async () => {
    await fs.rm(raced.outsideParent, { recursive: true, force: true });
    await fs.rm(raced.controlDirectory, { recursive: true, force: true });
  });
  assert.equal(raced.result.status, 'rejected');
  assert.match(raced.result.error.message, /checkpoint_path_outside_store/);
  assert.deepEqual(await fs.readdir(raced.moved), [`${draft.draftId}.json`, 'third-party.txt']);
  assert.equal(await fs.readFile(path.join(raced.moved, `${draft.draftId}.json`), 'utf8'), canonicalCheckpointJson(draft));
  assert.equal(await fs.readFile(path.join(paths.drafts, `${draft.draftId}.json`), 'utf8'), 'replacement-draft-must-survive');
});

test('checkpoint finalization intent replacement fails closed under directory swap with no outside temp or final', async (t) => {
  const core = await tempCore(t, 'checkpoint-intent-directory-swap');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['intent race'] } });
  const artifact = artifactForDraft(draft);
  const anchors = normalizeMachineAnchors({ files: [], commands: [] });
  const intent = {
    schemaVersion: 1,
    draftId: draft.draftId,
    artifactId: artifact.id,
    creationProvenance: 'created',
    writeClaimId: crypto.randomUUID(),
    build: finalizationBuild(anchors, artifact.createdAt),
  };
  const paths = checkpointStorePaths(core.workspace);
  const symlinkTarget = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-intent-symlink-target-')));
  const raced = await raceCheckpointWriteDirectory({
    directory: paths.finalizations,
    operation: (controlDirectory) => writeCheckpointFinalizationIntentUnlocked(core.workspace, intent, {
      testControlDirectory: controlDirectory,
      testPhase: 'after-write-before-finalize',
    }),
    replacementSetup: async () => {
      await fs.writeFile(path.join(symlinkTarget, `${draft.draftId}.json`), 'replacement-intent-must-survive', 'utf8');
      await fs.symlink(symlinkTarget, paths.finalizations, 'dir');
    },
  });
  t.after(async () => {
    await fs.rm(raced.outsideParent, { recursive: true, force: true });
    await fs.rm(raced.controlDirectory, { recursive: true, force: true });
    await fs.rm(symlinkTarget, { recursive: true, force: true });
  });
  assert.equal(raced.result.status, 'rejected');
  assert.match(raced.result.error.message, /checkpoint_path_outside_store/);
  assert.deepEqual(await fs.readdir(raced.moved), ['third-party.txt']);
  assert.equal(await fs.readFile(path.join(symlinkTarget, `${draft.draftId}.json`), 'utf8'), 'replacement-intent-must-survive');
  assert.deepEqual(await fs.readdir(symlinkTarget), [`${draft.draftId}.json`]);
});

test('checkpoint artifact create rolls back its exact inode after final link and directory swap', async (t) => {
  const core = await tempCore(t, 'checkpoint-artifact-directory-swap');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['artifact race'] } });
  const artifact = artifactForDraft(draft);
  const paths = checkpointStorePaths(core.workspace);
  const finalName = `${artifact.id}.json`;
  const raced = await raceCheckpointWriteDirectory({
    directory: paths.artifacts,
    phase: 'after-finalize-before-final-check',
    operation: (controlDirectory) => writeCheckpointArtifactNewUnlocked(core.workspace, artifact, {
      testControlDirectory: controlDirectory,
      testPhase: 'after-finalize-before-final-check',
    }),
    replacementSetup: async () => {
      await fs.mkdir(paths.artifacts);
      await fs.writeFile(path.join(paths.artifacts, finalName), 'replacement-artifact-must-survive', 'utf8');
    },
  });
  t.after(async () => {
    await fs.rm(raced.outsideParent, { recursive: true, force: true });
    await fs.rm(raced.controlDirectory, { recursive: true, force: true });
  });
  assert.equal(raced.result.status, 'rejected');
  assert.match(raced.result.error.message, /checkpoint_path_outside_store/);
  assert.deepEqual(await fs.readdir(raced.moved), ['third-party.txt']);
  assert.equal(await fs.readFile(path.join(paths.artifacts, finalName), 'utf8'), 'replacement-artifact-must-survive');
});

test('checkpoint audit replacement fails closed when the checkpoint root is swapped', async (t) => {
  const core = await tempCore(t, 'checkpoint-audit-directory-swap');
  await core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['seed audit'] } });
  const paths = checkpointStorePaths(core.workspace);
  const raced = await raceCheckpointWriteDirectory({
    directory: paths.root,
    operation: (controlDirectory) => appendCheckpointAuditUnlocked(
      core.workspace,
      { type: 'checkpoint.rejected', operation: 'artifact.read', reasonCode: 'checkpoint_directory_swap_probe' },
      { testControlDirectory: controlDirectory, testPhase: 'after-write-before-finalize' },
    ),
    replacementSetup: async () => {
      await fs.mkdir(paths.root);
      await Promise.all([
        fs.mkdir(paths.drafts),
        fs.mkdir(paths.artifacts),
        fs.mkdir(paths.finalizations),
      ]);
      await fs.writeFile(paths.audit, 'replacement-audit-must-survive\n', 'utf8');
    },
  });
  t.after(async () => {
    await fs.rm(raced.outsideParent, { recursive: true, force: true });
    await fs.rm(raced.controlDirectory, { recursive: true, force: true });
  });
  assert.equal(raced.result.status, 'rejected');
  assert.match(raced.result.error.message, /checkpoint_path_outside_store/);
  assert.ok((await fs.readdir(raced.moved)).includes('third-party.txt'));
  const movedFiles = await fs.readdir(raced.moved);
  assert.equal(movedFiles.some((name) => name.endsWith('.tmp')), false);
  assert.doesNotMatch(await fs.readFile(path.join(raced.moved, 'audit.ndjson'), 'utf8'), /checkpoint_directory_swap_probe/);
  assert.equal(await fs.readFile(paths.audit, 'utf8'), 'replacement-audit-must-survive\n');
});

test('worker reclaims a renamed moved claim when the pinned guardian is SIGKILLed and IPC closes', async (t) => {
  const core = await tempCore(t, 'checkpoint-guardian-crash-renamed-claim');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['worker backup cleanup'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-guardian-crash-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-guardian-crash-control-'));
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });

  await assert.rejects(
    runAtClaimWorkerPhase(
      () => prepareCheckpointArtifactWriteClaimUnlocked(
        core.workspace,
        artifact,
        writeClaimId,
        { testControlDirectory: controlDirectory, testPhase: 'after-write-before-final-check' },
      ),
      controlDirectory,
      'after-write-before-final-check',
      async () => {
        const { pid: guardPid } = JSON.parse(await fs.readFile(path.join(controlDirectory, 'guard.ready'), 'utf8'));
        await fs.rename(path.join(paths.artifacts, claimName), path.join(paths.artifacts, 'attacker-stash'));
        await fs.writeFile(path.join(paths.artifacts, 'third-party.txt'), 'survive', 'utf8');
        await fs.rename(paths.artifacts, movedArtifacts);
        await fs.mkdir(paths.artifacts);
        await fs.writeFile(path.join(paths.artifacts, claimName), 'replacement-survives', 'utf8');
        process.kill(guardPid, 'SIGKILL');
      },
    ),
    /checkpoint_path_outside_store/,
  );
  assert.deepEqual(await fs.readdir(movedArtifacts), ['third-party.txt']);
  assert.equal(await fs.readFile(path.join(paths.artifacts, claimName), 'utf8'), 'replacement-survives');
});

async function assertDirectoryHasNoInode(directory, expected) {
  for (const name of await fs.readdir(directory)) {
    const stat = await fs.lstat(path.join(directory, name), { bigint: true });
    assert.notEqual(`${stat.dev}:${stat.ino}`, `${expected.dev}:${expected.ino}`, `owned inode survived as ${name}`);
  }
}

test('file-worker SIGKILL cleanup follows the pinned directory and removes renamed hardlinks only', async (t) => {
  const core = await tempCore(t, 'checkpoint-file-worker-double-name-sigkill');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['original'] } });
  const updated = structuredClone(draft);
  updated.updatedAt = new Date(Date.parse(draft.updatedAt) + 1_000).toISOString();
  updated.claims.pending = ['FILE_WORKER_SIGKILL_OWNED_BYTES'];
  const paths = checkpointStorePaths(core.workspace);
  const finalName = `${draft.draftId}.json`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-file-kill-outside-')));
  const movedDrafts = path.join(outsideParent, 'moved-drafts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-file-kill-control-'));
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });

  const operation = writeCheckpointDraftUnlocked(core.workspace, updated, {
    testControlDirectory: controlDirectory,
    testPhase: 'after-finalize-before-final-check',
  });
  const ready = path.join(controlDirectory, 'after-finalize-before-final-check.ready');
  await waitForFile(ready);
  const { pid } = JSON.parse(await fs.readFile(ready, 'utf8'));
  const owned = await fs.stat(path.join(paths.drafts, finalName), { bigint: true });
  await fs.link(path.join(paths.drafts, finalName), path.join(paths.drafts, 'attacker-hardlink'));
  await fs.rename(path.join(paths.drafts, finalName), path.join(paths.drafts, 'attacker-renamed'));
  await fs.writeFile(path.join(paths.drafts, 'third-party.txt'), 'third-party-must-survive', 'utf8');
  await fs.rename(paths.drafts, movedDrafts);
  await fs.mkdir(paths.drafts, { mode: 0o700 });
  await fs.writeFile(path.join(paths.drafts, finalName), 'canonical-replacement-must-survive', 'utf8');
  await fs.writeFile(path.join(paths.drafts, 'replacement-third-party.txt'), 'replacement-third-party-must-survive', 'utf8');
  process.kill(pid, 'SIGKILL');

  await assert.rejects(operation, /checkpoint_internal_failure/);
  assert.deepEqual(await fs.readdir(movedDrafts), ['third-party.txt']);
  assert.equal(await fs.readFile(path.join(movedDrafts, 'third-party.txt'), 'utf8'), 'third-party-must-survive');
  assert.equal(await fs.readFile(path.join(paths.drafts, finalName), 'utf8'), 'canonical-replacement-must-survive');
  assert.equal(await fs.readFile(path.join(paths.drafts, 'replacement-third-party.txt'), 'utf8'), 'replacement-third-party-must-survive');
  await assertDirectoryHasNoInode(movedDrafts, owned);
  await assertDirectoryHasNoInode(paths.drafts, owned);
});

test('file-worker parent timeout waits for pinned cleanup after IPC termination and directory replacement', async (t) => {
  const core = await tempCore(t, 'checkpoint-file-worker-timeout-reaper');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['original'] } });
  const updated = structuredClone(draft);
  updated.updatedAt = new Date(Date.parse(draft.updatedAt) + 1_000).toISOString();
  updated.claims.pending = ['FILE_WORKER_TIMEOUT_OWNED_BYTES'];
  const paths = checkpointStorePaths(core.workspace);
  const finalName = `${draft.draftId}.json`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-file-timeout-outside-')));
  const movedDrafts = path.join(outsideParent, 'moved-drafts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-file-timeout-control-'));
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });

  const operation = writeCheckpointDraftUnlocked(core.workspace, updated, {
    testControlDirectory: controlDirectory,
    testPhase: 'after-finalize-before-final-check',
    testTimeoutMs: 200,
  });
  await waitForFile(path.join(controlDirectory, 'after-finalize-before-final-check.ready'));
  const owned = await fs.stat(path.join(paths.drafts, finalName), { bigint: true });
  await fs.rename(path.join(paths.drafts, finalName), path.join(paths.drafts, 'attacker-renamed'));
  await fs.rename(paths.drafts, movedDrafts);
  await fs.mkdir(paths.drafts, { mode: 0o700 });
  await fs.writeFile(path.join(paths.drafts, finalName), 'timeout-replacement-must-survive', 'utf8');

  await assert.rejects(operation, /checkpoint_internal_failure/);
  assert.deepEqual(await fs.readdir(movedDrafts), []);
  assert.equal(await fs.readFile(path.join(paths.drafts, finalName), 'utf8'), 'timeout-replacement-must-survive');
  await assertDirectoryHasNoInode(movedDrafts, owned);
  await assertDirectoryHasNoInode(paths.drafts, owned);
});

test('claim reaper survives worker and guardian SIGKILL and removes every renamed claim hardlink', async (t) => {
  const core = await tempCore(t, 'checkpoint-claim-double-sigkill-reaper');
  const draft = await core.checkpoints.createDraft({ runtime: 'unit', claims: { completed: ['CLAIM_DOUBLE_SIGKILL_OWNED_BYTES'] } });
  const artifact = artifactForDraft(draft);
  const writeClaimId = crypto.randomUUID();
  const paths = checkpointStorePaths(core.workspace);
  const claimName = `.${artifact.id}.claim-${writeClaimId}.tmp`;
  const outsideParent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-double-kill-outside-')));
  const movedArtifacts = path.join(outsideParent, 'moved-artifacts');
  const controlDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-double-kill-control-'));
  t.after(async () => {
    await fs.rm(outsideParent, { recursive: true, force: true });
    await fs.rm(controlDirectory, { recursive: true, force: true });
  });

  const operation = prepareCheckpointArtifactWriteClaimUnlocked(core.workspace, artifact, writeClaimId, {
    testControlDirectory: controlDirectory,
    testPhase: 'after-write-before-final-check',
  });
  await Promise.all([
    waitForFile(path.join(controlDirectory, 'guard.ready')),
    waitForFile(path.join(controlDirectory, 'after-write-before-final-check.ready')),
  ]);
  const { pid: guardPid } = JSON.parse(await fs.readFile(path.join(controlDirectory, 'guard.ready'), 'utf8'));
  const { pid: workerPid } = JSON.parse(await fs.readFile(path.join(controlDirectory, 'after-write-before-final-check.ready'), 'utf8'));
  const owned = await fs.stat(path.join(paths.artifacts, claimName), { bigint: true });
  await fs.link(path.join(paths.artifacts, claimName), path.join(paths.artifacts, 'attacker-hardlink'));
  await fs.rename(path.join(paths.artifacts, claimName), path.join(paths.artifacts, 'attacker-stash'));
  await fs.writeFile(path.join(paths.artifacts, 'third-party.txt'), 'third-party-must-survive', 'utf8');
  await fs.rename(paths.artifacts, movedArtifacts);
  await fs.mkdir(paths.artifacts, { mode: 0o700 });
  await fs.writeFile(path.join(paths.artifacts, claimName), 'canonical-replacement-must-survive', 'utf8');
  await fs.writeFile(path.join(paths.artifacts, 'replacement-third-party.txt'), 'replacement-third-party-must-survive', 'utf8');
  process.kill(workerPid, 'SIGKILL');
  process.kill(guardPid, 'SIGKILL');

  await assert.rejects(operation, /checkpoint_internal_failure/);
  assert.deepEqual(await fs.readdir(movedArtifacts), ['third-party.txt']);
  assert.equal(await fs.readFile(path.join(movedArtifacts, 'third-party.txt'), 'utf8'), 'third-party-must-survive');
  assert.equal(await fs.readFile(path.join(paths.artifacts, claimName), 'utf8'), 'canonical-replacement-must-survive');
  assert.equal(await fs.readFile(path.join(paths.artifacts, 'replacement-third-party.txt'), 'utf8'), 'replacement-third-party-must-survive');
  await assertDirectoryHasNoInode(movedArtifacts, owned);
  await assertDirectoryHasNoInode(paths.artifacts, owned);
});

async function collectRegularFileText(root) {
  const chunks = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) chunks.push(await fs.readFile(file, 'utf8'));
    }
  }
  await visit(root);
  return chunks.join('\n');
}

test('checkpoint root aliases are rejected before every public write in managed and existing-memory-root modes', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-checkpoint-root-alias-all-writes-')));
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });

  const managedProject = path.join(root, 'managed-project');
  await fs.mkdir(managedProject);
  const managed = await openCore({ root: path.join(root, 'managed-store'), space: 'alias-test', cwd: managedProject });
  const seed = await managed.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['seed'] } });
  const artifact = artifactForDraft(seed);
  const updated = structuredClone(seed);
  updated.updatedAt = new Date(Date.parse(seed.updatedAt) + 1_000).toISOString();
  updated.claims.pending = ['ROOT_ALIAS_MUST_NEVER_BE_WRITTEN'];
  const anchors = normalizeMachineAnchors({ files: [], commands: [] });
  const intent = {
    schemaVersion: 1,
    draftId: seed.draftId,
    artifactId: artifact.id,
    creationProvenance: 'created',
    writeClaimId: crypto.randomUUID(),
    build: finalizationBuild(anchors, artifact.createdAt),
  };
  const managedPaths = checkpointStorePaths(managed.workspace);
  await fs.rm(managedPaths.root, { recursive: true, force: true });
  await fs.symlink(managed.workspace.spaceDir, managedPaths.root, 'dir');

  const managedWrites = [
    () => managed.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['ROOT_ALIAS_MUST_NEVER_BE_WRITTEN'] } }),
    () => writeCheckpointDraftUnlocked(managed.workspace, updated),
    () => writeCheckpointFinalizationIntentUnlocked(managed.workspace, intent),
    () => writeCheckpointArtifactNewUnlocked(managed.workspace, artifact),
    () => prepareCheckpointArtifactWriteClaimUnlocked(managed.workspace, artifact, crypto.randomUUID()),
    () => appendCheckpointAuditUnlocked(managed.workspace, {
      type: 'checkpoint.rejected',
      operation: 'artifact.read',
      reasonCode: 'checkpoint_root_alias_probe',
    }),
  ];
  for (const write of managedWrites) await assert.rejects(write, /checkpoint_path_outside_store/);
  assert.equal(await fs.access(path.join(managed.workspace.spaceDir, 'drafts')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(managed.workspace.spaceDir, 'artifacts')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(managed.workspace.spaceDir, 'finalizations')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(managed.workspace.spaceDir, 'audit.ndjson')).then(() => true, () => false), false);
  assert.doesNotMatch(await collectRegularFileText(managed.workspace.spaceDir), /ROOT_ALIAS_MUST_NEVER_BE_WRITTEN|checkpoint_root_alias_probe/);

  const memoryRoot = path.join(root, 'existing-memory');
  const stateRoot = path.join(root, 'existing-state');
  await Promise.all([fs.mkdir(memoryRoot), fs.mkdir(stateRoot)]);
  const existing = await openCore({ memoryRoot, stateRoot });
  const existingPaths = checkpointStorePaths(existing.workspace);
  await fs.rm(existingPaths.root, { recursive: true, force: true });
  await fs.symlink(existing.workspace.mcpDir, existingPaths.root, 'dir');
  await assert.rejects(
    existing.checkpoints.createDraft({ runtime: 'unit', claims: { pending: ['EXISTING_ROOT_ALIAS_MUST_NEVER_BE_WRITTEN'] } }),
    /checkpoint_path_outside_store/,
  );
  assert.equal(await fs.access(path.join(existing.workspace.mcpDir, 'drafts')).then(() => true, () => false), false);
  assert.equal(await fs.access(path.join(existing.workspace.mcpDir, 'artifacts')).then(() => true, () => false), false);
  assert.doesNotMatch(await collectRegularFileText(existing.workspace.mcpDir), /EXISTING_ROOT_ALIAS_MUST_NEVER_BE_WRITTEN/);
});
