// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import fs from 'node:fs';
import path from 'node:path';
import type { Workspace, WorkspaceOptions } from './types.ts';
import { probeMetrics, type ProbeMetrics } from './context-probe.ts';
import {
  activationConfigurationId,
  readActivationEvidence,
  type ActivationEvidence,
} from './activation-ledger.ts';
import { verifyRuntimeHookWiring, type RuntimeHookWiring } from './hook-wiring.ts';

export type AutomationRuntime = 'claude-code' | 'codex' | 'openclaw' | 'hermes' | 'no-hook';
export type AutomationStatus = 'OK' | 'WARN' | 'BROKEN';
export type ActivationStatus = 'ACTIVE' | 'READY — WAITING FOR FIRST ACTIVITY' | 'TOOLS ONLY' | 'NEEDS REPAIR';
export type ActivationReasonCode =
  | 'ACTIVATION_LIVE_COMPLETED_AFTER_INSTALL'
  | 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY'
  | 'ACTIVATION_STARTED_ONLY'
  | 'ACTIVATION_SYNTHETIC_ONLY'
  | 'ACTIVATION_COMPLETED_BEFORE_INSTALL'
  | 'ACTIVATION_RECENT_FAILURE'
  | 'ACTIVATION_STALE_FAILURE'
  | 'ACTIVATION_WIRING_NOT_CONFIGURED'
  | 'ACTIVATION_WIRING_BROKEN'
  | 'ACTIVATION_WIRING_GENERATION_UNCONFIRMED'
  | 'ACTIVATION_NOT_ENABLED_TOOLS_ONLY'
  | 'ACTIVATION_NO_VERIFIED_LIFECYCLE_TOOLS_ONLY'
  | 'ACTIVATION_NO_HOOK_TOOLS_ONLY';

export type RuntimeActivation = {
  status: ActivationStatus;
  reasonCode: ActivationReasonCode;
  configuredAt?: string;
  lastObservedAt?: string;
};

export type AutomationMatrixRow = {
  runtime: string;
  sessionStartResume: string;
  promptRecall: string;
  sessionEndCapture: string;
  floorFallback: string;
  status: AutomationStatus;
  notes: string;
  probeCalls: number;
  activationStatus: ActivationStatus;
  activationReasonCode: ActivationReasonCode;
  configuredAt?: string;
  lastObservedAt?: string;
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

const ROWS: Array<Omit<AutomationMatrixRow, 'status' | 'notes' | 'probeCalls' | 'activationStatus' | 'activationReasonCode' | 'configuredAt' | 'lastObservedAt'>> = [
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
  const resolved = path.resolve(value).replace(/\\/g, '/');
  return /(?:^|^[A-Za-z]:)\/(?:private\/)?tmp(?:\/|$)/.test(resolved);
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
    const normalizedArg = arg.replace(/\\/g, '/');
    if (path.isAbsolute(arg) && /(?:^|\/)(?:server\.js|mcp\/server\.js)$/.test(normalizedArg) && !fs.existsSync(arg)) {
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

const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000;
const NO_HOOK_RUNTIME_KEYS = new Set([
  'workbuddy', 'opencode', 'gemini', 'cursor', 'claude-desktop', 'vscode', 'unknown', 'no-hook',
]);

function evidenceForRuntime(evidence: ActivationEvidence[], runtime: string): ActivationEvidence[] {
  if (runtime === 'no-hook') return evidence.filter((row) => NO_HOOK_RUNTIME_KEYS.has(row.runtime));
  return evidence.filter((row) => row.runtime === runtime);
}

function latest(rows: ActivationEvidence[], predicate: (row: ActivationEvidence) => boolean): ActivationEvidence | undefined {
  return rows.filter(predicate).sort((a, b) => b.observedAt.localeCompare(a.observedAt) || b.id.localeCompare(a.id))[0];
}

export function deriveRuntimeActivation(
  runtime: AutomationRuntime,
  allEvidence: ActivationEvidence[],
  options: { wiring?: RuntimeHookWiring; now?: number } = {},
): RuntimeActivation {
  const rows = evidenceForRuntime(allEvidence, runtime);
  const lastObservedAt = latest(rows, () => true)?.observedAt;

  // Availability, MCP calls, context probes, and guidance are not native lifecycle automation.
  if (runtime === 'no-hook') {
    return { status: 'TOOLS ONLY', reasonCode: 'ACTIVATION_NO_HOOK_TOOLS_ONLY', lastObservedAt };
  }
  if (runtime === 'openclaw' || runtime === 'hermes') {
    return { status: 'TOOLS ONLY', reasonCode: 'ACTIVATION_NO_VERIFIED_LIFECYCLE_TOOLS_ONLY', lastObservedAt };
  }

  const anyConfigured = latest(rows, (row) => row.status === 'configured');
  let configured = anyConfigured;
  if (options.wiring) {
    const wasEnabled = !!anyConfigured || options.wiring.managedPresent;
    if (options.wiring.state !== 'current') {
      if (!wasEnabled) return { status: 'TOOLS ONLY', reasonCode: 'ACTIVATION_NOT_ENABLED_TOOLS_ONLY', lastObservedAt };
      return {
        status: 'NEEDS REPAIR',
        reasonCode: 'ACTIVATION_WIRING_BROKEN',
        configuredAt: anyConfigured?.observedAt,
        lastObservedAt,
      };
    }
    if (options.wiring.generationId) {
      const generationId = activationConfigurationId(options.wiring.generationId);
      configured = latest(rows, (row) => row.status === 'configured' && row.configuration?.id === generationId);
      if (!configured) {
        if (anyConfigured) {
          return {
            status: 'NEEDS REPAIR',
            reasonCode: 'ACTIVATION_WIRING_GENERATION_UNCONFIRMED',
            configuredAt: anyConfigured.observedAt,
            lastObservedAt,
          };
        }
        return {
          status: 'READY — WAITING FOR FIRST ACTIVITY',
          reasonCode: 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY',
          lastObservedAt,
        };
      }
    }
  }

  const synthetic = latest(rows, (row) => row.status === 'synthetic');
  const sameConfiguredGeneration = (row: ActivationEvidence): boolean =>
    !configured?.configuration || row.configuration?.id === configured.configuration.id;
  const started = latest(rows, (row) => row.status === 'observed-live-started' && sameConfiguredGeneration(row));
  const completed = latest(rows, (row) => row.status === 'observed-live-completed' && sameConfiguredGeneration(row));
  const failed = latest(rows, (row) => row.status === 'failed' && sameConfiguredGeneration(row));

  if (!configured) {
    if (synthetic) return { status: 'READY — WAITING FOR FIRST ACTIVITY', reasonCode: 'ACTIVATION_SYNTHETIC_ONLY', lastObservedAt };
    if (options.wiring?.state === 'current') {
      return { status: 'READY — WAITING FOR FIRST ACTIVITY', reasonCode: 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY', lastObservedAt };
    }
    return { status: 'TOOLS ONLY', reasonCode: 'ACTIVATION_NOT_ENABLED_TOOLS_ONLY', lastObservedAt };
  }

  const configuredAt = configured.observedAt;
  const completedAfterInstall = completed && completed.observedAt > configuredAt ? completed : undefined;
  const failedAfterInstall = failed && failed.observedAt > configuredAt ? failed : undefined;
  const now = options.now ?? Date.now();
  const failureAt = failedAfterInstall ? Date.parse(failedAfterInstall.observedAt) : Number.NaN;
  const failureIsLatest = !!failedAfterInstall && (!completedAfterInstall || failedAfterInstall.observedAt > completedAfterInstall.observedAt);
  if (failureIsLatest && Number.isFinite(failureAt) && now - failureAt <= RECENT_FAILURE_MS) {
    return { status: 'NEEDS REPAIR', reasonCode: 'ACTIVATION_RECENT_FAILURE', configuredAt, lastObservedAt };
  }
  if (completedAfterInstall) {
    return { status: 'ACTIVE', reasonCode: 'ACTIVATION_LIVE_COMPLETED_AFTER_INSTALL', configuredAt, lastObservedAt };
  }
  if (failureIsLatest) {
    return { status: 'READY — WAITING FOR FIRST ACTIVITY', reasonCode: 'ACTIVATION_STALE_FAILURE', configuredAt, lastObservedAt };
  }
  if (completed && completed.observedAt <= configuredAt) {
    return { status: 'READY — WAITING FOR FIRST ACTIVITY', reasonCode: 'ACTIVATION_COMPLETED_BEFORE_INSTALL', configuredAt, lastObservedAt };
  }
  if (started && started.observedAt > configuredAt) {
    return { status: 'READY — WAITING FOR FIRST ACTIVITY', reasonCode: 'ACTIVATION_STARTED_ONLY', configuredAt, lastObservedAt };
  }
  if (synthetic) {
    return { status: 'READY — WAITING FOR FIRST ACTIVITY', reasonCode: 'ACTIVATION_SYNTHETIC_ONLY', configuredAt, lastObservedAt };
  }
  return { status: 'READY — WAITING FOR FIRST ACTIVITY', reasonCode: 'ACTIVATION_CONFIGURED_AWAITING_LIVE_ACTIVITY', configuredAt, lastObservedAt };
}

export async function automationMatrix(
  workspace: Workspace,
  spec: { command?: string; args?: string[] },
  options: { now?: number; hookOptions?: WorkspaceOptions & { globalHook?: boolean; recall?: boolean } } = {},
): Promise<{ rows: AutomationMatrixRow[]; metrics: ProbeMetrics; path: PathClassification; evidence: ActivationEvidence[] }> {
  const [metrics, evidence, claudeWiring, codexWiring] = await Promise.all([
    probeMetrics(workspace),
    readActivationEvidence(workspace).catch(() => []),
    verifyRuntimeHookWiring(workspace, 'claude-code', options.hookOptions),
    verifyRuntimeHookWiring(workspace, 'codex', options.hookOptions),
  ]);
  const wirings = new Map<string, RuntimeHookWiring>([
    ['claude-code', claudeWiring],
    ['codex', codexWiring],
  ]);
  const pathStatus = classifyAutomationPath(spec);
  const aggregateStatus = pathStatus.status === 'BROKEN' ? 'BROKEN' : 'OK';
  const rows = ROWS.map((row) => {
    const key = runtimeKey(row.runtime);
    const wiring = wirings.get(key);
    const activation = deriveRuntimeActivation(key as AutomationRuntime, evidence, { wiring, now: options.now });
    const probeCalls = key === 'no-hook' ? noHookCalls(metrics) : (metrics.probeCallsByRuntime[key] ?? 0);
    const notes: string[] = [];
    let status: AutomationStatus = 'OK';
    if (aggregateStatus === 'BROKEN') {
      status = aggregateStatus;
      notes.push(...pathStatus.notes);
    }
    if (activation.status === 'NEEDS REPAIR') {
      status = 'BROKEN';
      notes.push(...(wiring?.notes.length ? wiring.notes : ['configured lifecycle wiring needs repair']));
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
      activationStatus: activation.status,
      activationReasonCode: activation.reasonCode,
      configuredAt: activation.configuredAt,
      lastObservedAt: activation.lastObservedAt,
    };
  });
  return { rows, metrics, path: pathStatus, evidence };
}
