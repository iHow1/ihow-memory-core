// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 iHow Memory
//
// Deterministic, desensitized enterprise-style Safe Memory Gardener fixture.
// This intentionally uses generic project/team names only: no customer data,
// private identifiers, production endpoints, credentials, or domain ontology.
import fs from 'node:fs/promises';
import path from 'node:path';

export const ENTERPRISE_GARDENER_SPACE = 'enterprise-gardener-fixture';

export const WORKFLOW_EVENTS = [
  {
    id: 'evt-001-intake',
    actor: 'ops-reviewer',
    lane: 'intake',
    text: 'Decision: Project Orchard will keep approvals review-first before durable memory changes.',
    evidence: 'Synthetic workflow event evt-001-intake from sanitized review meeting notes.',
  },
  {
    id: 'evt-002-policy',
    actor: 'platform-steward',
    lane: 'policy',
    text: 'Fact: Project Orchard source of truth remains the governed Markdown memory store, not exported views.',
    evidence: 'Synthetic workflow event evt-002-policy from sanitized operating model notes.',
  },
  {
    id: 'evt-003-action',
    actor: 'enablement-lead',
    lane: 'delivery',
    text: 'Next action: prepare an evidence-linked digest for the platform review group.',
    evidence: 'Synthetic workflow event evt-003-action from sanitized delivery checklist.',
  },
  {
    id: 'evt-004-question',
    actor: 'ops-reviewer',
    lane: 'intake',
    text: 'Open question: should stale onboarding notes be archived after human approval?',
    evidence: 'Synthetic workflow event evt-004-question from sanitized review meeting notes.',
  },
  {
    id: 'evt-005-duplicate',
    actor: 'platform-steward',
    lane: 'policy',
    text: 'Decision: Project Orchard will keep approvals review-first before durable memory changes.',
    evidence: '',
  },
  {
    id: 'evt-006-stale',
    actor: 'enablement-lead',
    lane: 'delivery',
    text: 'Stale: old bulk rewrite checklist is deprecated and replaced by review-first organize drafts.',
    evidence: 'Synthetic workflow event evt-006-stale from sanitized cleanup plan.',
  },
];

function frontMatter(fields) {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n`;
}

export async function seedEnterpriseGardenerFixture(core) {
  const workflowDir = path.join(core.workspace.spaceDir, 'workflow-events', 'project-orchard');
  await fs.mkdir(workflowDir, { recursive: true });
  await fs.writeFile(
    path.join(workflowDir, 'events.ndjson'),
    `${WORKFLOW_EVENTS.map((event) => JSON.stringify(event)).join('\n')}\n`,
    'utf8',
  );

  const memoryDir = core.workspace.memoryDir;
  await fs.mkdir(path.join(memoryDir, 'scopes/project-orchard'), { recursive: true });
  await fs.mkdir(path.join(memoryDir, 'scopes/private'), { recursive: true });
  await fs.mkdir(path.join(memoryDir, 'audit'), { recursive: true });

  await fs.writeFile(
    path.join(memoryDir, 'scopes/project-orchard/workflow-state.md'),
    `${frontMatter({ visibility: 'project', fixture: 'enterprise-gardener', source: 'synthetic-workflow-events' })}# Project Orchard workflow state\n\n- ${WORKFLOW_EVENTS[0].text}\n- ${WORKFLOW_EVENTS[1].text} (${WORKFLOW_EVENTS[1].evidence})\n- ${WORKFLOW_EVENTS[2].text} (${WORKFLOW_EVENTS[2].evidence})\n`,
    'utf8',
  );

  await fs.writeFile(
    path.join(memoryDir, 'scopes/project-orchard/review-backlog.md'),
    `${frontMatter({ visibility: 'project', fixture: 'enterprise-gardener', source: 'synthetic-workflow-events' })}# Project Orchard review backlog\n\n${WORKFLOW_EVENTS.slice(3).map((event) => event.evidence ? `- ${event.text} (${event.evidence})` : `- ${event.text}`).join('\n')}\n`,
    'utf8',
  );

  await fs.writeFile(
    path.join(memoryDir, 'scopes/private/private-queue.md'),
    `${frontMatter({ visibility: 'private', fixture: 'enterprise-gardener' })}# Private queue\n\n- Fact: private staffing notes are excluded from project-scope gardener exports.\n`,
    'utf8',
  );

  await fs.writeFile(
    path.join(memoryDir, 'audit/raw-routing.md'),
    `${frontMatter({ visibility: 'audit-only', fixture: 'enterprise-gardener' })}# Audit-only routing\n\n- Fact: audit-only routing details are excluded from project-scope gardener exports.\n`,
    'utf8',
  );

  const candidate = await core.write_candidate({
    title: 'Project Orchard candidate digest input',
    text: 'Fact: Project Orchard candidate queue captures synthetic workflow evidence before promotion.',
    sourceAgent: 'enterprise-fixture',
    metadata: { fixture: 'enterprise-gardener', workflowEventIds: WORKFLOW_EVENTS.map((event) => event.id), verified: true },
    autoPromote: false,
  });

  const promoted = await core.promote(candidate.path, {
    scope: 'project-orchard',
    title: 'Candidate queue captured synthetic workflow evidence',
  });

  return { workflowEvents: WORKFLOW_EVENTS, candidate, promoted };
}
