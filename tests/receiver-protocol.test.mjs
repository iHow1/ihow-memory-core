// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Receiver-protocol design lock (Green/Yellow/Red lanes, OpenClaw-reviewed 2026-06-18). The protocol
// must LOWER friction when git anchors match (Green: proceed with a small reversible step) WITHOUT
// ever promoting the prior narrative to fact. These tests guard both halves: the lanes exist, and the
// wording never tells the agent to "trust the capsule" — matching anchors only prove the workspace
// hasn't drifted, never that the narrative is true.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleEnvelope, RECEIVER_INSTRUCTION } from '../src/envelope.ts';

const sample = assembleEnvelope({
  cwd: '/tmp/x',
  producerAgent: 'test',
  createdAt: '2026-06-18T00:00:00.000Z',
  anchors: { isRepo: true, repo: 'x', branch: 'main', head: 'abc1234', dirtyCount: 0, dirtyFiles: [] },
  quotedBody: 'Summary: shipped it',
});

test('receiver protocol has a preflight step and Green/Yellow/Red lanes', () => {
  assert.match(RECEIVER_INSTRUCTION, /PREFLIGHT/);
  assert.match(RECEIVER_INSTRUCTION, /GREEN/);
  assert.match(RECEIVER_INSTRUCTION, /YELLOW/);
  assert.match(RECEIVER_INSTRUCTION, /RED/);
  assert.match(RECEIVER_INSTRUCTION, /reversible/i, 'Green lane lets the agent proceed with a reversible step');
});

test('receiver protocol never tells the agent to trust the capsule as fact', () => {
  assert.doesNotMatch(RECEIVER_INSTRUCTION, /verified handoff/i);
  assert.doesNotMatch(RECEIVER_INSTRUCTION, /confirmed facts?/i);
  assert.doesNotMatch(RECEIVER_INSTRUCTION, /safe to proceed because/i);
  assert.match(RECEIVER_INSTRUCTION, /unverified/i, 'the narrative is explicitly unverified');
  assert.match(RECEIVER_INSTRUCTION, /never make the narrative true/i, 'anchors-match must not promote the narrative to fact');
});

test('Green lane lowers friction but the envelope still frames the narrative as unverified', () => {
  assert.match(sample, /UNVERIFIED/);
  assert.match(sample, /still unverified|claim to verify/i);
});
