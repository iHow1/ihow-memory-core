#!/usr/bin/env -S node --experimental-strip-types
// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import readline from 'node:readline';
import { openCore } from '../core.ts';
import type { WorkspaceOptions } from '../types.ts';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildHandoffPacket } from '../handoff.ts';

type JsonRpcRequest = {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

// Suppress only Node's node:sqlite ExperimentalWarning (Node >= 22.12 is our supported runtime); all other warnings pass through unchanged.
const _emitWarning = process.emitWarning.bind(process);
process.emitWarning = function (warning: string | Error, ...args: any[]): void {
  const message = typeof warning === 'string' ? warning : warning.message;
  const opts = args[0];
  const type = opts && typeof opts === 'object' ? opts.type : opts;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(message)) return;
  (_emitWarning as (...a: any[]) => void)(warning, ...args);
} as typeof process.emitWarning;

function packageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Two layouts: connect copies dist/ into <space>/.runtime (version stamped into .runtime/package.json at ../),
  // and the npm package runs dist/mcp/server.js directly (package.json at ../..). Try the runtime copy first.
  for (const rel of ['..', '../..']) {
    try {
      const version = (JSON.parse(readFileSync(path.join(here, rel, 'package.json'), 'utf8')) as { version?: string }).version;
      if (version) return version;
    } catch {
      // try next candidate
    }
  }
  return 'unknown';
}

function parseWorkspaceArgs(argv: string[]): WorkspaceOptions {
  const options: WorkspaceOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--space') options.space = argv[++index];
    else if (argv[index] === '--root') options.root = argv[++index];
    else if (argv[index] === '--memory-root') options.memoryRoot = argv[++index];
    else if (argv[index] === '--state-root') options.stateRoot = argv[++index];
    else if (argv[index] === '--cwd') options.cwd = argv[++index];
    else if (argv[index] === '--engine') options.engine = argv[++index];
    else if (argv[index] === '--vector-provider-command') options.vectorProviderCommand = argv[++index];
    else if (argv[index] === '--vector-model') options.vectorModel = argv[++index];
    else if (argv[index] === '--vector-timeout-ms') options.vectorTimeoutMs = Number(argv[++index]);
  }
  return options;
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id: JsonRpcRequest['id'], value: unknown): void {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id: JsonRpcRequest['id'], code: number, message: string): void {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOL_DEFINITIONS = [
  {
    name: 'memory.search',
    description: 'Search local iHow Memory; returns citation path + snippet ranked by relevance. Use before answering about prior work, decisions, preferences, TODOs, or when resuming a project — recall before you re-derive or re-ask. Matching is LEXICAL (keyword/term overlap), not semantic: there is no embedding model, so YOU are the semantic layer. (1) Issue 2-3 reworded queries with synonyms (e.g. both "auth token" and "鉴权 凭证") — a single phrasing misses notes that used different words. (2) memory.read the cited file before relying on any hit; a snippet can match on a coincidental term. (3) When hits conflict, prefer the more recently dated/promoted one. Treat results as candidates to rerank, not a ranked truth.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory.read',
    description: 'Read a memory markdown file by path; returns exact content plus citation. Use to open the full source behind a search snippet before relying on it.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'memory.write_candidate',
    description: 'Propose a memory candidate into the sandbox inbox (does NOT write durable memory). Use after a meaningful decision, a verified result, a blocker, a stated user preference, or a handoff summary, so the next session/agent can recall it. Never store secrets, tokens, or credentials.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        title: { type: 'string' },
        sourceAgent: { type: 'string' },
        metadata: { type: 'object' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory.promote',
    description: 'Promote a candidate into governed, durable memory with an audit event. Use after confirming the candidate is correct, non-sensitive, and worth keeping. Existing workspace mode uses memory/_mcp/promoted only.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate: { type: 'string' },
        target: { type: 'object' },
      },
      required: ['candidate'],
    },
  },
  {
    name: 'memory.durable_promote',
    description: 'Governed durable promote into the long-term layer. Requires explicit dryRun=true or realWrite=true — default to dryRun=true to preview the plan, and only set realWrite=true on explicit user confirmation.',
    inputSchema: {
      type: 'object',
      properties: {
        candidate: { type: 'string' },
        dryRun: { type: 'boolean' },
        realWrite: { type: 'boolean' },
        actor: { type: 'string' },
        target: { type: 'object' },
      },
      required: ['candidate'],
    },
  },
  {
    name: 'memory.journal',
    description: 'Append a low-weight, append-only entry to the daily journal (auto-capture lane). Unlike write_candidate -> promote, this writes directly: the entry is searchable but always ranked BELOW curated memory, so it is safe for automatic session-end capture of what happened. Never store secrets. For high-value durable facts worth keeping, use write_candidate + promote instead.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        title: { type: 'string' },
        sourceAgent: { type: 'string' },
      },
      required: ['text'],
    },
  },
  {
    name: 'memory.status',
    description: 'Return workspace, local FTS provider, index, and sync status. Use to confirm the index is ready and that cloud/sync are disabled (local-only) before relying on recall.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'memory.continue',
    description: 'RESUME after a context boundary (/clear, new thread, switched tool/model). Returns a runtime-neutral handoff PACKET: candidate resumable projects, each with MACHINE ANCHORS (git branch/HEAD/dirty — the only facts), the prior session narrative VERBATIM and UNVERIFIED (never trust it blind), code-computed freshness + anchor-conflict counts, and what to verify first. Call this FIRST when the user says "继续"/"continue"/"resume". The narrative is a claim to verify, not a fact — run the verifyFirst checks before acting. This tool does not itself resume; it hands you an auditable packet.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: 'your current working dir (informational; discovery is global across recorded projects)' },
        projectHint: { type: 'string', description: 'optional keyword to filter candidates to a project' },
        limit: { type: 'number', description: 'max candidate projects to return (default 5)' },
        excludeSessionId: { type: 'string', description: 'your own session id, to avoid listing the live session as a candidate' },
      },
    },
  },
] as const;

async function main(): Promise<void> {
  const core = await openCore(parseWorkspaceArgs(process.argv.slice(2)));
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line);
    } catch {
      error(null, -32700, 'parse_error');
      return;
    }

    try {
      const id = request.id ?? null;
      const params = request.params || {};
      if (request.method === 'initialize') {
        result(id, {
          protocolVersion: '2024-11-05',
          serverInfo: { name: 'ihow-memory-core', version: packageVersion() },
          capabilities: { tools: {} },
        });
      } else if (request.method?.startsWith('notifications/')) {
        return;
      } else if (request.method === 'tools/list') {
        result(id, { tools: TOOL_DEFINITIONS });
      } else if (request.method === 'tools/call') {
        const name = String(params.name || '');
        const args = (params.arguments || {}) as Record<string, unknown>;
        let payload: unknown;
        if (name === 'memory.search') {
          payload = await core.search(String(args.query || ''), { limit: Number(args.limit || 5) });
        } else if (name === 'memory.read') {
          payload = await core.read(String(args.ref || ''));
        } else if (name === 'memory.write_candidate') {
          payload = await core.write_candidate(args);
        } else if (name === 'memory.promote') {
          payload = await core.promote(String(args.candidate || ''), (args.target || {}) as Record<string, string>);
        } else if (name === 'memory.durable_promote') {
          payload = await core.durable_promote(String(args.candidate || ''), {
            dryRun: args.dryRun === true,
            realWrite: args.realWrite === true,
            actor: typeof args.actor === 'string' ? args.actor : 'mcp',
            target: (args.target || {}) as Record<string, string>,
          });
        } else if (name === 'memory.journal') {
          payload = await core.journal(args);
        } else if (name === 'memory.status') {
          payload = await core.status();
        } else if (name === 'memory.continue') {
          payload = await buildHandoffPacket({
            cwd: typeof args.cwd === 'string' ? args.cwd : process.cwd(),
            projectHint: typeof args.projectHint === 'string' ? args.projectHint : undefined,
            limit: Number.isFinite(args.limit as number) ? Number(args.limit) : undefined,
            excludeSessionId: typeof args.excludeSessionId === 'string' ? args.excludeSessionId : undefined,
          });
        } else {
          throw new Error('unknown_tool');
        }
        // MCP requires structuredContent to be a JSON object; tools that return an array
        // (e.g. memory.search) otherwise fail client-side schema validation
        // ("expected record, received array"). Wrap array payloads in an object.
        const structured = Array.isArray(payload) ? { results: payload } : payload;
        result(id, {
          content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
          structuredContent: structured,
        });
      } else {
        error(id, -32601, 'method_not_found');
      }
    } catch (caught) {
      error(request.id ?? null, -32000, caught instanceof Error ? caught.message : String(caught));
    }
  });
}

main().catch((caught) => {
  console.error(caught instanceof Error ? caught.message : String(caught));
  process.exitCode = 1;
});
