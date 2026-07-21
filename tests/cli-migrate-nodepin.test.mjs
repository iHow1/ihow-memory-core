// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Two alpha.9 wiring guarantees: (1) the UTC->local migration is reachable as a shipped CLI command
// `ihow-memory migrate-local-day` (so installed users can fix a split-day corpus — scripts/ is not in
// the npm package); (2) generated MCP configs pin an ABSOLUTE node (process.execPath), not bare 'node',
// so a stale PATH node cannot silently break the node:sqlite-dependent server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts');

async function mkdtempReal(p) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), p)));
}

test('migrate-local-day is a shipped CLI command (dry-run reports the rebucket)', async (t) => {
  const root = await mkdtempReal('ihow-cli-migrate-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const journalDir = path.join(root, 'memory', '_mcp', 'journal');
  await fs.mkdir(journalDir, { recursive: true });
  await fs.writeFile(
    path.join(journalDir, '2026-06-21.md'),
    '---\ndate: "2026-06-21"\n---\n# Journal 2026-06-21\n\n## 2026-06-21T02:00:00.000Z · t\n\nx\n',
    'utf8',
  );
  const out = execFileSync(process.execPath, [CLI, 'migrate-local-day', '--memory-root', path.join(root, 'memory')], {
    encoding: 'utf8',
    env: { ...process.env, IHOW_MEMORY_TZ: 'America/Los_Angeles' },
  });
  assert.match(out, /DRY RUN/);
  assert.match(out, /-> 2026-06-20\.md/, 'an evening UTC-named entry re-buckets to the local day');
  // dry-run must not have written anything
  await assert.rejects(fs.access(path.join(journalDir, '2026-06-20.md')), 'dry-run writes nothing');
});

test('generated MCP config pins an absolute node, not bare "node"', async (t) => {
  const root = await mkdtempReal('ihow-nodepin-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  const out = execFileSync(process.execPath, [CLI, 'init', '--runtime', 'codex', '--space', 'x', '--root', root], {
    encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.trim().startsWith('command ='));
  assert.ok(line, 'snippet has a command line');
  assert.ok(!/command\s*=\s*"node"/.test(line), 'must not be bare "node"');
  assert.match(line, /command\s*=\s*".*node.*"/, 'must be an absolute path to a node binary');
  assert.ok(path.isAbsolute(line.split('"')[1]), 'command path is absolute');
});

test('subcommand --help exits before setup or upgrade can write', async (t) => {
  const sandbox = await mkdtempReal('ihow-cli-help-');
  const home = path.join(sandbox, 'home');
  const cwd = path.join(sandbox, 'cwd');
  await fs.mkdir(home);
  await fs.mkdir(cwd);
  const opencodeConfig = path.join(home, '.config', 'opencode', 'opencode.json');
  const opencodeSentinel = `${JSON.stringify({
    mcp: {
      'ihow-memory': {
        type: 'local',
        command: ['/sentinel/node', '/sentinel/runtime/mcp/server.js'],
        enabled: true,
      },
    },
  }, null, 2)}\n`;
  await fs.mkdir(path.dirname(opencodeConfig), { recursive: true });
  await fs.writeFile(opencodeConfig, opencodeSentinel, 'utf8');
  t.after(async () => { await fs.rm(sandbox, { recursive: true, force: true }); });

  for (const command of ['setup', 'upgrade', 'rescue']) {
    const root = path.join(sandbox, `${command}-root`);
    const out = execFileSync(process.execPath, [CLI, command, '--help', '--root', root, '--space', 'help-probe'], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        PATH: '/usr/bin:/bin',
        IHOW_HANDOFF_METRICS: '0',
      },
    });
    assert.match(out, /Start here|Full command reference/, `${command} --help prints help`);
    await assert.rejects(fs.access(root), `${command} --help must not materialize a workspace`);
    assert.equal(
      await fs.readFile(opencodeConfig, 'utf8'),
      opencodeSentinel,
      `${command} --help must not rewrite a real runtime config`,
    );
  }
});
