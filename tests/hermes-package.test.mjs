// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const releaseVersion = '0.1.0-alpha.31';

test('package and lock metadata expose the alpha.31 Hermes bridge contract', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
  const bridge = 'dist/hermes-bridge.js';

  assert.equal(manifest.version, releaseVersion);
  assert.equal(lock.version, releaseVersion);
  assert.equal(lock.packages?.['']?.version, releaseVersion);
  assert.equal(manifest.bin?.['ihow-memory-hermes-bridge'], bridge);
  assert.equal(lock.packages?.['']?.bin?.['ihow-memory-hermes-bridge'], bridge);
  assert.ok(manifest.files?.includes('integrations/hermes/ihow-memory/'));
});

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
  assert.ok(files.has('NOTICE'));
  assert.ok(files.has('TRADEMARK.md'));
});
