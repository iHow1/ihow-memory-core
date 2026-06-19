// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// iHow Memory — handoff metrics (hypothesis ② "grooming decay" measurement lane).
//
// Question being measured: as the user keeps resuming via `continue`, do their handoffs get LESS wrong
// over time (corrections settle → anchor conflicts trend down) or is it Sisyphean (flat/rising)? We
// answer it WITHOUT an LLM judging "right/wrong": the primary signal `anchorConflictCount` is computed
// deterministically — count the git-SHA-shaped tokens the UNVERIFIED narrative cites that do NOT match
// the live HEAD. If grooming compounds, later handoffs reference fewer stale shas. (Same "machine
// anchors = the only fact" lock as the envelope: code does the equality check, not a model.)
//
// PRIVACY: this is a LOCAL, content-free measurement file — NOT the opt-in telemetry pipeline (which
// has a network future and a strict allow-list). We append only DERIVED counts + a narrative HASH,
// never raw narrative/code/paths. The narrative is read to compute counts, then discarded. Default ON
// for local dogfood; opt out with IHOW_HANDOFF_METRICS=0. Fully fault-tolerant: a logging failure must
// never break or block a handoff, and never touches the network.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type { GitAnchors } from './anchors.ts';

const METRICS_DIR = path.join(os.homedir(), '.ihow-memory');
const METRICS_PATH = path.join(METRICS_DIR, 'handoff-metrics.jsonl');

function sha(s: string, n = 16): string {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, n);
}

// Distinct git-SHA-shaped tokens (7–40 hex) cited in the narrative that DON'T prefix-match the live
// HEAD. A narrative that claims "HEAD 9cd4dc2 / 16 commits to push" when HEAD is really e1d482b will
// surface 9cd4dc2 here — a deterministic, no-LLM proxy for "narrative conflicts with reality".
export function anchorConflicts(narrative: string, head?: string): { total: number; stale: number; referencesHead: boolean } {
  const tokens = new Set((narrative.toLowerCase().match(/\b[0-9a-f]{7,40}\b/g) ?? []));
  const liveHead = head?.toLowerCase();
  let stale = 0;
  let referencesHead = false;
  for (const tok of tokens) {
    if (liveHead && (liveHead.startsWith(tok) || tok.startsWith(liveHead))) referencesHead = true;
    else stale += 1;
  }
  return { total: tokens.size, stale, referencesHead };
}

export type HandoffMetricInput = {
  projectDir?: string;
  anchors: GitAnchors;
  narrative: string; // already redacted; read to derive counts, never stored
  sourceSessionId?: string;
  sourceAgeMs?: number;
};

// Append one derived, content-free row per handoff. Never throws.
export async function recordHandoffMetric(input: HandoffMetricInput): Promise<void> {
  try {
    if (process.env.IHOW_HANDOFF_METRICS === '0') return; // opt-out
    const narrative = input.narrative ?? '';
    const captureEmpty = narrative.trim().length === 0;
    const conflicts = anchorConflicts(narrative, input.anchors?.head);
    const row = {
      ts: new Date().toISOString(),
      project: input.projectDir ? path.basename(input.projectDir) : null, // basename only — bucket key, no full path
      branch: input.anchors?.isRepo ? input.anchors.branch ?? null : null,
      head: input.anchors?.isRepo ? input.anchors.head ?? null : null,
      dirtyCount: input.anchors?.isRepo ? input.anchors.dirtyCount ?? 0 : null,
      ahead: input.anchors?.ahead ?? null,
      behind: input.anchors?.behind ?? null,
      sourceSessionHash: input.sourceSessionId ? sha(input.sourceSessionId, 12) : null,
      sourceAgeMs: input.sourceAgeMs ?? null,
      captureEmpty,
      narrativeLen: narrative.length,
      narrativeHash: captureEmpty ? null : sha(narrative.replace(/\s+/g, ' ').trim()), // churn/dup detection, not content
      anchorConflictCount: conflicts.stale, // PRIMARY metric: stale sha refs vs live HEAD
      shaRefsTotal: conflicts.total,
      referencesCurrentHead: conflicts.referencesHead,
    };
    await fs.mkdir(METRICS_DIR, { recursive: true });
    await fs.appendFile(METRICS_PATH, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // measurement must never disrupt a handoff
  }
}

export const HANDOFF_METRICS_PATH = METRICS_PATH;
