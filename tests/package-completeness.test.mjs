// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Release safety net. alpha.5/alpha.6 shipped a `files` whitelist that listed dist modules individually
// and missed dist/{transcript,handoff,anchors,envelope,handoff-metrics}.js — so a fresh `npm i` crashed
// with ERR_MODULE_NOT_FOUND the moment cli.js imported them. The unit suite passed (it runs the full local
// dist), and `npm pack --dry-run` looked fine, so nothing caught it until a real tarball install. This
// test reproduces the gap deterministically: pack the tarball and assert every relative import inside a
// packed module resolves to another packed file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RELEASE_VERSION = '0.1.0-alpha.27.1';

function readRoot(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function releaseSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = changelog.match(new RegExp(`## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[)`));
  assert.ok(match, `CHANGELOG has a ${version} section`);
  return match[1];
}

test('alpha.27.1 release candidate metadata and alpha.27 docs stay truthful and aligned', () => {
  const manifest = JSON.parse(readRoot('package.json'));
  const lock = JSON.parse(readRoot('package-lock.json'));
  assert.equal(manifest.version, RELEASE_VERSION);
  assert.equal(lock.version, RELEASE_VERSION);
  assert.equal(lock.packages?.['']?.version, RELEASE_VERSION);

  const alpha27 = releaseSection(readRoot('CHANGELOG.md'), '0.1.0-alpha.27');
  for (const heading of ['### Added', '### Changed', '### Notes']) {
    assert.match(alpha27, new RegExp(`^${heading.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}$`, 'm'));
  }
  for (const surface of [
    /Checkpoint Core/i,
    /native `?PreCompact`?/i,
    /crash-floor/i,
    /checkpoint-first/i,
    /protection state/i,
    /same-HEAD[^\n]*`?statusHash`? drift/i,
    /missing `?statusHash`?[^\n]*fail(?:s|ed)? closed/i,
    /textconv/i,
    /fsmonitor/i,
  ]) {
    assert.match(alpha27, surface, `alpha.27 documents ${surface}`);
  }
  assert.match(alpha27, /does not claim production certification/i);
  assert.match(alpha27, /Hermes native lifecycle/i);
  assert.match(alpha27, /Hermes Plugin/i);
  assert.match(alpha27, /ihow-memory-hermes-bridge/i);
  assert.match(alpha27, /HOST VERIFIED\/READY/i);
  assert.match(alpha27, /not independently certif(?:ied|iable) as `?ACTIVE`?/i);
  assert.doesNotMatch(alpha27, /remain deferred/i);
  assert.doesNotMatch(alpha27, /Checkpoint-to-`continue` integration[^\n]*deferred/i);
  assert.doesNotMatch(alpha27, /checkpoint crash floor[^\n]*deferred/i);

  const readmes = [
    ['README.md', readRoot('README.md'), /Hermes native lifecycle/i, /has not been published/i],
    ['README.zh-CN.md', readRoot('README.zh-CN.md'), /Hermes 原生生命周期/i, /尚未发布/i],
  ];
  for (const [name, readme, lifecycle, unpublished] of readmes) {
    assert.match(readme, /0\.1\.0-alpha\.27\.1/, `${name} states the local candidate version`);
    assert.match(readme, /Alpha\.27\.1/i, `${name} identifies the alpha.27.1 surface`);
    assert.match(readme, /PreCompact/i, `${name} documents native PreCompact`);
    assert.match(readme, /checkpoint-first/i, `${name} documents checkpoint-first continue`);
    assert.match(readme, /crash-floor/i, `${name} documents the crash floor`);
    assert.match(readme, /statusHash/, `${name} documents statusHash safety`);
    assert.match(readme, /local release-ready only/i, `${name} states the local-only boundary`);
    assert.match(readme, lifecycle, `${name} documents the Hermes native lifecycle`);
    assert.match(readme, /Hermes Plugin/i, `${name} documents the packaged Hermes Plugin`);
    assert.match(readme, /ihow-memory-hermes-bridge/i, `${name} documents the packaged Hermes bridge`);
    assert.match(readme, /HOST VERIFIED\/READY/i, `${name} uses the bounded Hermes host-verification status`);
    assert.match(readme, /(?:not independently certif(?:ied|iable) as|不能独立认证为) `?ACTIVE`?/i, `${name} does not claim Hermes ACTIVE`);
    assert.match(readme, unpublished, `${name} does not claim this checkout was published`);
    assert.doesNotMatch(readme, /not yet consumed by `memory\.continue`/i, `${name} removes stale continue deferral`);
    assert.doesNotMatch(readme, /does not yet feed `memory\.continue`/i, `${name} removes stale continue deferral`);
    assert.doesNotMatch(readme, /尚未接入 `memory\.continue`/, `${name} removes stale continue deferral`);
    assert.doesNotMatch(readme, /尚无 checkpoint crash-floor/, `${name} removes stale crash-floor deferral`);
  }
});

test('every relative import in a packed module is itself in the tarball (fresh install resolves)', () => {
  // --ignore-scripts: do NOT run prepack (which rebuilds dist) — that would race the other test files
  // reading dist concurrently. We pack the already-built dist and check the `files` whitelist vs imports.
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: ROOT, encoding: 'utf8' });
  const report = JSON.parse(out);
  const packed = new Set((report[0].files || []).map((f) => f.path.replace(/\\/g, '/')));
  const jsFiles = [...packed].filter((p) => p.startsWith('dist/') && p.endsWith('.js'));
  assert.ok(jsFiles.length > 5, `tarball should contain the dist modules (got ${jsFiles.length})`);
  for (const required of [
    'dist/anchors.js',
    'dist/checkpoint-claim-worker.js',
    'dist/checkpoint-file-worker.js',
    'dist/checkpoint-schema.js',
    'dist/checkpoints.js',
    'dist/floor.js',
    'dist/handoff.js',
    'dist/mcp/server.js',
    'dist/native-precompact.js',
    'dist/store/checkpoints.js',
  ]) {
    assert.ok(packed.has(required), `tarball must include ${required}`);
  }

  const missing = [];
  for (const rel of jsFiles) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/\bfrom\s+['"](\.[^'"]+)['"]/g)) {
      const spec = m[1];
      if (!spec.endsWith('.js')) continue; // bare/dir specifiers aren't used in built output
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (!packed.has(resolved)) missing.push(`${rel}  →  ${spec}  (resolved: ${resolved})`);
    }
  }
  assert.deepEqual(missing, [], `tarball is missing modules that packed code imports:\n  ${missing.join('\n  ')}`);
});

test('tracked-only clean tree rebuild packs a spawnable checkpoint worker', () => {
  const tracked = execFileSync('git', ['ls-files', '-z', '--cached'], { cwd: ROOT })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  assert.ok(tracked.includes('src/checkpoint-claim-worker.ts'), 'checkpoint claim worker source must be tracked in the delivery index');
  assert.ok(tracked.includes('src/checkpoint-file-worker.ts'), 'checkpoint file worker source must be tracked in the delivery index');

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ihow-package-clean-tree-'));
  const cleanTree = path.join(temporaryRoot, 'repo');
  const consumer = path.join(temporaryRoot, 'consumer');
  fs.mkdirSync(cleanTree, { recursive: true });
  fs.mkdirSync(consumer, { recursive: true });
  try {
    for (const relative of tracked) {
      const source = path.join(ROOT, relative);
      const destination = path.join(cleanTree, relative);
      const stat = fs.lstatSync(source);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (stat.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), destination);
      else if (stat.isFile()) fs.copyFileSync(source, destination);
    }

    const packReport = JSON.parse(execFileSync('npm', ['pack', '--json'], {
      cwd: cleanTree,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const tarball = path.join(cleanTree, packReport[0].filename);
    fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
      cwd: consumer,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const smoke = String.raw`
      import fs from 'node:fs/promises';
      import os from 'node:os';
      import path from 'node:path';
      import { openCore } from 'ihow-memory/dist/core.js';
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-packed-worker-smoke-'));
      try {
        const project = path.join(root, 'project');
        await fs.mkdir(project);
        const core = await openCore({ root: path.join(root, 'store'), space: 'packed-worker', cwd: project });
        const draft = await core.checkpoints.createDraft({ runtime: 'package-test', claims: { completed: ['spawn packaged worker'] } });
        const result = await core.checkpoints.finalizeDraft(
          draft.draftId,
          { trigger: { kind: 'explicit', signal: 'native', sourceEvent: 'package-test', reasonCode: 'package_test' } },
          async () => ({ files: [], commands: [] }),
        );
        if (!result.artifact?.id?.startsWith('cp_')) throw new Error('packaged checkpoint worker did not finalize');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    `;
    execFileSync(process.execPath, ['--input-type=module', '-e', smoke], {
      cwd: consumer,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
