// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  DurablePromoteOptions,
  DurablePromoteResult,
  PromoteResult,
  PromoteTarget,
  Workspace,
  WriteCandidatePayload,
  WriteCandidateResult,
} from './types.ts';
import { absoluteFromMemoryPath, isMcpSandboxPath, relativeToMemory, relativeToSpace } from './workspace.ts';
import { appendEvent } from './store/events.ts';
import { atomicWriteFile, nowCompact, readMemoryFile, safeFileSlug } from './store/files.ts';
import { withWorkspaceLock } from './store/lock.ts';

export const DEFAULT_PROTECTED_PATTERNS = [
  'SOUL.md',
  'USER.md',
  'IDENTITY.md',
  'MEMORY.md',
  'AGENTS.md',
  'memory/SOUL.md',
  'memory/USER.md',
  'memory/IDENTITY.md',
  'memory/MEMORY.md',
  'current.md',
];

const SECRET_LIKE_PATTERNS = [
  /\b(api[_-]?key|secret|token|password|passwd|cookie|authorization|bearer|refresh[_-]?token)\b\s*[:=]/i,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/i,
  /\bsk-[A-Za-z0-9_-]{16,}\b/i,
  /\bghp_[A-Za-z0-9_]{16,}\b/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /(?:账号|账户|邮箱)\s*[:：=]\s*\S+/i,
];

function candidateText(payload: WriteCandidatePayload): string {
  const text = payload.text ?? payload.content;
  if (typeof text !== 'string' || !text.trim()) {
    throw new Error('candidate_text_required');
  }
  assertNoSecretLikeContent(text);
  return text.trim();
}

function assertNoSecretLikeContent(text: string): void {
  if (SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(text))) {
    throw new Error('candidate_contains_secret_like_content');
  }
}

function assertNoSecretLikeDurableCandidate(content: string): void {
  if (SECRET_LIKE_PATTERNS.some((pattern) => pattern.test(content))) {
    throw new Error('redact_check_failed_candidate_contains_secret_like_content');
  }
}

function frontMatter(data: Record<string, unknown>): string {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${JSON.stringify(value)}`);
  }
  lines.push('---');
  return `${lines.join('\n')}\n`;
}

function markdownCandidate(candidateId: string, payload: WriteCandidatePayload): string {
  const title = payload.title || `Candidate ${candidateId}`;
  const sourceAgent = payload.sourceAgent || payload.source || 'unknown';
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  return `${frontMatter({
    type: 'memory_candidate',
    candidate_id: candidateId,
    status: 'candidate',
    source_agent: sourceAgent,
    created_at: new Date().toISOString(),
    ...metadata,
  })}\n# ${title}\n\n${candidateText(payload)}\n`;
}

export function isProtectedPath(ref: string): boolean {
  const normalized = ref.replace(/\\/g, '/').replace(/^\/+/, '');
  return DEFAULT_PROTECTED_PATTERNS.some((pattern) => normalized === pattern || normalized.endsWith(`/${pattern}`));
}

function normalizeRef(ref: string): string {
  return ref.replace(/\\/g, '/').replace(/^\/+/, '');
}

function stripMemoryPrefix(ref: string): string {
  const normalized = normalizeRef(ref);
  return normalized.startsWith('memory/') ? normalized.slice('memory/'.length) : normalized;
}

function resolveTargetPath(workspace: Workspace, candidateId: string, target: PromoteTarget = {}): string {
  if (workspace.mode === 'existing-memory-root') {
    const title = safeFileSlug(target.title || candidateId, candidateId);
    return path.join(workspace.promotedDir, `${nowCompact()}-${title}.md`);
  }

  const explicit = target.path?.trim();
  if (explicit) {
    if (isProtectedPath(explicit)) throw new Error('protected_core_path');
    const absolute = absoluteFromMemoryPath(workspace, explicit);
    return absolute;
  }

  const scope = safeFileSlug(target.scope || 'general', 'general');
  const title = safeFileSlug(target.title || candidateId, candidateId);
  const relative = path.join('scopes', scope, `${nowCompact()}-${title}.md`);
  if (isProtectedPath(relative)) throw new Error('protected_core_path');
  return path.join(workspace.memoryDir, relative);
}

function candidateDirForAgent(workspace: Workspace, sourceAgent: string): string {
  if (workspace.mode === 'existing-memory-root') {
    return path.join(workspace.candidatesDir, safeFileSlug(sourceAgent, 'unknown'));
  }
  return workspace.candidatesDir;
}

function isAllowedCandidatePath(workspace: Workspace, relativePath: string, absolutePath: string): boolean {
  if (workspace.mode === 'existing-memory-root') {
    return relativePath.startsWith('memory/_mcp/candidates/') && isMcpSandboxPath(workspace, absolutePath);
  }
  return relativePath.startsWith('memory/candidate/inbox/');
}

function isAllowedDurableTargetPath(relativePath: string): boolean {
  const normalized = normalizeRef(relativePath);
  const memoryRelative = stripMemoryPrefix(normalized);
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(memoryRelative)) return true;
  if (memoryRelative.startsWith('scopes/')) return true;
  if (memoryRelative.startsWith('inbox/')) return true;
  if (normalized.startsWith('projects/')) return true;
  return false;
}

function isForbiddenDurableTargetPath(relativePath: string): boolean {
  const memoryRelative = stripMemoryPrefix(relativePath);
  return (
    memoryRelative === 'recent/latest.md' ||
    memoryRelative === 'decisions.md' ||
    memoryRelative === 'workflows.md' ||
    memoryRelative === 'codex/current.md' ||
    memoryRelative === 'claude-code/current.md' ||
    memoryRelative.endsWith('/current.md')
  );
}

function resolveDurableTargetPath(workspace: Workspace, candidateId: string, target: PromoteTarget = {}): string {
  const explicit = target.path?.trim();
  if (explicit) {
    if (isProtectedPath(explicit)) throw new Error('protected_core_path');
    const normalized = normalizeRef(explicit);
    if (normalized.startsWith('projects/')) {
      const workspaceRoot = workspace.mode === 'existing-memory-root' ? path.dirname(workspace.memoryDir) : workspace.spaceDir;
      return path.resolve(workspaceRoot, normalized);
    }
    return absoluteFromMemoryPath(workspace, normalized);
  }

  const scope = safeFileSlug(target.scope || 'general', 'general');
  const title = safeFileSlug(target.title || candidateId, candidateId);
  return path.join(workspace.memoryDir, 'scopes', scope, `${nowCompact()}-${title}.md`);
}

function relativeDurableTarget(workspace: Workspace, targetPath: string): string {
  const resolved = path.resolve(targetPath);
  const memoryDir = path.resolve(workspace.memoryDir);
  if (resolved === memoryDir || resolved.startsWith(`${memoryDir}${path.sep}`)) {
    return relativeToSpace(workspace, resolved);
  }
  const workspaceRoot = workspace.mode === 'existing-memory-root' ? path.dirname(workspace.memoryDir) : workspace.spaceDir;
  const root = path.resolve(workspaceRoot);
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    return path.relative(root, resolved).split(path.sep).join('/');
  }
  throw new Error('target_outside_workspace');
}

function durableAppendContent(candidateContent: string): string {
  return candidateContent
    .replace(/^status:\s*"candidate"\s*$/m, 'status: "promoted"')
    .replace(/^type:\s*"memory_candidate"\s*$/m, 'type: "memory"')
    .replace(/^---\n/, `---\npromoted_at: "${new Date().toISOString()}"\n`);
}

async function durableTargetContent(targetPath: string, appendContent: string): Promise<string> {
  try {
    const existing = await fs.readFile(targetPath, 'utf8');
    return `${existing.replace(/\s*$/, '\n\n')}${appendContent}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return appendContent;
    throw error;
  }
}

function assertCandidateFrontMatter(content: string): void {
  const hasCandidateType = /^type:\s*"memory_candidate"\s*$/m.test(content);
  const hasCandidateStatus = /^status:\s*"candidate"\s*$/m.test(content);
  if (!hasCandidateType || !hasCandidateStatus) {
    throw new Error('candidate_frontmatter_required');
  }
}

export async function writeCandidate(
  workspace: Workspace,
  payload: WriteCandidatePayload,
): Promise<WriteCandidateResult> {
  return await withWorkspaceLock(workspace, async () => {
    const candidateId = crypto.randomUUID();
    const title = safeFileSlug(payload.title || candidateId, candidateId);
    const sourceAgent = payload.sourceAgent || payload.source || 'unknown';
    const filePath = path.join(candidateDirForAgent(workspace, sourceAgent), `${nowCompact()}-${title}.md`);
    await atomicWriteFile(filePath, markdownCandidate(candidateId, payload));
    const relativePath = relativeToSpace(workspace, filePath);
    await appendEvent(workspace, {
      type: 'candidate.created',
      path: relativePath,
      actor: sourceAgent,
      metadata: {
        candidateId,
        status: 'candidate',
        sandbox: workspace.mode === 'existing-memory-root' ? 'memory/_mcp' : undefined,
      },
    });
    return {
      candidateId,
      path: relativePath,
      status: 'candidate',
    };
  });
}

export async function promoteCandidate(
  workspace: Workspace,
  candidateRef: string,
  target: PromoteTarget = {},
): Promise<PromoteResult> {
  return await withWorkspaceLock(workspace, async () => {
    const candidate = await readMemoryFile(workspace, candidateRef);
    const candidateAbsolute = absoluteFromMemoryPath(workspace, candidate.path);
    if (!isAllowedCandidatePath(workspace, candidate.path, candidateAbsolute)) {
      throw new Error('candidate_must_be_from_inbox');
    }
    const candidateIdMatch = candidate.content.match(/^candidate_id:\s*"?(.*?)"?\s*$/m);
    const candidateId = candidateIdMatch?.[1] || path.basename(candidate.path, '.md');
    const targetPath = resolveTargetPath(workspace, candidateId, target);
    const targetRelative = relativeToSpace(workspace, targetPath);
    if (isProtectedPath(targetRelative)) throw new Error('protected_core_path');

    const body = candidate.content
      .replace(/^status:\s*"candidate"\s*$/m, 'status: "promoted"')
      .replace(/^type:\s*"memory_candidate"\s*$/m, 'type: "memory"')
      .replace(/^---\n/, `---\npromoted_at: "${new Date().toISOString()}"\n`);
    await atomicWriteFile(targetPath, body);

    if (workspace.mode === 'existing-memory-root') {
      if (!isMcpSandboxPath(workspace, targetPath)) throw new Error('target_outside_mcp_sandbox');
      await fs.rm(candidateAbsolute, { force: true });
    } else {
      const historyPath = path.join(workspace.historyDir, 'promoted-candidates', path.basename(candidate.path));
      await fs.mkdir(path.dirname(historyPath), { recursive: true });
      await fs.rename(candidateAbsolute, historyPath);
    }

    const event = await appendEvent(workspace, {
      type: 'memory.promoted',
      candidatePath: candidate.path,
      targetPath: targetRelative,
      actor: 'core.promote',
      metadata: {
        candidateId,
        target,
        stagingOnly: workspace.mode === 'existing-memory-root',
        targetMemoryPath: relativeToMemory(workspace, targetPath),
      },
    });
    return {
      candidateId,
      path: targetRelative,
      status: 'promoted',
      eventId: event.id,
    };
  });
}

export async function durablePromoteCandidate(
  workspace: Workspace,
  candidateRef: string,
  options: DurablePromoteOptions = {},
): Promise<DurablePromoteResult> {
  if (options.dryRun === true && options.realWrite === true) {
    throw new Error('durable_promote_mode_conflict');
  }
  if (options.dryRun !== true && options.realWrite !== true) {
    throw new Error('durable_promote_requires_explicit_dry_run_or_real_write');
  }

  return await withWorkspaceLock(workspace, async () => {
    const candidate = await readMemoryFile(workspace, candidateRef);
    const candidateAbsolute = absoluteFromMemoryPath(workspace, candidate.path);
    if (!isAllowedCandidatePath(workspace, candidate.path, candidateAbsolute)) {
      throw new Error('candidate_must_be_from_inbox');
    }
    assertCandidateFrontMatter(candidate.content);
    assertNoSecretLikeDurableCandidate(candidate.content);

    const candidateIdMatch = candidate.content.match(/^candidate_id:\s*"?(.*?)"?\s*$/m);
    const candidateId = candidateIdMatch?.[1] || path.basename(candidate.path, '.md');
    const targetPath = resolveDurableTargetPath(workspace, candidateId, options.target || {});
    const targetRelative = relativeDurableTarget(workspace, targetPath);

    if (isProtectedPath(targetRelative)) throw new Error('protected_core_path');
    if (isForbiddenDurableTargetPath(targetRelative)) throw new Error('durable_target_forbidden');
    if (!isAllowedDurableTargetPath(targetRelative)) throw new Error('durable_target_not_whitelisted');

    const appendContent = durableAppendContent(candidate.content);
    assertNoSecretLikeDurableCandidate(appendContent);

    const at = new Date().toISOString();
    const eventId = crypto.randomUUID();
    const actor = options.actor || 'core.durable-promote';
    const archiveCandidateTo = relativeToSpace(
      workspace,
      path.join(workspace.historyDir, 'promoted-candidates', path.basename(candidate.path)),
    );
    const auditEventPath = relativeToSpace(workspace, path.join(workspace.eventsDir, `${at.slice(0, 10)}.ndjson`));
    const dryRun = options.dryRun === true;
    const writeGuards = [
      'explicit-durable-promote-call',
      'candidate-inbox-source-only',
      'protected-core-blocked',
      'target-whitelist-enforced',
      'redact-check-before-write',
      'withWorkspaceLock',
      'atomicWriteFile-for-real-write',
      dryRun ? 'dry-run-no-write' : 'real-write-explicitly-enabled',
    ];
    const plan = {
      candidatePath: candidate.path,
      targetPath: targetRelative,
      targetAbsolutePath: targetPath,
      operation: 'append' as const,
      appendContent,
      archiveCandidateTo,
      auditEventPath,
      auditEvent: {
        id: eventId,
        type: 'memory.promoted.durable' as const,
        at,
        actor,
        candidatePath: candidate.path,
        targetPath: targetRelative,
        metadata: {
          candidateId,
          target: options.target || {},
          dryRun,
          source: 'candidate/inbox',
          archiveCandidateTo,
        },
      },
      writeGuards,
    };

    if (dryRun) {
      return {
        candidateId,
        status: 'dry-run',
        dryRun: true,
        plan,
        proof: {
          explicitDurableTrigger: true,
          sourceCandidateInboxOnly: true,
          protectedCoreBlocked: true,
          targetWhitelistEnforced: true,
          redactCheck: 'passed',
          dryRunNoWrites: true,
        },
      };
    }

    await atomicWriteFile(targetPath, await durableTargetContent(targetPath, appendContent));
    const archiveAbsolute = path.join(workspace.historyDir, 'promoted-candidates', path.basename(candidate.path));
    await fs.mkdir(path.dirname(archiveAbsolute), { recursive: true });
    await fs.rename(candidateAbsolute, archiveAbsolute);
    const event = await appendEvent(workspace, {
      type: 'memory.promoted.durable',
      candidatePath: candidate.path,
      targetPath: targetRelative,
      actor,
      metadata: {
        candidateId,
        target: options.target || {},
        dryRun: false,
        source: 'candidate/inbox',
        archiveCandidateTo,
      },
    });

    return {
      candidateId,
      status: 'promoted',
      dryRun: false,
      eventId: event.id,
      path: targetRelative,
      archivedCandidatePath: archiveCandidateTo,
      plan: {
        ...plan,
        auditEvent: {
          ...plan.auditEvent,
          id: event.id,
          at: event.at,
        },
      },
      proof: {
        explicitDurableTrigger: true,
        sourceCandidateInboxOnly: true,
        protectedCoreBlocked: true,
        targetWhitelistEnforced: true,
        redactCheck: 'passed',
        dryRunNoWrites: false,
      },
    };
  });
}
