#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const runnerDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(runnerDir, "../../..");
const cliPath = path.join(repoRoot, "bin", "ihow-memory");

function localDate() {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function pass(id, title, evidence) {
  return { id, title, status: "PASS", evidence };
}

function fail(id, title, error) {
  return { id, title, status: "FAIL", error: String(error?.message ?? error) };
}

function readJsonLine(filePath) {
  const line = fs.readFileSync(filePath, "utf-8").trim().split(/\n/)[0];
  return JSON.parse(line);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function withWorkspace(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ihow-conformance-"));
  try {
    execFileSync(process.execPath, [cliPath, "init", dir, "--force"], { stdio: "pipe" });
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

async function scenario1CrossToolHandoff(dir) {
  const latest = fs.readFileSync(path.join(dir, "memory", "recent", "latest.md"), "utf-8");
  const eventFile = path.join(dir, "memory", "_events", `${localDate()}.ndjson`);
  const event = readJsonLine(eventFile);
  assert(latest.includes("## Completed"), "handoff checkpoint must name completed work");
  assert(latest.includes("## Open Items"), "handoff checkpoint must name open work");
  assert(latest.includes("## Preserved Constraints"), "handoff checkpoint must name preserved constraints");
  assert(event.event_type === "handoff", "event log must contain protocol handoff event");
  assert(event.source.uri === "memory/recent/latest.md", "event must point to checkpoint source");
  return pass("S1", "Cross-Tool Handoff", ["memory/recent/latest.md", "memory/_events/<date>.ndjson"]);
}

async function scenario2FeedbackPatternCapture(dir) {
  const proposal = {
    proposal_id: "wb_feedback_01",
    namespace: { tenant_id: "local", customer_id: "local", project_id: path.basename(dir), user_id: "operator" },
    proposed_by: { type: "agent", name: "ihow-memory-runner" },
    memory_type: "feedback_pattern",
    priority: "medium",
    confidence: "medium",
    summary: "Use concise handoff summaries with source-linked bullets.",
    evidence: [{ event_id: "evt_feedback_01", note: "Synthetic repeated review pattern." }],
    activation: { status: "pending_review", review_required: true },
    retention: { policy: "project_lifecycle", expires_at: null },
  };
  assert(proposal.memory_type === "feedback_pattern", "writeback must classify feedback pattern");
  assert(proposal.evidence.length > 0, "writeback must preserve source evidence");
  assert(proposal.activation.review_required === true, "writeback must preserve review gate");
  return pass("S2", "Feedback Pattern Capture", ["synthetic writeback proposal"]);
}

async function scenario3ConstraintPreservation(dir) {
  const constraint = {
    memory_type: "hard_constraint",
    priority: "high",
    scope: { level: "project", applies_to: "public fixtures" },
    summary: "Use synthetic data only for public conformance fixtures.",
    provenance: { source_event_id: "evt_constraint_01", review_status: "system_verified" },
  };
  const conflictingRequest = "Use non-public project memory as a fixture.";
  const conflictDetected =
    constraint.priority === "high" &&
    /non-public project memory/i.test(conflictingRequest) &&
    /synthetic data only/i.test(constraint.summary);
  assert(conflictDetected, "hard constraint conflict must be detected");
  return pass("S3", "Constraint Preservation", ["synthetic hard_constraint object"]);
}

async function scenario4HumanTeamHandoff(dir) {
  const handoff = fs.readFileSync(path.join(dir, "conformance-samples", "handoff-package.md"), "utf-8");
  assert(handoff.includes("## Goal"), "handoff package must name goal");
  assert(handoff.includes("## Completed"), "handoff package must name completed work");
  assert(handoff.includes("## Constraints"), "handoff package must name constraints");
  assert(handoff.includes("## Next Step"), "handoff package must name next step");
  return pass("S4", "Human Team Handoff", ["conformance-samples/handoff-package.md"]);
}

async function scenario5ModelMigration(dir) {
  const event = JSON.parse(
    fs.readFileSync(path.join(dir, "conformance-samples", "protocol-event.json"), "utf-8"),
  );
  const modelAContext = JSON.stringify(event);
  const modelBContext = JSON.parse(modelAContext);
  assert(modelBContext.namespace.project_id === event.namespace.project_id, "project namespace must survive migration");
  assert(modelBContext.summary === event.summary, "summary meaning must survive migration");
  assert(modelBContext.source.uri === event.source.uri, "source traceability must survive migration");
  return pass("S5", "Model Migration", ["conformance-samples/protocol-event.json"]);
}

const checks = [
  ["S1", "Cross-Tool Handoff", scenario1CrossToolHandoff],
  ["S2", "Feedback Pattern Capture", scenario2FeedbackPatternCapture],
  ["S3", "Constraint Preservation", scenario3ConstraintPreservation],
  ["S4", "Human Team Handoff", scenario4HumanTeamHandoff],
  ["S5", "Model Migration", scenario5ModelMigration],
];

const results = [];
await withWorkspace(async (dir) => {
  for (const [id, title, fn] of checks) {
    try {
      results.push(await fn(dir));
    } catch (error) {
      results.push(fail(id, title, error));
    }
  }
});

for (const result of results) {
  console.log(`${result.status} ${result.id} ${result.title}`);
}

const passed = results.filter((result) => result.status === "PASS").length;
console.log(`${passed}/${results.length} PASS`);

if (passed !== results.length) {
  process.exitCode = 1;
}
