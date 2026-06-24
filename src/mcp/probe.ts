// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Verify-after-connect. A runtime is only reported "connected" once we can actually
// reach it — never on write-success alone. Two checks:
//  (1) the configured MCP server starts and answers a real round-trip (initialize +
//      memory.status) — catches broken bundles, bad roots, packageDir-type path bugs;
//  (2) for runtimes with an official MCP CLI, the server is actually registered in
//      that runtime's own config — catches the silent "config written but `mcp list`
//      empty" case (a real first-user incident with Hermes).
import { spawn, spawnSync } from 'node:child_process';

export type ProbeResult = { ok: boolean; detail: string };

// Spawn the configured server and do a newline-delimited JSON-RPC round-trip
// (the transport src/mcp/server.ts speaks). Resolves reachable iff memory.status
// returns ok within the timeout. Always tears the child process down.
export function probeMcpServer(
  spec: { command: string; args: string[] },
  opts: { timeoutMs?: number } = {},
): Promise<ProbeResult> {
  const timeoutMs = opts.timeoutMs ?? 12000;
  return new Promise<ProbeResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (caught) {
      resolve({ ok: false, detail: `spawn failed: ${caught instanceof Error ? caught.message : String(caught)}` });
      return;
    }
    let settled = false;
    let buf = '';
    let stderr = '';
    const finish = (r: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, detail: `no response within ${timeoutMs}ms` }), timeoutMs);
    child.on('error', (e) => finish({ ok: false, detail: `spawn error: ${e.message}` }));
    child.on('exit', (code) =>
      finish({ ok: false, detail: `server exited (code ${code})${stderr ? `: ${stderr.split('\n')[0]!.slice(0, 160)}` : ''}` }),
    );
    child.stderr?.on('data', (d) => { stderr += String(d); });
    child.stdout?.on('data', (d) => {
      buf += String(d);
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const lineStr = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!lineStr) continue;
        let msg: { id?: unknown; result?: { structuredContent?: { ok?: boolean; index?: { status?: string }; provider?: { id?: string } } }; error?: { message?: string } };
        try { msg = JSON.parse(lineStr); } catch { continue; }
        if (msg.id === 2) {
          const sc = msg.result?.structuredContent;
          if (sc?.ok) finish({ ok: true, detail: `server ok (index ${sc.index?.status ?? '?'}, provider ${sc.provider?.id ?? '?'})` });
          else finish({ ok: false, detail: msg.error ? `status error: ${msg.error.message}` : 'memory.status not ok' });
        }
      }
    });
    const send = (o: unknown): void => { try { child.stdin?.write(`${JSON.stringify(o)}\n`); } catch { /* ignore */ } };
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ihow-verify', version: '1' } } });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'memory.status', arguments: {} } });
  });
}

// For runtimes with an official MCP CLI, confirm ihow-memory is actually registered.
// 'n/a' = no CLI (config was written directly; verify on the runtime's first launch).
export function verifyRuntimeRegistration(runtime: string): { registered: boolean | 'n/a'; detail: string } {
  // On Windows the runtime CLIs are .cmd/.ps1 shims that Node's spawnSync can't exec by bare name
  // (ENOENT) — and connectRuntime already direct-writes config there. So there is no CLI to confirm
  // registration; treat as n/a and rely on the server round-trip instead of an ENOENT false-negative.
  if (process.platform === 'win32') {
    return { registered: 'n/a', detail: 'Windows: config written directly (no CLI registration check)' };
  }
  const run = (cmd: string, args: string[]): string | null => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 8000 });
    if (r.error || (typeof r.stdout !== 'string' && typeof r.stderr !== 'string')) return null;
    return `${r.stdout || ''}\n${r.stderr || ''}`.toLowerCase();
  };
  if (runtime === 'hermes') {
    const out = run('hermes', ['mcp', 'test', 'ihow-memory']);
    if (out == null) return { registered: 'n/a', detail: 'hermes CLI not runnable' };
    if (/not found|no mcp|not in config/.test(out)) return { registered: false, detail: 'hermes mcp test: not in config' };
    if (/connected|tools discovered|\bok\b|✓/.test(out)) return { registered: true, detail: 'hermes mcp test: connected' };
    return { registered: false, detail: 'hermes mcp test: not connected' };
  }
  if (runtime === 'codex') {
    const out = run('codex', ['mcp', 'list']);
    if (out == null) return { registered: 'n/a', detail: 'codex CLI not runnable' };
    return out.includes('ihow-memory')
      ? { registered: true, detail: 'codex mcp list: present' }
      : { registered: false, detail: 'codex mcp list: ihow-memory missing' };
  }
  if (runtime === 'claude-code') {
    const out = run('claude', ['mcp', 'list']);
    if (out == null) return { registered: 'n/a', detail: 'claude CLI not runnable' };
    return out.includes('ihow-memory')
      ? { registered: true, detail: 'claude mcp list: present' }
      : { registered: false, detail: 'claude mcp list: ihow-memory missing' };
  }
  return { registered: 'n/a', detail: 'no official CLI — written directly, verify on first launch' };
}

export type ConnectionStatus = 'reachable' | 'written' | 'pending';

// Combine both checks into one honest verdict per runtime.
export async function verifyConnection(
  spec: { command: string; args: string[] },
  runtime: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: ConnectionStatus; reachable: boolean; detail: string }> {
  const probe = await probeMcpServer(spec, opts);
  if (!probe.ok) {
    return { status: 'written', reachable: false, detail: `configured server unreachable — ${probe.detail}` };
  }
  const reg = verifyRuntimeRegistration(runtime);
  if (reg.registered === false) {
    // CLI explicitly says ihow-memory isn't registered — the real "written but not connected"
    // false-positive (the first-user Hermes incident). This is a genuine failure to surface.
    return { status: 'written', reachable: false, detail: `server runs, but ${reg.detail}` };
  }
  // registered === true OR 'n/a' (direct-write / Windows / no CLI): the server round-trips AND the
  // config is written — the best verification possible at install time. Restart the runtime to load.
  return { status: 'reachable', reachable: true, detail: `${probe.detail}; ${reg.detail}` };
}
