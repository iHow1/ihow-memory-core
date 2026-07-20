// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Hermetic Codex MCP CLI shim. A successful `codex mcp add` must materialize both
// registration state and CODEX_HOME/config.toml, matching the real CLI contract
// required by the runtime adapter's post-registration approval edit.
import fs from 'node:fs/promises';
import path from 'node:path';

export async function makeCodexMcpShim(bin) {
  const shim = path.join(bin, 'codex');
  const body = String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const codexHome = process.env.CODEX_HOME || path.join(process.env.HOME, '.codex');
const statePath = path.join(codexHome, '.ihow-test-mcp-state.json');
const configPath = path.join(codexHome, 'config.toml');
const load = () => { try { return JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { return null; } };
const save = (value) => {
  fs.mkdirSync(codexHome, { recursive: true });
  if (value === null) { try { fs.unlinkSync(statePath); } catch {} return; }
  fs.writeFileSync(statePath, JSON.stringify(value));
};
const removeConfigEntry = () => {
  let raw;
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { return; }
  const lines = raw.split('\n');
  const start = lines.findIndex((line) => line.trim() === '[mcp_servers.ihow-memory]');
  if (start < 0) return;
  let end = start + 1;
  while (end < lines.length) {
    const header = lines[end].trim();
    if (header.startsWith('[') && !header.startsWith('[mcp_servers.ihow-memory.')) break;
    end += 1;
  }
  lines.splice(start, end - start);
  fs.writeFileSync(configPath, lines.join('\n'));
};
const writeConfigEntry = (spec) => {
  fs.mkdirSync(codexHome, { recursive: true });
  let raw = '';
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch {}
  if (raw.includes('[mcp_servers.ihow-memory]')) removeConfigEntry();
  try { raw = fs.readFileSync(configPath, 'utf8'); } catch { raw = ''; }
  const separator = raw && !raw.endsWith('\n') ? '\n\n' : raw ? '\n' : '';
  const args = JSON.stringify(spec.args || []);
  fs.writeFileSync(configPath,
    raw + separator
      + '[mcp_servers.ihow-memory]\n'
      + 'command = ' + JSON.stringify(spec.command) + '\n'
      + 'args = ' + args + '\n');
};
if (argv[0] !== 'mcp') process.exit(0);
const state = load();
if (argv[1] === 'get') {
  if (!state) process.exit(1);
  process.stdout.write(JSON.stringify({
    name: 'ihow-memory', enabled: true, disabled_reason: null,
    transport: {
      type: 'stdio', command: state.command, args: state.args || [], env: state.env || {},
      env_vars: [], cwd: null,
    },
  }) + '\n');
  process.exit(0);
}
if (argv[1] === 'list') {
  if (state) process.stdout.write('ihow-memory\n');
  process.exit(0);
}
if (argv[1] === 'remove') {
  save(null);
  removeConfigEntry();
  process.exit(0);
}
if (argv[1] === 'add') {
  const separator = argv.indexOf('--');
  if (separator < 0 || !argv[separator + 1]) process.exit(2);
  const env = {};
  for (let index = 3; index < separator; index += 1) {
    if (argv[index] === '--env' && argv[index + 1]) {
      const split = argv[index + 1].indexOf('=');
      env[argv[index + 1].slice(0, split)] = argv[index + 1].slice(split + 1);
      index += 1;
    }
  }
  const spec = { command: argv[separator + 1], args: argv.slice(separator + 2), env };
  save(spec);
  writeConfigEntry(spec);
  process.exit(0);
}
process.exit(0);
`;
  await fs.writeFile(shim, body, 'utf8');
  await fs.chmod(shim, 0o755);
  return shim;
}
