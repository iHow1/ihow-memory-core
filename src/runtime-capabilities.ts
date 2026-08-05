// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory

export type PreCompactCapability = 'native' | 'estimated' | 'none';

export type RuntimeLifecycleCapabilities = Readonly<{
  sessionStart: boolean;
  sessionReset: boolean;
  beforePrompt: boolean;
  afterTurn: boolean;
  sessionFinalize: boolean;
  sessionEnd: boolean;
  preCompact: PreCompactCapability;
}>;

export type RuntimeCapabilityManifest = Readonly<{
  runtime: string;
  mcpTools: boolean;
  readableTranscript: boolean;
  lifecycle: RuntimeLifecycleCapabilities;
}>;

export type RuntimeAutomationCeiling =
  | 'lifecycle-capable'
  | 'tools-only'
  | 'explicit-only';

const NO_LIFECYCLE: RuntimeLifecycleCapabilities = Object.freeze({
  sessionStart: false,
  sessionReset: false,
  beforePrompt: false,
  afterTurn: false,
  sessionFinalize: false,
  sessionEnd: false,
  preCompact: 'none',
});

const HERMES_LIFECYCLE: RuntimeLifecycleCapabilities = Object.freeze({
  sessionStart: true,
  sessionReset: true,
  beforePrompt: true,
  afterTurn: true,
  sessionFinalize: true,
  sessionEnd: true,
  preCompact: 'none',
});

const KNOWN: Readonly<Record<string, RuntimeCapabilityManifest>> = Object.freeze({
  hermes: Object.freeze({
    runtime: 'hermes',
    mcpTools: true,
    readableTranscript: true,
    lifecycle: HERMES_LIFECYCLE,
  }),
  workbuddy: Object.freeze({
    runtime: 'workbuddy',
    mcpTools: true,
    readableTranscript: true,
    lifecycle: NO_LIFECYCLE,
  }),
});

function normalizeRuntime(runtime: string): string {
  return runtime.trim().toLowerCase() || 'unknown';
}

export function runtimeCapabilityManifest(runtime: string): RuntimeCapabilityManifest {
  const normalized = normalizeRuntime(runtime);
  const known = KNOWN[normalized];
  if (known) return known;
  return Object.freeze({
    runtime: normalized,
    mcpTools: false,
    readableTranscript: false,
    lifecycle: NO_LIFECYCLE,
  });
}

export function runtimeAutomationCeiling(manifest: RuntimeCapabilityManifest): RuntimeAutomationCeiling {
  const lifecycle = manifest.lifecycle;
  if (
    lifecycle.sessionStart
    || lifecycle.sessionReset
    || lifecycle.beforePrompt
    || lifecycle.afterTurn
    || lifecycle.sessionFinalize
    || lifecycle.sessionEnd
    || lifecycle.preCompact !== 'none'
  ) {
    return 'lifecycle-capable';
  }
  if (manifest.mcpTools || manifest.readableTranscript) return 'tools-only';
  return 'explicit-only';
}
