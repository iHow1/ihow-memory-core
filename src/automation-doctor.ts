// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace } from './types.ts';
import { probeMetrics, type ProbeMetrics } from './context-probe.ts';

export type AutomationRuntime = 'claude-code' | 'codex' | 'openclaw' | 'hermes' | 'no-hook';
export type AutomationStatus = 'OK' | 'WARN' | 'BROKEN';

export type AutomationMatrixRow = {
  runtime: string;
  sessionStartResume: string;
  promptRecall: string;
  sessionEndCapture: string;
  floorFallback: string;
  status: AutomationStatus;
  notes: string;
  probeCalls: number;
};

export type PathClassification = {
  status: AutomationStatus;
  notes: string[];
};

export function automationStatusRank(status: AutomationStatus): number {
  if (status === 'BROKEN') return 2;
  if (status === 'WARN') return 1;
  return 0;
}

export function worstAutomationStatus(statuses: AutomationStatus[]): AutomationStatus {
  let worst: AutomationStatus = 'OK';
  for (const status of statuses) {
    if (automationStatusRank(status) > automationStatusRank(worst)) worst = status;
  }
  return worst;
}

const ROWS: Array<Omit<AutomationMatrixRow, 'status' | 'notes' | 'probeCalls'>> = [
  {
    runtime: 'Claude Code',
    sessionStartResume: 'hook',
    promptRecall: 'hook/skill',
    sessionEndCapture: 'Stop hook',
    floorFallback: 'SessionStart floor',
  },
  {
    runtime: 'Codex',
    sessionStartResume: 'hook',
    promptRecall: 'UserPromptSubmit hook',
    sessionEndCapture: 'finalize / no true Stop',
    floorFallback: 'SessionStart floor sweep',
  },
  {
    runtime: 'OpenClaw',
    sessionStartResume: 'native/session integration',
    promptRecall: 'memory_search/continue',
    sessionEndCapture: 'cooperative journal',
    floorFallback: 'probe/floor',
  },
  {
    runtime: 'Hermes',
    sessionStartResume: 'MCP/setup',
    promptRecall: 'MCP',
    sessionEndCapture: 'cooperative/missing',
    floorFallback: 'probe/floor candidate',
  },
  {
    runtime: 'WorkBuddy/OpenCode/Gemini',
    sessionStartResume: 'context_probe(session_start)',
    promptRecall: 'context_probe(prompt)',
    sessionEndCapture: 'cooperative journal',
    floorFallback: 'stale marker only',
  },
];

function runtimeKey(label: string): string {
  if (label === 'Claude Code') return 'claude-code';
  if (label === 'WorkBuddy/OpenCode/Gemini') return 'no-hook';
  return label.toLowerCase();
}

function isMissingExecutable(command: string): boolean {
  if (!path.isAbsolute(command)) return false;
  try {
    fs.accessSync(command, fs.constants.X_OK);
    return false;
  } catch {
    return true;
  }
}

function isDeadTmpPath(value: string): boolean {
  const resolved = path.resolve(value);
  return resolved === '/tmp' || resolved.startsWith('/tmp/') || resolved === '/private/tmp' || resolved.startsWith('/private/tmp/');
}

export function classifyAutomationPath(spec: { command?: string; args?: string[] }): PathClassification {
  const notes: string[] = [];
  const command = spec.command || '';
  const args = Array.isArray(spec.args) ? spec.args : [];
  const all = [command, ...args].filter(Boolean);
  if (!command) notes.push('missing MCP command');
  for (const item of all) {
    if (path.isAbsolute(item) && isDeadTmpPath(item)) notes.push(`temporary MCP path (may disappear after restart): ${item}`);
  }
  if (command && isMissingExecutable(command)) notes.push(`missing MCP command: ${command}`);
  for (const arg of args) {
    if (path.isAbsolute(arg) && /(?:^|\/)(?:server\.js|mcp\/server\.js)$/.test(arg) && !fs.existsSync(arg)) {
      notes.push(`runtime bundle not materialized: ${arg}`);
    }
  }
  if (notes.some((n) => /missing MCP command/.test(n))) {
    return { status: 'BROKEN', notes };
  }
  return { status: notes.length ? 'WARN' : 'OK', notes };
}

function noHookCalls(metrics: ProbeMetrics): number {
  return (metrics.probeCallsByRuntime.workbuddy ?? 0)
    + (metrics.probeCallsByRuntime.opencode ?? 0)
    + (metrics.probeCallsByRuntime.gemini ?? 0)
    + (metrics.probeCallsByRuntime.unknown ?? 0);
}

export async function automationMatrix(
  workspace: Workspace,
  spec: { command?: string; args?: string[] },
): Promise<{ rows: AutomationMatrixRow[]; metrics: ProbeMetrics; path: PathClassification }> {
  const metrics = await probeMetrics(workspace);
  const pathStatus = classifyAutomationPath(spec);
  const aggregateStatus = pathStatus.status === 'BROKEN' ? 'BROKEN' : 'OK';
  const rows = ROWS.map((row) => {
    const key = runtimeKey(row.runtime);
    const probeCalls = key === 'no-hook' ? noHookCalls(metrics) : (metrics.probeCallsByRuntime[key] ?? 0);
    const notes: string[] = [];
    let status: AutomationStatus = 'OK';
    if (aggregateStatus === 'BROKEN') {
      status = aggregateStatus;
      notes.push(...pathStatus.notes);
    }
    if (key === 'no-hook' && probeCalls === 0) {
      status = status === 'BROKEN' ? status : 'WARN';
      notes.push('no context_probe calls recorded for no-hook runtimes');
    }
    if (key !== 'no-hook' && probeCalls === 0) notes.push('no recent context_probe calls recorded');
    return {
      ...row,
      status,
      notes: notes.length ? notes.join('; ') : 'ok',
      probeCalls,
    };
  });
  return { rows, metrics, path: pathStatus };
}
