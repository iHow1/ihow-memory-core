// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Security lock: the `continue` command runs the prior session's narrative through the same-source
// secret redactor before putting it in the handoff envelope, so a secret VALUE that appeared in the
// previous session (email, API key, token) never leaks into the handoff a fresh agent reads. The
// machine anchors are git-derived and carry no secrets; the narrative is the only secret-bearing
// surface, and it is redacted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/ihow-memory.mjs', import.meta.url));

function iso(agoMs = 0) {
  return new Date(Date.now() - agoMs).toISOString();
}

test('continue: redacts secret values from the prior narrative', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-continue-redact-'));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  const space = 'h';
  const cwd = path.join(root, 'work');
  await fs.mkdir(cwd, { recursive: true });

  const transcript = path.join(root, 'prev.jsonl');
  const closing =
    '完成了对接, 把联系人邮箱 alice@example.com 记入了文档, 临时用的密钥 sk-ABCDEFGH12345678ZZ 需要后续轮换。下一步: 把这些挪到环境变量并删掉硬编码, 还没做。'.repeat(2);
  await fs.writeFile(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { content: '对接第三方' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: closing }] } }),
    ].join('\n') + '\n',
    'utf8',
  );
  const hooksDir = path.join(root, space, '.hooks');
  await fs.mkdir(hooksDir, { recursive: true });
  await fs.writeFile(
    path.join(hooksDir, 'stop-prev.json'),
    JSON.stringify({ schemaVersion: 2, processed: false, sessionId: 'prev', cwd, transcriptPath: transcript, hookLastAt: iso(1000), markerCreatedAt: iso(1000) }),
    'utf8',
  );

  const out = execFileSync(process.execPath, [CLI, 'continue', '--root', root, '--space', space, '--cwd', cwd], { encoding: 'utf8' });

  assert.doesNotMatch(out, /alice@example\.com/, 'email value is not leaked');
  assert.doesNotMatch(out, /sk-ABCDEFGH12345678ZZ/, 'api-key value is not leaked');
  assert.match(out, /\[redacted\]/, 'secrets degrade to [redacted]');
  // the non-secret narrative around the secret is still carried (redaction, not whole-body drop)
  assert.match(out, /挪到环境变量/, 'the surrounding narrative survives redaction');
});
