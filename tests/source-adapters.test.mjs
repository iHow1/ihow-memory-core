// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openCore } from '../src/core.ts';
import { containsSecretLikeContent } from '../src/governance.ts';
import { renderSourceAdapterMarkdown, validateSourceAdapterDocument } from '../src/source-adapters.ts';

async function mkdtempReal(prefix) {
  return await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function coreFor(t) {
  const root = await mkdtempReal('ihow-source-adapters-');
  t.after(async () => { await fs.rm(root, { recursive: true, force: true }); });
  return await openCore({ root, space: 'source-adapters' });
}

async function writeSourceDoc(core, doc) {
  const validated = validateSourceAdapterDocument(doc);
  const abs = path.join(core.workspace.spaceDir, validated.memory_path);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, renderSourceAdapterMarkdown(validated), 'utf8');
  return validated;
}

function fixtureDoc(overrides = {}) {
  return {
    adapter: { id: 'fixture-contract', kind: 'fixture', version: 'alpha25-v1' },
    source_id: 'fixture:orchard:review-note-001',
    scope: 'project-orchard',
    visibility: 'source-shared',
    title: 'Fixture adapter review note',
    text: '- Fact: fixture adapter review note supports Orchard source review.',
    source_uri: 'fixture://orchard/review-note-001',
    metadata: { fixture: true },
    ...overrides,
  };
}

test('alpha25 source adapter contract validates fixture docs into source-lane markdown', async () => {
  const doc = validateSourceAdapterDocument(fixtureDoc());
  assert.equal(doc.adapter.kind, 'fixture');
  assert.equal(doc.visibility, 'source-shared');
  assert.equal(doc.memory_path, 'memory/sources/shared/project-orchard/fixture-orchard-review-note-001-fixture-adapter-review-note.md');
  assert.equal(doc.safety.secret_redaction, 'passed');

  const markdown = renderSourceAdapterMarkdown(doc);
  assert.match(markdown, /visibility: source-shared/);
  assert.match(markdown, /source_adapter_kind: "fixture"/);
  assert.match(markdown, /source_id: "fixture:orchard:review-note-001"/);
  assert.match(markdown, /fixture adapter review note supports Orchard source review/);
  assert.equal(containsSecretLikeContent(markdown), false);
});

test('alpha25 source adapter fixture participates in gardener source/shared boundary without external adapters', async (t) => {
  const core = await coreFor(t);
  await writeSourceDoc(core, fixtureDoc());
  await writeSourceDoc(core, fixtureDoc({
    source_id: 'fixture:orchard:operator-scratch-001',
    visibility: 'source-local',
    title: 'Fixture adapter local scratchpad',
    text: '- Fact: fixture local scratchpad remains source-local until review.',
    source_uri: 'fixture://orchard/operator-scratch-001',
  }));

  const projectDraft = await core.organize({ scope: 'project-orchard', actor: 'source-adapter-test' });
  const projectJson = JSON.stringify(projectDraft);
  assert.match(projectJson, /fixture adapter review note supports Orchard source review/);
  assert.doesNotMatch(projectJson, /fixture local scratchpad remains source-local/);
  assert.ok(projectDraft.sources.some((s) => s.source === 'memory/sources/shared/project-orchard/fixture-orchard-review-note-001-fixture-adapter-review-note.md'));
  assert.ok(projectDraft.sources.every((s) => s.visibility === 'source-shared'));

  const sourceDraft = await core.organize({ scope: 'source', actor: 'source-adapter-test' });
  const sourceJson = JSON.stringify(sourceDraft);
  assert.match(sourceJson, /fixture adapter review note supports Orchard source review/);
  assert.match(sourceJson, /fixture local scratchpad remains source-local/);
  assert.deepEqual(new Set(sourceDraft.sources.map((s) => s.visibility)), new Set(['source-local', 'source-shared']));
});

test('alpha25 source adapter contract rejects curated/audit lanes and secret-like provenance ids', () => {
  assert.throws(
    () => validateSourceAdapterDocument(fixtureDoc({ visibility: 'project' })),
    /source_adapter_visibility_must_be_source_lane/,
  );
  assert.throws(
    () => validateSourceAdapterDocument(fixtureDoc({ source_id: 'fixture:sk-abcdefghijklmnopqrstuvwxyz0123456789' })),
    /source_adapter_source_id_invalid|source_adapter_source_id_contains_secret_like_content/,
  );
  assert.throws(
    () => validateSourceAdapterDocument(fixtureDoc({ metadata: { owner: 'person@example.com' } })),
    /source_adapter_metadata_contains_secret_like_content/,
  );
});

test('alpha25 source adapter contract redacts PII-like body text before markdown rendering', () => {
  const doc = validateSourceAdapterDocument(fixtureDoc({
    title: 'Fixture contact note',
    text: '- Fact: fixture owner person@example.com follows up after review.',
  }));
  assert.equal(doc.safety.secret_redaction, 'redacted');
  assert.deepEqual(doc.safety.redacted_fields, ['text']);
  const markdown = renderSourceAdapterMarkdown(doc);
  assert.doesNotMatch(markdown, /person@example\.com/);
  assert.match(markdown, /\[redacted\]/);
  assert.equal(containsSecretLikeContent(markdown), false);
});
