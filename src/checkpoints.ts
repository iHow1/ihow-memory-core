// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CheckpointProtectionState, CheckpointProtectionSummary, Workspace, WorkspaceOptions } from './types.ts';
import { gitAnchors, gitWorktreeStatusHash, repoRoot } from './anchors.ts';
import { withWorkspaceLock } from './store/lock.ts';
import {
  CHECKPOINT_DEFAULT_LIST_LIMIT,
  boundCheckpointDraft,
  buildCheckpointArtifact,
  canonicalCheckpointJson,
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
  commitCheckpointDraftLocatorFinalizedUnlocked,
  findCheckpointDraftsByLocatorUnlocked,
  listCheckpointArtifactFiles,
  readCheckpointArtifactUnlocked,
  readCheckpointAudit,
  readCheckpointFinalizationAuditUnlocked,
  readCheckpointDraftUnlocked,
  readCheckpointFinalizationIntentUnlocked,
  readCheckpointSemanticArtifactIndexUnlocked,
  linkCheckpointArtifactWriteClaimUnlocked,
  prepareCheckpointArtifactWriteClaimUnlocked,
  removeCheckpointFinalizationIntentUnlocked,
  stageCheckpointDraftLocatorCreateUnlocked,
  stageCheckpointDraftLocatorFinalizedUnlocked,
  stageCheckpointDraftLocatorUpdateUnlocked,
  writeCheckpointDraftUnlocked,
  writeCheckpointFinalizationIntentUnlocked,
  writeCheckpointSemanticArtifactIndexUnlocked,
  checkpointAuditV2MarkerFaultPoint,
  checkpointStorePaths,
  type CheckpointAuditEvent,
  type CheckpointDraftLocatorMatch,
  type CheckpointFinalizationIntentV1,
} from './store/checkpoints.ts';
import { readActivationEvidence } from './activation-ledger.ts';
import { readEventsAllLanes } from './store/events.ts';

export type CheckpointMachineAnchorProvider = () => CheckpointMachineAnchors | Promise<CheckpointMachineAnchors>;

// Canonical live provider for runtime-generated checkpoints. Git facts and the worktree content hash
// are collected by the same hardened anchor implementation used by continue verification. A failed
// statusHash collection is omitted rather than invented; checkpoint provenance then keeps the artifact
// fail-closed at YELLOW until a receiver can verify it live.
export function collectLiveCheckpointMachineAnchors(projectDir: string): CheckpointMachineAnchors {
  const live = gitAnchors(projectDir);
  if (!live.isRepo || !live.repo) return { files: [], commands: [] };
  const statusHash = gitWorktreeStatusHash(projectDir);
  return {
    git: {
      repo: live.repo,
      ...(live.branch ? { branch: live.branch } : {}),
      ...(live.head ? { head: live.head } : {}),
      ...(live.dirty !== undefined ? { dirty: live.dirty } : {}),
      ...(statusHash ? { statusHash } : {}),
    },
    files: [],
    commands: [],
  };
}

export type CheckpointDraftFinalizationPrecondition = {
  expectedUpdatedAt: string;
  expectedContentSha256: string;
};

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

export type CheckpointArtifactSnapshot = {
  status: 'ok' | 'missing' | 'degraded';
  artifacts: CheckpointArtifactV1[];
  reasonCode?: string;
};

type CheckpointDraftSnapshot = {
  status: 'ok' | 'missing' | 'degraded';
  drafts: CheckpointDraftV1[];
  reasonCode?: string;
};

export type CheckpointService = {
  createDraft(input: unknown): Promise<CheckpointDraftV1>;
  updateDraft(draftId: string, input: unknown): Promise<CheckpointDraftV1>;
  finalizeDraft(
    draftId: string,
    request: unknown,
    collectMachineAnchors: CheckpointMachineAnchorProvider,
    precondition?: CheckpointDraftFinalizationPrecondition,
  ): Promise<{ artifact: CheckpointArtifactV1; deduplicated: boolean }>;
  list(opts?: { limit?: number }): Promise<CheckpointListItem[]>;
  read(artifactId: string): Promise<CheckpointArtifactV1>;
  inspect(artifactId: string): Promise<CheckpointInspection>;
  audit(): Promise<CheckpointAuditEvent[]>;
};

function digest(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function checkpointDraftFinalizationPrecondition(
  draft: CheckpointDraftV1,
): CheckpointDraftFinalizationPrecondition {
  return {
    expectedUpdatedAt: draft.updatedAt,
    expectedContentSha256: digest(canonicalCheckpointJson(draft)),
  };
}

function assertCheckpointDraftFinalizationPrecondition(
  draft: CheckpointDraftV1,
  precondition: CheckpointDraftFinalizationPrecondition | undefined,
): void {
  if (!precondition) return;
  if (
    draft.updatedAt !== precondition.expectedUpdatedAt
    || digest(canonicalCheckpointJson(draft)) !== precondition.expectedContentSha256
  ) throw new Error('checkpoint_draft_precondition_failed');
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

const CHECKPOINT_ARTIFACT_SNAPSHOT_MAX_VISITS = 256;
const CHECKPOINT_ARTIFACT_BASENAME_RE = /^cp_[a-f0-9]{64}\.json$/;
const CHECKPOINT_DRAFT_SNAPSHOT_MAX_VISITS = 256;
const CHECKPOINT_DRAFT_SNAPSHOT_BASENAME_RE = /^draft_[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/;

async function checkpointSnapshotDirectoryState(
  workspace: Workspace,
  directory: string,
): Promise<'contained' | 'missing' | 'invalid'> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return 'invalid';
    const containment = workspace.mode === 'existing-memory-root' ? workspace.mcpDir : workspace.spaceDir;
    const [containmentReal, directoryReal] = await Promise.all([fs.realpath(containment), fs.realpath(directory)]);
    return directoryReal !== containmentReal && directoryReal.startsWith(`${containmentReal}${path.sep}`)
      ? 'contained'
      : 'invalid';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid';
  }
}

// Resume/status discovery is deliberately separate from the public list API: it proves a bounded view
// of the canonical namespace, marks canonical non-files/corrupt bytes as degraded, and never lets an
// unbounded artifact directory turn memory.continue into a startup scan.
export async function readCheckpointArtifactSnapshot(
  workspace: Workspace,
  limit = CHECKPOINT_ARTIFACT_SNAPSHOT_MAX_VISITS,
): Promise<CheckpointArtifactSnapshot> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHECKPOINT_ARTIFACT_SNAPSHOT_MAX_VISITS) {
    return { status: 'degraded', artifacts: [], reasonCode: 'checkpoint_artifact_scan_limit_invalid' };
  }
  const directoryPath = checkpointStorePaths(workspace).artifacts;
  const directoryState = await checkpointSnapshotDirectoryState(workspace, directoryPath);
  if (directoryState === 'missing') return { status: 'missing', artifacts: [] };
  if (directoryState === 'invalid') {
    return { status: 'degraded', artifacts: [], reasonCode: 'checkpoint_path_outside_store' };
  }
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', artifacts: [] };
    return { status: 'degraded', artifacts: [], reasonCode: checkpointSnapshotFailureCode(error) };
  }
  const ids: string[] = [];
  let degradedReason: string | undefined;
  let visited = 0;
  try {
    for await (const entry of directory) {
      visited += 1;
      if (visited > limit) {
        degradedReason = 'checkpoint_artifact_scan_limit_exceeded';
        break;
      }
      if (!CHECKPOINT_ARTIFACT_BASENAME_RE.test(entry.name)) continue;
      if (!entry.isFile()) {
        degradedReason ??= 'checkpoint_path_outside_store';
        continue;
      }
      ids.push(entry.name.slice(0, -'.json'.length));
    }
  } catch (error) {
    degradedReason ??= checkpointSnapshotFailureCode(error);
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') degradedReason ??= checkpointSnapshotFailureCode(error);
    });
  }
  if (degradedReason === 'checkpoint_artifact_scan_limit_exceeded') {
    return { status: 'degraded', artifacts: [], reasonCode: degradedReason };
  }
  const artifacts: CheckpointArtifactV1[] = [];
  for (const id of ids.sort()) {
    try {
      artifacts.push((await readCheckpointArtifactUnlocked(workspace, id)).artifact);
    } catch (error) {
      degradedReason ??= checkpointSnapshotFailureCode(error);
    }
  }
  if (degradedReason) return { status: 'degraded', artifacts, reasonCode: degradedReason };
  return artifacts.length ? { status: 'ok', artifacts } : { status: 'missing', artifacts: [] };
}

function checkpointSnapshotFailureCode(error: unknown): string {
  if (error instanceof CheckpointValidationError) return error.code;
  if (error instanceof Error && /^checkpoint_[a-z0-9_]+$/.test(error.message)) return error.message;
  return 'checkpoint_internal_failure';
}

async function readCheckpointDraftSnapshot(
  workspace: Workspace,
  limit = CHECKPOINT_DRAFT_SNAPSHOT_MAX_VISITS,
): Promise<CheckpointDraftSnapshot> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CHECKPOINT_DRAFT_SNAPSHOT_MAX_VISITS) {
    return { status: 'degraded', drafts: [], reasonCode: 'checkpoint_draft_scan_limit_invalid' };
  }
  const directoryPath = checkpointStorePaths(workspace).drafts;
  const directoryState = await checkpointSnapshotDirectoryState(workspace, directoryPath);
  if (directoryState === 'missing') return { status: 'missing', drafts: [] };
  if (directoryState === 'invalid') {
    return { status: 'degraded', drafts: [], reasonCode: 'checkpoint_path_outside_store' };
  }
  let directory: Awaited<ReturnType<typeof fs.opendir>>;
  try {
    directory = await fs.opendir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing', drafts: [] };
    return { status: 'degraded', drafts: [], reasonCode: checkpointSnapshotFailureCode(error) };
  }
  const ids: string[] = [];
  let degradedReason: string | undefined;
  let visited = 0;
  try {
    for await (const entry of directory) {
      visited += 1;
      if (visited > limit) {
        degradedReason = 'checkpoint_draft_scan_limit_exceeded';
        break;
      }
      if (!CHECKPOINT_DRAFT_SNAPSHOT_BASENAME_RE.test(entry.name)) continue;
      if (!entry.isFile()) {
        degradedReason ??= 'checkpoint_path_outside_store';
        continue;
      }
      ids.push(entry.name.slice(0, -'.json'.length));
    }
  } catch (error) {
    degradedReason ??= checkpointSnapshotFailureCode(error);
  } finally {
    await directory.close().catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code !== 'ERR_DIR_CLOSED') degradedReason ??= checkpointSnapshotFailureCode(error);
    });
  }
  if (degradedReason === 'checkpoint_draft_scan_limit_exceeded') {
    return { status: 'degraded', drafts: [], reasonCode: degradedReason };
  }
  const drafts: CheckpointDraftV1[] = [];
  for (const id of ids.sort()) {
    try { drafts.push(await readCheckpointDraftUnlocked(workspace, id)); }
    catch (error) { degradedReason ??= checkpointSnapshotFailureCode(error); }
  }
  if (degradedReason) return { status: 'degraded', drafts, reasonCode: degradedReason };
  return drafts.length ? { status: 'ok', drafts } : { status: 'missing', drafts: [] };
}

function sameCheckpointProject(
  value: { project: CheckpointProjectIdentity },
  project: CheckpointProjectIdentity,
): boolean {
  return value.project.projectId && project.projectId
    ? value.project.projectId === project.projectId
    : value.project.cwdHash === project.cwdHash;
}

function newestCheckpointFirst(left: CheckpointArtifactV1, right: CheckpointArtifactV1): number {
  const byTime = right.createdAt.localeCompare(left.createdAt);
  if (byTime) return byTime;
  if (left.supersedes === right.id) return -1;
  if (right.supersedes === left.id) return 1;
  return left.id.localeCompare(right.id);
}

function protectionSummary(artifact: CheckpointArtifactV1 | undefined): CheckpointProtectionSummary | null {
  if (!artifact) return null;
  return {
    artifactId: artifact.id,
    createdAt: artifact.createdAt,
    triggerKind: artifact.trigger.kind,
    triggerSignal: artifact.trigger.signal,
    coverageComplete: artifact.coverage.complete,
    ...(artifact.coverage.eventCount === undefined ? {} : { eventCount: artifact.coverage.eventCount }),
  };
}

export async function checkpointProtectionState(
  workspace: Workspace,
  options: WorkspaceOptions = {},
): Promise<CheckpointProtectionState> {
  let project: CheckpointProjectIdentity;
  try {
    project = await resolveCheckpointProjectIdentity({ ...options, cwd: options.cwd || process.cwd() }, workspace);
  } catch {
    return {
      lookup: { status: 'degraded', reasonCode: 'checkpoint_project_identity_unavailable' },
      latestComplete: null,
      latestPartial: null,
      latestFloor: null,
      stale: 'unknown',
      newerMaterial: null,
      worstLossEvents: 'unknown',
      activationDegradation: [],
    };
  }
  const [artifactSnapshot, draftSnapshot, events, activation] = await Promise.all([
    readCheckpointArtifactSnapshot(workspace),
    readCheckpointDraftSnapshot(workspace),
    readEventsAllLanes(workspace).catch(() => []),
    readActivationEvidence(workspace).catch(() => []),
  ]);
  const projectArtifacts = artifactSnapshot.artifacts
    .filter((artifact) => sameCheckpointProject(artifact, project))
    .sort(newestCheckpointFirst);
  const latestCompleteArtifact = projectArtifacts.find((artifact) => artifact.coverage.complete);
  const latestPartialArtifact = projectArtifacts.find((artifact) => !artifact.coverage.complete);
  const latestSafeArtifact = projectArtifacts[0];
  const openDrafts = draftSnapshot.drafts
    .filter((draft) => !draft.finalization && sameCheckpointProject(draft, project))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.draftId.localeCompare(b.draftId));
  const newestMaterial = openDrafts[0];

  let stale: CheckpointProtectionState['stale'];
  if (artifactSnapshot.status === 'degraded' || draftSnapshot.status === 'degraded') stale = 'unknown';
  else stale = !!newestMaterial && (!latestSafeArtifact || newestMaterial.updatedAt > latestSafeArtifact.createdAt);

  let worstLossEvents: CheckpointProtectionState['worstLossEvents'] = 'unknown';
  if (stale === false && latestSafeArtifact) {
    worstLossEvents = 0;
  } else if (stale === true && newestMaterial) {
    const baseline = newestMaterial.coverage.fromCheckpointId
      ? projectArtifacts.find((artifact) => artifact.id === newestMaterial.coverage.fromCheckpointId)
      : undefined;
    if (
      baseline
      && typeof baseline.coverage.eventCount === 'number'
      && typeof newestMaterial.coverage.eventCount === 'number'
      && newestMaterial.coverage.eventCount >= baseline.coverage.eventCount
    ) {
      worstLossEvents = newestMaterial.coverage.eventCount - baseline.coverage.eventCount;
    }
  }

  const latestCrashFloor = projectArtifacts
    .filter((artifact) => artifact.trigger.kind === 'crash_floor')
    .sort(newestCheckpointFirst)[0];
  const latestFloorJournal = [...events]
    .filter((event) => event.type === 'memory.journal.appended' && event.metadata?.floor === true)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0];
  const latestFloor: CheckpointProtectionState['latestFloor'] = latestCrashFloor
    ? {
        kind: 'checkpoint',
        artifactId: latestCrashFloor.id,
        at: latestCrashFloor.createdAt,
        triggerSignal: latestCrashFloor.trigger.signal,
      }
    : latestFloorJournal
      ? {
          kind: 'journal',
          at: latestFloorJournal.at,
          runtime: typeof latestFloorJournal.metadata?.floorRuntime === 'string'
            ? latestFloorJournal.metadata.floorRuntime
            : 'unknown',
        }
      : null;

  const latestActivation = new Map<string, (typeof activation)[number]>();
  for (const row of activation) latestActivation.set(row.runtime, row);
  const activationDegradation: CheckpointProtectionState['activationDegradation'] = [...latestActivation.values()]
    .filter((row) => row.status === 'failed')
    .map((row) => ({
      runtime: row.runtime,
      observedAt: row.observedAt,
      reasonCode: 'activation_latest_event_failed' as const,
    }))
    .sort((a, b) => a.runtime.localeCompare(b.runtime));

  return {
    lookup: {
      status: artifactSnapshot.status,
      ...(artifactSnapshot.reasonCode ? { reasonCode: artifactSnapshot.reasonCode } : {}),
    },
    latestComplete: protectionSummary(latestCompleteArtifact),
    latestPartial: protectionSummary(latestPartialArtifact),
    latestFloor,
    stale,
    newerMaterial: stale === true && newestMaterial
      ? {
          draftId: newestMaterial.draftId,
          updatedAt: newestMaterial.updatedAt,
          ...(newestMaterial.coverage.eventCount === undefined ? {} : { eventCount: newestMaterial.coverage.eventCount }),
        }
      : null,
    worstLossEvents,
    activationDegradation,
  };
}

export async function locateCheckpointDrafts(
  workspace: Workspace,
  project: CheckpointProjectIdentity,
  runtime: string,
  sessionId: string,
): Promise<CheckpointDraftLocatorMatch> {
  const session = normalizeCheckpointSession(runtime, sessionId);
  return await withWorkspaceLock(workspace, async () => (
    await findCheckpointDraftsByLocatorUnlocked(workspace, project, session)
  ));
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
    if (![
      'checkpoint_finalization_audit_outcome_mismatch',
      'checkpoint_finalization_audit_missing',
      'checkpoint_audit_conflict_invalid',
      'checkpoint_audit_pending_invalid',
      'checkpoint_audit_publication_invalid',
      'checkpoint_audit_segment_invalid',
      'checkpoint_audit_state_invalid',
      'checkpoint_draft_precondition_failed',
    ].includes(code)) {
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
  return await readCheckpointSemanticArtifactIndexUnlocked(workspace, candidate);
}

async function repairSemanticIndexAfterDurableFinalization(
  workspace: Workspace,
  artifact: CheckpointArtifactV1,
): Promise<void> {
  // The index is a private optimization, not completion authority. Writing it only after the artifact,
  // audit, and draft marker are durable makes every crash window conservative: a lost write causes one
  // safe extra artifact, while a stale/early pointer is revalidated and ignored on the next lookup.
  await writeCheckpointSemanticArtifactIndexUnlocked(workspace, artifact).catch(() => {});
}

async function ensureFinalizationAuditUnlocked(
  workspace: Workspace,
  draftId: string,
  artifact: CheckpointArtifactV1,
  type: 'checkpoint.artifact.created' | 'checkpoint.artifact.deduplicated',
): Promise<void> {
  await appendCheckpointAuditUnlocked(workspace, {
    type,
    operation: 'artifact.finalize',
    draftId,
    artifactId: artifact.id,
    ...(artifact.supersedes ? { supersedes: artifact.supersedes } : {}),
  });
  const published = await readCheckpointFinalizationAuditUnlocked(workspace, draftId, true);
  if (
    !published
    || published.artifactId !== artifact.id
    || published.type !== type
    || published.supersedes !== artifact.supersedes
  ) throw new Error('checkpoint_finalization_audit_outcome_mismatch');
}

async function requireFinalizationAuditUnlocked(
  workspace: Workspace,
  draftId: string,
  artifact: CheckpointArtifactV1,
): Promise<void> {
  const existing = await readCheckpointFinalizationAuditUnlocked(workspace, draftId, true);
  if (!existing) throw new Error('checkpoint_finalization_audit_missing');
  if (
    existing.artifactId !== artifact.id
    || existing.supersedes !== artifact.supersedes
    || (existing.type !== 'checkpoint.artifact.created' && existing.type !== 'checkpoint.artifact.deduplicated')
  ) throw new Error('checkpoint_finalization_audit_outcome_mismatch');
}

async function assertNoAuditOnlyFinalizationUnlocked(workspace: Workspace, draftId: string): Promise<void> {
  if (await readCheckpointFinalizationAuditUnlocked(workspace, draftId)) {
    throw new Error('checkpoint_finalization_audit_outcome_mismatch');
  }
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
    // A crash-floor observation proves only that this bounded draft was the latest safely persisted
    // state we could recover. It can never upgrade the cooperative draft's coverage claim to complete,
    // even when the draft author marked it complete before the host disappeared. Keeping this rule in
    // the deterministic artifact builder also keeps intent/marker recovery byte-for-byte reproducible.
    coverage: build.trigger.kind === 'crash_floor'
      ? { ...draft.coverage, complete: false }
      : draft.coverage,
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
  checkpointAuditV2MarkerFaultPoint();
  const recovered = boundCheckpointDraft({ ...draft, finalization: { artifactId: artifact.id } });
  await stageCheckpointDraftLocatorFinalizedUnlocked(workspace, draft, recovered);
  await writeCheckpointDraftUnlocked(workspace, recovered);
  await commitCheckpointDraftLocatorFinalizedUnlocked(workspace, recovered);
  await repairSemanticIndexAfterDurableFinalization(workspace, artifact);
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
  await commitCheckpointDraftLocatorFinalizedUnlocked(workspace, draft);
  await repairSemanticIndexAfterDurableFinalization(workspace, artifact);
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
          // Publish the content-bound locator first. Until the canonical draft write lands, lookup
          // rejects the early pointer; after it lands, a new cooperative draft can no longer be hidden
          // behind an older finalized receipt even if this process dies before the audit append.
          await stageCheckpointDraftLocatorCreateUnlocked(workspace, draft);
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
          await stageCheckpointDraftLocatorUpdateUnlocked(workspace, draft, updated);
          await writeCheckpointDraftUnlocked(workspace, updated);
          await appendCheckpointAuditUnlocked(workspace, { type: 'checkpoint.draft.updated', operation: 'draft.update', draftId });
          return updated;
        });
      });
    },

    async finalizeDraft(draftId, request, collectMachineAnchors, precondition) {
      return await rejected(workspace, 'artifact.finalize', async () => {
        const finalized = validateFinalizeRequest(request);
        if (typeof collectMachineAnchors !== 'function') throw new CheckpointValidationError('checkpoint_machine_anchor_provider_required');

        // Recovery deliberately runs before anchor collection. If the immutable artifact landed but the
        // draft/audit writes did not, retry binds that exact artifact and never observes replacement anchors.
        const recovered = await withWorkspaceLock(workspace, async () => {
          const draft = await readCheckpointDraftUnlocked(workspace, draftId);
          assertProjectMatchesService(draft, project);
          assertCheckpointDraftFinalizationPrecondition(draft, precondition);
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
          // This is the authoritative CAS: after it passes, the workspace lock excludes updateDraft
          // until the artifact, audit, draft marker, and locator commit have completed.
          assertCheckpointDraftFinalizationPrecondition(draft, precondition);
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
            checkpointAuditV2MarkerFaultPoint();
            const completedDraft = boundCheckpointDraft({ ...draft, finalization: { artifactId: semanticDuplicate.id } });
            await stageCheckpointDraftLocatorFinalizedUnlocked(workspace, draft, completedDraft);
            await writeCheckpointDraftUnlocked(workspace, completedDraft);
            await commitCheckpointDraftLocatorFinalizedUnlocked(workspace, completedDraft);
            await repairSemanticIndexAfterDurableFinalization(workspace, semanticDuplicate);
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
          checkpointAuditV2MarkerFaultPoint();
          const completedDraft = boundCheckpointDraft({ ...draft, finalization: { artifactId: artifact.id } });
          await stageCheckpointDraftLocatorFinalizedUnlocked(workspace, draft, completedDraft);
          await writeCheckpointDraftUnlocked(workspace, completedDraft);
          await commitCheckpointDraftLocatorFinalizedUnlocked(workspace, completedDraft);
          await repairSemanticIndexAfterDurableFinalization(workspace, artifact);
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
      return await withWorkspaceLock(workspace, async () => await readCheckpointAudit(workspace));
    },
  };
}
