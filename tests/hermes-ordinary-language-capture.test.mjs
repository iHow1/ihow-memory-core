// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const plugin = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');

const DELTA_TOOL_PARAMETERS = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'integer', const: 1 },
        status: { type: 'string', const: 'emitted' },
        proposal: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['preference', 'fact', 'event', 'procedure'] },
            subject: { type: 'string', minLength: 1, maxLength: 120 },
            key: { type: 'string', minLength: 1, maxLength: 120 },
            value: { type: 'string', minLength: 1, maxLength: 1_200 },
          },
          required: ['kind', 'subject', 'key', 'value'],
        },
      },
      required: ['schemaVersion', 'status', 'proposal'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        schemaVersion: { type: 'integer', const: 1 },
        status: { type: 'string', const: 'explicit_none' },
      },
      required: ['schemaVersion', 'status'],
    },
  ],
};

const semanticItem = {
  kind: 'preference',
  subject: 'User',
  key: 'editor',
  value: 'VS Code',
};

async function registerContract() {
  const script = String.raw`
import importlib.util, json, pathlib, sys
plugin = pathlib.Path(sys.argv[1])
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
        descriptor = args[0] if len(args) == 1 and isinstance(args[0], dict) else {}
        name = descriptor.get("name") or kwargs.get("name")
        if name is None and args and isinstance(args[0], str):
            name = args[0]
        callback = descriptor.get("callback") or descriptor.get("handler")
        callback = callback or kwargs.get("callback") or kwargs.get("handler") or kwargs.get("function")
        if callback is None:
            callback = next((value for value in args[1:] if callable(value)), None)
        description = descriptor.get("description") or kwargs.get("description")
        if description is None:
            description = next((value for value in args[1:] if isinstance(value, str)), None)
        schema = (descriptor.get("parameters") or descriptor.get("schema") or descriptor.get("input_schema")
                  or kwargs.get("parameters") or kwargs.get("schema") or kwargs.get("input_schema"))
        if schema is None:
            schema = next((value for value in args[1:] if isinstance(value, dict)), None)
        if isinstance(schema, str):
            schema = json.loads(schema)
        parameters = schema.get("parameters") if isinstance(schema, dict) and isinstance(schema.get("parameters"), dict) else schema
        if description is None and isinstance(schema, dict):
            description = schema.get("description")
        self.tools.append({
            "name": name,
            "callback": callable(callback),
            "description": description,
            "parameters": parameters,
        })

ctx = Ctx()
module.register(ctx)
print(json.dumps({"hooks": sorted(ctx.hooks), "tools": ctx.tools}, sort_keys=True))
`;
  const run = spawnSync('python3', ['-B', '-c', script, plugin], {
    cwd: repo,
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

function lifecycleScript() {
  return String.raw`
import hashlib, importlib.util, json, os, pathlib, sys, time
from types import SimpleNamespace

plugin = pathlib.Path(sys.argv[1])
repo = sys.argv[2]
mode = sys.argv[3]
arguments = sys.argv[4]
break_transport_at_end = sys.argv[5] == "break"
session_id = "raw-ordinary-session-canary-4817"
turn_id = "raw-ordinary-turn-canary-5928"
user_text = "raw ordinary user body canary 6039"
final_text = "raw final answer body canary 7140"
semantic_value = "VS Code"
secret_canary = "raw-secret-sidecar-canary-8251"
durable_input = {
    "schemaVersion": 1,
    "identityDomain": "hermes-transcript-v1",
    "sessionHash": hashlib.sha256(b"ordinary-b3-session").hexdigest(),
    "turnId": hashlib.sha256(b"ordinary-b3-turn").hexdigest(),
    "inputSourceHash": "sha256:" + hashlib.sha256(b"ordinary-b3-source").hexdigest(),
    "inputContentSha256": hashlib.sha256(b"ordinary-b3-content").hexdigest(),
}

spec = importlib.util.spec_from_file_location("ihow_memory_plugin", plugin / "__init__.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class Ctx:
    def __init__(self):
        self.hooks = {}
        self.tools = []
        self.tool_invocations = 0
    def register_hook(self, name, callback):
        self.hooks[name] = callback
    def register_tool(self, *args, **kwargs):
        self.tools.append((args, kwargs))

class NonListToolCallContainer:
    def __init__(self, calls):
        self.calls = tuple(calls)
    def __iter__(self):
        return iter(self.calls)
    def __len__(self):
        return len(self.calls)

ctx = Ctx()
module.register(ctx)
dispatches = []
real_dispatch = module._dispatch

def summarize_dispatch(event):
    action = event.get("turnReceipt") if isinstance(event, dict) else None
    action = action if isinstance(action, dict) else {}
    receipt = action.get("receipt") if isinstance(action.get("receipt"), dict) else {}
    diagnostic = event.get("diagnostic") if isinstance(event, dict) else None
    diagnostic = diagnostic if isinstance(diagnostic, dict) else {}
    return {
        "event": event.get("event") if isinstance(event, dict) else None,
        "action": action.get("action"),
        "deltaState": receipt.get("deltaState"),
        "hasDeltaLinkage": "deltaLinkage" in receipt,
        "diagnosticCode": diagnostic.get("code"),
        "diagnosticReason": diagnostic.get("reason"),
    }

def tracked_dispatch(event):
    dispatches.append(summarize_dispatch(event))
    return real_dispatch(event)

module._dispatch = tracked_dispatch

def pending_state_summary():
    containers = {}
    for name, value in vars(module).items():
        lowered = name.lower()
        tracked_name = "pending" in lowered or ("sidecar" in lowered and any(
            marker in lowered for marker in ("state", "cache", "buffer", "store")
        ))
        if tracked_name and isinstance(value, (dict, list, tuple)):
            containers[name] = value
    serialized = json.dumps(containers, ensure_ascii=False, sort_keys=True, default=str)
    raw_values = (session_id, turn_id, user_text, final_text, secret_canary)
    return {
        "containerCount": len(containers),
        "entryCount": sum(len(value) for value in containers.values()),
        "pendingReceiptCount": len(getattr(module, "_pending_receipts", {})),
        "aliasCount": len(getattr(module, "_receipt_aliases", {})),
        "pendingDeltaStates": sorted(
            value.get("deltaState") for value in getattr(module, "_pending_receipts", {}).values()
            if isinstance(value, dict) and isinstance(value.get("deltaState"), str)
        ),
        "pendingProposalCount": sum(
            1 for value in getattr(module, "_pending_receipts", {}).values()
            if isinstance(value, dict) and isinstance(value.get("deltaProposal"), dict)
        ),
        "hasTypedSemantic": semantic_value in serialized,
        "hasRawCanary": any(value in serialized for value in raw_values),
        "bounded3600x256": (
            getattr(module, "_PENDING_RECEIPT_TTL_SECONDS", None) == 3600
            and getattr(module, "_MAX_PENDING_RECEIPTS", None) == 256
        ),
    }

def receipt_summary():
    target = pathlib.Path(os.environ["MEMORY_ROOT"]) / "_mcp" / "turn-receipts" / "v1.json"
    if not target.exists():
        return None
    document = json.loads(target.read_text(encoding="utf-8"))
    receipts = document.get("receipts", [])
    if len(receipts) != 1:
        return {"count": len(receipts)}
    receipt = receipts[0]
    return {
        "count": 1,
        "state": receipt.get("state"),
        "deltaState": receipt.get("deltaState"),
        "hasDeltaLinkage": "deltaLinkage" in receipt,
    }

module._on_pre_llm_call(
    session_id=session_id,
    turn_id=turn_id,
    user_message=user_text,
    conversation_history=[{"role": "user", "content": user_text, "_db_persisted": True}],
    durable_transcript_input=durable_input,
    platform="cli",
    cwd=repo,
)

post_api = ctx.hooks.get("post_api_request")
assert post_api is not None, "post_api_request hook not registered"
if mode == "none":
    tool_calls = []
elif mode == "duplicate":
    tool_calls = [
        SimpleNamespace(
            id=f"ihow-memory-control-sidecar-{index}",
            type="function",
            function=SimpleNamespace(name="ihow_memory_delta", arguments=arguments),
        )
        for index in range(2)
    ]
elif mode == "mixed-intermediate":
    tool_calls = [
        SimpleNamespace(
            id="ihow-memory-control-sidecar",
            type="function",
            function=SimpleNamespace(name="ihow_memory_delta", arguments=arguments),
        ),
        SimpleNamespace(
            id="real-executable-call",
            type="function",
            function=SimpleNamespace(name="read_file", arguments='{"path":"README.md"}'),
        ),
    ]
elif mode == "opaque-intermediate":
    tool_calls = [
        SimpleNamespace(
            id="ihow-memory-control-sidecar",
            type="function",
            function=SimpleNamespace(name="ihow_memory_delta", arguments=arguments),
        ),
        SimpleNamespace(
            id="opaque-executable-call",
            type="function",
            function=SimpleNamespace(arguments='{}'),
        ),
    ]
elif mode == "non-list-intermediate":
    tool_calls = NonListToolCallContainer([
        SimpleNamespace(
            id="host-owned-generic-call",
            type="function",
            function=SimpleNamespace(name="read_file", arguments='{"path":"README.md"}'),
        ),
    ])
else:
    tool_calls = [SimpleNamespace(
        id="ihow-memory-control-sidecar",
        type="function",
        function=SimpleNamespace(name="ihow_memory_delta", arguments=arguments),
    )]
assistant_message = SimpleNamespace(
    content="" if mode == "empty-content" else final_text,
    tool_calls=tool_calls,
)
original_tool_calls = assistant_message.tool_calls
original_tool_call_items = list(original_tool_calls) if mode == "non-list-intermediate" else None
dispatch_count_before_api = len(dispatches)
post_api(
    session_id=session_id,
    turn_id=turn_id,
    assistant_message=assistant_message,
    platform="cli",
    cwd=repo,
)
dispatch_count_after_api = len(dispatches)
state_after_api = pending_state_summary()
non_list_container_preserved = (
    mode != "non-list-intermediate" or assistant_message.tool_calls is original_tool_calls
)
non_list_values_preserved = (
    mode != "non-list-intermediate" or list(assistant_message.tool_calls) == original_tool_call_items
)
remaining_after_api = [
    getattr(getattr(call, "function", None), "name", None)
    for call in (assistant_message.tool_calls or [])
]
if mode in ("mixed-intermediate", "opaque-intermediate", "non-list-intermediate", "empty-content"):
    assistant_message = SimpleNamespace(content=final_text, tool_calls=[])
    post_api(
        session_id=session_id,
        turn_id=turn_id,
        assistant_message=assistant_message,
        platform="cli",
        cwd=repo,
    )
if mode == "ttl-expired":
    with module._pending_receipts_lock:
        for pending in module._pending_receipts.values():
            pending["_touched"] = time.monotonic() - module._PENDING_RECEIPT_TTL_SECONDS - 1

module._on_post_llm_call(
    session_id=session_id,
    turn_id=turn_id,
    assistant_response=final_text,
    conversation_history=[
        {"role": "user", "content": user_text, "_db_persisted": True},
        {"role": "assistant", "content": final_text, "_db_persisted": True},
    ],
    platform="cli",
    cwd=repo,
)
state_after_post = pending_state_summary()
receipt_after_post = receipt_summary()
terminal_before_end = sum(
    1 for item in dispatches
    if item["action"] == "capture" or (item["action"] == "commit" and item["deltaState"] is not None)
)

if break_transport_at_end:
    os.environ["IHOW_MEMORY_HERMES_BRIDGE"] = str(pathlib.Path(os.environ["IHOW_MEMORY_STATE_ROOT"]) / "missing-bridge.ts")
module._on_session_end(
    session_id=session_id,
    turn_id=turn_id,
    completed=True,
    interrupted=False,
    platform="cli",
    cwd=repo,
)

print(json.dumps({
    "contentUnchanged": assistant_message.content == final_text,
    "toolCallsStripped": isinstance(assistant_message.tool_calls, list) and len(assistant_message.tool_calls) == 0,
    "remainingAfterApi": remaining_after_api,
    "nonListContainerPreserved": non_list_container_preserved,
    "nonListValuesPreserved": non_list_values_preserved,
    "postApiDispatchCount": dispatch_count_after_api - dispatch_count_before_api,
    "toolInvocations": ctx.tool_invocations,
    "stateAfterApi": state_after_api,
    "stateAfterPost": state_after_post,
    "stateAfterEnd": pending_state_summary(),
    "receiptAfterPost": receipt_after_post,
    "receiptAfterEnd": receipt_summary(),
    "terminalBeforeEnd": terminal_before_end,
    "dispatches": dispatches,
}, sort_keys=True))
`;
}

async function runLifecycle({ mode, arguments: toolArguments = '', breakTransportAtEnd = false }) {
  const memoryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-ordinary-memory-'));
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-hermes-ordinary-state-'));
  const eventLog = path.join(stateRoot, 'events.ndjson');
  const run = spawnSync('python3', [
    '-B', '-c', lifecycleScript(), plugin, repo, mode, toolArguments,
    breakTransportAtEnd ? 'break' : 'normal',
  ], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      ...process.env,
      MEMORY_ROOT: memoryRoot,
      IHOW_MEMORY_STATE_ROOT: stateRoot,
      IHOW_MEMORY_HERMES_BRIDGE: bridge,
      IHOW_MEMORY_HERMES_NODE: process.execPath,
      IHOW_MEMORY_HERMES_EVENT_LOG: eventLog,
    },
  });
  return {
    run,
    memoryRoot,
    stateRoot,
    eventLog,
    sessionId: 'raw-ordinary-session-canary-4817',
    turnId: 'raw-ordinary-turn-canary-5928',
    userText: 'raw ordinary user body canary 6039',
    finalText: 'raw final answer body canary 7140',
    secretCanary: 'raw-secret-sidecar-canary-8251',
  };
}

async function readRegularFiles(root) {
  const files = [];
  async function visit(directory) {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(entryPath);
      else if (entry.isFile()) files.push({
        path: entryPath,
        relative: path.relative(root, entryPath),
        content: await fs.readFile(entryPath),
      });
    }
  }
  await visit(root);
  return files;
}

async function readReceipts(memoryRoot) {
  const raw = await fs.readFile(path.join(memoryRoot, '_mcp', 'turn-receipts', 'v1.json'), 'utf8');
  return JSON.parse(raw).receipts;
}

function visitJson(value, callback) {
  if (Array.isArray(value)) {
    for (const item of value) visitJson(item, callback);
    return;
  }
  if (!value || typeof value !== 'object') return;
  callback(value);
  for (const nested of Object.values(value)) visitJson(nested, callback);
}

async function semanticCandidateCount(memoryRoot) {
  const files = (await readRegularFiles(memoryRoot)).filter(file => (
    /candidate/i.test(file.relative)
    && !file.relative.includes(`${path.sep}_events${path.sep}`)
  ));
  let count = 0;
  for (const file of files) {
    const raw = file.content.toString('utf8').trim();
    if (!raw) continue;
    if (
      /^type:\s*["']?memory_candidate["']?\s*$/m.test(raw)
      && /^proposal_id:\s*["']?mp1_[a-f0-9]{64}["']?\s*$/m.test(raw)
      && raw.includes(`subject=${semanticItem.subject}`)
      && raw.includes(`key=${semanticItem.key}`)
      && raw.includes(`value=${semanticItem.value}`)
    ) {
      count += 1;
      continue;
    }
    const documents = [];
    try {
      documents.push(JSON.parse(raw));
    } catch {
      for (const line of raw.split('\n')) {
        try { documents.push(JSON.parse(line)); } catch { /* non-JSON candidate artifacts do not match */ }
      }
    }
    for (const document of documents) visitJson(document, value => {
      if (
        value.kind === semanticItem.kind
        && value.subject === semanticItem.subject
        && value.key === semanticItem.key
        && value.value === semanticItem.value
      ) count += 1;
    });
  }
  return count;
}

function terminalActions(output) {
  return output.dispatches.filter(item => (
    item.action === 'capture' || (item.action === 'commit' && item.deltaState !== null)
  ));
}

async function assertNoRawCanaries(fixture, output) {
  const persisted = [
    ...await readRegularFiles(fixture.memoryRoot),
    ...await readRegularFiles(fixture.stateRoot),
  ];
  for (const canary of [
    fixture.sessionId,
    fixture.turnId,
    fixture.userText,
    fixture.finalText,
    fixture.secretCanary,
  ]) {
    assert.equal(JSON.stringify(output).includes(canary), false, `raw canary exposed by fixture: ${canary}`);
    const encoded = Buffer.from(canary);
    for (const file of persisted) {
      assert.equal(file.content.includes(encoded), false, `raw canary persisted in ${file.path}: ${canary}`);
    }
  }
}

function assertDurableProofPending(output) {
  assert.equal(output.terminalBeforeEnd, 0, 'post_llm_call must not commit or capture the receipt');
  assert.equal(terminalActions(output).length, 0, 'session_end must not commit or capture before durable proof');
  const endDiagnostics = output.dispatches.filter(item => (
    item.event === 'runtime.session_end'
    && item.diagnosticCode === 'durable_transcript_revision_pending'
  ));
  assert.equal(endDiagnostics.length, 1, 'session_end must emit one bounded pending diagnostic');
  assert.equal(output.stateAfterEnd.aliasCount, 0, 'session_end must clear only the raw hook alias');
  assert.equal(output.stateAfterEnd.pendingReceiptCount, 1, 'schema-v2 OPEN must remain pending durable proof');
}

test('manifest and registration expose the ordinary-language terminal sidecar contract', async () => {
  const manifest = await fs.readFile(path.join(plugin, 'plugin.yaml'), 'utf8');
  assert.match(manifest, /^\s*-\s*post_api_request\s*$/m);
  assert.match(manifest, /\bihow_memory_delta\b/);

  const contract = await registerContract();
  assert.equal(contract.hooks.includes('post_api_request'), true);
  const tools = contract.tools.filter(tool => tool.name === 'ihow_memory_delta');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].callback, true);
  assert.deepEqual(tools[0].parameters, DELTA_TOOL_PARAMETERS);
  assert.match(tools[0].description, /same final response|同一(?:次)?最终回复/i);
  assert.match(tools[0].description, /terminal sidecar|终端\s*sidecar/i);
  assert.match(tools[0].description, /not a user command|不是用户命令/i);
  assert.match(tools[0].description, /must not trigger (?:a )?second (?:round|api|llm)|不得触发第二轮/i);
});

test('typed emitted sidecar is stripped in-place, staged once, and awaits durable proof', async () => {
  const fixture = await runLifecycle({
    mode: 'emitted',
    arguments: JSON.stringify({ schemaVersion: 1, status: 'emitted', proposal: semanticItem }),
  });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.equal(output.contentUnchanged, true);
  assert.equal(output.toolCallsStripped, true);
  assert.equal(output.postApiDispatchCount, 0, 'sidecar extraction must not make a second bridge/API round');
  assert.equal(output.toolInvocations, 0, 'the stripped control call must never execute as a tool');
  assert.equal(output.stateAfterApi.hasTypedSemantic, true);
  assert.equal(output.stateAfterApi.hasRawCanary, false);
  assert.equal(output.stateAfterApi.bounded3600x256, true);
  assert.equal(output.stateAfterPost.hasRawCanary, false);
  assert.equal(output.receiptAfterPost.state, 'OPEN');
  assertDurableProofPending(output);
  assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['emitted']);
  assert.equal(output.stateAfterEnd.pendingProposalCount, 1);

  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
  await assertNoRawCanaries(fixture, output);
});

test('ordinary turn without a sidecar stages not_emitted and awaits durable proof', async () => {
  const fixture = await runLifecycle({ mode: 'none' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.equal(output.contentUnchanged, true);
  assert.equal(output.toolCallsStripped, true);
  assert.equal(output.postApiDispatchCount, 0);
  assert.equal(output.stateAfterApi.hasTypedSemantic, false);
  assert.equal(output.receiptAfterPost.state, 'OPEN');
  assertDurableProofPending(output);
  assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['not_emitted']);
  assert.equal(output.stateAfterEnd.pendingProposalCount, 0);

  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal(receipts[0].deltaState, 'not_emitted');
  assert.equal('deltaLinkage' in receipts[0], false);
  assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
  await assertNoRawCanaries(fixture, output);
});

test('typed explicit_none is staged without an early commit or candidate', async () => {
  const fixture = await runLifecycle({
    mode: 'explicit_none',
    arguments: JSON.stringify({ schemaVersion: 1, status: 'explicit_none' }),
  });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.equal(output.contentUnchanged, true);
  assert.equal(output.toolCallsStripped, true);
  assert.equal(output.postApiDispatchCount, 0);
  assert.equal(output.stateAfterApi.hasRawCanary, false);
  assert.equal(output.receiptAfterPost.state, 'OPEN');
  assertDurableProofPending(output);
  assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['explicit_none']);
  assert.equal(output.stateAfterEnd.pendingProposalCount, 0);

  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal('deltaLinkage' in receipts[0], false);
  assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
  await assertNoRawCanaries(fixture, output);
});

for (const [name, toolArguments] of [
  ['malformed', '{"schemaVersion":1,"status":"emitted",'],
  ['unknown-field', JSON.stringify({
    schemaVersion: 1,
    status: 'emitted',
    proposal: semanticItem,
    response: 'forbidden raw field',
  })],
  ['duplicate', JSON.stringify({ schemaVersion: 1, status: 'emitted', proposal: semanticItem })],
  ['oversized', JSON.stringify({
    schemaVersion: 1,
    status: 'emitted',
    proposal: { ...semanticItem, value: 'x'.repeat(20_001) },
  })],
  ['secret-bearing', JSON.stringify({
    schemaVersion: 1,
    status: 'emitted',
    proposal: { ...semanticItem, value: 'password: raw-secret-sidecar-canary-8251' },
  })],
]) {
  test(`${name} sidecar stages extraction_failed without an early commit or candidate`, async () => {
    const fixture = await runLifecycle({ mode: name, arguments: toolArguments });
    assert.equal(fixture.run.status, 0, fixture.run.stderr);
    const output = JSON.parse(fixture.run.stdout);
    assert.equal(output.contentUnchanged, true);
    assert.equal(output.toolCallsStripped, true);
    assert.equal(output.postApiDispatchCount, 0);
    assert.equal(output.stateAfterApi.hasTypedSemantic, false);
    assert.equal(output.stateAfterApi.hasRawCanary, false);
    assert.equal(output.receiptAfterPost.state, 'OPEN');
    assertDurableProofPending(output);
    assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['extraction_failed']);
    assert.equal(output.stateAfterEnd.pendingProposalCount, 0);

    const receipts = await readReceipts(fixture.memoryRoot);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].state, 'OPEN');
    assert.equal('deltaLinkage' in receipts[0], false);
    assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
    await assertNoRawCanaries(fixture, output);
  });
}

test('intermediate mixed sidecar is stripped, ignored, and final absence remains not_emitted', async () => {
  const fixture = await runLifecycle({
    mode: 'mixed-intermediate',
    arguments: JSON.stringify({ schemaVersion: 1, status: 'emitted', proposal: semanticItem }),
  });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.deepEqual(output.remainingAfterApi, ['read_file'], 'only the executable tool call remains after strip-first');
  assert.equal(output.stateAfterApi.hasTypedSemantic, false, 'intermediate sidecar is never staged');
  assertDurableProofPending(output);
  assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['not_emitted']);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal('deltaLinkage' in receipts[0], false);
  assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
  await assertNoRawCanaries(fixture, output);
});

test('sidecar without visible content is stripped but never staged as emitted', async () => {
  const fixture = await runLifecycle({
    mode: 'empty-content',
    arguments: JSON.stringify({ schemaVersion: 1, status: 'emitted', proposal: semanticItem }),
  });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.equal(output.toolCallsStripped, true);
  assert.equal(output.stateAfterApi.hasTypedSemantic, false, 'empty visible content cannot be terminal capture evidence');
  assertDurableProofPending(output);
  assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['not_emitted']);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal('deltaLinkage' in receipts[0], false);
  assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
  await assertNoRawCanaries(fixture, output);
});

test('an uninspectable generic tool call is preserved and prevents terminal sidecar staging', async () => {
  const fixture = await runLifecycle({
    mode: 'opaque-intermediate',
    arguments: JSON.stringify({ schemaVersion: 1, status: 'emitted', proposal: semanticItem }),
  });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.deepEqual(output.remainingAfterApi, [null], 'unknown generic calls must not be dropped by the iHow hook');
  assert.equal(output.stateAfterApi.hasTypedSemantic, false);
  assertDurableProofPending(output);
  assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['not_emitted']);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
  await assertNoRawCanaries(fixture, output);
});

test('a non-list tool-call container remains host-owned and is never cleared by the iHow observer', async () => {
  const fixture = await runLifecycle({ mode: 'non-list-intermediate' });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.equal(output.nonListContainerPreserved, true, 'observer must preserve the host container identity');
  assert.equal(output.nonListValuesPreserved, true, 'observer must preserve every host-owned call');
  assert.deepEqual(output.remainingAfterApi, ['read_file']);
  assert.equal(output.stateAfterApi.hasTypedSemantic, false);
  assertDurableProofPending(output);
  assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['not_emitted']);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal('deltaLinkage' in receipts[0], false);
  assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
  await assertNoRawCanaries(fixture, output);
});

test('an expired pending receipt stays OPEN with an honest diagnostic and no false candidate', async () => {
  const fixture = await runLifecycle({
    mode: 'ttl-expired',
    arguments: JSON.stringify({ schemaVersion: 1, status: 'emitted', proposal: semanticItem }),
  });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assertDurableProofPending(output);
  assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['emitted']);
  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].state, 'OPEN');
  assert.equal(receipts[0].deltaState, 'not_emitted');
  assert.equal('deltaLinkage' in receipts[0], false);
  assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
  await assertNoRawCanaries(fixture, output);
});

test('session_end transport failure is fail-open, clears the alias, and never records false emitted', async () => {
  const fixture = await runLifecycle({
    mode: 'emitted',
    arguments: JSON.stringify({ schemaVersion: 1, status: 'emitted', proposal: semanticItem }),
    breakTransportAtEnd: true,
  });
  assert.equal(fixture.run.status, 0, fixture.run.stderr);
  const output = JSON.parse(fixture.run.stdout);
  assert.equal(output.contentUnchanged, true);
  assert.equal(output.toolCallsStripped, true);
  assert.equal(output.receiptAfterPost.state, 'OPEN');
  assertDurableProofPending(output);
  assert.deepEqual(output.stateAfterEnd.pendingDeltaStates, ['emitted']);

  const receipts = await readReceipts(fixture.memoryRoot);
  assert.equal(receipts.some(receipt => (
    receipt.state === 'COMMITTED' && receipt.deltaState === 'emitted'
  )), false);
  assert.equal(await semanticCandidateCount(fixture.memoryRoot), 0);
  await assertNoRawCanaries(fixture, output);
});
