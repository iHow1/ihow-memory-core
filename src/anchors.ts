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
import { readFileSync } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

// Non-git verify-first anchor: a content fingerprint of a file the session edited. When the project is
// not a git repo, the receiver re-hashes these (same bytes + sha8 = unchanged) to detect drift before
// trusting the narrative — the git-free equivalent of comparing HEAD.
export type FileAnchor = { path: string; bytes: number; sha8: string };

export type GitAnchors = {
  isRepo: boolean;
  repo?: string;
  branch?: string;
  head?: string;
  headSubject?: string;
  ahead?: number;
  behind?: number;
  dirty?: boolean;
  dirtyCount?: number;
  dirtyFiles?: string[];
  statusHash?: string;
  lastCommitRel?: string;
  files?: FileAnchor[]; // non-git fallback anchors (only set when isRepo is false)
};

// SECURITY: anchors are computed against directories mined VERBATIM from OTHER tools' session stores
// (Codex cwd / WorkBuddy cwd / OpenClaw workspaceDir / OpenCode session.directory). A plain `git status`
// in an attacker-controlled repo executes that repo's local `.git/config` `core.fsmonitor` command — a
// remote-code-execution path triggered merely by running `memory.continue`. We neutralize the
// config-driven command-exec vectors on EVERY invocation: command-line `-c` has the highest precedence,
// so it overrides any repo-local `core.fsmonitor` / `core.hooksPath`. We also drop optional locks and
// disable terminal prompts so a hostile/odd repo can't make git hang or block.
const GIT_HARDENING_ARGS = ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null'];

// Run one git subcommand, bounded, hardened, and non-throwing. Returns raw stdout, or null on any
// failure (not a repo, git missing, timeout, non-zero exit); callers trim only when appropriate.
function gitRaw(cwd: string, args: string[]): string | null {
  try {
    const r = spawnSync('git', [...GIT_HARDENING_ARGS, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 4000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    return r.stdout;
  } catch {
    return null;
  }
}

function git(cwd: string, args: string[]): string | null {
  return gitRaw(cwd, args)?.trim() ?? null;
}

const STATUS_HASH_MAX_UNTRACKED_FILES = 256;

export function gitWorktreeStatusHash(cwd: string): string | undefined {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return undefined;
  const porcelain = gitRaw(top, ['status', '--porcelain=v1', '--untracked-files=all']);
  const cachedDiff = gitRaw(top, ['diff', '--no-ext-diff', '--binary', '--cached', 'HEAD', '--']);
  const unstagedDiff = gitRaw(top, ['diff', '--no-ext-diff', '--binary', '--']);
  const untrackedRaw = gitRaw(top, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (porcelain === null) return undefined;
  if (cachedDiff === null || unstagedDiff === null || untrackedRaw === null) return undefined;
  const untracked = untrackedRaw.split('\0').filter(Boolean).sort();
  if (untracked.length > STATUS_HASH_MAX_UNTRACKED_FILES) return undefined;
  const hash = crypto.createHash('sha256')
    .update(porcelain).update('\0')
    .update(cachedDiff).update('\0')
    .update(unstagedDiff).update('\0');
  for (const file of untracked) {
    const blob = git(top, ['hash-object', '--no-filters', '--', file]);
    if (!blob || !/^[a-f0-9]{40,64}$/.test(blob)) return undefined;
    hash.update(file).update('\0').update(blob).update('\0');
  }
  return hash.digest('hex');
}

// Collect git anchors for a working directory. Deterministic, bounded, never throws.
export function gitAnchors(cwd: string): GitAnchors {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top) return { isRepo: false };

  const porcelain = gitRaw(top, ['status', '--porcelain=v1', '--untracked-files=all']);
  const dirtyFiles = porcelain ? porcelain.split('\n').filter((l) => l.trim()) : [];
  const dirtyCount = porcelain === null ? undefined : dirtyFiles.length;

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
    dirty: dirtyCount === undefined ? undefined : dirtyCount > 0,
    dirtyCount,
    dirtyFiles: dirtyFiles.slice(0, 10),
    lastCommitRel: git(cwd, ['log', '-1', '--pretty=%cr']) ?? undefined,
  };
}

// Resolve the git repo root containing `dir` (the `--show-toplevel`), or null when `dir` is not inside a
// repo. Hardened + non-throwing like the rest of this module. Used to prove that a receiver's cwd and the
// session's INFERRED project are the SAME checkout before a resume can earn a confident GREEN — different
// repo (or no repo) means we cannot vouch the receiver is sitting where the work landed.
export function repoRoot(dir: string): string | null {
  const top = git(dir, ['rev-parse', '--show-toplevel']);
  return top ? path.resolve(top) : null;
}

// Render anchors as the deterministic "facts" block of an envelope. No interpretation.
// Fingerprint up to `limit` of the files the session edited (size + short content hash). Used as the
// verify-first anchor for NON-git projects. Bounded + non-throwing: missing/unreadable files are skipped,
// big files are still hashed (source files are small; the cap bounds the count, not the size meaningfully).
export function fileAnchors(files: string[], limit = 12): FileAnchor[] {
  const out: FileAnchor[] = [];
  for (const f of files) {
    if (out.length >= limit) break;
    if (!f) continue;
    const abs = f.startsWith('~/') ? path.join(os.homedir(), f.slice(2)) : f;
    try {
      const buf = readFileSync(abs);
      out.push({ path: f, bytes: buf.length, sha8: crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8) });
    } catch {
      // skip files that no longer exist / aren't readable
    }
  }
  return out;
}

export function renderAnchors(a: GitAnchors): string {
  if (!a.isRepo) {
    if (a.files && a.files.length) {
      return [
        '(not a git repo — file-fingerprint anchors; re-check by re-hashing each file: same bytes + sha8 = unchanged)',
        ...a.files.map((f) => `  ${f.path} — ${f.bytes} bytes · sha ${f.sha8}`),
      ].join('\n');
    }
    return '(cwd is not a git repository — no machine anchors available)';
  }
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

// Infer the project a session worked on from the files it touched: the git repo root that contains the
// most of them. This keeps `continue` project-aware even when every session is launched from one
// terminal cwd — the project is "where the work landed on disk", not the session's cwd. Returns the
// dominant git repo root, or undefined when none of the touched files live in a git repo.
export function inferProjectDir(files: string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const f of files) {
    if (!f) continue;
    const expanded = f.startsWith('~/') ? path.join(os.homedir(), f.slice(2)) : f;
    const root = git(path.dirname(expanded), ['rev-parse', '--show-toplevel']);
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestN = 0;
  for (const [root, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = root;
    }
  }
  return best;
}
