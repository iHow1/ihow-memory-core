// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const plugin = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const pluginSource = path.join(plugin, '__init__.py');
const pluginManifest = path.join(plugin, 'plugin.yaml');

function digest(domain, value) {
  return crypto.createHash('sha256').update(domain).update(value).digest('hex');
}

function rawCanaries(label) {
  return {
    session: `raw-b6-session-${label}-canary`,
    turn: `raw-b6-turn-${label}-canary`,
    user: `raw B6 user ${label} canary`,
    final: `raw B6 final ${label} canary`,
    secret: `raw-b6-secret-${label}-canary`,
    path: `/raw/b6/${label}/path-canary`,
  };
}

function durableTranscriptInput(label) {
  return {
    schemaVersion: 1,
    identityDomain: 'hermes-transcript-v1',
    sessionHash: digest('b6-b3-session\0', label),
    turnId: digest('b6-b3-turn\0', label),
    inputSourceHash: `sha256:${digest('b6-b3-input-source\0', label)}`,
    inputContentSha256: digest('b6-b3-input-content\0', label),
  };
}

function b2Values(raw) {
  const sessionHash = digest('turn-receipt-session-v1\0', raw.session);
  const turnId = digest('turn-receipt-turn-v1\0', raw.turn);
  const inputSource = digest('turn-receipt-source-v1\0', raw.turn);
  return {
    sessionHash,
    turnId,
    inputSource,
    correlationKey: digest(
      'hermes-turn-receipt-correlation-v1\0',
      `${sessionHash}\0${turnId}`,
    ),
  };
}

const PYTHON_DRIVER = String.raw`
import copy, importlib.util, json, os, pathlib, sys

plugin = pathlib.Path(sys.argv[1])
repo = sys.argv[2]
scenario = sys.argv[3]
config = json.loads(sys.argv[4])
raw = config["raw"]
evidence = config.get("evidence")

spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Ctx:
    def __init__(self):
        self.hooks = {}
        self.tools = []
    def register_hook(self, name, callback):
        self.hooks[name] = callback
    def register_tool(self, *args, **kwargs):
        self.tools.append((args, kwargs))

ctx = Ctx()
module.register(ctx)

captured_events = []
def dispatch(event):
    captured_events.append(copy.deepcopy(event))
    return {}
module._dispatch = dispatch

real_sha256 = module._sha256
hash_calls = []
def tracked_sha256(domain, value):
    result = real_sha256(domain, value)
    hash_calls.append({"domain": domain, "result": result})
    return result
module._sha256 = tracked_sha256

real_classify = module._classify_delta_sidecars
classify_calls = []
def tracked_classify(sidecars):
    result = real_classify(sidecars)
    classify_calls.append({"sidecarCount": len(sidecars), "state": result[0]})
    return result
module._classify_delta_sidecars = tracked_classify

def common_kwargs():
    return {
        "session_id": raw["session"],
        "turn_id": raw["turn"],
        "platform": "cli",
        "cwd": repo,
        "secret_canary": raw["secret"],
        "source_path": raw["path"],
    }

def run_pre():
    kwargs = common_kwargs()
    kwargs.update({
        "user_message": raw["user"],
        "conversation_history": [
            {"role": "user", "content": raw["user"], "_db_persisted": True},
        ],
    })
    if evidence is not None:
        kwargs["durable_transcript_input"] = evidence
    return ctx.hooks["pre_llm_call"](**kwargs)

def sidecar_call():
    arguments = json.dumps({
        "schemaVersion": 1,
        "status": "emitted",
        "proposal": {
            "kind": "fact",
            "subject": "B6 routing",
            "key": "terminal proposal",
            "value": "one durable proposal",
        },
    }, ensure_ascii=False, separators=(",", ":"))
    return {
        "id": "ihow-memory-control-sidecar",
        "type": "function",
        "function": {"name": "ihow_memory_delta", "arguments": arguments},
    }

def run_post_api(intermediate=False):
    calls = [sidecar_call()]
    if intermediate:
        calls.append({
            "id": "real-executable-tool",
            "type": "function",
            "function": {"name": "read_file", "arguments": "{\\\"path\\\":\\\"README.md\\\"}"},
        })
    kwargs = common_kwargs()
    kwargs["assistant_message"] = {"content": raw["final"], "tool_calls": calls}
    return ctx.hooks["post_api_request"](**kwargs)

def run_post_llm():
    kwargs = common_kwargs()
    kwargs.update({
        "assistant_response": raw["final"],
        "conversation_history": [
            {"role": "user", "content": raw["user"], "_db_persisted": True},
            {"role": "assistant", "content": raw["final"], "_db_persisted": True},
        ],
    })
    return ctx.hooks["post_llm_call"](**kwargs)

def run_end():
    kwargs = common_kwargs()
    kwargs.update({"completed": True, "interrupted": False})
    return ctx.hooks["on_session_end"](**kwargs)

def pending_rows():
    container = getattr(module, "_pending_receipts", None)
    if not isinstance(container, dict):
        return []
    rows = []
    for value in container.values():
        if isinstance(value, dict):
            rows.append({
                key: copy.deepcopy(item)
                for key, item in value.items()
                if not str(key).startswith("_")
            })
    return rows

def persisted_projection(event):
    projected = {"event": event.get("event") if isinstance(event, dict) else None}
    if isinstance(event, dict) and "turnReceipt" in event:
        projected["turnReceipt"] = copy.deepcopy(event["turnReceipt"])
    if isinstance(event, dict) and "publication" in event:
        projected["publication"] = copy.deepcopy(event["publication"])
    if isinstance(event, dict) and event.get("event") == "runtime.durable_transcript_revision":
        projected["projectId"] = event.get("projectId")
        projected["eventKeys"] = sorted(event)
    diagnostics = []
    if isinstance(event, dict):
        for key, value in event.items():
            lowered = str(key).lower()
            if "diagnostic" in lowered or "anomaly" in lowered:
                diagnostics.append({"field": key, "value": copy.deepcopy(value)})
    projected["diagnostics"] = diagnostics
    return projected

snapshots = {}
if scenario == "fixture":
    ctx.hooks["on_session_start"](**common_kwargs())
elif scenario == "durable-publication":
    ctx.hooks["on_durable_transcript_revision"](
        telemetry_schema_version=1,
        schemaVersion=1,
        sessionHash=evidence["sessionHash"],
        revision=3,
        manifestPath=f"manifests/{evidence['sessionHash']}.json",
        transcriptPath=f"revisions/{evidence['sessionHash']}/3.json",
        contentSha256="a" * 64,
        committedAt="2026-07-18T00:00:00.000000Z",
    )
elif scenario == "pre":
    run_pre()
    snapshots["afterPre"] = pending_rows()
elif scenario == "alias-route":
    run_pre()
    run_post_api(intermediate=False)
    snapshots["afterTerminalApi"] = pending_rows()
    run_post_llm()
    snapshots["afterPostLlm"] = pending_rows()
    run_end()
    snapshots["afterEnd"] = pending_rows()
elif scenario == "ephemeral-open-stage":
    run_pre()
    run_post_api(intermediate=False)
    snapshots["afterStage"] = pending_rows()
elif scenario == "alias-miss":
    run_post_api(intermediate=False)
    run_post_llm()
    run_end()
    snapshots["afterMiss"] = pending_rows()
elif scenario == "single-proposal":
    run_pre()
    run_post_api(intermediate=True)
    snapshots["classifyAfterIntermediate"] = len(classify_calls)
    snapshots["pendingAfterIntermediate"] = pending_rows()
    run_post_api(intermediate=False)
    snapshots["classifyAfterTerminal"] = len(classify_calls)
    snapshots["pendingAfterTerminal"] = pending_rows()
    run_post_llm()
    snapshots["classifyAfterPostLlm"] = len(classify_calls)
    run_end()
    snapshots["classifyAfterEnd"] = len(classify_calls)
elif scenario == "diagnostic-boundary":
    run_pre()
    run_end()
else:
    raise RuntimeError("unknown test scenario")

print(json.dumps({
    "moduleLoaded": True,
    "registeredHooks": sorted(ctx.hooks),
    "captured": [persisted_projection(event) for event in captured_events],
    "hashCalls": hash_calls,
    "classifyCalls": classify_calls,
    "snapshots": snapshots,
}, ensure_ascii=False, sort_keys=True))
`;

async function runPlugin({ label, scenario, evidence = durableTranscriptInput(label) }) {
  const raw = rawCanaries(label);
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ihow-b6-${label}-memory-`));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), `ihow-b6-${label}-state-`));
  const config = { raw, evidence };
  const run = spawnSync('python3', [
    '-B', '-c', PYTHON_DRIVER, plugin, repo, scenario, JSON.stringify(config),
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORY_ROOT: memoryRoot,
      IHOW_MEMORY_STATE_ROOT: stateRoot,
    },
  });
  const output = run.status === 0 ? JSON.parse(run.stdout) : null;
  return { run, output, raw, evidence, memoryRoot, stateRoot };
}

function allActions(output) {
  return output.captured
    .map(item => item.turnReceipt)
    .filter(action => action !== undefined);
}

function allDiagnostics(output) {
  return output.captured.flatMap(item => item.diagnostics.map(entry => entry.value));
}

function identityProjection(receipt) {
  return {
    sessionHash: receipt?.sessionHash,
    turnId: receipt?.turnId,
    inputSourceHash: receipt?.inputSourceHash,
    inputContentSha256: receipt?.inputContentSha256,
  };
}

function withoutHookTurnDiagnostic(value) {
  if (Array.isArray(value)) return value.map(withoutHookTurnDiagnostic);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'hookTurnDiagnostic')
    .map(([key, item]) => [key, withoutHookTurnDiagnostic(item)]));
}

function persistedSafeJson(output, extra = undefined) {
  return JSON.stringify({
    captured: output.captured,
    ...(extra === undefined ? {} : { extra }),
  });
}

function assertNoRawCanaries(serialized, raw, context) {
  for (const [name, canary] of Object.entries(raw)) {
    assert.equal(serialized.includes(canary), false, `${context} leaked raw ${name} canary`);
  }
}

function assertNoB2DurableIdentity(value, raw, context) {
  const serialized = JSON.stringify(withoutHookTurnDiagnostic(value));
  const b2 = b2Values(raw);
  for (const [name, candidate] of Object.entries(b2)) {
    assert.equal(serialized.includes(candidate), false, `${context} persisted B2-derived ${name}`);
    assert.equal(serialized.includes(`sha256:${candidate}`), false, `${context} persisted B2-derived ${name} source form`);
  }
}

async function regularFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push({ path: target, bytes: await fs.readFile(target) });
    }
  }
  await visit(root);
  return files;
}

function noEvidenceViolations(output, raw) {
  const actions = allActions(output);
  const diagnostics = allDiagnostics(output);
  const violations = [];
  const forbidden = actions.filter(action => ['open', 'capture', 'commit'].includes(action?.action));
  if (forbidden.length !== 0) violations.push(`forbidden receipt actions: ${JSON.stringify(forbidden)}`);
  if (actions.some(action => action?.receipt?.schemaVersion === 1)) {
    violations.push('schemaVersion-1 fallback receipt was emitted');
  }
  if (diagnostics.length !== 1) violations.push(`expected one anomaly diagnostic, got ${diagnostics.length}`);
  if (diagnostics.length === 1) {
    const encoded = JSON.stringify(diagnostics[0]);
    if (Buffer.byteLength(encoded, 'utf8') > 1_024) violations.push('diagnostic exceeded 1,024 UTF-8 bytes');
    for (const [name, canary] of Object.entries(raw)) {
      if (encoded.includes(canary)) violations.push(`diagnostic leaked raw ${name} canary`);
    }
  }
  return violations;
}

test('fixture — real Python plugin module loads, registers lifecycle, and reaches capture-only dispatch', async () => {
  const fixture = await runPlugin({ label: 'fixture', scenario: 'fixture' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  assert.equal(fixture.output.moduleLoaded, true);
  assert.equal(fixture.output.registeredHooks.includes('pre_llm_call'), true);
  assert.equal(fixture.output.registeredHooks.includes('post_api_request'), true);
  assert.equal(fixture.output.registeredHooks.includes('on_session_end'), true);
  assert.equal(fixture.output.captured.length, 1);
  assert.equal(fixture.output.captured[0].event, 'runtime.session_start');
});

test('Host contract RED — durable revision hook consumes the real flat seven-field callback payload', async () => {
  const fixture = await runPlugin({ label: 'durable-publication', scenario: 'durable-publication' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  assert.equal(fixture.output.captured.length, 1);
  assert.deepEqual(fixture.output.captured[0], {
    event: 'runtime.durable_transcript_revision',
    projectId: digest('turn-receipt-project-v1\0', repo),
    eventKeys: ['event', 'observedAt', 'projectId', 'publication', 'runtime', 'schemaVersion'],
    publication: {
      schemaVersion: 1,
      sessionHash: fixture.evidence.sessionHash,
      revision: 3,
      manifestPath: `manifests/${fixture.evidence.sessionHash}.json`,
      transcriptPath: `revisions/${fixture.evidence.sessionHash}/3.json`,
      contentSha256: 'a'.repeat(64),
      committedAt: '2026-07-18T00:00:00.000000Z',
    },
    diagnostics: [],
  });
  assert.equal(JSON.stringify(fixture.output.captured[0]).includes(repo), false, 'durable envelope leaked project path');
  assertNoRawCanaries(persistedSafeJson(fixture.output), fixture.raw, 'durable publication callback');
});

test('Plugin manifest RED — durable revision hook is declared in both loader hook lists', async () => {
  const manifest = await fs.readFile(pluginManifest, 'utf8');
  for (const key of ['provides_hooks', 'hooks']) {
    const match = manifest.match(new RegExp(`^${key}:\\n((?:  - [^\\n]+\\n?)+)`, 'm'));
    assert.ok(match, `${key} list is missing`);
    assert.match(match[1], /^  - on_durable_transcript_revision$/m, `${key} omits durable revision hook`);
  }
});

test('mandatory RED 1 — OPEN exact-copy uses valid six-field B3 evidence and never substitutes B2 identity', async () => {
  const fixture = await runPlugin({ label: 'red-1-open', scenario: 'pre' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const actions = allActions(fixture.output);
  assert.equal(actions.length, 1, 'pre_llm_call must emit exactly one receipt action');
  assert.equal(actions[0].action, 'open');
  const receipt = actions[0].receipt;
  const actual = {
    schemaVersion: receipt?.schemaVersion,
    identityDomain: receipt?.identityDomain,
    origin: receipt?.origin,
    revision: receipt?.revision,
    ...identityProjection(receipt),
  };
  assert.deepEqual(actual, {
    schemaVersion: 2,
    identityDomain: 'hermes-transcript-v1',
    origin: 'native-hook',
    revision: 1,
    sessionHash: fixture.evidence.sessionHash,
    turnId: fixture.evidence.turnId,
    inputSourceHash: fixture.evidence.inputSourceHash,
    inputContentSha256: fixture.evidence.inputContentSha256,
  });
  const b2IdentityOutputs = new Set(fixture.output.hashCalls
    .filter(call => /turn-receipt-(?:session|turn|source)-v1/.test(call.domain))
    .flatMap(call => [call.result, `sha256:${call.result}`]));
  for (const value of Object.values(identityProjection(receipt))) {
    assert.equal(b2IdentityOutputs.has(value), false, 'receipt identity must not be a B2 recomputation');
  }
  assertNoRawCanaries(persistedSafeJson(fixture.output, actions), fixture.raw, 'OPEN action');
});

const noEvidenceCases = [
  ['missing evidence', () => null],
  ['wrong hex length', evidence => ({ ...evidence, sessionHash: evidence.sessionHash.slice(1) })],
  ['uppercase hex', evidence => ({ ...evidence, turnId: evidence.turnId.toUpperCase() })],
  ['missing sha256: prefix', evidence => ({ ...evidence, inputSourceHash: evidence.inputSourceHash.slice(7) })],
  ['schemaVersion mismatch', evidence => ({ ...evidence, schemaVersion: 2 })],
];

for (const [name, mutate] of noEvidenceCases) {
  test(`mandatory RED 2 — No-evidence refusal: ${name} emits no receipt action and exactly one bounded anomaly`, async () => {
    const label = `red-2-${name.replaceAll(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
    const valid = durableTranscriptInput(label);
    const evidence = mutate(valid);
    const fixture = await runPlugin({ label, scenario: 'pre', evidence });
    assert.equal(fixture.run.status, 0, fixture.run.stderr);
    assert.deepEqual(noEvidenceViolations(fixture.output, fixture.raw), []);
    assertNoRawCanaries(persistedSafeJson(fixture.output), fixture.raw, `No-evidence ${name}`);
  });
}

test('mandatory RED 3 — Alias routing stages one terminal typed delta on pending B3 identity and defers COMMIT to durable proof', async () => {
  const fixture = await runPlugin({ label: 'red-3-alias-routing', scenario: 'alias-route' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const actions = allActions(fixture.output);
  const opens = actions.filter(action => action?.action === 'open');
  const terminalActions = actions.filter(action => ['capture', 'commit'].includes(action?.action));
  const pending = fixture.output.snapshots.afterTerminalApi;
  const violations = [];
  if (opens.length !== 1) violations.push(`expected one OPEN, got ${opens.length}`);
  if (opens[0]?.receipt?.schemaVersion !== 2) violations.push('OPEN is not schemaVersion 2');
  if (JSON.stringify(identityProjection(opens[0]?.receipt)) !== JSON.stringify({
    sessionHash: fixture.evidence.sessionHash,
    turnId: fixture.evidence.turnId,
    inputSourceHash: fixture.evidence.inputSourceHash,
    inputContentSha256: fixture.evidence.inputContentSha256,
  })) violations.push('OPEN identity is not exact-copied B3 evidence');
  if (fixture.output.classifyCalls.length !== 1) {
    violations.push(`typed delta classified ${fixture.output.classifyCalls.length} times`);
  }
  if (pending.length !== 1) violations.push(`expected one staged pending receipt, got ${pending.length}`);
  if (pending.length === 1 && JSON.stringify(identityProjection(pending[0])) !== JSON.stringify({
    sessionHash: fixture.evidence.sessionHash,
    turnId: fixture.evidence.turnId,
    inputSourceHash: fixture.evidence.inputSourceHash,
    inputContentSha256: fixture.evidence.inputContentSha256,
  })) violations.push('terminal delta is not associated with the pending B3 identity');
  if (terminalActions.length !== 0) violations.push('hook-only lifecycle emitted CAPTURE/COMMIT before durable proof');
  if (!fixture.output.registeredHooks.includes('on_durable_transcript_revision')) {
    violations.push('durable transcript revision hook is not registered');
  }
  assert.deepEqual(violations, []);
  const persistedCandidates = { actions, pending };
  assertNoRawCanaries(JSON.stringify(persistedCandidates), fixture.raw, 'alias-routed staging');
  assertNoB2DurableIdentity(persistedCandidates, fixture.raw, 'alias-routed staging');
});

test('mandatory RED 8 — Alias is ephemeral across two Python processes and appears in no temporary persisted file', async () => {
  const first = await runPlugin({ label: 'red-8-ephemeral', scenario: 'ephemeral-open-stage' });
  assert.equal(first.run.status, 0, first.run.stderr);
  const firstActions = allActions(first.output);
  const firstPending = first.output.snapshots.afterStage;
  const firstPersisted = [
    ...await regularFiles(first.memoryRoot),
    ...await regularFiles(first.stateRoot),
  ];
  const forbiddenFileValues = [
    ...Object.values(first.raw),
    ...Object.values(b2Values(first.raw)),
  ];
  for (const file of firstPersisted) {
    for (const candidate of forbiddenFileValues) {
      assert.equal(file.bytes.includes(Buffer.from(candidate)), false, `alias/raw key persisted in ${file.path}`);
    }
  }

  const second = await runPlugin({
    label: 'red-8-ephemeral',
    scenario: 'alias-miss',
    evidence: null,
  });
  assert.equal(second.run.status, 0, second.run.stderr);
  const secondActions = allActions(second.output);
  const secondPersisted = [
    ...await regularFiles(second.memoryRoot),
    ...await regularFiles(second.stateRoot),
  ];
  assert.equal(secondActions.some(action => ['open', 'capture', 'commit'].includes(action?.action)), false);
  assert.deepEqual(second.output.snapshots.afterMiss, []);
  assert.equal(secondPersisted.length, 0, 'alias miss must not create durable state from raw hook ids');

  const violations = [];
  if (firstActions.filter(action => action?.action === 'open').length !== 1) {
    violations.push('first process did not OPEN exactly once');
  }
  if (firstActions.find(action => action?.action === 'open')?.receipt?.schemaVersion !== 2) {
    violations.push('first process OPEN is not the B3 schemaVersion-2 receipt');
  }
  if (firstPending.length !== 1 || firstPending[0]?.sessionHash !== first.evidence.sessionHash
      || firstPending[0]?.turnId !== first.evidence.turnId) {
    violations.push('first process did not stage under the pending B3 identity');
  }
  assert.deepEqual(violations, []);
  assertNoRawCanaries(persistedSafeJson(first.output, firstPending), first.raw, 'first ephemeral process');
  assertNoRawCanaries(persistedSafeJson(second.output), second.raw, 'fresh alias-miss process');
  assertNoB2DurableIdentity({ actions: firstActions, pending: firstPending }, first.raw, 'ephemeral first process');
});

test('mandatory RED 10 — Single proposal ignores executable intermediate response, classifies terminal once, and never re-derives on session end', async () => {
  const fixture = await runPlugin({ label: 'red-10-single-proposal', scenario: 'single-proposal' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const actions = allActions(fixture.output);
  const terminalActions = actions.filter(action => ['capture', 'commit'].includes(action?.action));
  assert.deepEqual({
    afterIntermediate: fixture.output.snapshots.classifyAfterIntermediate,
    afterTerminal: fixture.output.snapshots.classifyAfterTerminal,
    afterPostLlm: fixture.output.snapshots.classifyAfterPostLlm,
    afterSessionEnd: fixture.output.snapshots.classifyAfterEnd,
  }, {
    afterIntermediate: 0,
    afterTerminal: 1,
    afterPostLlm: 1,
    afterSessionEnd: 1,
  });
  const pending = fixture.output.snapshots.pendingAfterTerminal;
  const open = actions.find(action => action?.action === 'open');
  const violations = [];
  if (open?.receipt?.schemaVersion !== 2) violations.push('OPEN is not schemaVersion 2');
  if (pending.length !== 1 || pending[0]?.sessionHash !== fixture.evidence.sessionHash
      || pending[0]?.turnId !== fixture.evidence.turnId) {
    violations.push('terminal proposal is not staged on exact B3 identity');
  }
  if (terminalActions.length !== 0) violations.push('session end emitted terminal receipt before durable proof');
  if (!fixture.output.registeredHooks.includes('on_durable_transcript_revision')) {
    violations.push('durable transcript revision hook is not registered');
  }
  assert.deepEqual(violations, []);
  assertNoRawCanaries(persistedSafeJson(fixture.output, pending), fixture.raw, 'single proposal lifecycle');
  assertNoB2DurableIdentity({ actions, pending }, fixture.raw, 'single proposal lifecycle');
});

test('mandatory RED 12 — Non-identity diagnostic is bounded B2 hookTurnDiagnostic while receipt identity comes only from durable input', async () => {
  const fixture = await runPlugin({ label: 'red-12-diagnostic', scenario: 'diagnostic-boundary' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const actions = allActions(fixture.output);
  const open = actions.find(action => action?.action === 'open');
  const diagnostics = allDiagnostics(fixture.output);
  const expectedHookTurnDiagnostic = b2Values(fixture.raw).turnId;
  const violations = [];
  if (open?.receipt?.schemaVersion !== 2
      || open?.receipt?.identityDomain !== 'hermes-transcript-v1'
      || open?.receipt?.origin !== 'native-hook') {
    violations.push('captured OPEN is not a native schemaVersion-2 B3 receipt');
  }
  if (JSON.stringify(identityProjection(open?.receipt)) !== JSON.stringify({
    sessionHash: fixture.evidence.sessionHash,
    turnId: fixture.evidence.turnId,
    inputSourceHash: fixture.evidence.inputSourceHash,
    inputContentSha256: fixture.evidence.inputContentSha256,
  })) violations.push('receipt identity fields are not exact-copied durable input');

  for (const diagnostic of diagnostics) {
    if (diagnostic && typeof diagnostic === 'object') {
      if ('sessionHash' in diagnostic || 'turnId' in diagnostic
          || 'inputSourceHash' in diagnostic || 'inputContentSha256' in diagnostic) {
        violations.push('diagnostic reused receipt identity field names');
      }
      if ('hookTurnDiagnostic' in diagnostic) {
        if (!/^[a-f0-9]{64}$/.test(diagnostic.hookTurnDiagnostic)) {
          violations.push('hookTurnDiagnostic is not 64 lowercase hex');
        }
        if (diagnostic.hookTurnDiagnostic !== expectedHookTurnDiagnostic) {
          violations.push('hookTurnDiagnostic is not the bounded B2 hook turn hash');
        }
        if (Object.values(identityProjection(open?.receipt)).includes(diagnostic.hookTurnDiagnostic)) {
          violations.push('hookTurnDiagnostic entered the receipt identity domain');
        }
      }
    }
  }

  const source = await fs.readFile(pluginSource, 'utf8');
  if (!source.includes('durable_transcript_input')) {
    violations.push('pre-hook source has no durable_transcript_input identity source');
  }
  for (const pattern of [
    /["']sessionHash["']\s*:\s*_sha256\(\s*["']turn-receipt-session-v1/,
    /["']turnId["']\s*:\s*_sha256\(\s*["']turn-receipt-turn-v1/,
    /["']inputSourceHash["']\s*:\s*["']sha256:["']\s*\+\s*_sha256\(\s*["']turn-receipt-source-v1/,
  ]) {
    if (pattern.test(source)) violations.push(`source still derives durable identity via ${pattern}`);
  }
  assert.deepEqual(violations, []);
  assertNoRawCanaries(persistedSafeJson(fixture.output), fixture.raw, 'non-identity diagnostic');
  assertNoB2DurableIdentity(actions, fixture.raw, 'non-identity diagnostic receipt actions');
});
