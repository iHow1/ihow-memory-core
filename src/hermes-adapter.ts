// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory

export type HermesMcpBinding = Readonly<{
  name: string;
  command: string;
  args: readonly string[];
  env?: Readonly<Record<string, string>>;
  tools?: readonly string[];
}>;

export type HermesBindingIssue =
  | 'LEGACY_ALIAS'
  | 'INCOMPLETE_TOOL_INVENTORY'
  | 'MISSING_ROOT_BINDING'
  | 'DUPLICATE_BINDINGS';

export type HermesBindingStatus =
  | 'canonical-full'
  | 'legacy-thin-wrapper'
  | 'conflicting-bindings'
  | 'needs-repair'
  | 'absent';

export type HermesBindingDiagnosis = Readonly<{
  status: HermesBindingStatus;
  canonical?: HermesMcpBinding;
  legacy?: HermesMcpBinding;
  issues: readonly HermesBindingIssue[];
}>;

const REQUIRED_FULL_TOOLS = Object.freeze([
  'memory.continue',
  'memory.search',
  'memory.read',
  'memory.journal',
  'memory.write_candidate',
  'memory.context_probe',
  'memory.forget',
  'memory.remember',
]);

const LEGACY_THIN_TOOLS = Object.freeze([
  'init_workspace',
  'refresh',
  'status',
  'read_memory',
  'write_memory',
  'append_daily',
]);

function hasAllTools(binding: HermesMcpBinding, required: readonly string[]): boolean {
  const available = new Set(binding.tools ?? []);
  return required.every((tool) => available.has(tool));
}

function hasCanonicalRoots(binding: HermesMcpBinding): boolean {
  const env = binding.env ?? {};
  return Boolean(env.MEMORY_ROOT && env.IHOW_MEMORY_STATE_ROOT);
}

function isLegacyThinWrapper(binding: HermesMcpBinding): boolean {
  const executable = `${binding.command} ${binding.args.join(' ')}`.toLowerCase();
  return hasAllTools(binding, LEGACY_THIN_TOOLS)
    || executable.includes('ihowmemory_mcp.py');
}

export function classifyHermesMcpBindings(bindings: readonly HermesMcpBinding[]): HermesBindingDiagnosis {
  const canonical = bindings.find((binding) => binding.name === 'ihow-memory');
  const legacy = bindings.find((binding) => binding.name === 'ihowmemory');
  if (!canonical && !legacy) {
    return Object.freeze({ status: 'absent', issues: Object.freeze([]) });
  }

  if (canonical && legacy) {
    return Object.freeze({
      status: 'conflicting-bindings',
      canonical,
      legacy,
      issues: Object.freeze<HermesBindingIssue[]>(['DUPLICATE_BINDINGS']),
    });
  }

  if (legacy) {
    const issues: HermesBindingIssue[] = ['LEGACY_ALIAS'];
    if (!hasAllTools(legacy, REQUIRED_FULL_TOOLS)) issues.push('INCOMPLETE_TOOL_INVENTORY');
    return Object.freeze({
      status: isLegacyThinWrapper(legacy) ? 'legacy-thin-wrapper' : 'needs-repair',
      legacy,
      issues: Object.freeze(issues),
    });
  }

  const issues: HermesBindingIssue[] = [];
  if (!hasAllTools(canonical!, REQUIRED_FULL_TOOLS)) issues.push('INCOMPLETE_TOOL_INVENTORY');
  if (!hasCanonicalRoots(canonical!)) issues.push('MISSING_ROOT_BINDING');
  return Object.freeze({
    status: issues.length === 0 ? 'canonical-full' : 'needs-repair',
    canonical,
    issues: Object.freeze(issues),
  });
}
