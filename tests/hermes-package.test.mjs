// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');

test('npm package includes the Hermes plugin and its Node bridge', () => {
  const raw = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: repo,
    encoding: 'utf8',
  });
  const report = JSON.parse(raw)[0];
  const files = new Set(report.files.map((entry) => entry.path.replace(/\\/g, '/')));
  assert.ok(files.has('dist/hermes-bridge.js'));
  assert.ok(files.has('integrations/hermes/ihow-memory/plugin.yaml'));
  assert.ok(files.has('integrations/hermes/ihow-memory/__init__.py'));
});
