// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Host-specific PreCompact adapters. Inputs are normalized into an exact, bounded discriminated
// union. Transcript/custom-instruction bytes are never read or persisted: at most an in-memory hash
// reference is retained long enough to derive a privacy-safe dedupe key.
import crypto from 'node:crypto';
import path from 'node:path';
import type { WorkspaceOptions } from './types.ts';
import { openCore } from './core.ts';
import {
  canonicalCheckpointJson,
  type CheckpointDraftV1,
} from './checkpoint-schema.ts';
import { locateCheckpointDrafts, resolveCheckpointProjectIdentity } from './checkpoints.ts';
import {
  readNativePreCompactReceipt,
  writeNativePreCompactReceipt,
} from './store/checkpoints.ts';

export const NATIVE_PRECOMPACT_INPUT_MAX_BYTES = 48 * 1024;
const ID_MAX = 256;
const CWD_MAX = 4096;
const MODEL_MAX = 256;
const TRANSCRIPT_REF_MAX_BYTES = 4096;
const CUSTOM_INSTRUCTIONS_REF_MAX_BYTES = 32 * 1024;

type UntrustedRef = {
  kind: 'untrusted-ref';
  sha256: string;
  bytes: number;
};

type NativePreCompactCommon = {
  event: 'PreCompact';
  project: { cwd: string };
  session: { id: string };
  observedAt: string;
  delivery: { mode: 'best_effort'; dedupeKey: string };
  usage: { status: 'unknown' };
  transcriptRef?: UntrustedRef;
};

export type ClaudePreCompactTrigger = NativePreCompactCommon & {
  runtime: 'claude-code';
  trigger: 'manual' | 'auto';
  customInstructionsRef?: UntrustedRef;
};

export type CodexPreCompactTrigger = NativePreCompactCommon & {
  runtime: 'codex';
  model: string;
  turn: { id: string };
  trigger: 'manual' | 'auto';
};

export type NativePreCompactTrigger = ClaudePreCompactTrigger | CodexPreCompactTrigger;

export type NativePreCompactResult = {
  status: 'completed';
  artifactId: string;
  deduplicated: boolean;
  draftPath: 'existing' | 'minimal-shadow';
};

export class NativePreCompactInputError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'NativePreCompactInputError';
    this.code = code;
  }
}

function fail(code: string): never {
  throw new NativePreCompactInputError(code);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('native_precompact_payload_object_required');
  return value as Record<string, unknown>;
}

function boundedString(value: unknown, code: string, max: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || value.includes('\0')) fail(code);
  return value;
}

function safeCode(value: unknown, code: string, max: number): string {
  const text = boundedString(value, code, max).trim();
  if (!text || !/^[A-Za-z0-9._:/@+-]+$/.test(text)) fail(code);
  return text;
}

function trigger(value: unknown): 'manual' | 'auto' {
  if (value !== 'manual' && value !== 'auto') fail('native_precompact_trigger_invalid');
  return value;
}

function ref(value: unknown, maxBytes: number, code: string): UntrustedRef | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') fail(code);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) fail(code);
  return {
    kind: 'untrusted-ref',
    sha256: crypto.createHash('sha256').update(value).digest('hex'),
    bytes,
  };
}

function observedAt(value?: string): string {
  if (value === undefined) return new Date().toISOString();
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) fail('native_precompact_observed_at_invalid');
  return new Date(parsed).toISOString();
}

function dedupeKey(value: unknown): string {
  return crypto.createHash('sha256').update(canonicalCheckpointJson(value)).digest('hex');
}

// Unknown host fields are intentionally ignored for forward compatibility. The returned object has an
// exact closed shape, so prompts, raw transcript/custom instructions, secrets, PII, and future unknown
// fields cannot leak into checkpoint or activation persistence.
export function normalizeNativePreCompactTrigger(
  runtime: 'claude-code' | 'codex',
  payload: unknown,
  at?: string,
): NativePreCompactTrigger {
  const input = record(payload);
  if (input.hook_event_name !== 'PreCompact') fail('native_precompact_event_invalid');
  const cwd = boundedString(input.cwd, 'native_precompact_cwd_invalid', CWD_MAX);
  const sessionId = boundedString(input.session_id, 'native_precompact_session_invalid', ID_MAX);
  const compactTrigger = trigger(input.trigger);
  const transcriptRef = ref(input.transcript_path, TRANSCRIPT_REF_MAX_BYTES, 'native_precompact_transcript_ref_invalid');
  const seenAt = observedAt(at);

  if (runtime === 'claude-code') {
    const customInstructionsRef = ref(
      input.custom_instructions,
      CUSTOM_INSTRUCTIONS_REF_MAX_BYTES,
      'native_precompact_custom_instructions_ref_invalid',
    );
    const key = dedupeKey({
      runtime, event: 'PreCompact', cwd, sessionId, trigger: compactTrigger,
      transcript: transcriptRef?.sha256 ?? null,
      customInstructions: customInstructionsRef?.sha256 ?? null,
    });
    return {
      runtime,
      event: 'PreCompact',
      project: { cwd },
      session: { id: sessionId },
      observedAt: seenAt,
      delivery: { mode: 'best_effort', dedupeKey: key },
      usage: { status: 'unknown' },
      ...(transcriptRef ? { transcriptRef } : {}),
      trigger: compactTrigger,
      ...(customInstructionsRef ? { customInstructionsRef } : {}),
    };
  }

  const model = safeCode(input.model, 'native_precompact_model_invalid', MODEL_MAX);
  const turnId = boundedString(input.turn_id, 'native_precompact_turn_invalid', ID_MAX);
  const key = dedupeKey({
    runtime, event: 'PreCompact', cwd, sessionId, turnId, model, trigger: compactTrigger,
    transcript: transcriptRef?.sha256 ?? null,
  });
  return {
    runtime,
    event: 'PreCompact',
    project: { cwd },
    session: { id: sessionId },
    observedAt: seenAt,
    delivery: { mode: 'best_effort', dedupeKey: key },
    usage: { status: 'unknown' },
    ...(transcriptRef ? { transcriptRef } : {}),
    model,
    turn: { id: turnId },
    trigger: compactTrigger,
  };
}

function isMinimalShadowDraft(draft: CheckpointDraftV1): boolean {
  return (
    !draft.finalization
    && draft.claims.objective === undefined
    && draft.claims.completed.length === 0
    && draft.claims.pending.length === 0
    && draft.claims.decisions.length === 0
    && draft.claims.blockers.length === 0
    && draft.claims.nextActions.length === 0
    && draft.evidence.length === 0
    && draft.coverage.complete === false
    && draft.coverage.eventCount === 0
    && draft.coverage.fromCheckpointId === undefined
    && Object.keys(draft.coverage.omittedCounts).length === 0
    && draft.redaction.applied === false
    && draft.redaction.count === 0
  );
}

async function matchingDraft(
  workspace: Awaited<ReturnType<typeof openCore>>['workspace'],
  project: Awaited<ReturnType<typeof resolveCheckpointProjectIdentity>>,
  runtime: 'claude-code' | 'codex',
  sessionId: string,
): Promise<{ open?: CheckpointDraftV1; recentFinalized?: CheckpointDraftV1 }> {
  const match = await locateCheckpointDrafts(workspace, project, runtime, sessionId);
  if (match.completeness === 'unknown') throw new Error(match.reasonCode);
  return match;
}

// Deliberately model-free and transcript-free. Existing cooperative drafts are finalized as-is. With no
// matching draft, we create the smallest valid partial shadow: empty claims, incomplete coverage, and
// no machine-anchor scan. This is cheap, bounded, auditable, and does not steal Stage 4 crash-floor or
// continue semantics.
export async function runNativePreCompact(
  contract: NativePreCompactTrigger,
  options: WorkspaceOptions = {},
): Promise<NativePreCompactResult> {
  const effective = { ...options, cwd: path.resolve(contract.project.cwd) };
  const core = await openCore(effective);
  const project = await resolveCheckpointProjectIdentity(effective, core.workspace);
  const matched = await matchingDraft(core.workspace, project, contract.runtime, contract.session.id);
  if (!matched.open && matched.recentFinalized?.finalization?.artifactId) {
    const receipt = await readNativePreCompactReceipt(core.workspace, contract.delivery.dedupeKey).catch(() => undefined);
    if (
      receipt?.draftId === matched.recentFinalized.draftId
      && receipt.artifactId === matched.recentFinalized.finalization.artifactId
    ) {
      const prior = await core.checkpoints.read(receipt.artifactId);
      const expectedSource = contract.runtime === 'claude-code' ? 'ClaudeCode.PreCompact' : 'Codex.PreCompact';
      const replayAgeMs = Date.parse(contract.observedAt) - Date.parse(receipt.completedAt);
      // Never dedupe from recency alone. The private receipt binds the exact normalized delivery key to
      // the still-latest finalized draft/artifact, and any newly opened cooperative draft bypasses this
      // path. A lost receipt therefore causes a safe extra checkpoint rather than a false dedupe.
      if (
        prior.trigger.kind === 'pre_compact'
        && prior.trigger.sourceEvent === expectedSource
        && replayAgeMs >= 0
        && replayAgeMs <= 10_000
      ) {
        // Revalidate under the workspace lock immediately before accepting the private receipt. A
        // cooperative draft opened after the first lookup updates the exact locator and wins over the
        // old receipt; the event then finalizes that state instead of silently replaying old completion.
        const current = await matchingDraft(core.workspace, project, contract.runtime, contract.session.id);
        if (!current.open && current.recentFinalized?.draftId === matched.recentFinalized.draftId) {
          return {
            status: 'completed',
            artifactId: prior.id,
            deduplicated: true,
            draftPath: prior.trigger.signal === 'native' ? 'existing' : 'minimal-shadow',
          };
        }
      }
    }
  }
  const refreshed = matched.open
    ? matched
    : await matchingDraft(core.workspace, project, contract.runtime, contract.session.id);
  let draft = refreshed.open;
  let draftPath: NativePreCompactResult['draftPath'] = draft && !isMinimalShadowDraft(draft)
    ? 'existing'
    : 'minimal-shadow';
  if (!draft) {
    draft = await core.checkpoints.createDraft({
      runtime: contract.runtime,
      sessionId: contract.session.id,
      claims: { coverage: { complete: false, eventCount: 0 } },
    });
    draftPath = 'minimal-shadow';
  }
  const sourceEvent = contract.runtime === 'claude-code' ? 'ClaudeCode.PreCompact' : 'Codex.PreCompact';
  const result = await core.checkpoints.finalizeDraft(draft.draftId, {
    trigger: {
      kind: 'pre_compact',
      signal: draftPath === 'existing' ? 'native' : 'shadow',
      sourceEvent,
      reasonCode: draftPath === 'existing'
        ? 'native_precompact_existing_draft'
        : 'native_precompact_minimal_partial',
    },
  }, async () => ({ files: [], commands: [] }));
  await writeNativePreCompactReceipt(core.workspace, {
    schemaVersion: 1,
    dedupeKey: contract.delivery.dedupeKey,
    draftId: draft.draftId,
    artifactId: result.artifact.id,
    completedAt: new Date().toISOString(),
  });
  return {
    status: 'completed',
    artifactId: result.artifact.id,
    deduplicated: result.deduplicated,
    draftPath,
  };
}
