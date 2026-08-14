import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const requiredPackageFiles = [
  'LICENSE',
  'NOTICE',
  'TRADEMARK.md',
  'dist/vendor/smol-toml/LICENSE',
];

function fail(message) {
  throw new Error(`release_evidence_failed: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: options.binary ? null : 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr;
    fail(`${command} ${args.join(' ')} exited ${result.status}: ${String(stderr || '').trim()}`);
  }
  return result.stdout;
}

function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function fileSha256(file) {
  return sha256(fs.readFileSync(file));
}

function outputArgument(argv) {
  const index = argv.indexOf('--output');
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail('--output requires a directory');
  return path.resolve(root, value);
}

const argv = process.argv.slice(2);
const allowDirty = argv.includes('--allow-dirty');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
if (packageJson.license !== 'Apache-2.0') fail(`package license is ${packageJson.license || 'missing'}, expected Apache-2.0`);
if (packageLock.version !== packageJson.version || packageLock.packages?.['']?.version !== packageJson.version) {
  fail('package.json and package-lock.json versions are not identical');
}

const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${packageJson.version}]`)) fail(`CHANGELOG has no release section for ${packageJson.version}`);
const notice = fs.readFileSync(path.join(root, 'NOTICE'), 'utf8');
if (/local-first|no telemetry|required network calls/i.test(notice)) {
  fail('NOTICE contains product or privacy claims that belong in README');
}

const explicitOutput = outputArgument(argv);
const outputDir = explicitOutput || fs.mkdtempSync(path.join(os.tmpdir(), 'ihow-release-evidence-'));
fs.mkdirSync(outputDir, { recursive: true });

try {
  const gitHead = String(run('git', ['rev-parse', 'HEAD'])).trim();
  const gitTree = String(run('git', ['rev-parse', 'HEAD^{tree}'])).trim();
  const dirtyBeforeEvidence = String(run('git', ['status', '--porcelain'])).trim().length > 0;
  if (dirtyBeforeEvidence && !allowDirty) {
    fail('working tree is dirty; release evidence must bind one committed tree (use --allow-dirty only for development diagnostics)');
  }
  const sourceArchive = run('git', ['archive', '--format=tar', 'HEAD'], { binary: true });
  const packOutput = String(run('npm', [
    'pack',
    '--ignore-scripts',
    '--silent',
    '--json',
    '--pack-destination',
    outputDir,
  ]));
  const packed = JSON.parse(packOutput)[0];
  if (!packed?.filename || !Array.isArray(packed.files)) fail('npm pack returned an unexpected manifest');

  const packedPaths = new Set(packed.files.map((entry) => entry.path));
  const missing = requiredPackageFiles.filter((file) => !packedPaths.has(file));
  if (missing.length > 0) fail(`package is missing required legal files: ${missing.join(', ')}`);

  const tarballPath = path.join(outputDir, packed.filename);
  if (!fs.existsSync(tarballPath)) fail(`tarball was not created: ${packed.filename}`);

  const legalFiles = Object.fromEntries(requiredPackageFiles.map((file) => [file, {
    sha256: fileSha256(path.join(root, file)),
    bytes: fs.statSync(path.join(root, file)).size,
  }]));
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    releaseEligible: !dirtyBeforeEvidence,
    package: {
      name: packageJson.name,
      version: packageJson.version,
      license: packageJson.license,
      filename: packed.filename,
      sha1: packed.shasum,
      sha512Integrity: packed.integrity,
      sha256: fileSha256(tarballPath),
      bytes: fs.statSync(tarballPath).size,
      entries: packed.entryCount,
    },
    source: {
      repository: packageJson.repository?.url || null,
      gitHead,
      gitTree,
      dirtyBeforeEvidence,
      gitArchiveSha256: sha256(sourceArchive),
    },
    legal: {
      requiredPackageFiles,
      files: legalFiles,
    },
  };

  const manifestPath = path.join(outputDir, 'release-evidence.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, 'checksums.txt'), [
    `${manifest.package.sha256}  ${packed.filename}`,
    `${fileSha256(manifestPath)}  release-evidence.json`,
    ...requiredPackageFiles.map((file) => `${legalFiles[file].sha256}  ${file}`),
    '',
  ].join('\n'));

  console.log(JSON.stringify({
    releaseEvidence: manifest.releaseEligible ? 'PASS' : 'DEVELOPMENT_ONLY',
    releaseEligible: manifest.releaseEligible,
    output: explicitOutput ? path.relative(root, outputDir) : '(temporary)',
    package: `${packageJson.name}@${packageJson.version}`,
    tarball: packed.filename,
    tarballSha256: manifest.package.sha256,
    gitHead,
    gitTree,
    dirtyBeforeEvidence,
    requiredLegalFiles: requiredPackageFiles,
  }));
} finally {
  if (!explicitOutput) fs.rmSync(outputDir, { recursive: true, force: true });
}
