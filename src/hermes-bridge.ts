#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { openCore } from './core.ts';
import { contextProbe } from './context-probe.ts';
import { containsSecretLikeContent, redactSecretLikeContent } from './governance.ts';
import { CheckpointValidationError, type CheckpointMachineAnchors } from './checkpoint-schema.ts';

import {
  runtimeEventToContextProbe,
  type RuntimeLifecycleEvent,
  type RuntimeLifecycleEventName,
} from './runtime-events.ts';

const KNOWN_EVENTS = new Set<RuntimeLifecycleEventName>([
  'runtime.session_start',
  'runtime.session_reset',
  'runtime.before_prompt',
  'runtime.after_turn',
  'runtime.session_finalize',
  'runtime.session_end',
]);
const MAX_CONTEXT_CHARS = 8_000;
const CHECKPOINT_EVENTS = new Set<RuntimeLifecycleEventName>([
  'runtime.session_finalize',
  'runtime.session_end',
]);
const FILE_ANCHOR_MAX_BYTES = 1024 * 1024;

type HermesBridgeEvent = RuntimeLifecycleEvent & {
  prompt?: unknown;
  checkpointClaims?: unknown;
};

function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_]+$/.test(error.message)
    ? error.message
    : 'hermes_bridge_failed';
}

function commandOutputHash(output: string | Buffer): string {
  return crypto.createHash('sha256').update(output).digest('hex');
}

async function boundedRegularFileAnchor(
  cwd: string,
  relative: string,
): Promise<CheckpointMachineAnchors['files'][number] | undefined> {
  const target = path.join(cwd, relative);
  let handle: fsPromises.FileHandle | undefined;
  try {
    // O_NOFOLLOW rejects a symlink at the final component. One descriptor binds metadata and bytes
    // to the same inode, avoiding a stat/read TOCTOU anchor.
    handle = await fsPromises.open(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > FILE_ANCHOR_MAX_BYTES) return undefined;
    const content = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < content.length) {
      const { bytesRead } = await handle.read(content, offset, content.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ino !== before.ino
      || after.dev !== before.dev
    ) return undefined;
    return {
      path: relative,
      sha256: commandOutputHash(content),
      mtime: after.mtime.toISOString(),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function collectCheckpointAnchors(cwd: string): Promise<CheckpointMachineAnchors> {
  const files: CheckpointMachineAnchors['files'] = [];
  for (const relative of ['package.json', 'README.md']) {
    const anchor = await boundedRegularFileAnchor(cwd, relative);
    if (anchor) files.push(anchor);
  }
  return { files, commands: [] };
}

function checkpointSkipCode(error: unknown): string | undefined {
  const code = error instanceof CheckpointValidationError ? error.code : errorCode(error);
  if (code === 'checkpoint_secret_rejected' || code === 'checkpoint_sanitizer_residual_secret') {
    return 'checkpoint-secret-rejected';
  }
  return undefined;
}


async function maybeFinalizeCheckpoint(
  core: Awaited<ReturnType<typeof openCore>>,
  event: HermesBridgeEvent,
): Promise<{ checkpointId?: string; checkpointSkipped?: string }> {
  if (!CHECKPOINT_EVENTS.has(event.event)) return {};
  if (!event.checkpointClaims || typeof event.checkpointClaims !== 'object' || Array.isArray(event.checkpointClaims)) {
    return { checkpointSkipped: 'claims-unavailable' };
  }
  try {
    const draft = await core.checkpoints.createDraft({
      runtime: 'hermes',
      ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      claims: event.checkpointClaims,
    });
    const result = await core.checkpoints.finalizeDraft(
      draft.draftId,
      {
        trigger: {
          kind: 'session_end',
          signal: 'native',
          sourceEvent: event.event === 'runtime.session_finalize'
            ? 'hermes.on_session_finalize'
            : 'hermes.on_session_end',
          reasonCode: 'hermes_lifecycle_checkpoint',
        },
      },
      () => collectCheckpointAnchors(event.cwd),
    );
    return { checkpointId: result.artifact.id };
  } catch (error) {
    const skip = checkpointSkipCode(error);
    if (skip) return { checkpointSkipped: skip };
    throw error;
  }
}

async function main(): Promise<void> {
  const raw = fs.readFileSync(0, 'utf8').trim();
  if (!raw) throw new Error('runtime_event_input_required');
  let event: HermesBridgeEvent;
  try {
    event = JSON.parse(raw) as HermesBridgeEvent;
  } catch {
    throw new Error('runtime_event_json_invalid');
  }
  if (!KNOWN_EVENTS.has(event.event)) throw new Error('runtime_event_name_invalid');
  if (typeof event.prompt === 'string' && event.prompt.trim()) {
    const redacted = redactSecretLikeContent(event.prompt.trim()).slice(0, 2_000);
    if (containsSecretLikeContent(redacted)) throw new Error('runtime_event_prompt_redaction_failed');
    const { prompt: _discarded, ...metadata } = event;
    event = Object.freeze({ ...metadata, promptDigest: redacted }) as HermesBridgeEvent;
  }
  const request = runtimeEventToContextProbe(event);
  const core = await openCore({ cwd: event.cwd });
  if (!request) {
    process.stdout.write(`${JSON.stringify({ ok: true })}\n`);
    return;
  }
  const output = await contextProbe(core.workspace, request, {
    search: core.search,
  });
  const context = typeof output.injectText === 'string' && output.injectText.trim()
    ? output.injectText.slice(0, MAX_CONTEXT_CHARS)
    : undefined;
  const checkpoint = await maybeFinalizeCheckpoint(core, event);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    ...(context ? { context } : {}),
    ...checkpoint,
  })}\n`);
}

main().catch((error) => {
  process.stdout.write(`${JSON.stringify({ ok: false, error: errorCode(error) })}\n`);
  process.exitCode = 1;
});
