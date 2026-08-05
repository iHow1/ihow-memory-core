// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
import type { JsonRecord } from './types.ts';
import { containsSecretLikeContent, redactSecretLikeContent } from './governance.ts';
import { safeFileSlug } from './store/files.ts';

export type SourceAdapterKind = 'fixture' | 'feishu' | 'obsidian' | 'ima' | 'markdown';
export type SourceAdapterVisibility = 'source-local' | 'source-shared';

export type SourceAdapterDescriptor = {
  id: string;
  kind: SourceAdapterKind;
  version: string;
};

export type SourceAdapterDocument = {
  adapter: SourceAdapterDescriptor;
  source_id: string;
  scope: string;
  visibility: SourceAdapterVisibility;
  title: string;
  text: string;
  source_uri?: string;
  metadata?: JsonRecord;
};

export type ValidatedSourceAdapterDocument = {
  adapter: SourceAdapterDescriptor;
  source_id: string;
  scope: string;
  scope_slug: string;
  visibility: SourceAdapterVisibility;
  title: string;
  text: string;
  source_uri?: string;
  metadata: JsonRecord;
  memory_path: string;
  safety: {
    secret_redaction: 'passed' | 'redacted';
    redacted_fields: string[];
    export_safe: true;
  };
};

const SOURCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9:._/-]{1,119}$/;
const ADAPTER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{1,79}$/;
const ADAPTER_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,39}$/;

function oneLine(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`source_adapter_${field}_required`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`source_adapter_${field}_required`);
  if (/\r|\n|\0/.test(trimmed)) throw new Error(`source_adapter_${field}_must_be_one_line`);
  return trimmed;
}

function assertCleanPersistedField(field: string, value: string): void {
  if (containsSecretLikeContent(value)) throw new Error(`source_adapter_${field}_contains_secret_like_content`);
}

function redactPersistedText(field: string, value: string, redactedFields: string[]): string {
  const redacted = redactSecretLikeContent(value).trim();
  if (redacted !== value.trim()) redactedFields.push(field);
  if (!redacted) throw new Error(`source_adapter_${field}_required`);
  if (containsSecretLikeContent(redacted)) throw new Error(`source_adapter_${field}_contains_secret_like_content`);
  return redacted;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function laneForVisibility(visibility: SourceAdapterVisibility): 'local' | 'shared' {
  return visibility === 'source-local' ? 'local' : 'shared';
}

export function sourceAdapterMemoryPath(doc: Pick<ValidatedSourceAdapterDocument, 'visibility' | 'scope_slug' | 'source_id' | 'title'>): string {
  const idSlug = safeFileSlug(doc.source_id, 'source');
  const titleSlug = safeFileSlug(doc.title, 'source-import');
  return `memory/sources/${laneForVisibility(doc.visibility)}/${doc.scope_slug}/${idSlug}-${titleSlug}.md`;
}

export function validateSourceAdapterDocument(input: SourceAdapterDocument): ValidatedSourceAdapterDocument {
  const adapterId = oneLine(input.adapter?.id, 'adapter_id');
  if (!ADAPTER_ID_RE.test(adapterId)) throw new Error('source_adapter_adapter_id_invalid');
  assertCleanPersistedField('adapter_id', adapterId);

  const adapterKind = oneLine(input.adapter?.kind, 'adapter_kind') as SourceAdapterKind;
  if (!['fixture', 'feishu', 'obsidian', 'ima', 'markdown'].includes(adapterKind)) throw new Error('source_adapter_adapter_kind_invalid');

  const adapterVersion = oneLine(input.adapter?.version, 'adapter_version');
  if (!ADAPTER_VERSION_RE.test(adapterVersion)) throw new Error('source_adapter_adapter_version_invalid');
  assertCleanPersistedField('adapter_version', adapterVersion);

  const sourceId = oneLine(input.source_id, 'source_id');
  if (!SOURCE_ID_RE.test(sourceId)) throw new Error('source_adapter_source_id_invalid');
  assertCleanPersistedField('source_id', sourceId);

  const scope = oneLine(input.scope, 'scope').toLowerCase();
  assertCleanPersistedField('scope', scope);
  const scopeSlug = safeFileSlug(scope, 'source');
  if (scopeSlug !== scope) throw new Error('source_adapter_scope_must_be_slug');

  if (input.visibility !== 'source-local' && input.visibility !== 'source-shared') {
    throw new Error('source_adapter_visibility_must_be_source_lane');
  }

  const redactedFields: string[] = [];
  const title = redactPersistedText('title', oneLine(input.title, 'title'), redactedFields);
  const rawText = typeof input.text === 'string' ? input.text.trim() : '';
  if (!rawText) throw new Error('source_adapter_text_required');
  const text = redactPersistedText('text', rawText, redactedFields);

  let sourceUri: string | undefined;
  if (input.source_uri !== undefined) {
    sourceUri = oneLine(input.source_uri, 'source_uri');
    assertCleanPersistedField('source_uri', sourceUri);
  }

  const metadata = input.metadata ?? {};
  const metadataJson = JSON.stringify(metadata);
  if (containsSecretLikeContent(metadataJson)) throw new Error('source_adapter_metadata_contains_secret_like_content');

  const adapter = { id: adapterId, kind: adapterKind, version: adapterVersion };
  const base = {
    adapter,
    source_id: sourceId,
    scope,
    scope_slug: scopeSlug,
    visibility: input.visibility,
    title,
    text,
    source_uri: sourceUri,
    metadata,
    safety: {
      secret_redaction: redactedFields.length ? 'redacted' as const : 'passed' as const,
      redacted_fields: redactedFields,
      export_safe: true as const,
    },
  };
  return { ...base, memory_path: sourceAdapterMemoryPath(base) };
}

export function renderSourceAdapterMarkdown(input: SourceAdapterDocument | ValidatedSourceAdapterDocument): string {
  const doc = 'memory_path' in input ? input : validateSourceAdapterDocument(input);
  const frontmatter = [
    '---',
    `visibility: ${doc.visibility}`,
    `source_id: ${yamlString(doc.source_id)}`,
    `source_adapter: ${yamlString(doc.adapter.id)}`,
    `source_adapter_kind: ${yamlString(doc.adapter.kind)}`,
    `source_adapter_version: ${yamlString(doc.adapter.version)}`,
    `source_scope: ${yamlString(doc.scope)}`,
    ...(doc.source_uri ? [`source_uri: ${yamlString(doc.source_uri)}`] : []),
    '---',
  ].join('\n');
  const markdown = `${frontmatter}\n# ${doc.title}\n\n${doc.text.replace(/\s+$/u, '')}\n`;
  if (containsSecretLikeContent(markdown)) throw new Error('source_adapter_markdown_contains_secret_like_content');
  return markdown;
}
