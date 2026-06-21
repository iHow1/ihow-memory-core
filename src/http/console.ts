#!/usr/bin/env -S node --experimental-strip-types
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
// Local read-only web console for iHow Memory.
// local-first: binds 127.0.0.1, no account, no API key, GET-only, no write endpoints.
// Serves a single static page plus read-only JSON endpoints backed by the existing core API.
import http from 'node:http';
import path from 'node:path';
import { openCore } from '../core.ts';
import type { WorkspaceOptions } from '../types.ts';

type ConsoleOptions = WorkspaceOptions & {
  host?: string;
  port?: number;
};

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
// The console serves the user's ENTIRE memory read-only with no auth, by design. Its safety rests on
// being reachable ONLY from the local loopback. Two distinct guards are needed:
//  - bind-time: refuse to listen on a non-loopback interface (no accidental 0.0.0.0 exposure);
//  - request-time: a loopback Host-header allowlist, because DNS-rebinding lets a remote web page make
//    the victim's BROWSER issue requests to 127.0.0.1 (which pass any remote-IP check) carrying the
//    attacker's Host header. Validating Host defeats that.
const LOOPBACK_REMOTE_IPS = new Set(['127.0.0.1', '::1']);
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

// Normalize a Host/bind value to a bare host name, lowercase. Handles "[::1]:8788" -> "::1",
// "localhost:8788" -> "localhost", "127.0.0.1:8788" -> "127.0.0.1", and bare IPv6 "::1" -> "::1"
// (a bare IPv6 has 2+ colons, so it must NOT be treated as host:port).
function normalizeHostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const m = h.match(/^\[([^\]]+)\]/); // [ipv6] or [ipv6]:port
    return m ? m[1] : h.replace(/^\[/, '').replace(/\].*$/, '');
  }
  // strip :port only for a single-colon host:port (IPv4 / hostname); leave bare IPv6 (2+ colons) intact
  if ((h.match(/:/g) || []).length === 1) return h.replace(/:\d+$/, '');
  return h;
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostName(host));
}

// Bind-time guard. Refuses any non-loopback bind host: the console is local-read-only-by-design and has
// no authentication, so exposing it on a LAN/public interface would publish all memory. (Power users who
// need remote access should SSH-tunnel to the loopback port instead.)
export function assertLoopbackBindHost(host: string): void {
  if (!isLoopbackHost(host)) {
    throw new Error(
      `refusing to bind the read-only console to non-loopback host "${host}" — it exposes all memory with no auth. ` +
        `Use 127.0.0.1 (default) and SSH-tunnel if you need remote access.`,
    );
  }
}

function json(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = `${JSON.stringify(payload, null, 2)}\n`;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function remoteIp(req: http.IncomingMessage): string {
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

// Reused safety contract from the hosted server: reject absolute paths and parent traversal.
function assertSafeRef(ref: string): void {
  if (typeof ref !== 'string' || !ref.trim()) throw new Error('ref_required');
  const normalized = ref.replace(/\\/g, '/');
  if (normalized.includes('\0')) throw new Error('invalid_ref');
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) {
    throw new Error('path_traversal_rejected');
  }
}

export async function createConsoleServer(options: ConsoleOptions = {}): Promise<http.Server> {
  const core = await openCore(options);

  return http.createServer(async (req, res) => {
    try {
      // local-first guard: only loopback callers, even if someone binds a wider host.
      const ip = remoteIp(req);
      if (ip && !LOOPBACK_REMOTE_IPS.has(ip)) return json(res, 403, { ok: false, error: 'local_only' });
      // DNS-rebinding / Host-header defense: a malicious page on a domain that resolves to 127.0.0.1 makes
      // the victim's browser hit the loopback port (passing the IP check) with its OWN Host header. Only a
      // loopback Host name may read memory; anything else (incl. a missing Host) is rejected.
      if (!isLoopbackHost(req.headers.host || '')) return json(res, 403, { ok: false, error: 'bad_host' });
      // belt-and-suspenders: refuse any non-loopback Origin (a cross-site browser caller).
      const origin = req.headers.origin;
      if (origin && origin !== 'null') {
        let originHost = '';
        try { originHost = new URL(origin).hostname; } catch { /* malformed → treated as non-loopback below */ }
        if (!isLoopbackHost(originHost)) return json(res, 403, { ok: false, error: 'bad_origin' });
      }
      // read-only: refuse anything that is not a GET.
      if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'read_only_console' });

      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const route = url.pathname;

      if (route === '/' || route === '/index.html') return html(res, 200, PAGE);
      if (route === '/health') return json(res, 200, { ok: true, mode: 'local-console', readOnly: true });
      if (route === '/api/status') return json(res, 200, await core.status());
      if (route === '/api/search') {
        const query = url.searchParams.get('q') || '';
        const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);
        return json(res, 200, await core.search(query, { limit }));
      }
      if (route === '/api/read') {
        const ref = url.searchParams.get('ref') || '';
        assertSafeRef(ref);
        return json(res, 200, await core.read(ref));
      }
      if (route === '/api/audit') {
        const limit = Math.min(Number(url.searchParams.get('limit') || 25), 100);
        // Delegate to core.audit() so the panel spans BOTH the main and _mcp auto-capture lanes
        // (single two-lane source of truth) instead of hand-reading only the main eventsDir.
        const events = await core.audit();
        return json(res, 200, { ok: true, events: events.slice(-limit) });
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const status = message === 'path_traversal_rejected' ? 400 : message === 'ref_required' ? 400 : 400;
      return json(res, status, { ok: false, error: message || 'bad_request' });
    }
  });
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const options: ConsoleOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--host') options.host = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--space') options.space = argv[++index];
    else if (arg === '--root') options.root = argv[++index];
    else if (arg === '--memory-root') options.memoryRoot = argv[++index];
    else if (arg === '--state-root') options.stateRoot = argv[++index];
    else if (arg === '--cwd') options.cwd = argv[++index];
    else if (arg === '--engine') options.engine = argv[++index];
  }
  const host = options.host || process.env.IHOW_MEMORY_CONSOLE_HOST || DEFAULT_HOST;
  const port = options.port ?? Number(process.env.IHOW_MEMORY_CONSOLE_PORT || DEFAULT_PORT);
  assertLoopbackBindHost(host);
  const server = await createConsoleServer(options);
  server.listen(port, host, () => {
    console.log('cloud: disabled / local only');
    console.log(`iHow Memory console (read-only): http://${host}:${port}`);
    console.log('Open the URL in a browser. Ctrl+C to stop.');
  });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>iHow Memory — Local Console</title>
<style>
  :root { --bg:#0f1419; --panel:#fff; --ink:#1b2733; --muted:#6b7785; --line:#e3e8ee; --accent:#2f6f4f; --chip:#eef3f0; }
  * { box-sizing: border-box; }
  body { margin:0; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif; color:var(--ink); background:#f5f7f9; }
  header { background:var(--bg); color:#e8eef2; padding:14px 22px; display:flex; align-items:center; gap:12px; flex-wrap:wrap; }
  header h1 { font-size:16px; margin:0; font-weight:600; letter-spacing:.2px; }
  .badge { font-size:11px; padding:2px 8px; border-radius:999px; background:#1d2b22; color:#7fd1a3; border:1px solid #2c4435; }
  .badge.cloud { background:#2a2030; color:#d8a7d8; border-color:#43314a; }
  .wrap { max-width:1080px; margin:0 auto; padding:22px; display:grid; gap:18px; grid-template-columns:1fr 1fr; }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:10px; padding:16px 18px; }
  .card.full { grid-column:1 / -1; }
  .card h2 { font-size:13px; text-transform:uppercase; letter-spacing:.6px; color:var(--muted); margin:0 0 12px; }
  .kv { display:grid; grid-template-columns:auto 1fr; gap:4px 14px; font-size:13px; }
  .kv dt { color:var(--muted); }
  .kv dd { margin:0; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; word-break:break-all; }
  .row { display:flex; gap:8px; }
  input[type=text] { flex:1; padding:9px 11px; border:1px solid var(--line); border-radius:8px; font:inherit; }
  button { padding:9px 14px; border:0; border-radius:8px; background:var(--accent); color:#fff; font:inherit; cursor:pointer; }
  button:hover { background:#27593f; }
  .hit { padding:9px 10px; border:1px solid var(--line); border-radius:8px; margin-top:8px; cursor:pointer; }
  .hit:hover { border-color:var(--accent); background:#fafdfb; }
  .hit .path { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--accent); word-break:break-all; }
  .hit .snip { color:var(--muted); margin-top:3px; font-size:12.5px; }
  pre { background:#0f1419; color:#d6e2ea; padding:12px; border-radius:8px; overflow:auto; max-height:340px; font-size:12px; white-space:pre-wrap; word-break:break-word; }
  .cite { font-family:ui-monospace,Menlo,monospace; font-size:12px; color:var(--accent); margin-bottom:8px; word-break:break-all; }
  .ev { font-family:ui-monospace,Menlo,monospace; font-size:12px; padding:5px 0; border-bottom:1px solid var(--line); }
  .ev .t { color:var(--accent); }
  .muted { color:var(--muted); }
  .empty { color:var(--muted); font-style:italic; padding:6px 0; }
</style>
</head>
<body>
<header>
  <h1>iHow Memory</h1>
  <span class="badge">read-only console</span>
  <span class="badge cloud">cloud disabled · local only</span>
</header>
<div class="wrap">
  <section class="card">
    <h2>Status</h2>
    <dl class="kv" id="status"><dd class="muted">loading…</dd></dl>
  </section>
  <section class="card">
    <h2>Audit (recent)</h2>
    <div id="audit"><div class="empty">loading…</div></div>
  </section>
  <section class="card">
    <h2>Search</h2>
    <div class="row">
      <input type="text" id="q" placeholder="search memory… (e.g. alpha sprint)" />
      <button id="go">Search</button>
    </div>
    <div id="hits"></div>
  </section>
  <section class="card">
    <h2>Read · citation</h2>
    <div id="cite" class="cite muted">click a search result to view its cited source</div>
    <pre id="content" class="muted">—</pre>
  </section>
</div>
<script>
const $ = (id) => document.getElementById(id);
async function getJSON(u) { const r = await fetch(u); return r.json(); }

async function loadStatus() {
  try {
    const s = await getJSON('/api/status');
    const w = s.workspace || {}, p = s.provider || {}, i = s.index || {}, sync = s.sync || {};
    $('status').innerHTML =
      row('memory root', w.memoryRoot || w.path || '—') +
      row('mode', w.mode || '—') +
      row('provider', (p.id || '?') + ' (ready=' + (p.ready ?? '?') + ', cloud=' + (p.cloud ?? '?') + ')') +
      (p.fallback ? row('fallback', (p.fallbackFrom||'?') + ' → fts (' + (p.lastError||'') + ')') : '') +
      row('index', (i.status || '?') + ', documents=' + (i.documents ?? '?')) +
      row('sync', 'enabled=' + (sync.enabled ?? false));
  } catch (e) { $('status').innerHTML = '<dd class="muted">status error: ' + e + '</dd>'; }
}
function row(k, v) { return '<dt>' + esc(k) + '</dt><dd>' + esc(String(v)) + '</dd>'; }

async function loadAudit() {
  try {
    const a = await getJSON('/api/audit?limit=25');
    const events = a.events || (Array.isArray(a) ? a : []);
    if (!events.length) { $('audit').innerHTML = '<div class="empty">no audit events yet</div>'; return; }
    $('audit').innerHTML = events.slice().reverse().map(function(e){
      const t = e.type || e.event || e.kind || 'event';
      const id = e.id || e.ref || e.path || '';
      const when = e.at || e.ts || e.time || '';
      return '<div class="ev"><span class="t">' + esc(t) + '</span> <span class="muted">' + esc(String(when)) + '</span><br>' + esc(String(id)) + '</div>';
    }).join('');
  } catch (e) { $('audit').innerHTML = '<div class="empty">audit error: ' + e + '</div>'; }
}

async function doSearch() {
  const q = $('q').value.trim();
  if (!q) return;
  $('hits').innerHTML = '<div class="empty">searching…</div>';
  try {
    const data = await getJSON('/api/search?limit=10&q=' + encodeURIComponent(q));
    const hits = Array.isArray(data) ? data : (data.hits || data.results || data.matches || []);
    if (!hits.length) { $('hits').innerHTML = '<div class="empty">no matches</div>'; return; }
    $('hits').innerHTML = '';
    hits.forEach(function(h){
      const ref = h.ref || h.path || (h.citation && h.citation.path) || '';
      const snip = h.snippet || h.preview || h.text || h.excerpt || '';
      const div = document.createElement('div');
      div.className = 'hit';
      div.innerHTML = '<div class="path">' + esc(ref || '(no path)') + '</div>' + (snip ? '<div class="snip">' + esc(String(snip).slice(0,180)) + '</div>' : '');
      div.onclick = function(){ openRead(ref); };
      $('hits').appendChild(div);
    });
  } catch (e) { $('hits').innerHTML = '<div class="empty">search error: ' + e + '</div>'; }
}

async function openRead(ref) {
  if (!ref) return;
  $('cite').textContent = ref; $('cite').className = 'cite';
  $('content').textContent = 'loading…'; $('content').className = '';
  try {
    const d = await getJSON('/api/read?ref=' + encodeURIComponent(ref));
    const cite = (d.citation && (d.citation.path || d.citation)) || d.path || ref;
    $('cite').textContent = String(cite);
    $('content').textContent = d.content || d.text || JSON.stringify(d, null, 2);
  } catch (e) { $('content').textContent = 'read error: ' + e; }
}

function esc(s){ return String(s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); }

$('go').onclick = doSearch;
$('q').addEventListener('keydown', function(e){ if (e.key === 'Enter') doSearch(); });
loadStatus(); loadAudit();
</script>
</body>
</html>`;

if (process.argv[1] && import.meta.url === new URL(process.argv[1], 'file://').href) {
  main().catch((caught) => {
    console.error(caught instanceof Error ? caught.message : String(caught));
    process.exitCode = 1;
  });
}
