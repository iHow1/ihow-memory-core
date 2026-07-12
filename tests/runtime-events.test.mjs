// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mapHermesHookEvent,
  runtimeEventToContextProbe,
} from '../src/runtime-events.ts';

test('Hermes lifecycle hooks map to runtime-neutral event names', () => {
  assert.equal(mapHermesHookEvent('on_session_start'), 'runtime.session_start');
  assert.equal(mapHermesHookEvent('on_session_reset'), 'runtime.session_reset');
  assert.equal(mapHermesHookEvent('pre_llm_call'), 'runtime.before_prompt');
  assert.equal(mapHermesHookEvent('post_llm_call'), 'runtime.after_turn');
  assert.equal(mapHermesHookEvent('on_session_finalize'), 'runtime.session_finalize');
  assert.equal(mapHermesHookEvent('on_session_end'), 'runtime.session_end');
});

test('unknown Hermes hooks fail closed', () => {
  assert.equal(mapHermesHookEvent('pre_compact'), undefined);
  assert.equal(mapHermesHookEvent(''), undefined);
});

test('runtime events produce bounded context_probe requests without transcript payloads', () => {
  const start = runtimeEventToContextProbe({
    schemaVersion: 1,
    event: 'runtime.session_start',
    runtime: 'hermes',
    cwd: '/repo',
    sessionId: 'session-1',
    platform: 'cli',
    observedAt: '2026-07-12T00:00:00.000Z',
  });
  assert.deepEqual(start, {
    cwd: '/repo',
    runtime: 'hermes',
    sessionHint: 'session-1',
    eventHint: 'session_start',
  });

  const prompt = runtimeEventToContextProbe({
    schemaVersion: 1,
    event: 'runtime.before_prompt',
    runtime: 'hermes',
    cwd: '/repo',
    sessionId: 'session-1',
    platform: 'telegram',
    observedAt: '2026-07-12T00:00:01.000Z',
    promptDigest: 'fix activation truth',
  });
  assert.deepEqual(prompt, {
    cwd: '/repo',
    runtime: 'hermes',
    sessionHint: 'session-1',
    promptDigest: 'fix activation truth',
    eventHint: 'prompt',
  });
  assert.equal('assistantResponse' in prompt, false);
  assert.equal('conversationHistory' in prompt, false);
});

test('after-turn is observational and finalize/end map to session_end', () => {
  assert.equal(runtimeEventToContextProbe({
    schemaVersion: 1,
    event: 'runtime.after_turn',
    runtime: 'hermes',
    cwd: '/repo',
    sessionId: 'session-1',
    platform: 'cli',
    observedAt: '2026-07-12T00:00:02.000Z',
  }), undefined);

  for (const event of ['runtime.session_finalize', 'runtime.session_end']) {
    assert.deepEqual(runtimeEventToContextProbe({
      schemaVersion: 1,
      event,
      runtime: 'hermes',
      cwd: '/repo',
      sessionId: 'session-1',
      platform: 'cli',
      observedAt: '2026-07-12T00:00:03.000Z',
    }), {
      cwd: '/repo',
      runtime: 'hermes',
      sessionHint: 'session-1',
      eventHint: 'session_end',
    });
  }
});

test('invalid or oversized runtime event data is rejected before persistence', () => {
  assert.throws(() => runtimeEventToContextProbe({
    schemaVersion: 1,
    event: 'runtime.before_prompt',
    runtime: 'hermes',
    cwd: '',
    sessionId: 'session-1',
    platform: 'cli',
    observedAt: '2026-07-12T00:00:00.000Z',
  }), /runtime_event_cwd_required/);

  assert.throws(() => runtimeEventToContextProbe({
    schemaVersion: 1,
    event: 'runtime.before_prompt',
    runtime: 'hermes',
    cwd: '/repo',
    sessionId: 'session-1',
    platform: 'cli',
    observedAt: 'not-a-date',
  }), /runtime_event_observed_at_invalid/);

  assert.throws(() => runtimeEventToContextProbe({
    schemaVersion: 1,
    event: 'runtime.before_prompt',
    runtime: 'hermes',
    cwd: '/repo',
    sessionId: 'session-1',
    platform: 'cli',
    observedAt: '2026-07-12T00:00:00.000Z',
    promptDigest: 'x'.repeat(2001),
  }), /runtime_event_prompt_digest_too_large/);
});
