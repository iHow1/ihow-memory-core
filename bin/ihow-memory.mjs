#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REQUIRED_NODE = '22.12.0';

function versionParts(value) {
  return value
    .replace(/^v/, '')
    .split('.')
    .slice(0, 3)
    .map((part) => Number.parseInt(part, 10) || 0);
}

function versionAtLeast(actual, expected) {
  const left = versionParts(actual);
  const right = versionParts(expected);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return true;
    if (left[index] < right[index]) return false;
  }
  return true;
}

const actualNode = process.env.IHOW_MEMORY_TEST_NODE_VERSION || process.versions.node;
const command = process.argv[2] || 'help';

if (!versionAtLeast(actualNode, REQUIRED_NODE)) {
  console.error('doctor: failed');
  console.error(`- fail node: v${actualNode}`);
  console.error('  hint: Install Node >= 22.12, then rerun: ihow-memory doctor.');
  console.error('  example: nvm install 22 && nvm use 22');
  console.error('- action sqlite: skipped until Node is upgraded');
  console.error('cloud: disabled / local only');
  if (command !== 'doctor') {
    console.error(`command "${command}" was not started because this package requires Node >= 22.12.`);
  }
  process.exitCode = 1;
} else {
  const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cliPath = path.join(packageDir, 'dist', 'cli.js');
  const child = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: process.env,
  });
  if (child.error) {
    console.error(`Unable to start iHow Memory: ${child.error.message}`);
    process.exitCode = 1;
  } else {
    process.exitCode = child.status ?? 1;
  }
}
