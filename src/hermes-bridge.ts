#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { openCore } from './core.ts';
import { contextProbe } from './context-probe.ts';
import { containsSecretLikeContent, redactSecretLikeContent } from './governance.ts';
import { checkpointDraftFinalizationPrecondition } from './checkpoints.ts';
import { CheckpointValidationError, type CheckpointMachineAnchors } from './checkpoint-schema.ts';
import { appendEvent } from './store/events.ts';
import { validateMemoryDeltaV1, type MemoryDeltaV1 } from './capture-intents.ts';

import {
  runtimeEventToContextProbe,
  type RuntimeLifecycleEvent,
  type RuntimeLifecycleEventName,
} from './runtime-events.ts';

const KNOWN_EVENTS = new Set<RuntimeLifecycleEventName>([
  'runtime.session_start',
  'runtime.session_reset',
  'runtime.before_prompt',
  'runtime.after_turn',
  'runtime.session_finalize',
  'runtime.session_end',
]);
const DURABLE_TRANSCRIPT_REVISION_EVENT = 'runtime.durable_transcript_revision';
const MAX_CONTEXT_CHARS = 8_000;
const CHECKPOINT_EVENTS = new Set<RuntimeLifecycleEventName>([
  'runtime.session_finalize',
  'runtime.session_end',
]);
const FILE_ANCHOR_MAX_BYTES = 1024 * 1024;

type HermesBridgeEvent = RuntimeLifecycleEvent & {
  prompt?: unknown;
  checkpointClaims?: unknown;
  turnReceipt?: unknown;
  diagnostic?: unknown;
};

type HermesDurableTranscriptRevisionEvent = Readonly<{
  schemaVersion: 1;
  event: typeof DURABLE_TRANSCRIPT_REVISION_EVENT;
  runtime: 'hermes';
  projectId: string;
  observedAt: string;
  publication: Record<string, unknown>;
}>;

const HASH_RE = /^[a-f0-9]{64}$/;
const SOURCE_HASH_RE = /^sha256:[a-f0-9]{64}$/;
const COMMIT_NOT_PROVEN_REASONS = new Set([
  'identity_invalid',
  'durable_marker_missing',
  'pending_not_found',
  'final_evidence_invalid',
  'final_conflict',
  'end_not_successful',
  'final_evidence_missing',
  'transport_failure',
  'input_conflict',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => key in record);
}

function parseDurableTranscriptRevisionEvent(value: unknown): HermesDurableTranscriptRevisionEvent | undefined {
  if (!isRecord(value) || value.event !== DURABLE_TRANSCRIPT_REVISION_EVENT) return undefined;
  if (
    !exactKeys(value, ['schemaVersion', 'event', 'runtime', 'projectId', 'observedAt', 'publication'])
    || value.schemaVersion !== 1
    || value.runtime !== 'hermes'
    || typeof value.projectId !== 'string'
    || !HASH_RE.test(value.projectId)
    || typeof value.observedAt !== 'string'
    || value.observedAt.length > 40
    || !Number.isFinite(Date.parse(value.observedAt))
    || !isRecord(value.publication)
  ) throw new Error('hermes_durable_revision_event_invalid');
  return {
    schemaVersion: 1,
    event: DURABLE_TRANSCRIPT_REVISION_EVENT,
    runtime: 'hermes',
    projectId: value.projectId,
    observedAt: value.observedAt,
    publication: value.publication,
  };
}

type ParsedReceiptAction =
  | { action: 'open' | 'commit'; receipt: Record<string, unknown> }
  | { action: 'capture'; delta: MemoryDeltaV1 };

function parseReceiptAction(value: unknown): ParsedReceiptAction | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.action !== 'string') {
    throw new Error('hermes_turn_receipt_action_invalid');
  }
  if (value.action === 'capture') {
    if (!exactKeys(value, ['action', 'delta'])) throw new Error('hermes_turn_receipt_capture_invalid');
    return { action: 'capture', delta: validateMemoryDeltaV1(value.delta).delta };
  }
  if (!exactKeys(value, ['action', 'receipt'])) throw new Error('hermes_turn_receipt_action_invalid');
  const receipt = value.receipt;
  const openKeysV1 = [
    'schemaVersion', 'runtime', 'projectId', 'sessionHash', 'turnId', 'revision',
    'inputSourceHash', 'inputContentSha256', 'openedAt',
  ] as const;
  const openKeysV2 = [
    'schemaVersion', 'identityDomain', 'origin', 'runtime', 'projectId', 'sessionHash', 'turnId', 'revision',
    'inputSourceHash', 'inputContentSha256', 'openedAt',
  ] as const;
  const commitKeys = [
    'schemaVersion', 'runtime', 'projectId', 'sessionHash', 'turnId', 'revision',
    'inputSourceHash', 'inputContentSha256', 'finalSourceHash', 'finalContentSha256',
    'committedAt', 'deltaState',
  ] as const;
  if (value.action !== 'open' && value.action !== 'commit') {
    throw new Error('hermes_turn_receipt_action_invalid');
  }
  const action = value.action as 'open' | 'commit';
  if (!isRecord(receipt)) {
    throw new Error(action === 'commit' ? 'hermes_turn_receipt_commit_invalid' : 'hermes_turn_receipt_action_invalid');
  }
  const keys = action === 'commit'
    ? commitKeys
    : receipt.schemaVersion === 2
      ? openKeysV2
      : openKeysV1;
  if (!exactKeys(receipt, keys)) {
    throw new Error(action === 'commit' ? 'hermes_turn_receipt_commit_invalid' : 'hermes_turn_receipt_action_invalid');
  }
  if (
    (receipt.schemaVersion !== 1 && receipt.schemaVersion !== 2)
    || receipt.runtime !== 'hermes'
    || receipt.revision !== 1
    || typeof receipt.projectId !== 'string' || !HASH_RE.test(receipt.projectId)
    || typeof receipt.sessionHash !== 'string' || !HASH_RE.test(receipt.sessionHash)
    || typeof receipt.turnId !== 'string' || !HASH_RE.test(receipt.turnId)
    || typeof receipt.inputSourceHash !== 'string' || !SOURCE_HASH_RE.test(receipt.inputSourceHash)
    || typeof receipt.inputContentSha256 !== 'string' || !HASH_RE.test(receipt.inputContentSha256)
  ) throw new Error(`hermes_turn_receipt_${value.action}_invalid`);
  if (value.action === 'open') {
    if (
      (receipt.schemaVersion === 2 && (
        receipt.identityDomain !== 'hermes-transcript-v1'
        || receipt.origin !== 'native-hook'
      ))
      || typeof receipt.openedAt !== 'string'
      || new Date(receipt.openedAt).toISOString() !== receipt.openedAt
    ) throw new Error('hermes_turn_receipt_open_invalid');
  } else if (
    receipt.schemaVersion !== 1
    || typeof receipt.finalSourceHash !== 'string' || !SOURCE_HASH_RE.test(receipt.finalSourceHash)
    || typeof receipt.finalContentSha256 !== 'string' || !HASH_RE.test(receipt.finalContentSha256)
    || typeof receipt.committedAt !== 'string'
    || new Date(receipt.committedAt).toISOString() !== receipt.committedAt
    || !['not_emitted', 'explicit_none', 'extraction_failed'].includes(receipt.deltaState as string)
  ) throw new Error('hermes_turn_receipt_commit_invalid');
  return { action: value.action, receipt };
}

function parseCommitDiagnostic(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value.code !== 'string') {
    throw new Error('hermes_commit_diagnostic_invalid');
  }
  const hasHookTurnDiagnostic = 'hookTurnDiagnostic' in value;
  const hookTurnDiagnostic = value.hookTurnDiagnostic;
  if (hasHookTurnDiagnostic && (typeof hookTurnDiagnostic !== 'string' || !HASH_RE.test(hookTurnDiagnostic))) {
    throw new Error('hermes_commit_diagnostic_invalid');
  }
  if (value.code === 'commit_not_proven') {
    const keys = hasHookTurnDiagnostic
      ? ['code', 'reason', 'hookTurnDiagnostic'] as const
      : ['code', 'reason'] as const;
    if (
      !exactKeys(value, keys)
      || typeof value.reason !== 'string'
      || !COMMIT_NOT_PROVEN_REASONS.has(value.reason)
    ) throw new Error('hermes_commit_diagnostic_invalid');
    return { ...value };
  }
  if (value.code === 'durable_transcript_input_invalid' || value.code === 'durable_transcript_revision_pending') {
    const keys = hasHookTurnDiagnostic
      ? ['code', 'hookTurnDiagnostic'] as const
      : ['code'] as const;
    if (!exactKeys(value, keys)) throw new Error('hermes_commit_diagnostic_invalid');
    return { ...value };
  }
  throw new Error('hermes_commit_diagnostic_invalid');
}

type ReceiptProjectionBinding = {
  runtime: string;
  projectId: string;
  sessionHash: string;
};

function receiptProjectionBinding(action: ParsedReceiptAction | undefined): ReceiptProjectionBinding | undefined {
  if (action?.action === 'commit') {
    return {
      runtime: action.receipt.runtime as string,
      projectId: action.receipt.projectId as string,
      sessionHash: action.receipt.sessionHash as string,
    };
  }
  if (action?.action === 'capture') {
    const { runtime, projectId, sessionHash } = action.delta.receiptIdentity;
    return { runtime, projectId, sessionHash };
  }
  return undefined;
}

function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
    ? error.message
    : 'hermes_bridge_failed';
}

function commandOutputHash(output: string | Buffer): string {
  return crypto.createHash('sha256').update(output).digest('hex');
}

async function boundedRegularFileAnchor(
  cwd: string,
  relative: string,
): Promise<CheckpointMachineAnchors['files'][number] | undefined> {
  const target = path.join(cwd, relative);
  let handle: fsPromises.FileHandle | undefined;
  try {
    // O_NOFOLLOW rejects a symlink at the final component. One descriptor binds metadata and bytes
    // to the same inode, avoiding a stat/read TOCTOU anchor.
    handle = await fsPromises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > FILE_ANCHOR_MAX_BYTES) return undefined;
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ino !== before.ino
      || after.dev !== before.dev
    ) return undefined;
    return {
      path: relative,
      sha256: commandOutputHash(content),
      mtime: after.mtime.toISOString(),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function collectCheckpointAnchors(cwd: string): Promise<CheckpointMachineAnchors> {
  const files: CheckpointMachineAnchors['files'] = [];
  for (const relative of ['package.json', 'README.md']) {
    const anchor = await boundedRegularFileAnchor(cwd, relative);
    if (anchor) files.push(anchor);
  }
  return { files, commands: [] };
}

function checkpointSkipCode(error: unknown): string | undefined {
  const code = error instanceof CheckpointValidationError ? error.code : errorCode(error);
  if (code === 'checkpoint_secret_rejected' || code === 'checkpoint_sanitizer_residual_secret') {
    return 'checkpoint-secret-rejected';
  }
  return undefined;
}


async function maybeFinalizeCheckpoint(
  core: Awaited<ReturnType<typeof openCore>>,
  event: HermesBridgeEvent,
  receiptAction: ParsedReceiptAction | undefined,
): Promise<{ checkpointId?: string; checkpointSkipped?: string }> {
  if (!CHECKPOINT_EVENTS.has(event.event)) return {};
  if (!event.checkpointClaims || typeof event.checkpointClaims !== 'object' || Array.isArray(event.checkpointClaims)) {
    return { checkpointSkipped: 'claims-unavailable' };
  }
  try {
    const rawClaims = event.checkpointClaims as Record<string, unknown>;
    const rawCoverage = isRecord(rawClaims.coverage) ? rawClaims.coverage : undefined;
    const binding = event.event === 'runtime.session_end'
      ? receiptProjectionBinding(receiptAction)
      : undefined;
    const receiptCoverage = binding
      ? await core.turnReceipts.knownCoverage(binding).catch(() => ({
          status: 'unknown' as const,
          reasonCode: 'turn_receipt_coverage_lookup_failed' as const,
          knownReceiptCount: 0,
          gapCount: 0,
        }))
      : {
          status: 'unknown' as const,
          reasonCode: 'turn_receipt_binding_unavailable' as const,
          knownReceiptCount: 0,
          gapCount: 0,
        };
    const bindingDowngraded = rawCoverage?.complete === true && receiptCoverage.status !== 'known_closed';
    const claims = bindingDowngraded
      ? { ...rawClaims, coverage: { ...rawCoverage, complete: false } }
      : rawClaims;
    const draft = await core.checkpoints.createDraft({
      runtime: 'hermes',
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      claims,
    });
    const precondition = rawCoverage?.complete === true && receiptCoverage.status === 'known_closed' && binding
      ? checkpointDraftFinalizationPrecondition(draft, {
          schemaVersion: 1,
          binding,
          requiredStatus: 'known_closed',
          expectedSnapshotSha256: receiptCoverage.snapshotSha256,
        })
      : checkpointDraftFinalizationPrecondition(draft);
    const result = await core.checkpoints.finalizeDraft(
      draft.draftId,
      {
        trigger: {
          kind: 'session_end',
          signal: 'native',
          sourceEvent: event.event === 'runtime.session_finalize'
            ? 'hermes.on_session_finalize'
            : 'hermes.on_session_end',
          reasonCode: bindingDowngraded
            ? receiptCoverage.status === 'partial'
              ? 'hermes_lifecycle_checkpoint_receipt_gaps'
              : 'hermes_lifecycle_checkpoint_receipt_binding_unavailable'
            : 'hermes_lifecycle_checkpoint',
        },
      },
      () => collectCheckpointAnchors(event.cwd),
      precondition,
    );
    return { checkpointId: result.artifact.id };
  } catch (error) {
    const skip = checkpointSkipCode(error);
    if (skip) return { checkpointSkipped: skip };
    throw error;
  }
}

async function main(): Promise<void> {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) throw new Error('runtime_event_input_required');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('runtime_event_json_invalid');
  }
  const durableRevision = parseDurableTranscriptRevisionEvent(parsed);
  if (durableRevision) {
    const core = await openCore({ cwd: process.cwd() });
    const replay = await core.turnReceipts.consumeDurableTranscriptRevision({
      hermesHome: process.env.HERMES_HOME,
      projectId: durableRevision.projectId,
      publication: durableRevision.publication,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, replay })}\n`);
    return;
  }
  let event = parsed as HermesBridgeEvent;
  if (!KNOWN_EVENTS.has(event.event)) throw new Error('runtime_event_name_invalid');
  if (typeof event.prompt === 'string' && event.prompt.trim()) {
    const redacted = redactSecretLikeContent(event.prompt.trim()).slice(0, 2_000);
    if (containsSecretLikeContent(redacted)) throw new Error('runtime_event_prompt_redaction_failed');
    const { prompt: _discarded, ...metadata } = event;
    event = Object.freeze({ ...metadata, promptDigest: redacted }) as HermesBridgeEvent;
  }
  const request = runtimeEventToContextProbe(event);
  const receiptAction = parseReceiptAction(event.turnReceipt);
  if (receiptAction?.action === 'capture' && event.event !== 'runtime.session_end') {
    throw new Error('hermes_turn_receipt_event_invalid');
  }
  const diagnostic = parseCommitDiagnostic(event.diagnostic);
  const core = await openCore({ cwd: event.cwd });
  if (receiptAction?.action === 'open') await core.turnReceipts.open(receiptAction.receipt);
  if (receiptAction?.action === 'commit') await core.turnReceipts.commit(receiptAction.receipt);
  if (receiptAction?.action === 'capture') await core.captureTurnDelta(receiptAction.delta);
  if (diagnostic) {
    await appendEvent(core.workspace, {
      type: 'memory.context_probe',
      actor: 'hermes',
      metadata: diagnostic,
    });
  }
  if (!request) {
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    return;
  }
  const output = await contextProbe(core.workspace, request, {
    search: core.search,
  });
  const context = typeof output.injectText === 'string' && output.injectText.trim()
    ? output.injectText.slice(0, MAX_CONTEXT_CHARS)
    : undefined;
  const checkpoint = await maybeFinalizeCheckpoint(core, event, receiptAction);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ...(context ? { context } : {}),
    ...checkpoint,
  })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: errorCode(error) })}\n`);
  process.exitCode = 1;
});
