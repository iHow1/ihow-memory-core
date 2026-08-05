// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..');
const pluginSource = path.join(repo, 'integrations', 'hermes', 'ihow-memory');
const bridge = path.join(repo, 'src', 'hermes-bridge.ts');
const hermesRepo = process.env.IHOW_MEMORY_HERMES_CHECKOUT
  || path.join(os.homedir(), '.hermes', 'hermes-agent');
const hermesPython = process.env.IHOW_MEMORY_HERMES_PYTHON
  || path.join(hermesRepo, 'venv', 'bin', 'python');
const hostAvailable = fsSync.existsSync(path.join(hermesRepo, 'run_agent.py'))
  && fsSync.existsSync(path.join(hermesRepo, 'agent', 'turn_context.py'))
  && fsSync.existsSync(path.join(hermesRepo, 'agent', 'transcript_revision.py'))
  && fsSync.existsSync(hermesPython);

const userCanary = 'b6-shared-contract-user-canary';
const assistantCanary = 'b6-shared-contract-assistant-canary';

const hostScript = String.raw`
from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent.turn_context import build_turn_context
import agent.transcript_revision as transcript_revision
from hermes_state import SessionDB
from run_agent import AIAgent

root = Path(sys.argv[1])
user_text = sys.argv[2]
assistant_text = sys.argv[3]
os.environ["HERMES_HOME"] = str(root)
db = SessionDB(db_path=root / "state.db")
try:
    with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch.object(
        AIAgent, "_create_openai_client", return_value=object()
    ):
        agent = AIAgent(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            model="test/model",
            quiet_mode=True,
            session_db=db,
            session_id="b6-shared-contract-session",
            skip_context_files=True,
            skip_memory=True,
        )
    agent._cached_system_prompt = "SYSTEM"
    agent._skip_mcp_refresh = True
    agent.compression_enabled = False
    received = []

    def hook(name, **kwargs):
        if name == "pre_llm_call":
            value = kwargs.get("durable_transcript_input")
            received.append(dict(value) if isinstance(value, dict) else value)
        return []

    with patch("hermes_cli.plugins.invoke_hook", side_effect=hook), patch.object(
        transcript_revision, "get_hermes_home", return_value=root
    ):
        context = build_turn_context(
            agent=agent,
            user_message=user_text,
            system_message=None,
            conversation_history=None,
            task_id="b6-shared-contract-task",
            stream_callback=None,
            persist_user_message=None,
            restore_or_build_system_prompt=lambda *_a, **_k: None,
            install_safe_stdio=lambda: None,
            sanitize_surrogates=lambda value: value,
            summarize_user_message_for_log=lambda value: value,
            set_session_context=lambda _sid: None,
            set_current_write_origin=lambda _origin: None,
            ra=lambda: SimpleNamespace(_set_interrupt=lambda *_a, **_k: None),
        )
        assert len(received) == 1 and isinstance(received[0], dict), received
        hook_input = received[0]
        context.messages.append({
            "role": "assistant",
            "content": assistant_text,
            "finish_reason": "stop",
        })
        agent._persist_session(context.messages, [])

    expected_hook_keys = {
        "schemaVersion",
        "identityDomain",
        "sessionHash",
        "turnId",
        "inputSourceHash",
        "inputContentSha256",
    }
    assert set(hook_input) == expected_hook_keys
    assert hook_input["schemaVersion"] == 1
    assert hook_input["identityDomain"] == "hermes-transcript-v1"

    export_root = root / "exports" / "transcripts" / "v1"
    manifest_path = export_root / "manifests" / f"{hook_input['sessionHash']}.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    revision_path = export_root / manifest["current"]["path"]
    revision = json.loads(revision_path.read_text(encoding="utf-8"))
    assert revision["sessionHash"] == hook_input["sessionHash"]
    matches = [turn for turn in revision["turns"] if turn["turnId"] == hook_input["turnId"]]
    assert len(matches) == 1, matches
    turn = matches[0]
    expected = {
        "sessionHash": revision["sessionHash"],
        "turnId": turn["turnId"],
        "inputSourceHash": turn["inputSourceHash"],
        "inputContentSha256": turn["inputContentSha256"],
    }
    actual = {key: hook_input[key] for key in expected}
    assert actual == expected, {"actual": actual, "expected": expected}
    assert manifest["currentRevision"] >= 1
    assert revision["revision"] == manifest["currentRevision"]
    print(json.dumps({
        "status": "PASS",
        "manifestRevision": manifest["currentRevision"],
        "hookKeys": sorted(hook_input),
        "exactFields": sorted(expected),
        "revisionTurnCount": len(revision["turns"]),
    }, sort_keys=True))
finally:
    db.close()
`;

const realHostChainScript = String.raw`
from __future__ import annotations

import json
import os
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from agent.turn_context import build_turn_context
from hermes_cli import plugins as plugin_system
from hermes_state import SessionDB
from run_agent import AIAgent

home = Path(os.environ["HERMES_HOME"])
memory_root = Path(os.environ["MEMORY_ROOT"])
db = SessionDB(db_path=home / "state.db")
try:
    plugin_system.discover_plugins(force=True)
    manager = plugin_system.get_plugin_manager()
    loaded = manager._plugins.get("ihow-memory")
    assert loaded is not None and loaded.enabled, manager.list_plugins()
    assert manager.has_hook("pre_llm_call")
    assert manager.has_hook("on_durable_transcript_revision")

    with patch.dict(os.environ, {"OPENROUTER_API_KEY": "test-key"}), patch.object(
        AIAgent, "_create_openai_client", return_value=object()
    ):
        agent = AIAgent(
            api_key="test-key",
            base_url="https://openrouter.ai/api/v1",
            model="test/model",
            quiet_mode=True,
            session_db=db,
            session_id="b6-real-host-chain-session",
            skip_context_files=True,
            skip_memory=True,
        )
    agent._cached_system_prompt = "SYSTEM"
    agent._skip_mcp_refresh = True
    agent.compression_enabled = False
    context = build_turn_context(
        agent=agent,
        user_message=os.environ["B6_USER_CANARY"],
        system_message=None,
        conversation_history=None,
        task_id="b6-real-host-chain-task",
        stream_callback=None,
        persist_user_message=None,
        restore_or_build_system_prompt=lambda *_a, **_k: None,
        install_safe_stdio=lambda: None,
        sanitize_surrogates=lambda value: value,
        summarize_user_message_for_log=lambda value: value,
        set_session_context=lambda _sid: None,
        set_current_write_origin=lambda _origin: None,
        ra=lambda: SimpleNamespace(_set_interrupt=lambda *_a, **_k: None),
    )

    store_path = memory_root / "_mcp" / "turn-receipts" / "v1.json"
    opened_store = json.loads(store_path.read_text(encoding="utf-8"))
    assert len(opened_store["receipts"]) == 1, opened_store
    opened = opened_store["receipts"][0]
    assert opened["schemaVersion"] == 2
    assert opened["state"] == "OPEN"
    assert opened["origin"] == "native-hook"
    assert "committedAt" not in opened

    context.messages.append({
        "role": "assistant",
        "content": os.environ["B6_ASSISTANT_CANARY"],
        "finish_reason": "stop",
    })
    agent._persist_session(context.messages, [])

    committed_store = json.loads(store_path.read_text(encoding="utf-8"))
    assert len(committed_store["receipts"]) == 1, committed_store
    committed = committed_store["receipts"][0]
    assert committed["schemaVersion"] == 2
    assert committed["state"] == "COMMITTED"
    assert committed["origin"] == "native-hook"
    assert committed["deltaState"] == "not_emitted"

    manifest_path = home / "exports" / "transcripts" / "v1" / "manifests" / f"{committed['sessionHash']}.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    revision_path = home / "exports" / "transcripts" / "v1" / manifest["current"]["path"]
    revision = json.loads(revision_path.read_text(encoding="utf-8"))
    matching = [turn for turn in revision["turns"] if turn["turnId"] == committed["turnId"]]
    assert len(matching) == 1, matching
    turn = matching[0]
    for key in (
        "inputSourceHash", "inputContentSha256", "finalSourceHash", "finalContentSha256", "deltaState"
    ):
        assert committed[key] == turn[key], {"key": key}
    assert committed["durableRevision"] <= manifest["currentRevision"]
    assert committed["transcriptPath"] == f"revisions/{committed['sessionHash']}/{committed['durableRevision']}.json"
    print(json.dumps({
        "status": "PASS",
        "hooks": sorted(name for name in manager._hooks if name in ("pre_llm_call", "on_durable_transcript_revision")),
        "openState": opened["state"],
        "finalState": committed["state"],
        "origin": committed["origin"],
        "receiptCount": len(committed_store["receipts"]),
        "currentRevision": manifest["currentRevision"],
        "durableRevision": committed["durableRevision"],
    }, sort_keys=True))
finally:
    db.close()
`;

async function regularFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) files.push(target);
    }
  }
  await visit(root);
  return files;
}

test('actual pre-hook durable input is byte-identical to the actual current revision turn', {
  skip: hostAvailable
    ? false
    : 'Hermes checkout unavailable; set IHOW_MEMORY_HERMES_CHECKOUT/IHOW_MEMORY_HERMES_PYTHON',
}, async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-host-contract-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const run = spawnSync(
    hermesPython,
    ['-B', '-c', hostScript, home, userCanary, assistantCanary],
    {
      cwd: hermesRepo,
      encoding: 'utf8',
      env: {
        ...process.env,
        PYTHONPATH: hermesRepo,
        HERMES_HOME: home,
        OPENROUTER_API_KEY: 'test-key',
      },
      timeout: 120_000,
    },
  );

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.includes(userCanary), false);
  assert.equal(run.stdout.includes(assistantCanary), false);
  const output = JSON.parse(run.stdout.trim());
  assert.equal(output.status, 'PASS');
  assert.deepEqual(output.exactFields, [
    'inputContentSha256',
    'inputSourceHash',
    'sessionHash',
    'turnId',
  ]);
  assert.deepEqual(output.hookKeys, [
    'identityDomain',
    'inputContentSha256',
    'inputSourceHash',
    'schemaVersion',
    'sessionHash',
    'turnId',
  ]);
  assert.equal(output.revisionTurnCount, 1);
  assert.ok(output.manifestRevision >= 1);
});

test('real Host persistence publishes through PluginManager, Adapter, Bridge, and Core to one schema-v2 COMMITTED receipt', {
  skip: hostAvailable
    ? false
    : 'Hermes checkout unavailable; set IHOW_MEMORY_HERMES_CHECKOUT/IHOW_MEMORY_HERMES_PYTHON',
}, async (t) => {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-real-host-home-')));
  const memoryRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-real-host-memory-')));
  const stateRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-b6-real-host-state-')));
  t.after(async () => {
    await Promise.all([
      fs.rm(home, { recursive: true, force: true }),
      fs.rm(memoryRoot, { recursive: true, force: true }),
      fs.rm(stateRoot, { recursive: true, force: true }),
    ]);
  });
  const pluginTarget = path.join(home, 'plugins', 'ihow-memory');
  await fs.mkdir(path.dirname(pluginTarget), { recursive: true });
  await fs.cp(pluginSource, pluginTarget, { recursive: true });
  await fs.writeFile(path.join(home, 'config.yaml'), 'plugins:\n  enabled:\n    - ihow-memory\n', 'utf8');

  const env = {
    ...process.env,
    PYTHONPATH: hermesRepo,
    HERMES_HOME: home,
    MEMORY_ROOT: memoryRoot,
    IHOW_MEMORY_STATE_ROOT: stateRoot,
    IHOW_MEMORY_HERMES_BRIDGE: bridge,
    IHOW_MEMORY_HERMES_NODE: process.execPath,
    OPENROUTER_API_KEY: 'test-key',
    B6_USER_CANARY: userCanary,
    B6_ASSISTANT_CANARY: assistantCanary,
    PYTHONDONTWRITEBYTECODE: '1',
  };
  for (const key of ['HERMES_SAFE_MODE', 'IHOW_MEMORY_HERMES_TEST_MODE', 'IHOW_MEMORY_HERMES_EVENT_LOG']) {
    delete env[key];
  }
  const run = spawnSync(hermesPython, ['-B', '-c', realHostChainScript], {
    cwd: repo,
    encoding: 'utf8',
    env,
    timeout: 120_000,
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(run.stdout.includes(userCanary), false);
  assert.equal(run.stdout.includes(assistantCanary), false);
  const output = JSON.parse(run.stdout.trim());
  assert.deepEqual(output, {
    currentRevision: 2,
    durableRevision: 2,
    finalState: 'COMMITTED',
    hooks: ['on_durable_transcript_revision', 'pre_llm_call'],
    openState: 'OPEN',
    origin: 'native-hook',
    receiptCount: 1,
    status: 'PASS',
  });

  const projectId = crypto.createHash('sha256')
    .update('turn-receipt-project-v1\0')
    .update(await fs.realpath(repo))
    .digest('hex');
  const store = JSON.parse(await fs.readFile(path.join(memoryRoot, '_mcp', 'turn-receipts', 'v1.json'), 'utf8'));
  assert.equal(store.receipts[0].projectId, projectId);
  for (const file of [...await regularFiles(memoryRoot), ...await regularFiles(stateRoot)]) {
    const bytes = await fs.readFile(file);
    assert.equal(bytes.includes(Buffer.from(userCanary)), false, `raw user canary persisted in ${file}`);
    assert.equal(bytes.includes(Buffer.from(assistantCanary)), false, `raw assistant canary persisted in ${file}`);
  }
});
