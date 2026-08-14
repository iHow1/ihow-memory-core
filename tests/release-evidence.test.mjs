import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('release evidence rejects a dirty working tree by default', () => {
  const result = spawnSync(process.execPath, ['scripts/release-evidence.mjs'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /working tree is dirty/);
});

test('development evidence verifies legal files but is not release eligible', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'ihow-release-evidence-test-'));
  try {
    const result = spawnSync(process.execPath, ['scripts/release-evidence.mjs', '--allow-dirty', '--output', output], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
    });
    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(result.stdout.trim());
    assert.equal(receipt.releaseEvidence, 'DEVELOPMENT_ONLY');
    assert.equal(receipt.releaseEligible, false);
    assert.equal(receipt.dirtyBeforeEvidence, true);
    assert.match(receipt.gitTree, /^[a-f0-9]{40}$/);

    const manifest = JSON.parse(fs.readFileSync(path.join(output, 'release-evidence.json'), 'utf8'));
    assert.equal(manifest.releaseEligible, false);
    assert.equal(manifest.package.license, 'Apache-2.0');
    assert.match(manifest.package.sha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.source.gitArchiveSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.source.gitTree, /^[a-f0-9]{40}$/);
    for (const required of ['LICENSE', 'NOTICE', 'TRADEMARK.md', 'dist/vendor/smol-toml/LICENSE']) {
      assert.match(manifest.legal.files[required].sha256, /^[a-f0-9]{64}$/);
    }

    const checksums = fs.readFileSync(path.join(output, 'checksums.txt'), 'utf8');
    assert.match(checksums, /release-evidence\.json/);
    assert.match(checksums, /ihow-memory-.*\.tgz/);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});
