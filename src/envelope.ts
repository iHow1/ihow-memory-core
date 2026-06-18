// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// The handoff "transport envelope" — NOT a report, NOT a reasoning artifact. Design lock (n=12 A/B
// + OpenClaw review, 2026-06-18): an LLM-generated "smart capsule" (facts/inference split, or a
// humble verify-framed version) makes the receiving agent CONFIDENTLY WRONG (2/6 then 4/6), because
// the generator has no live tools and fabricates "verified" findings; a faithfully-quoted, attributed
// UNVERIFIED narrative + git-verified anchors keeps the receiver skeptical (0/6). So this module does
// PURE STRING ASSEMBLY: it adds no interpretation, asserts no facts, detects no contradictions, runs
// no LLM. The only "facts" are the machine anchors (from anchors.ts / git). Everything the previous
// agent said is carried verbatim under an explicit "UNVERIFIED" banner. Truth-judgment happens on the
// RECEIVER side, which has real tools (see RECEIVER_INSTRUCTION).

import type { GitAnchors } from './anchors.ts';
import { renderAnchors } from './anchors.ts';

export const CAPSULE_VERSION = 1;

// Fixed receiver protocol (NOT LLM-generated). Tells the next agent to verify-first: the narrative
// is the previous agent's unverified claim; the only facts are the anchors, which must be re-checked
// against live state before acting.
export const RECEIVER_INSTRUCTION = [
  'HOW TO CONTINUE — verify first, do NOT trust the narrative as fact:',
  '1. PREFLIGHT: run `git rev-parse --short HEAD`, `git status` and compare to the MACHINE ANCHORS',
  '   above. If HEAD / branch / dirty no longer match, the handoff is STALE — reconcile before acting.',
  '2. HANDSHAKE: say back what you understand the task to be and what you will verify first.',
  '3. FIRST ACTION = a minimal verification (read a file, run the tests, check git) — NEVER a large change.',
  "4. The narrative is the previous agent's OWN words and is UNVERIFIED. Treat any status claim",
  '   (built / passing / done / deployed / published) as a claim to verify, not a fact.',
].join('\n');

export type EnvelopeInput = {
  cwd: string;
  producerAgent: string;
  createdAt: string;
  anchors: GitAnchors;
  quotedBody: string; // already redacted; the previous agent's faithful session summary, verbatim
  sourceSessionId?: string;
  transcriptRef?: string;
};

// Assemble the dumb transport envelope. Pure string assembly — no LLM, no asserted facts.
export function assembleEnvelope(input: EnvelopeInput): string {
  const body = input.quotedBody.trim() || '(no substantive prior-session summary was captured)';
  const lines: string[] = [
    '=== ihow handoff — attributed transport envelope (NOT a report) ===',
    `capsule_version: ${CAPSULE_VERSION}`,
    `created_at: ${input.createdAt}`,
    `producer_agent: ${input.producerAgent}`,
  ];
  if (input.sourceSessionId) lines.push(`source_session: ${input.sourceSessionId}`);
  if (input.transcriptRef) lines.push(`transcript_ref: ${input.transcriptRef}`);
  lines.push(`cwd: ${input.cwd}`);
  lines.push('');
  lines.push('--- MACHINE ANCHORS — facts, git-verified (re-check live before trusting) ---');
  lines.push(renderAnchors(input.anchors));
  lines.push('');
  lines.push("--- PREVIOUS AGENT SAID — UNVERIFIED (its own words, not checked by this tool) ---");
  lines.push(body);
  lines.push('');
  lines.push('--- RECEIVER PROTOCOL ---');
  lines.push(RECEIVER_INSTRUCTION);
  return lines.join('\n');
}
