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
const RELEASE_VERSION = '0.1.0-alpha.31.2';

function readRoot(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

function releaseSection(changelog, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = changelog.match(new RegExp(`## \\[${escaped}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[)`));
  assert.ok(match, `CHANGELOG has a ${version} section`);
  return match[1];
}

test('alpha.31.2 prerelease metadata and docs stay truthful and aligned', () => {
  const manifest = JSON.parse(readRoot('package.json'));
  const lock = JSON.parse(readRoot('package-lock.json'));
  assert.equal(manifest.version, RELEASE_VERSION);
  assert.equal(lock.version, RELEASE_VERSION);
  assert.equal(lock.packages?.['']?.version, RELEASE_VERSION);
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'the frozen runtime must not depend on external node_modules');
  assert.deepEqual(lock.packages?.['']?.dependencies ?? {}, {}, 'lockfile preserves the zero-runtime-dependency contract');

  const changelog = readRoot('CHANGELOG.md');
  const alpha312 = releaseSection(changelog, RELEASE_VERSION);
  assert.match(alpha312, /Upgrade-safe native hooks/i);
  assert.match(alpha312, /without rewriting already-valid host hook files/i);
  assert.match(alpha312, /Stable native-hook bootstrap/i);
  assert.match(alpha312, /byte-stable launcher/i);
  assert.match(alpha312, /Two-generation activation/i);
  assert.match(alpha312, /MCP probe/i);
  assert.match(alpha312, /exact previous self-verifying generation/i);
  assert.match(alpha312, /upgrade --runtime <name>/i);
  assert.match(alpha312, /OpenCode/i);
  assert.match(alpha312, /rescue command/i);
  assert.match(alpha312, /npm `?next`?[^\n]*(?:source of truth|availability)/i);
  assert.match(alpha312, /(?:publication|published)[^\n]*(?:does not|doesn['’]t)[^\n]*(?:live activation|production certification|frozen runtime)/i);
  assert.match(alpha312, /report-only/i);

  const alpha311 = releaseSection(changelog, '0.1.0-alpha.31.1');
  assert.match(alpha311, /WorkBuddy/i);
  assert.match(alpha311, /\.workbuddy\/\.mcp\.json/);
  assert.match(alpha311, /Codex/i);
  assert.match(alpha311, /per-tool/i);
  assert.match(alpha311, /read-only/i);
  assert.match(alpha311, /rollback/i);
  assert.match(alpha311, /self-contained/i);
  assert.match(alpha311, /BSD-3-Clause/i);
  assert.match(alpha311, /npm `?next`?[^\n]*(?:source of truth|availability)/i);
  assert.match(alpha311, /(?:publication|published)[^\n]*(?:does not|doesn['’]t)[^\n]*(?:runtime activation|production certification)/i);
  assert.match(alpha311, /TOOLS ONLY/i);
  assert.doesNotMatch(alpha311, /all[^\n]*ACTIVE/i);

  const alpha31 = releaseSection(changelog, '0.1.0-alpha.31');
  for (const surface of [
    /Alpha\.30/i,
    /turn receipt/i,
    /ordinary-language/i,
    /semantic activation/i,
    /bge-m3/i,
    /Hermes/i,
    /rollback/i,
    /organize[^\n]*tick/i,
    /proposal review state/i,
    /Grounded Media/i,
    /Activity Ledger/i,
  ]) assert.match(alpha31, surface, `alpha.31 documents ${surface}`);
  assert.match(alpha31, /local release-ready/i);
  assert.match(alpha31, /npm `?next`?[^\n]*(?:source of truth|availability)/i);
  assert.match(alpha31, /(?:publication|published)[^\n]*(?:does not|doesn['’]t)[^\n]*(?:runtime activation|production certification)/i);
  assert.match(alpha31, /report-only/i);
  assert.match(alpha31, /does not automatically rewrite authoritative memory/i);
  assert.match(alpha31, /EQUAL_UNTRUSTED/i);
  assert.match(alpha31, /COMMITTED[^\n]*(?:does not|doesn['’]t)[^\n]*(?:success|successful)/i);
  assert.match(alpha31, /(?:no|not)[^\n]*(?:APPLIED|authoritative write)/i);

  const readmes = [
    ['README.md', readRoot('README.md'), /Alpha\.31\.2 prerelease/i, /npm `?@?next`?[^\n]*(?:source of truth|availability)/i],
    ['README.zh-CN.md', readRoot('README.zh-CN.md'), /Alpha\.31\.2 预发布版/i, /npm `?@?next`?[^\n]*(?:真相源|可用)/i],
  ];
  for (const [name, readme, versionLabel, registryTruth] of readmes) {
    assert.match(readme, /0\.1\.0-alpha\.31\.2/, `${name} states the prerelease version`);
    assert.match(readme, versionLabel, `${name} identifies the alpha.31.2 surface`);
    assert.match(readme, registryTruth, `${name} identifies npm next as availability truth`);
    assert.match(readme, /\.workbuddy\/\.mcp\.json/, `${name} states WorkBuddy's effective user-scope path`);
    assert.doesNotMatch(readme, /\.workbuddy\/mcp\.json/, `${name} does not advertise WorkBuddy's obsolete user-scope path`);
    assert.match(readme, /report-only/i, `${name} preserves report-only consolidation truth`);
    assert.match(readme, /EQUAL_UNTRUSTED/i, `${name} preserves grounded-media trust boundaries`);
    assert.match(readme, /COMMITTED/i, `${name} preserves activity-ledger verdict boundaries`);
  }

  const workbuddyGuide = readRoot('examples/connect-workbuddy.md');
  assert.match(workbuddyGuide, /\.workbuddy\/\.mcp\.json/, 'WorkBuddy guide states the effective user-scope path');
  assert.doesNotMatch(workbuddyGuide, /\.workbuddy\/mcp\.json/, 'WorkBuddy guide does not advertise the obsolete user-scope path');

  const alpha27 = releaseSection(changelog, '0.1.0-alpha.27');
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
    'dist/cli-runtime.js',
    'dist/floor.js',
    'dist/grounded-media.js',
    'dist/handoff.js',
    'dist/live-activity-ledger.js',
    'dist/mcp/server.js',
    'dist/native-precompact.js',
    'dist/proposal-review-state.js',
    'dist/store/checkpoints.js',
    'dist/vendor/smol-toml/parse.js',
    'dist/vendor/smol-toml/LICENSE',
  ]) {
    assert.ok(packed.has(required), `tarball must include ${required}`);
  }
  assert.match(
    readRoot('dist/cli.js'),
    /import ['"]\.\/cli-runtime\.js['"]/,
    'the public CLI entry is a stable bootstrap that delegates to the release implementation',
  );

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

test('tracked-only clean tree rebuild packs a spawnable checkpoint worker and rescue bootstrap', () => {
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

    const installedBin = path.join(consumer, 'node_modules', 'ihow-memory', 'bin', 'ihow-memory.mjs');
    const rescueRoot = path.join(temporaryRoot, 'rescue-root');
    const rescue = JSON.parse(execFileSync(process.execPath, [
      installedBin, 'rescue', '--json', '--root', rescueRoot, '--space', 'packed-rescue',
    ], {
      encoding: 'utf8',
      env: { ...process.env, HOME: path.join(temporaryRoot, 'home'), IHOW_HANDOFF_METRICS: '0' },
    }));
    assert.equal(rescue.ok, true, 'fresh packed install can run the out-of-band rescue entry');
    assert.equal(rescue.mode, 'rescue');
    assert.ok(fs.existsSync(path.join(rescueRoot, 'packed-rescue', '.runtime', 'cli.js')), 'rescue installs the stable bootstrap');
    assert.ok(fs.existsSync(path.join(rescueRoot, 'packed-rescue', '.runtime', 'cli-runtime.js')), 'rescue installs the release CLI implementation');

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
