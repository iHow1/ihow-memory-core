#!/usr/bin/env node
// Deterministic protocol double for claim-honesty tests: the provider is ready and indexes, but its
// semantic search contributes no hits. This models a successfully running real-model lane with zero
// measured fixture delta without requiring Ollama, a network, or downloaded model weights.
let input = '';
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input.trim() || '{}');
const method = process.argv[2] || request.method;
const model = request.provider?.model || 'deterministic-zero-delta-model';

if (method === 'status') {
  console.log(JSON.stringify({ id: 'vector-gguf', model, ready: true, cloud: false }));
} else if (method === 'index') {
  console.log(JSON.stringify({ indexed: 20 }));
} else if (method === 'search') {
  console.log(JSON.stringify({ hits: [] }));
} else {
  console.error(`unsupported method: ${method}`);
  process.exitCode = 2;
}
