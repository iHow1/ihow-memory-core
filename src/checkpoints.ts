// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Workspace, WorkspaceOptions } from './types.ts';
import { repoRoot } from './anchors.ts';
import { withWorkspaceLock } from './store/lock.ts';
import {
  CHECKPOINT_DEFAULT_LIST_LIMIT,
  boundCheckpointDraft,
  buildCheckpointArtifact,
  canonicalCheckpointJson,
  canonicalCheckpointSemanticJson,
  type CheckpointArtifactV1,
  type CheckpointArtifactBuildV1,
  type CheckpointDraftV1,
  type CheckpointFinalizeRequest,
  type CheckpointMachineAnchors,
  type CheckpointProjectIdentity,
  CheckpointValidationError,
  isCheckpointAnchorOmissionKey,
  normalizeCheckpointClaimsInput,
  normalizeCheckpointSession,
  normalizeMachineAnchors,
  validateDraftCreateInput,
  validateDraftUpdateInput,
  validateFinalizeRequest,
} from './checkpoint-schema.ts';
import {
  appendCheckpointAuditUnlocked,
  listCheckpointArtifactFiles,
  readCheckpointArtifactUnlocked,
  readCheckpointAudit,
  readCheckpointDraftUnlocked,
  readCheckpointFinalizationIntentUnlocked,
  linkCheckpointArtifactWriteClaimUnlocked,
  prepareCheckpointArtifactWriteClaimUnlocked,
  removeCheckpointFinalizationIntentUnlocked,
  writeCheckpointDraftUnlocked,
  writeCheckpointFinalizationIntentUnlocked,
  type CheckpointAuditEvent,
  type CheckpointFinalizationIntentV1,
} from './store/checkpoints.ts';

export type CheckpointMachineAnchorProvider = () => CheckpointMachineAnchors | Promise<CheckpointMachineAnchors>;

export type CheckpointListItem = {
  id: string;
  createdAt?: string;
  triggerKind?: string;
  supersedes?: string;
  sizeBytes?: number;
  integrity: 'valid' | 'invalid';
  reasonCode?: string;
};

export type CheckpointInspection = {
  id: string;
  schemaVersion?: number;
  createdAt?: string;
  sizeBytes?: number;
  canonical?: boolean;
  integrity: { valid: boolean; contentSha256?: string; reasonCode?: string };
  supersedes?: string;
};

export type CheckpointService = {
  createDraft(input: unknown): Promise<CheckpointDraftV1>;
  updateDraft(draftId: string, input: unknown): Promise<CheckpointDraftV1>;
  finalizeDraft(draftId: string, request: unknown, collectMachineAnchors: CheckpointMachineAnchorProvider): Promise<{ artifact: CheckpointArtifactV1; deduplicated: boolean }>;
  list(opts?: { limit?: number }): Promise<CheckpointListItem[]>;
  read(artifactId: string): Promise<CheckpointArtifactV1>;
  inspect(artifactId: string): Promise<CheckpointInspection>;
  audit(): Promise<CheckpointAuditEvent[]>;
};

function digest(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

async function canonicalRealPath(input: string): Promise<string> {
  const resolved = path.resolve(input);
  return await fs.realpath(resolved).catch(() => resolved);
}

export async function resolveCheckpointProjectIdentity(options: WorkspaceOptions, workspace: Workspace): Promise<CheckpointProjectIdentity> {
  const cwd = await canonicalRealPath(options.cwd || process.cwd());
  const root = await canonicalRealPath(repoRoot(cwd) || cwd);
  return {
    cwdHash: digest(`cwd\0${cwd}`),
    workspaceId: digest(`workspace\0${workspace.space}`),
    projectId: digest(`project\0${root}`),
  };
}

function stableFailureCode(error: unknown): string {
  if (error instanceof CheckpointValidationError) return error.code;
  if (error instanceof Error && /^checkpoint_[a-z0-9_]+$/.test(error.message)) return error.message;
  return 'checkpoint_internal_failure';
}

async function auditRejection(workspace: Workspace, operation: CheckpointAuditEvent['operation'], reasonCode: string): Promise<void> {
  // Rejection events intentionally contain no input, model text, path, session id, error message, or hash
  // derived from rejected bytes. Only a stable reason code and operation are persisted.
  await withWorkspaceLock(workspace, async () => {
    await appendCheckpointAuditUnlocked(workspace, { type: 'checkpoint.rejected', operation, reasonCode });
  }).catch(() => {});
}

async function rejected<T>(workspace: Workspace, operation: CheckpointAuditEvent['operation'], fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const code = stableFailureCode(error);
    // Persisted audit contradictions must be observed without mutating the very audit log under
    // investigation. In particular, an audit-only finalization is a fail-closed state, not a healing path.
    if (code !== 'checkpoint_finalization_audit_outcome_mismatch') {
      await auditRejection(workspace, operation, code);
    }
    if (error instanceof CheckpointValidationError) throw error;
    throw new CheckpointValidationError(code);
  }
}

function mergeDraftUpdate(draft: CheckpointDraftV1, normalized: ReturnType<typeof normalizeCheckpointClaimsInput>, at: string): CheckpointDraftV1 {
  return boundCheckpointDraft({
    ...draft,
    updatedAt: at,
    claims: normalized.claims,
    evidence: normalized.evidence,
    coverage: normalized.coverage,
    redaction: normalized.redaction,
  });
}

function assertProjectMatchesService(draft: CheckpointDraftV1, project: CheckpointProjectIdentity): void {
  if (canonicalCheckpointJson(draft.project) !== canonicalCheckpointJson(project)) {
    throw new Error('checkpoint_draft_project_mismatch');
  }
}

async function findSemanticDuplicateUnlocked(workspace: Workspace, candidate: CheckpointArtifactV1): Promise<CheckpointArtifactV1 | undefined> {
  const candidateSemantic = canonicalCheckpointSemanticJson(candidate);
  for (const artifactId of await listCheckpointArtifactFiles(workspace)) {
    const artifact = (await readCheckpointArtifactUnlocked(workspace, artifactId)).artifact;
    if (canonicalCheckpointSemanticJson(artifact) === candidateSemantic) return artifact;
  }
  return undefined;
}

async function ensureFinalizationAuditUnlocked(
  workspace: Workspace,
  draftId: string,
  artifact: CheckpointArtifactV1,
  type: 'checkpoint.artifact.created' | 'checkpoint.artifact.deduplicated',
): Promise<void> {
  const existing = await readCheckpointAudit(workspace);
  const matching = existing.filter((event) => event.operation === 'artifact.finalize' && event.draftId === draftId);
  if (matching.length > 0) {
    if (
      matching.length !== 1
      || matching[0].artifactId !== artifact.id
      || matching[0].type !== type
      || matching[0].supersedes !== artifact.supersedes
    ) throw new Error('checkpoint_finalization_audit_outcome_mismatch');
    return;
  }
  await appendCheckpointAuditUnlocked(workspace, {
    type,
    operation: 'artifact.finalize',
    draftId,
    artifactId: artifact.id,
    ...(artifact.supersedes ? { supersedes: artifact.supersedes } : {}),
  });
}

async function requireFinalizationAuditUnlocked(
  workspace: Workspace,
  draftId: string,
  artifact: CheckpointArtifactV1,
): Promise<void> {
  const existing = await readCheckpointAudit(workspace);
  const matching = existing.filter((event) => (
    event.operation === 'artifact.finalize'
    && event.draftId === draftId
  ));
  if (matching.length === 0) throw new Error('checkpoint_finalization_audit_missing');
  if (
    matching.length !== 1
    || matching[0].artifactId !== artifact.id
    || matching[0].supersedes !== artifact.supersedes
    || (matching[0].type !== 'checkpoint.artifact.created' && matching[0].type !== 'checkpoint.artifact.deduplicated')
  ) throw new Error('checkpoint_finalization_audit_outcome_mismatch');
}

async function assertNoAuditOnlyFinalizationUnlocked(workspace: Workspace, draftId: string): Promise<void> {
  const matching = (await readCheckpointAudit(workspace)).filter((event) => (
    event.operation === 'artifact.finalize' && event.draftId === draftId
  ));
  if (matching.length > 0) throw new Error('checkpoint_finalization_audit_outcome_mismatch');
}

function assertFinalizeRequestMatchesBuild(request: CheckpointFinalizeRequest, build: CheckpointArtifactBuildV1): void {
  if (
    canonicalCheckpointJson(request.trigger) !== canonicalCheckpointJson(build.trigger)
    || request.supersedes !== build.supersedes
  ) throw new Error('checkpoint_finalization_request_mismatch');
}

function assertFinalizeRequestMatchesArtifact(request: CheckpointFinalizeRequest, artifact: CheckpointArtifactV1): void {
  if (
    canonicalCheckpointJson(request.trigger) !== canonicalCheckpointJson(artifact.trigger)
    || request.supersedes !== artifact.supersedes
  ) throw new Error('checkpoint_finalization_request_mismatch');
}

function buildArtifactFromDraft(draft: CheckpointDraftV1, build: CheckpointArtifactBuildV1): CheckpointArtifactV1 {
  return buildCheckpointArtifact({
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
}

function assertIntentMatchesDraft(
  draft: CheckpointDraftV1,
  intent: CheckpointFinalizationIntentV1,
  request?: CheckpointFinalizeRequest,
): CheckpointArtifactV1 {
  if (request) assertFinalizeRequestMatchesBuild(request, intent.build);
  const expected = buildArtifactFromDraft(draft, intent.build);
  if (expected.id !== intent.artifactId) throw new Error('checkpoint_finalization_intent_mismatch');
  return expected;
}

function markerBuildFromPersistedArtifact(draft: CheckpointDraftV1, artifact: CheckpointArtifactV1): CheckpointArtifactBuildV1 {
  const anchorOmittedCounts: Record<string, number> = {};
  const allOmittedKeys = new Set([
    ...Object.keys(draft.coverage.omittedCounts),
    ...Object.keys(artifact.coverage.omittedCounts),
  ]);
  for (const key of allOmittedKeys) {
    const draftCount = draft.coverage.omittedCounts[key] ?? 0;
    const artifactCount = artifact.coverage.omittedCounts[key] ?? 0;
    if (artifactCount < draftCount) throw new Error('checkpoint_draft_artifact_mismatch');
    const added = artifactCount - draftCount;
    if (added > 0) {
      if (!isCheckpointAnchorOmissionKey(key)) throw new Error('checkpoint_draft_artifact_mismatch');
      anchorOmittedCounts[key] = added;
    }
  }
  const anchorRedactionCount = artifact.redaction.count - draft.redaction.count;
  if (anchorRedactionCount < 0) throw new Error('checkpoint_draft_artifact_mismatch');
  return {
    createdAt: artifact.createdAt,
    trigger: artifact.trigger,
    anchors: artifact.anchors,
    anchorOmittedCounts,
    anchorRedaction: { applied: anchorRedactionCount > 0, count: anchorRedactionCount },
    ...(artifact.supersedes ? { supersedes: artifact.supersedes } : {}),
  };
}

function assertRecoveredArtifactMatchesDraft(draft: CheckpointDraftV1, artifact: CheckpointArtifactV1): void {
  const expected = buildArtifactFromDraft(draft, markerBuildFromPersistedArtifact(draft, artifact));
  if (canonicalCheckpointJson(expected) !== canonicalCheckpointJson(artifact)) {
    throw new Error('checkpoint_draft_artifact_mismatch');
  }
}

async function recoverDraftFinalizationUnlocked(
  workspace: Workspace,
  draft: CheckpointDraftV1,
  project: CheckpointProjectIdentity,
  request?: CheckpointFinalizeRequest,
): Promise<CheckpointArtifactV1 | undefined> {
  assertProjectMatchesService(draft, project);
  const intent = await readCheckpointFinalizationIntentUnlocked(workspace, draft.draftId);
  if (!intent) return undefined;
  const artifact = assertIntentMatchesDraft(draft, intent, request);
  await validateSupersedesUnlocked(workspace, draft, artifact.supersedes);
  if (intent.creationProvenance === 'created') {
    if (!intent.writeClaimId) throw new Error('checkpoint_finalization_intent_invalid');
    const ownership = await linkCheckpointArtifactWriteClaimUnlocked(workspace, artifact, intent.writeClaimId);
    if (ownership === 'unexpected-existing') throw new Error('checkpoint_artifact_unexpected_existing');
  } else {
    const existing = await readCheckpointArtifactUnlocked(workspace, artifact.id);
    if (existing.raw !== canonicalCheckpointJson(artifact)) throw new Error('checkpoint_integrity_hash_collision');
  }
  await ensureFinalizationAuditUnlocked(
    workspace,
    draft.draftId,
    artifact,
    intent.creationProvenance === 'created' ? 'checkpoint.artifact.created' : 'checkpoint.artifact.deduplicated',
  );
  const recovered = boundCheckpointDraft({ ...draft, finalization: { artifactId: artifact.id } });
  await writeCheckpointDraftUnlocked(workspace, recovered);
  await removeCheckpointFinalizationIntentUnlocked(workspace, draft.draftId);
  return artifact;
}

async function recoverDraftMarkerUnlocked(
  workspace: Workspace,
  draft: CheckpointDraftV1,
  project: CheckpointProjectIdentity,
  request: CheckpointFinalizeRequest,
): Promise<CheckpointArtifactV1 | undefined> {
  assertProjectMatchesService(draft, project);
  if (!draft.finalization?.artifactId) return undefined;
  const intent = await readCheckpointFinalizationIntentUnlocked(workspace, draft.draftId);
  let artifact: CheckpointArtifactV1;
  if (intent) {
    const expected = assertIntentMatchesDraft(draft, intent, request);
    if (draft.finalization.artifactId !== expected.id) throw new Error('checkpoint_finalization_intent_mismatch');
    if (intent.creationProvenance === 'created') {
      if (!intent.writeClaimId) throw new Error('checkpoint_finalization_intent_invalid');
      const ownership = await linkCheckpointArtifactWriteClaimUnlocked(workspace, expected, intent.writeClaimId);
      if (ownership === 'unexpected-existing') throw new Error('checkpoint_artifact_unexpected_existing');
    }
    artifact = (await readCheckpointArtifactUnlocked(workspace, draft.finalization.artifactId)).artifact;
    if (canonicalCheckpointJson(expected) !== canonicalCheckpointJson(artifact)) {
      throw new Error('checkpoint_finalization_intent_mismatch');
    }
    await validateSupersedesUnlocked(workspace, draft, artifact.supersedes);
    await ensureFinalizationAuditUnlocked(
      workspace,
      draft.draftId,
      artifact,
      intent.creationProvenance === 'created' ? 'checkpoint.artifact.created' : 'checkpoint.artifact.deduplicated',
    );
  } else {
    artifact = (await readCheckpointArtifactUnlocked(workspace, draft.finalization.artifactId)).artifact;
    assertFinalizeRequestMatchesArtifact(request, artifact);
    await validateSupersedesUnlocked(workspace, draft, artifact.supersedes);
    // The normal order is audit -> draft marker. A marker without either an audit or the still-durable
    // creation intent is not a recoverable crash state; accepting it would bless out-of-band tampering.
    assertRecoveredArtifactMatchesDraft(draft, artifact);
    await requireFinalizationAuditUnlocked(workspace, draft.draftId, artifact);
  }
  await removeCheckpointFinalizationIntentUnlocked(workspace, draft.draftId);
  return artifact;
}

async function validateSupersedesUnlocked(
  workspace: Workspace,
  draft: CheckpointDraftV1,
  supersedes: string | undefined,
): Promise<void> {
  if (!supersedes) return;
  const prior = await readCheckpointArtifactUnlocked(workspace, supersedes);
  const priorBinding = prior.artifact.project.projectId ?? prior.artifact.project.cwdHash;
  const draftBinding = draft.project.projectId ?? draft.project.cwdHash;
  if (priorBinding !== draftBinding) throw new Error('checkpoint_supersedes_project_mismatch');
}

export async function createCheckpointService(
  workspace: Workspace,
  options: WorkspaceOptions = {},
): Promise<CheckpointService> {
  const project = await resolveCheckpointProjectIdentity(options, workspace);

  return {
    async createDraft(input) {
      return await rejected(workspace, 'draft.create', async () => {
        const parsed = validateDraftCreateInput(input);
        const normalized = normalizeCheckpointClaimsInput(parsed.claims);
        const now = new Date().toISOString();
        const draft = boundCheckpointDraft({
          schemaVersion: 1,
          draftId: `draft_${crypto.randomUUID()}`,
          project,
          session: normalizeCheckpointSession(parsed.runtime, parsed.sessionId),
          createdAt: now,
          updatedAt: now,
          claims: normalized.claims,
          evidence: normalized.evidence,
          coverage: normalized.coverage,
          redaction: normalized.redaction,
        });
        await withWorkspaceLock(workspace, async () => {
          await writeCheckpointDraftUnlocked(workspace, draft);
          await appendCheckpointAuditUnlocked(workspace, { type: 'checkpoint.draft.created', operation: 'draft.create', draftId: draft.draftId });
        });
        return draft;
      });
    },

    async updateDraft(draftId, input) {
      return await rejected(workspace, 'draft.update', async () => {
        const claims = validateDraftUpdateInput(input);
        const normalized = normalizeCheckpointClaimsInput(claims);
        return await withWorkspaceLock(workspace, async () => {
          const draft = await readCheckpointDraftUnlocked(workspace, draftId);
          assertProjectMatchesService(draft, project);
          if (draft.finalization) throw new Error('checkpoint_draft_finalization_started');
          if (await recoverDraftFinalizationUnlocked(workspace, draft, project)) throw new Error('checkpoint_draft_finalization_started');
          const updated = mergeDraftUpdate(draft, normalized, new Date().toISOString());
          await writeCheckpointDraftUnlocked(workspace, updated);
          await appendCheckpointAuditUnlocked(workspace, { type: 'checkpoint.draft.updated', operation: 'draft.update', draftId });
          return updated;
        });
      });
    },

    async finalizeDraft(draftId, request, collectMachineAnchors) {
      return await rejected(workspace, 'artifact.finalize', async () => {
        const finalized = validateFinalizeRequest(request);
        if (typeof collectMachineAnchors !== 'function') throw new CheckpointValidationError('checkpoint_machine_anchor_provider_required');

        // Recovery deliberately runs before anchor collection. If the immutable artifact landed but the
        // draft/audit writes did not, retry binds that exact artifact and never observes replacement anchors.
        const recovered = await withWorkspaceLock(workspace, async () => {
          const draft = await readCheckpointDraftUnlocked(workspace, draftId);
          assertProjectMatchesService(draft, project);
          const marked = await recoverDraftMarkerUnlocked(workspace, draft, project, finalized);
          if (marked) return marked;
          const artifact = await recoverDraftFinalizationUnlocked(workspace, draft, project, finalized);
          if (artifact) return artifact;
          await assertNoAuditOnlyFinalizationUnlocked(workspace, draft.draftId);
          await validateSupersedesUnlocked(workspace, draft, finalized.supersedes);
          return undefined;
        });
        if (recovered) return { artifact: recovered, deduplicated: true };

        let rawAnchors: unknown;
        let anchorFailure: unknown;
        try {
          rawAnchors = await collectMachineAnchors();
        } catch {
          anchorFailure = new CheckpointValidationError('checkpoint_anchor_collection_failed');
        }
        let normalizedAnchors: ReturnType<typeof normalizeMachineAnchors> | undefined;
        if (anchorFailure === undefined) {
          try {
            normalizedAnchors = normalizeMachineAnchors(rawAnchors);
          } catch (error) {
            anchorFailure = error;
          }
        }

        return await withWorkspaceLock(workspace, async () => {
          const draft = await readCheckpointDraftUnlocked(workspace, draftId);
          assertProjectMatchesService(draft, project);
          const marked = await recoverDraftMarkerUnlocked(workspace, draft, project, finalized);
          if (marked) return { artifact: marked, deduplicated: true };
          const crashedArtifact = await recoverDraftFinalizationUnlocked(workspace, draft, project, finalized);
          if (crashedArtifact) return { artifact: crashedArtifact, deduplicated: true };
          // Re-check after provider collection: an external writer may have introduced an audit-only
          // contradiction while this process was outside the workspace lock.
          await assertNoAuditOnlyFinalizationUnlocked(workspace, draft.draftId);
          await validateSupersedesUnlocked(workspace, draft, finalized.supersedes);
          // Collection and normalization failures are deferred until after this second locked
          // reconciliation. The provider may have durably finalized (or introduced an audit-only
          // contradiction) immediately before throwing or exposing a failing getter.
          if (anchorFailure !== undefined) throw anchorFailure;
          if (!normalizedAnchors) throw new Error('checkpoint_internal_failure');

          const build: CheckpointArtifactBuildV1 = {
            createdAt: new Date().toISOString(),
            trigger: finalized.trigger,
            anchors: normalizedAnchors.anchors,
            anchorOmittedCounts: normalizedAnchors.omittedCounts,
            anchorRedaction: normalizedAnchors.redaction,
            ...(finalized.supersedes ? { supersedes: finalized.supersedes } : {}),
          };
          const artifact = buildArtifactFromDraft(draft, build);

          const semanticDuplicate = await findSemanticDuplicateUnlocked(workspace, artifact);
          if (semanticDuplicate) {
            // Dedup also gets an intent: without it, a kill after audit but before the draft marker would
            // recollect anchors on retry and could bind a different checkpoint.
            await writeCheckpointFinalizationIntentUnlocked(workspace, {
              schemaVersion: 1,
              draftId: draft.draftId,
              artifactId: semanticDuplicate.id,
              creationProvenance: 'deduplicated',
              build: { ...build, createdAt: semanticDuplicate.createdAt },
            });
            await ensureFinalizationAuditUnlocked(workspace, draftId, semanticDuplicate, 'checkpoint.artifact.deduplicated');
            const completedDraft = boundCheckpointDraft({ ...draft, finalization: { artifactId: semanticDuplicate.id } });
            await writeCheckpointDraftUnlocked(workspace, completedDraft);
            await removeCheckpointFinalizationIntentUnlocked(workspace, draft.draftId);
            return { artifact: semanticDuplicate, deduplicated: true };
          }

          // Persist the deterministic build inputs and expected artifact ID before the immutable write.
          // A retry rebuilds and verifies this exact snapshot without collecting replacement anchors, while
          // the public CheckpointArtifactV1 remains exactly the documented schema.
          const writeClaimId = crypto.randomUUID();
          await prepareCheckpointArtifactWriteClaimUnlocked(workspace, artifact, writeClaimId);
          await writeCheckpointFinalizationIntentUnlocked(workspace, {
            schemaVersion: 1,
            draftId: draft.draftId,
            artifactId: artifact.id,
            creationProvenance: 'created',
            writeClaimId,
            build,
          });
          const ownership = await linkCheckpointArtifactWriteClaimUnlocked(workspace, artifact, writeClaimId);
          if (ownership === 'unexpected-existing') throw new Error('checkpoint_artifact_unexpected_existing');

          await ensureFinalizationAuditUnlocked(
            workspace,
            draftId,
            artifact,
            'checkpoint.artifact.created',
          );
          const completedDraft = boundCheckpointDraft({ ...draft, finalization: { artifactId: artifact.id } });
          await writeCheckpointDraftUnlocked(workspace, completedDraft);
          await removeCheckpointFinalizationIntentUnlocked(workspace, draft.draftId);
          return { artifact, deduplicated: false };
        });
      });
    },

    async list(opts = {}) {
      const rawLimit = opts.limit ?? CHECKPOINT_DEFAULT_LIST_LIMIT;
      if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) throw new CheckpointValidationError('checkpoint_list_limit_invalid');
      const ids = await listCheckpointArtifactFiles(workspace);
      const items = await Promise.all(ids.map(async (id): Promise<CheckpointListItem> => {
        try {
          const { artifact, sizeBytes } = await readCheckpointArtifactUnlocked(workspace, id);
          return { id, createdAt: artifact.createdAt, triggerKind: artifact.trigger.kind, ...(artifact.supersedes ? { supersedes: artifact.supersedes } : {}), sizeBytes, integrity: 'valid' };
        } catch (error) {
          return { id, integrity: 'invalid', reasonCode: stableFailureCode(error) };
        }
      }));
      const invalid = items.find((item) => item.integrity === 'invalid');
      if (invalid) await auditRejection(workspace, 'artifact.list', invalid.reasonCode ?? 'checkpoint_integrity_mismatch');
      return items
        .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || a.id.localeCompare(b.id))
        .slice(0, rawLimit);
    },

    async read(artifactId) {
      return await rejected(workspace, 'artifact.read', async () => (await readCheckpointArtifactUnlocked(workspace, artifactId)).artifact);
    },

    async inspect(artifactId) {
      try {
        const { artifact, raw, sizeBytes } = await readCheckpointArtifactUnlocked(workspace, artifactId);
        return {
          id: artifact.id,
          schemaVersion: artifact.schemaVersion,
          createdAt: artifact.createdAt,
          sizeBytes,
          canonical: raw === canonicalCheckpointJson(artifact),
          integrity: { valid: true, contentSha256: artifact.integrity.contentSha256 },
          ...(artifact.supersedes ? { supersedes: artifact.supersedes } : {}),
        };
      } catch (error) {
        const reasonCode = stableFailureCode(error);
        await auditRejection(workspace, 'artifact.inspect', reasonCode);
        return { id: artifactId, integrity: { valid: false, reasonCode } };
      }
    },

    async audit() {
      return await readCheckpointAudit(workspace);
    },
  };
}
