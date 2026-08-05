// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultPromptRecallBoundary } from '../src/recall-quality.ts';

test('alpha26 recall boundary allows plain reviewed memory', () => {
  const decision = defaultPromptRecallBoundary('---\nstatus: "promoted"\n---\n\nReviewed project decision.', 'scopes/team/decision.md');
  assert.deepEqual(decision, { allowed: true });
});

test('alpha26 recall boundary excludes flagged memory by frontmatter and path', () => {
  assert.deepEqual(
    defaultPromptRecallBoundary('---\nflagged: true\n---\n\nNeeds human review.', 'scopes/team/flagged.md'),
    { allowed: false, reason: 'flagged' },
  );
  assert.deepEqual(
    defaultPromptRecallBoundary('---\nstatus: promoted\n---\n\nQuarantined note.', 'scopes/flagged/manual-review.md'),
    { allowed: false, reason: 'flagged' },
  );
});

test('alpha26 recall boundary accepts BOM/whitespace frontmatter and excludes private memory by frontmatter and path', () => {
  assert.deepEqual(
    defaultPromptRecallBoundary('\ufeff  --- \r\nvisibility: private\r\n---\r\n\r\nPrivate note.', 'scopes/team/private.md'),
    { allowed: false, reason: 'private' },
  );
  assert.deepEqual(
    defaultPromptRecallBoundary('---\nstatus: promoted\n---\n\nPrivate path note.', 'private/account.md'),
    { allowed: false, reason: 'private' },
  );
});

test('alpha26 recall boundary excludes audit-only memory by frontmatter and path', () => {
  assert.deepEqual(
    defaultPromptRecallBoundary('---\nvisibility: audit-only\n---\n\nAudit event.', 'scopes/team/audit.md'),
    { allowed: false, reason: 'audit-only' },
  );
  assert.deepEqual(
    defaultPromptRecallBoundary('---\nstatus: promoted\n---\n\nAudit path event.', '_events/2026-01-01.jsonl'),
    { allowed: false, reason: 'audit-only' },
  );
});
