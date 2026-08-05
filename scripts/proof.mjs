import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function logStep(name, value) {
  console.log(`\n[${name}]`);
  console.log(JSON.stringify(value, null, 2));
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ihow-memory-core-proof-'));
const space = 'proof-a0-1';
const core = await openCore({ root, space });

try {
  const initialStatus = await core.status();
  logStep('status.initial', initialStatus);
  assert(initialStatus.provider.id === 'fts', 'provider must be fts');
  assert(initialStatus.provider.cloud === false, 'provider must be local/no-cloud');
  assert(initialStatus.provider.model === null, 'provider must not use a model');
  assert(initialStatus.sync.enabled === false, 'sync must be disabled');

  const candidate = await core.write_candidate({
    title: 'agent-a-proof-memory',
    text: 'Agent A durable proof memory: blue-copper-river marker for A0.1 local FTS citation.',
    sourceAgent: 'agent-a',
    // This proof demonstrates the explicit governed loop: propose a candidate,
    // verify it is not searchable yet, then promote through the manual gate.
    autoPromote: false,
    metadata: {
      proof: 'A0.1',
      cloud: false,
      model: null,
    },
  });
  logStep('agentA.write_candidate', candidate);
  assert(candidate.status === 'candidate', 'write_candidate must create a candidate');
  assert(candidate.path.includes('memory/candidate/inbox/'), 'candidate must be written to candidate/inbox');

  const beforePromoteSearch = await core.search('blue-copper-river', { limit: 5 });
  logStep('search.before_promote', beforePromoteSearch);
  assert(beforePromoteSearch.length === 0, 'candidate must not be searchable before promote');

  const promoted = await core.promote(candidate.path, {
    scope: 'proof',
    title: 'agent-a-proof-memory',
  });
  logStep('agentA.promote', promoted);
  assert(promoted.status === 'promoted', 'promote must create durable memory');
  assert(promoted.path.includes('memory/scopes/proof/'), 'promoted memory must land in durable scope');
  assert(promoted.eventId, 'promote must create audit event');

  const results = await core.search('blue-copper-river', { limit: 5 });
  logStep('agentB.search', results);
  assert(results.length >= 1, 'agent B must find promoted memory');
  assert(results[0].citation?.path === results[0].path, 'search result must include citation path');
  assert(results[0].citation?.snippet?.includes('blue-copper-river'), 'search citation must include snippet');
  assert(results[0].source === 'fts', 'search must use local FTS');

  const read = await core.read(results[0].path);
  logStep('agentB.read', {
    path: read.path,
    snippet: read.snippet,
    citation: read.citation,
    containsMarker: read.content.includes('blue-copper-river'),
  });
  assert(read.citation.path === results[0].path, 'read must include citation path');
  assert(read.content.includes('blue-copper-river'), 'read must return exact promoted content');

  const finalStatus = await core.status();
  logStep('status.final', finalStatus);
  assert(finalStatus.index.documents >= 1, 'index must include promoted document');
  assert(finalStatus.provider.cloud === false, 'proof must remain no-cloud');
  assert(finalStatus.provider.model === null, 'proof must remain no-model');

  console.log('\nPASS ihow-memory-core A0.1 10-second proof: local candidate (autoPromote:false) -> promote -> FTS citation/read');
} finally {
  if (process.env.IHOW_MEMORY_KEEP_PROOF !== '1') {
    await fs.rm(root, { recursive: true, force: true });
  } else {
    console.log(`\nkept proof workspace: ${root}`);
  }
}
