// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Deterministic machine-verified anchors for the handoff "continue" path. These are the ONLY facts
// a handoff envelope is allowed to state, because they are read straight from git by code — an LLM
// can never fabricate them. (Design lock, n=12 A/B 2026-06-18: any LLM-ASSERTED "fact" or
// "verified finding" in a handoff makes the receiving agent confidently wrong; the safe split is
// machine anchors as fact + a faithfully-quoted, attributed, UNVERIFIED narrative the receiver
// must re-check live. See projects spec ihow-continue.) Never throws: a non-git cwd returns
// { isRepo: false } and the envelope simply carries no anchors.

import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type GitAnchors = {
  isRepo: boolean;
  repo?: string;
  branch?: string;
  head?: string;
  headSubject?: string;
  ahead?: number;
  behind?: number;
  dirtyCount?: number;
  dirtyFiles?: string[];
  lastCommitRel?: string;
};

// Run one git subcommand, bounded and non-throwing. Returns trimmed stdout, or null on any
// failure (not a repo, git missing, timeout, non-zero exit).
function git(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 4000, maxBuffer: 10 * 1024 * 1024 });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout.trim();
  } catch {
    return null;
  }
}

// Collect git anchors for a working directory. Deterministic, bounded, never throws.
export function gitAnchors(cwd: string): GitAnchors {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return { isRepo: false };

  const porcelain = git(cwd, ['status', '--porcelain']);
  const dirtyFiles = porcelain ? porcelain.split('\n').filter((l) => l.trim()) : [];

  let ahead: number | undefined;
  let behind: number | undefined;
  // "<ahead> <behind>" relative to the tracking branch; null (no upstream) leaves both undefined.
  const counts = git(cwd, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (counts) {
    const [a, b] = counts.split(/\s+/).map((n) => Number(n));
    if (Number.isFinite(a)) ahead = a;
    if (Number.isFinite(b)) behind = b;
  }

  // On detached HEAD (and mid-rebase) abbrev-ref returns the literal "HEAD"; render it as detached
  // rather than a branch literally named HEAD.
  const branchRaw = git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    isRepo: true,
    repo: path.basename(top),
    branch: branchRaw === 'HEAD' ? '(detached)' : (branchRaw ?? undefined),
    head: git(cwd, ['rev-parse', '--short', 'HEAD']) ?? undefined,
    headSubject: git(cwd, ['log', '-1', '--pretty=%s']) ?? undefined,
    ahead,
    behind,
    dirtyCount: dirtyFiles.length,
    dirtyFiles: dirtyFiles.slice(0, 10),
    lastCommitRel: git(cwd, ['log', '-1', '--pretty=%cr']) ?? undefined,
  };
}

// Render anchors as the deterministic "facts" block of an envelope. No interpretation.
export function renderAnchors(a: GitAnchors): string {
  if (!a.isRepo) return '(cwd is not a git repository — no machine anchors available)';
  const lines = [
    `repo: ${a.repo}`,
    `branch: ${a.branch ?? '?'}`,
    `HEAD: ${a.head ?? '?'}${a.headSubject ? `  ${a.headSubject}` : ''}`,
  ];
  if (a.ahead !== undefined || a.behind !== undefined) {
    lines.push(`upstream: ${a.ahead ?? '?'} ahead / ${a.behind ?? '?'} behind`);
  }
  lines.push(`dirty: ${a.dirtyCount ?? 0} file(s)`);
  if (a.dirtyFiles && a.dirtyFiles.length) lines.push(...a.dirtyFiles.map((f) => `  ${f}`));
  if (a.lastCommitRel) lines.push(`last commit: ${a.lastCommitRel}`);
  return lines.join('\n');
}
