// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import * as proposals from '../src/memory-proposals.ts';
import { openCore } from '../src/core.ts';
import { appendEvent } from '../src/store/events.ts';

function proposalInput(kind = 'fact') {
  return {
    schemaVersion: 1,
    kind,
    text: `[memory:${kind}] subject=Workspace | key=Mode | value=Review first`,
    subject: 'Workspace',
    key: 'Mode',
    value: 'Review first',
    scope: {
      declaredVisibility: 'project',
      effectiveVisibility: 'project',
      projectScope: 'alpha29',
      sourcePath: null,
      frontmatter: null,
    },
    provenance: {
      sourceKind: 'transcript',
      sourceId: 'session-1',
      runtime: 'codex',
      observedAt: '2026-07-16T00:00:00.000Z',
      sourceSha256: 'a'.repeat(64),
      evidenceLocator: 'transcript:record:0:text:line:1',
    },
    relation: {
      verdict: 'new',
      targetProposalIds: [],
      targetPaths: [],
      reviewRequired: true,
      destructive: false,
      reason: 'no_existing_relation',
    },
    review: { mode: 'review-first', state: 'pending' },
    safety: {
      outcome: 'candidate-only',
      directDurableWrite: false,
      indexWrite: false,
      destructive: false,
      autoPromote: false,
    },
  };
}

test('MemoryProposalV1 is exact, versioned, deterministic, and supports all four kinds', () => {
  assert.equal(typeof proposals.createMemoryProposalV1, 'function', 'createMemoryProposalV1 behavior must exist');
  assert.equal(typeof proposals.validateMemoryProposalV1, 'function', 'validateMemoryProposalV1 behavior must exist');
  assert.equal(typeof proposals.canonicalProposalIdV1, 'function', 'canonicalProposalIdV1 behavior must exist');

  for (const kind of ['preference', 'fact', 'event', 'procedure']) {
    const first = proposals.createMemoryProposalV1(proposalInput(kind));
    const second = proposals.createMemoryProposalV1(structuredClone(proposalInput(kind)));
    assert.match(first.proposalId, /^mp1_[0-9a-f]{64}$/);
    assert.equal(first.proposalId, second.proposalId);
    assert.equal(proposals.canonicalProposalIdV1(first), first.proposalId);
    assert.deepEqual(proposals.validateMemoryProposalV1(first), first);
  }
});

test('MemoryProposalV1 rejects unknown fields, unknown kinds, and schema drift', () => {
  const valid = proposals.createMemoryProposalV1(proposalInput());
  assert.throws(
    () => proposals.validateMemoryProposalV1({ ...valid, extra: true }),
    /unknown field/,
  );
  assert.throws(
    () => proposals.validateMemoryProposalV1({ ...valid, schemaVersion: 2 }),
    /schemaVersion/,
  );
  assert.throws(
    () => proposals.createMemoryProposalV1({ ...proposalInput(), kind: 'status' }),
    /kind/,
  );
  const nested = structuredClone(valid);
  nested.provenance.extra = true;
  assert.throws(() => proposals.validateMemoryProposalV1(nested), /unknown field/);
});

function jsonl(...records) {
  return records.map((record) => JSON.stringify(record)).join('\n');
}

test('transcript extraction accepts only exact English/Chinese marked text signals', () => {
  assert.equal(
    typeof proposals.extractTranscriptMemorySignalsV1,
    'function',
    'transcript explicit-signal extraction behavior must exist',
  );
  const raw = jsonl(
    { type: 'user', message: { content: 'ordinary prose must not become memory' } },
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '[memory:preference] subject= Alice  | key= Editor | value= VS Code' },
          { type: 'tool_result', content: '[memory:fact] subject=Leak | key=tool | value=must-ignore' },
          {
            type: 'tool_use',
            name: 'Bash',
            input: { command: 'echo "[memory:event] subject=Leak | key=bash | value=must-ignore"' },
          },
          { type: 'text', text: '[记忆:流程] 主体= 项目甲 ｜ 键= 发布 ｜ 值= 先测试 再发布' },
        ],
      },
    },
  );
  const result = proposals.extractTranscriptMemorySignalsV1(raw);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(
    result.signals.map(({ kind, subject, key, value, supersedes }) => ({ kind, subject, key, value, supersedes })),
    [
      { kind: 'preference', subject: 'Alice', key: 'Editor', value: 'VS Code', supersedes: null },
      { kind: 'procedure', subject: '项目甲', key: '发布', value: '先测试 再发布', supersedes: null },
    ],
  );
  assert.match(result.signals[0].evidenceLocator, /^transcript:record:\d+:text:\d+:line:\d+$/);
});

test('transcript extraction ignores unmarked prose and rejects malformed marked lines conservatively', () => {
  const raw = jsonl(
    { type: 'user', message: { content: 'I prefer dark mode and the old choice is no longer used.' } },
    { type: 'assistant', message: { content: '[memory:fact] subject=A | key=B | key=C | value=D' } },
    { type: 'assistant', message: { content: '[memory:event] subject=A | value=D' } },
    { type: 'assistant', message: { content: '[memory:procedure] subject=A | key=B | value=D | guess=yes' } },
  );
  const result = proposals.extractTranscriptMemorySignalsV1(raw);
  assert.deepEqual(result.signals, []);
  assert.equal(result.rejected.length, 3);
  assert.deepEqual(result.rejected.map((item) => item.reason), [
    'signal_duplicate_field',
    'signal_missing_field',
    'signal_unknown_field',
  ]);
});

function sourceEnvelope(overrides = {}) {
  return {
    sourceId: 'runtime-session-1',
    runtime: 'codex',
    observedAt: '2026-07-16T01:02:03.000Z',
    declaredVisibility: 'project',
    projectScope: 'alpha29',
    sourcePath: null,
    frontmatter: null,
    ...overrides,
  };
}

function runtimeRequest(overrides = {}) {
  const source = sourceEnvelope(overrides.source);
  return {
    schemaVersion: 1,
    sourceKind: 'runtime-event',
    source,
    runtimeEvent: {
      schemaVersion: 1,
      event: 'runtime.after_turn',
      runtime: source.runtime,
      cwd: '/tmp/alpha29-fixture',
      sessionId: source.sourceId,
      observedAt: source.observedAt,
    },
    signalText: '[memory:event] subject=alpha29 | key=gate | value=focused tests passed',
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'source')),
  };
}

test('runtime-event extraction requires a validated lifecycle event plus bounded explicit signal', () => {
  assert.equal(typeof proposals.validateMemoryProposalRequestV1, 'function');
  assert.equal(typeof proposals.extractMemorySignalsV1, 'function');
  const request = proposals.validateMemoryProposalRequestV1(runtimeRequest());
  const result = proposals.extractMemorySignalsV1(request);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.signals.map(({ kind, subject, key, value }) => ({ kind, subject, key, value })), [
    { kind: 'event', subject: 'alpha29', key: 'gate', value: 'focused tests passed' },
  ]);
  assert.equal(result.signals[0].evidenceLocator, 'runtime-event:signal:line:1');
});

test('runtime-event/source validation rejects malformed, mismatched, unknown, and oversized input', () => {
  const schema = runtimeRequest();
  schema.runtimeEvent.schemaVersion = 2;
  assert.throws(() => proposals.validateMemoryProposalRequestV1(schema), /runtime.*schemaVersion|schemaVersion.*runtime/);

  const eventName = runtimeRequest();
  eventName.runtimeEvent.event = 'runtime.unknown';
  assert.throws(() => proposals.validateMemoryProposalRequestV1(eventName), /runtimeEvent.event/);

  const mismatch = runtimeRequest({ source: { runtime: 'codex' } });
  mismatch.runtimeEvent.runtime = 'claude';
  assert.throws(() => proposals.validateMemoryProposalRequestV1(mismatch), /runtime.*match/);

  assert.throws(
    () => proposals.validateMemoryProposalRequestV1(runtimeRequest({ signalText: 'x'.repeat(4097) })),
    /signalText.*4096/,
  );

  const extra = runtimeRequest();
  extra.source.extra = true;
  assert.throws(() => proposals.validateMemoryProposalRequestV1(extra), /unknown field/);
});

async function temporaryCore(t, prefix = 'ihow-alpha29-product-') {
  const parent = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(async () => { await fs.rm(parent, { recursive: true, force: true }); });
  const core = await openCore({ root: parent, space: 'proposal-test', cwd: parent, engine: 'fts' });
  return { parent, core };
}

async function treeSnapshot(root) {
  const entries = [];
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) {
        const data = await fs.readFile(absolute);
        entries.push({
          path: path.relative(root, absolute).split(path.sep).join('/'),
          bytes: data.length,
          sha256: crypto.createHash('sha256').update(data).digest('hex'),
        });
      }
    }
  }
  await walk(root);
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

test('secret/private/audit/malformed gates block with exactly zero workspace writes', async (t) => {
  assert.equal(typeof proposals.proposeMemoryV1, 'function', 'bounded proposal gate/staging entry must exist');
  const { parent, core } = await temporaryCore(t);
  const hostile = [
    runtimeRequest({ signalText: '[memory:fact] subject=build | key=token | value=api_key=REAL_SECRET_123456' }),
    runtimeRequest({ source: { declaredVisibility: 'private' } }),
    runtimeRequest({ source: { declaredVisibility: 'project', sourcePath: 'notes/private/account.md' } }),
    runtimeRequest({ source: { declaredVisibility: 'source-shared', frontmatter: 'visibility: audit-only' } }),
    runtimeRequest({ source: { projectScope: '../escape' } }),
  ];
  const expectedReasons = ['secret', 'private', 'private', 'audit-only', 'malformed_input'];
  for (let index = 0; index < hostile.length; index += 1) {
    const before = await treeSnapshot(parent);
    const result = await proposals.proposeMemoryV1(core.workspace, hostile[index]);
    const after = await treeSnapshot(parent);
    assert.deepEqual(result, [{ schemaVersion: 1, status: 'blocked', reason: expectedReasons[index] }]);
    assert.deepEqual(after, before, `blocked control ${index} must write nothing`);
  }
});

test('visibility precedence cannot downgrade audit/private boundaries', () => {
  assert.equal(typeof proposals.effectiveProposalVisibilityV1, 'function');
  assert.equal(proposals.effectiveProposalVisibilityV1(sourceEnvelope({
    declaredVisibility: 'project',
    sourcePath: 'audit/log.md',
    frontmatter: 'visibility: private',
  })), 'audit-only');
  assert.equal(proposals.effectiveProposalVisibilityV1(sourceEnvelope({
    declaredVisibility: 'source-shared',
    sourcePath: 'notes/private/item.md',
  })), 'private');
});

test('real core proposal method stages exactly one review candidate/event and leaves durable/index surfaces unchanged', async (t) => {
  assert.equal(typeof proposals.proposalPersistenceCensusV1, 'function', 'persistence census behavior must exist');
  const { core } = await temporaryCore(t, 'ihow-alpha29-stage-');
  assert.equal(typeof core.propose_memory, 'function', 'bounded core proposal method must exist');
  await core.rebuild();
  const before = await proposals.proposalPersistenceCensusV1(core.workspace);
  const request = runtimeRequest({
    signalText: '[memory:fact] subject=alpha29 | key=owner | value=alice@example.com',
  });
  const result = await core.propose_memory(request);
  const after = await proposals.proposalPersistenceCensusV1(core.workspace);

  assert.equal(result.length, 1);
  assert.equal(result[0].status, 'staged');
  assert.equal(result[0].proposal.review.state, 'pending');
  assert.equal(result[0].proposal.safety.outcome, 'candidate-only');
  assert.equal(result[0].proposal.value, '[redacted]');
  assert.equal(result[0].relationError, null);
  assert.equal(after.candidates.fileCount - before.candidates.fileCount, 1);
  assert.equal(after.events.eventCount - before.events.eventCount, 1);
  assert.deepEqual(after.events.eventTypes.slice(before.events.eventTypes.length), ['candidate.created']);
  assert.equal(after.durable.sha256, before.durable.sha256);
  assert.equal(after.history.sha256, before.history.sha256);
  assert.equal(after.fts.sha256, before.fts.sha256);
  assert.equal(after.indexManifest.sha256, before.indexManifest.sha256);

  const candidate = await fs.readFile(path.join(core.workspace.memoryDir, result[0].candidate.path.slice('memory/'.length)), 'utf8');
  assert.doesNotMatch(candidate, /alice@example\.com/);
  assert.match(candidate, /\[redacted\]/);
});

test('ignored proposal requests through the real core method change no persistence surface', async (t) => {
  const { core } = await temporaryCore(t, 'ihow-alpha29-ignore-');
  await core.rebuild();
  const before = await proposals.proposalPersistenceCensusV1(core.workspace);
  const request = runtimeRequest({ signalText: 'ordinary lifecycle prose only' });
  const result = await core.propose_memory(request);
  const after = await proposals.proposalPersistenceCensusV1(core.workspace);
  assert.deepEqual(result, [{ schemaVersion: 1, status: 'ignored', reason: 'no_explicit_signal' }]);
  assert.deepEqual(after, before);
});

function relationRequest(signalText, sourceId, secondOffset) {
  const observedAt = new Date(Date.parse('2026-07-16T02:00:00.000Z') + secondOffset * 1000).toISOString();
  return runtimeRequest({
    source: { sourceId, observedAt },
    signalText,
    runtimeEvent: {
      schemaVersion: 1,
      event: 'runtime.after_turn',
      runtime: 'codex',
      cwd: '/tmp/alpha29-fixture',
      sessionId: sourceId,
      observedAt,
    },
  });
}

test('relations use exact NFKC/trim/collapse/lowercase matching and remain non-destructive', async (t) => {
  const { core } = await temporaryCore(t, 'ihow-alpha29-relations-');
  await core.rebuild();
  const first = (await core.propose_memory(relationRequest(
    '[memory:fact] subject=Ａlice | key= Editor   Choice | value=VS Code',
    'relation-1',
    1,
  )))[0];
  assert.equal(first.status, 'staged');

  const duplicate = (await core.propose_memory(relationRequest(
    '[memory:fact] subject=alice | key=editor choice | value=vs code',
    'relation-2',
    2,
  )))[0];
  assert.equal(duplicate.proposal.relation.verdict, 'duplicate');
  assert.ok(duplicate.proposal.relation.targetProposalIds.includes(first.proposal.proposalId));

  const conflict = (await core.propose_memory(relationRequest(
    '[memory:fact] subject=Alice | key=Editor Choice | value=Zed',
    'relation-3',
    3,
  )))[0];
  assert.equal(conflict.proposal.relation.verdict, 'conflict');
  assert.equal(conflict.proposal.relation.destructive, false);

  const supersedes = (await core.propose_memory(relationRequest(
    `[memory:fact] subject=Alice | key=Editor Choice | value=Neovim | supersedes=${first.proposal.proposalId}`,
    'relation-4',
    4,
  )))[0];
  assert.equal(supersedes.proposal.relation.verdict, 'supersedes');
  assert.deepEqual(supersedes.proposal.relation.targetProposalIds, [first.proposal.proposalId]);

  const beforeAmbiguous = await proposals.proposalPersistenceCensusV1(core.workspace);
  const ambiguous = (await core.propose_memory(relationRequest(
    '[memory:procedure] subject=Deploy | key=Runbook | value=old steps no longer used',
    'relation-5',
    5,
  )))[0];
  const afterAmbiguous = await proposals.proposalPersistenceCensusV1(core.workspace);
  assert.equal(ambiguous.proposal.relation.verdict, 'review_required');
  assert.notEqual(ambiguous.proposal.relation.verdict, 'supersedes');
  assert.equal(afterAmbiguous.durable.sha256, beforeAmbiguous.durable.sha256);
  assert.equal(afterAmbiguous.history.sha256, beforeAmbiguous.history.sha256);
  assert.equal(afterAmbiguous.fts.sha256, beforeAmbiguous.fts.sha256);
  assert.equal(afterAmbiguous.indexManifest.sha256, beforeAmbiguous.indexManifest.sha256);
});

test('forgotten/remembered events map to bounded redacted feedback without changing alpha28 Golden bytes', async () => {
  assert.equal(typeof proposals.feedbackEvidenceFromEventsV1, 'function');
  assert.equal(typeof proposals.validateMemoryFeedbackEvidenceV1, 'function');
  const holdoutPath = new URL('../eval/golden/v1/holdout.json', import.meta.url);
  const before = crypto.createHash('sha256').update(await fs.readFile(holdoutPath)).digest('hex');
  const evidence = proposals.feedbackEvidenceFromEventsV1([
    {
      id: 'forget-1',
      type: 'memory.forgotten',
      at: '2026-07-16T03:00:00.000Z',
      path: 'memory/scopes/alpha29/owner.md',
      actor: 'test',
    },
    {
      id: 'remember-1',
      type: 'memory.remembered',
      at: '2026-07-16T03:01:00.000Z',
      path: 'memory/scopes/alpha29/api_key=REAL_SECRET_123456.md',
      actor: 'test',
    },
    { id: 'ignore-1', type: 'candidate.created', at: '2026-07-16T03:02:00.000Z' },
  ]);
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence.map((item) => item.kind), ['negative-correction', 'restoration']);
  assert.ok(evidence.every((item) => proposals.validateMemoryFeedbackEvidenceV1(item)));
  assert.doesNotMatch(JSON.stringify(evidence), /REAL_SECRET_123456/);
  assert.ok(evidence.every((item) => item.safety.durableWrite === false));
  const after = crypto.createHash('sha256').update(await fs.readFile(holdoutPath)).digest('hex');
  assert.equal(after, before);
});

test('an exact active memory.forgotten target can produce a correction supersedes relation', async (t) => {
  const { core } = await temporaryCore(t, 'ihow-alpha29-forgotten-relation-');
  const original = (await core.propose_memory(relationRequest(
    '[memory:fact] subject=Service | key=Port | value=8080',
    'forgotten-relation-1',
    10,
  )))[0];
  await appendEvent(core.workspace, {
    type: 'memory.forgotten',
    path: original.candidate.path,
    actor: 'test',
    metadata: { reason: 'incorrect' },
  });
  const correction = (await core.propose_memory(relationRequest(
    '[memory:fact] subject=Service | key=Port | value=9090',
    'forgotten-relation-2',
    11,
  )))[0];
  assert.equal(correction.proposal.relation.verdict, 'supersedes');
  assert.deepEqual(correction.proposal.relation.targetPaths, [original.candidate.path]);
  assert.equal(correction.proposal.relation.reason, 'forgotten_correction_target');
});
