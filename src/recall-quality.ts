// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Deterministic recall-quality gates shared by prompt recall surfaces. This is intentionally
// model-free: it does not add a semantic provider, it only fails closed on boundaries that must
// not be injected into a prompt by default.

export type RecallBoundaryReason = 'flagged' | 'private' | 'audit-only';

export type RecallBoundaryDecision = {
  allowed: boolean;
  reason?: RecallBoundaryReason;
};

function frontmatter(content: string): string {
  const match = String(content || '').match(/^﻿?\s*---\r?\n([\s\S]*?)\r?\n---/);
  return match ? match[1] : '';
}

function scalar(front: string, key: 'visibility' | 'scope'): string | undefined {
  const match = front.match(new RegExp(`^\\s*${key}\\s*:\\s*["']?([^"'\\r\\n#]+)`, 'im'));
  return match?.[1]?.trim().toLowerCase();
}

function normalizedMemoryPath(relativePath: string | undefined): string {
  const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\/+/, '').toLowerCase();
  return normalized.startsWith('memory/') ? normalized.slice('memory/'.length) : normalized;
}

function privatePath(relativePath: string | undefined): boolean {
  const mem = normalizedMemoryPath(relativePath);
  return mem.startsWith('private/') || mem.startsWith('scopes/private/');
}

function auditOnlyPath(relativePath: string | undefined): boolean {
  const mem = normalizedMemoryPath(relativePath);
  return mem.startsWith('audit/') || mem.startsWith('_events/') || mem.includes('/_events/');
}

// Default prompt recall is a cross-session read into model context. It must not surface quarantine,
// private, or audit-only memory unless a future explicit, audited scope option asks for that surface.
export function defaultPromptRecallBoundary(content: string, relativePath?: string): RecallBoundaryDecision {
  const front = frontmatter(content);
  if (/^\s*flagged\s*:\s*["']?true\b/im.test(front)) return { allowed: false, reason: 'flagged' };

  const visibility = scalar(front, 'visibility');
  const scope = scalar(front, 'scope');
  if (visibility === 'private' || scope === 'private' || privatePath(relativePath)) return { allowed: false, reason: 'private' };
  if (visibility === 'audit-only' || visibility === 'audit_only' || scope === 'audit-only' || scope === 'audit_only' || auditOnlyPath(relativePath)) {
    return { allowed: false, reason: 'audit-only' };
  }

  return { allowed: true };
}
