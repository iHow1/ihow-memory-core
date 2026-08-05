#!/usr/bin/env node
// Deterministic protocol double for claim-honesty tests: the provider is ready and indexes, but it
// deliberately ranks every non-target document ahead of the target. On the purpose-built six-document
// fixture this lets RRF boost five wrong lexical hits and move the labeled target from top-5 to rank 6,
// producing a stable negative paraphrase delta without a model, network, or downloaded weights.
import fs from 'node:fs/promises';
import path from 'node:path';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input.trim() || '{}');
const method = process.argv[2] || request.method;
const model = request.provider?.model || 'deterministic-negative-delta-model';
const workspace = request.workspace || {};
const storePath = path.join(path.dirname(workspace.indexPath || path.join(process.cwd(), 'index.sqlite')), 'negative-delta-sidecar.json');

async function listMarkdown(dir) {
  const out = [];
  let entries = [];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await listMarkdown(abs));
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(abs);
  }
  return out;
}

if (method === 'status') {
  console.log(JSON.stringify({ id: 'vector-gguf', model, ready: true, cloud: false }));
} else if (method === 'index') {
  const files = await listMarkdown(workspace.memoryDir);
  const base = path.dirname(workspace.memoryDir);
  const paths = files
    .map((abs) => path.relative(base, abs).split(path.sep).join('/'))
    .filter((rel) => rel.includes('/scopes/') && !rel.includes('/scopes/target/'));
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ paths }), 'utf8');
  console.log(JSON.stringify({ indexed: files.length }));
} else if (method === 'search') {
  const store = JSON.parse(await fs.readFile(storePath, 'utf8'));
  const limit = Math.max(1, Math.min(Number(request.opts?.limit || 10), 25));
  const hits = store.paths.slice(0, limit).map((docPath, index) => ({
    path: docPath,
    snippet: 'deterministic wrong-document ranking fixture',
    score: 1 - index / 100,
    source: 'vector-gguf',
    citation: { path: docPath, snippet: 'deterministic wrong-document ranking fixture' },
  }));
  console.log(JSON.stringify({ hits }));
} else {
  console.error(`unsupported method: ${method}`);
  process.exitCode = 2;
}
