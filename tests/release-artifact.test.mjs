// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { validateEvidence, archiveFiles } from '../scripts/verify-release-artifact.mjs';

function fixture() {
  const bytes = Buffer.from('synthetic artifact');
  const source = { head: 'a'.repeat(40), tree: 'b'.repeat(40), dirty: false };
  return { bytes, source, manifest: { releaseEligible: true,
    package: { name: 'ihow-memory', version: '0.1.1', filename: 'ihow-memory-0.1.1.tgz', bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    source: { gitHead: source.head, gitTree: source.tree, dirtyBeforeEvidence: false } } };
}

test('exact artifact evidence rejects changed bytes and source identities', () => {
  const f = fixture();
  validateEvidence(f.manifest, f.bytes, f.source);
  assert.throws(() => validateEvidence(f.manifest, Buffer.from('changed'), f.source), /hash mismatch/);
  for (const [key, value] of [['head', 'c'.repeat(40)], ['tree', 'd'.repeat(40)], ['dirty', true]]) {
    assert.throws(() => validateEvidence(f.manifest, f.bytes, { ...f.source, [key]: value }));
  }
  assert.throws(() => validateEvidence({ ...f.manifest, releaseEligible: false }, f.bytes, f.source));
  assert.throws(() => validateEvidence({ ...f.manifest, package: { ...f.manifest.package, filename: '../elsewhere.tgz' } }, f.bytes, f.source));
});

test('archive paths reject traversal, duplicates and non-package members', () => {
  assert.deepEqual(archiveFiles('package/\npackage/package.json\npackage/dist/core.js\n'), ['package/package.json', 'package/dist/core.js']);
  for (const names of ['package/../secret', '/package/test', 'outside/file', 'package/a\npackage/a', 'package/a\\b']) {
    assert.throws(() => archiveFiles(names));
  }
});

test('release workflow retains its artifact before tests and verifies the same artifact before publication', () => {
  const workflow = fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8');
  const packed = workflow.indexOf('node scripts/release-evidence.mjs --output release-evidence');
  const tests = workflow.indexOf('- name: Tests');
  const verified = workflow.indexOf('node scripts/verify-release-artifact.mjs release-evidence/release-evidence.json');
  const published = workflow.indexOf('npm publish "$PACKAGE"');
  assert.ok(packed > 0 && packed < tests && tests < verified && verified < published);
  assert.doesNotMatch(workflow.slice(packed), /npm run build|npm run release:evidence/);
});
