// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// automation-v2 floor capture tests. Locks in the dogfood-proven contract for the deterministic
// transcript summarizer (2026-06-16, 12 real transcripts + adversarial grading):
//   - v2 "last substantive segment" selector beats v1 "longest segment" (which froze mid-session
//     milestones as false conclusions -> 42% misleading). Regression: v2 must pick the terminal
//     handoff, not the longer mid-session report.
//   - the LOCKED scope never lets tool_result content into the body (the security red line).
//   - the composed body, after redactSecretLikeContent, has ZERO hard-detector hits.
//   - the parser tolerates real jsonl shape (string|array content, non-conversational + malformed
//     lines) without throwing.
//   - the selector emits audit metadata (window/threshold/chosenIndex/chosenChars/fallbackReason).
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTranscript, summarizeTranscript } from '../src/transcript.ts';
import { containsSecretLikeContent, redactSecretLikeContent } from '../src/governance.ts';

function asst(text) {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
}
function usr(content) {
  return { type: 'user', message: { content } };
}

test('parseTranscript: tolerates real jsonl shape (string|array content, skips non-conv + malformed)', () => {
  const raw = [
    JSON.stringify({ type: 'user', message: { content: 'hello' } }),
    'definitely not json {{{', // malformed -> skipped, never throws
    JSON.stringify({ type: 'attachment', foo: 1 }), // non-conversational -> skipped
    JSON.stringify({ type: 'queue-operation', bar: 2 }), // non-conversational -> skipped
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi back' }] } }),
    '', // blank
  ].join('\n');
  const recs = parseTranscript(raw);
  assert.equal(recs.length, 2, 'only the user + assistant conversational records survive');
  assert.equal(recs[0].type, 'user');
  assert.equal(recs[1].type, 'assistant');
});

test('v2 selector regression: picks the terminal handoff, NOT the longer mid-session report', () => {
  // The mid-session report is the LONGEST segment (what v1 would freeze as a false "done").
  const midReport = '修复完成：根因已定位并全部改好，37 处实例零残留，浏览器渲染验证通过，看起来一切就绪。'.repeat(8);
  // The real terminal state: work is NOT actually done; a handoff with a pending blocker.
  const handoffCore = '交接：实际状态是验证仍 pending，blocked on 用户授权超时，需要你手动确认 10 个 logo，下一步切回中文核对再收口。';
  const handoff = handoffCore.repeat(3);
  const records = [
    usr('帮我修复 logo 渲染问题'),
    asst(midReport),
    asst('中间执行了一步脚本'),
    asst('好的，继续。'), // short fragment near the end
    asst(handoff), // the substantive terminal segment
  ];
  assert.ok(handoff.length >= 160 && handoff.length < midReport.length, 'fixture sanity: handoff is substantive but shorter than the mid report');

  const { body, selector } = summarizeTranscript(records);
  assert.ok(body.includes('验证仍 pending'), 'v2 captured the terminal handoff');
  assert.ok(body.includes('blocked on'), 'v2 captured the pending blocker');
  assert.ok(!body.includes('一切就绪'), 'v2 did NOT freeze the stale mid-session "done" claim');
  assert.equal(selector.fallbackReason, '', 'a substantive segment was found, no fallback');
  assert.equal(selector.tailDistance, 0, 'the chosen segment is the last one');
});

test('locked scope: tool_result content NEVER enters the body (security red line)', () => {
  const leak = 'LEAK_SECRET_TOKEN_abcdef0123456789';
  const records = [
    // a user turn carrying a tool_result block (file/command output) — must be ignored entirely
    usr([{ type: 'tool_result', content: leak }]),
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Read', input: { file_path: '/Users/x/notes.md' } },
          { type: 'tool_use', name: 'Bash', input: { command: `cat secrets && echo ${leak}` } },
          { type: 'text', text: '完成了对账：核对了三张表与 68 条记录，下一步把结论写回交接文档，状态稳定可清理。' },
        ],
      },
    },
  ];
  const { body } = summarizeTranscript(records);
  assert.ok(!body.includes(leak), 'tool_result content and raw Bash args never appear in the body');
  assert.ok(body.includes('notes.md'), 'but Read file paths (in-scope) do appear');
  assert.ok(body.includes('Did: 1 shell commands'), 'commands are reduced to a count + binary names');
  assert.ok(!body.includes('cat secrets'), 'raw Bash command is not dumped');
});

test('Did line: a quoted regex alternation does NOT leak its branches as fake binaries', () => {
  // dogfood 2026-06-17: `grep -nE "marker|hook-stop|runStopHook" f` used to split on the in-quote `|`
  // and list marker/hook-stop/runStopHook as "binaries". Quote-aware splitting keeps only real binaries;
  // an out-of-quote pipe still splits into each real stage.
  const records = [
    usr('排查 hook'),
    {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Bash', input: { command: 'grep -nE "marker|hook-stop|runStopHook|sessionStart" src/cli.ts | head -5' } },
          { type: 'text', text: '排查完成：定位到 hook 注册点,确认 marker 写入路径正确,下一步补可观测日志后即可收口验证。' },
        ],
      },
    },
  ];
  const { body } = summarizeTranscript(records);
  assert.match(body, /Did: 1 shell commands/);
  assert.ok(/\bgrep\b/.test(body) && /\bhead\b/.test(body), 'real binaries (grep, the piped head) are kept');
  for (const fake of ['hook-stop', 'runStopHook', 'sessionStart']) {
    assert.ok(!new RegExp(`\\(${'[^)]*'}${fake}`).test(body.split('Did:')[1] ?? ''), `regex branch ${fake} is not listed as a binary`);
  }
});

test('Did line: a heredoc body does NOT leak its content lines as fake binaries', () => {
  // dogfood 2026-06-17: `git commit -F - <<'EOF' ... EOF` leaked `EOF` + body words (workspace/memory)
  // as binaries. Heredoc bodies are literal data, not commands — stripHeredocs removes them first.
  const cmd = "git commit -F - <<'EOF'\nfeat: thing\n- touched workspace and memory\nEOF\necho done";
  const records = [
    usr('提交'),
    {
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }, { type: 'text', text: '提交完成：改动已落库,验证通过,下一步推分支后通知评审,状态可继续。' }] },
    },
  ];
  const { body } = summarizeTranscript(records);
  const didLine = (body.split('Did:')[1] ?? '').split('\n')[0];
  assert.match(didLine, /\bgit\b/, 'the real binary (git) is kept');
  for (const leak of ['EOF', 'workspace', 'memory', 'feat']) {
    assert.ok(!new RegExp(`\\b${leak}\\b`).test(didLine), `heredoc body token ${leak} does not leak as a binary`);
  }
});

test('redact zero-hit: a body containing an email is hard-detector-clean after redaction', () => {
  const withEmail = '上线收口：新版已发布并独立验证；企业咨询联系 hi@ihowmemory.com，按钮点击可复制邮箱。'.repeat(3);
  const records = [usr('继续官网'), asst(withEmail)];
  const { body } = summarizeTranscript(records);
  assert.ok(containsSecretLikeContent(body), 'raw body trips the detector (email pattern)');
  const redacted = redactSecretLikeContent(body);
  assert.ok(!containsSecretLikeContent(redacted), 'POST-redaction the body is zero-hit (OpenClaw §3.5)');
  assert.ok(redacted.includes('上线收口'), 'redaction preserves the surrounding useful content');
});

test('selector metadata: fallback_longest recorded when no segment is substantive', () => {
  const { selector } = summarizeTranscript([usr('t'), asst('短'), asst('也很短')]);
  assert.equal(selector.fallbackReason, 'fallback_longest', 'no >=160 segment -> fallback, audited');
  assert.ok(selector.chosenChars > 0, 'fallback still chooses the longest available');

  const { selector: s2 } = summarizeTranscript([usr('t'), asst('x'.repeat(200))]);
  assert.equal(s2.fallbackReason, '', 'a >=160 segment -> no fallback');
  assert.equal(s2.window, 1);
});

test('empty / trivial transcript: empty body, empty selector reason', () => {
  const { body, selector } = summarizeTranscript(parseTranscript(''));
  assert.equal(body, '', 'no records -> empty body (caller skips journaling)');
  assert.equal(selector.fallbackReason, 'empty');
});
