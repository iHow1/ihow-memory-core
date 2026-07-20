// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { openCore } from '../src/core.ts';
import { candidateCodeIdentity, CANDIDATE_IDENTITY_FILES, loadAndValidate, evaluateCompare, adjudicateLiveHybridExecution, scoreRows, percentile, runGate, seed, DEFAULT_FIXTURE, DEFAULT_MANIFEST, MANIFEST_KEYS } from '../scripts/semantic-activation-gate.mjs';

const GATE = path.resolve('scripts/semantic-activation-gate.mjs');
const cli = (args, options={}) => spawnSync(process.execPath, ['--experimental-strip-types', GATE, ...args], {encoding:'utf8', ...options});

test('semantic activation gate artifacts exist and are importable', async () => {
  const gate = await import('../scripts/semantic-activation-gate.mjs');
  assert.equal(typeof gate.runGate, 'function');
});

test('fixture and manifest freeze exact hashes, keys, count, composition, and case order', async () => {
  const { fixture, manifest } = await loadAndValidate();
  assert.equal(fixture.documents.length, 37);
  assert.deepEqual(Object.keys(manifest), MANIFEST_KEYS);
  assert.deepEqual(manifest.documentComposition, {'public-current':24,'stale-superseded':5,private:4,'forbidden-harmful':2,'hard-negative':2});
  assert.equal(manifest.model.id, 'bge-m3');
  assert.equal(manifest.model.expectedDimension, 1024);
  assert.deepEqual(manifest.latencyProfiles.deterministicOracle, {searchP50MsMax:500,searchP95MsMax:1000,indexMsMax:5000});
  assert.deepEqual(manifest.latencyProfiles.realGate, {searchP50MsMax:1500,searchP95MsMax:3000,indexMsMax:600000});
});

test('Gate seed writes bounded document_id and only valid explicit superseded_by metadata', async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'gate-seed-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const core = await openCore({ root, space: 'gate-seed' });
  await seed(core, { documents: [
    { path: 'memory/current.md', documentId: 'current:v1', text: 'current', visibility: 'public' },
    { path: 'memory/stale.md', documentId: 'stale:v1', supersededBy: 'current:v1', text: 'stale', visibility: 'public' },
    { path: 'memory/invalid.md', documentId: 'invalid', supersededBy: '../not-an-id', text: 'invalid', visibility: 'public' },
  ] }, false);
  const current = await fs.readFile(path.join(core.workspace.spaceDir, 'memory/current.md'), 'utf8');
  const stale = await fs.readFile(path.join(core.workspace.spaceDir, 'memory/stale.md'), 'utf8');
  const invalid = await fs.readFile(path.join(core.workspace.spaceDir, 'memory/invalid.md'), 'utf8');
  assert.match(current, /^---\n[\s\S]*document_id: "current:v1"/);
  assert.doesNotMatch(current, /superseded_by|\nstate:/);
  assert.match(stale, /superseded_by: "current:v1"/);
  assert.doesNotMatch(invalid, /superseded_by|\nstate:/);
});

test('compact offline real-rank replay locks A2 closure metrics without query text or model execution', () => {
  const A = (caseId, language, category, gold, rank, stale = []) => ({ caseId, language, category, expected: 'answer', goldIds: [gold], currentIds: [gold], staleIds: stale, rankedIds: rank, injectedIds: [] });
  const rows = [
    A('en-paraphrase-auth','en','paraphrase','en-auth-current',['en-flags-current','en-time-current','zh-auth-current','en-cache-current','en-auth-current','en-auth-stale'],['en-auth-stale']),
    A('en-paraphrase-storage','en','paraphrase','en-storage-current',['en-storage-current']), A('en-paraphrase-handoff','en','paraphrase','en-handoff-current',['en-handoff-current']), A('en-paraphrase-pagination','en','paraphrase','en-pagination-current',['en-auth-stale','en-auth-current','zh-pagination-current','en-pagination-current']),
    A('zh-paraphrase-auth','zh','paraphrase','zh-auth-current',['zh-auth-current','zh-auth-stale'],['zh-auth-stale']), A('zh-paraphrase-storage','zh','paraphrase','zh-storage-current',['zh-storage-current']), A('zh-paraphrase-handoff','zh','paraphrase','zh-handoff-current',['zh-handoff-current']), A('zh-paraphrase-pagination','zh','paraphrase','zh-pagination-current',['zh-pagination-current']),
    A('en-keyword-cache','en','keyword','en-cache-current',['en-cache-current','en-cache-stale'],['en-cache-stale']), A('en-partial-retry','en','partial','en-retry-current',['en-retry-current']), A('zh-keyword-cache','zh','keyword','zh-cache-current',['zh-cache-current','zh-cache-stale'],['zh-cache-stale']), A('zh-partial-retry','zh','partial','zh-retry-current',['zh-retry-current']),
    A('en-current-over-stale','en','current-vs-stale','en-auth-current',['en-auth-current','en-auth-stale'],['en-auth-stale']), A('zh-current-over-stale','zh','current-vs-stale','zh-cache-current',['zh-cache-current','zh-cache-stale'],['zh-cache-stale']),
    { caseId:'noanswer-private-en',language:'en',category:'privacy',expected:'no-answer',goldIds:[],currentIds:[],staleIds:[],rankedIds:[],injectedIds:[] }, { caseId:'noanswer-private-zh',language:'zh',category:'privacy',expected:'no-answer',goldIds:[],currentIds:[],staleIds:[],rankedIds:[],injectedIds:[] },
    { caseId:'noanswer-forbidden',language:'en',category:'safety',expected:'no-answer',goldIds:[],currentIds:[],staleIds:[],rankedIds:[],injectedIds:[] }, { caseId:'noanswer-harmful',language:'zh',category:'safety',expected:'no-answer',goldIds:[],currentIds:[],staleIds:[],rankedIds:[],injectedIds:[] },
    A('hard-negative-cache','en','hard-negative','en-cache-current',['en-cache-current','en-cache-stale'],['en-cache-stale']), A('hard-negative-queue','zh','hard-negative','zh-queue-current',['zh-queue-current']),
  ];
  const metrics = scoreRows(rows);
  assert.deepEqual({ recall5: metrics.recall5, enRecall5: metrics.enRecall5, zhRecall5: metrics.zhRecall5 }, { recall5: 1, enRecall5: 1, zhRecall5: 1 });
  assert.ok(metrics.mrr >= 0.9, `MRR ${metrics.mrr} must remain above the sealed acceptance floor`);
  const failures = rows.filter((r) => r.expected === 'answer' && !r.currentIds.some((id) => r.rankedIds.slice(0, 5).includes(id)));
  const staleBeforeCurrent = rows.filter((r) => r.staleIds.some((id) => r.rankedIds.indexOf(id) >= 0 && r.rankedIds.indexOf(id) < Math.min(...r.currentIds.map((x) => r.rankedIds.indexOf(x)).filter((x) => x >= 0))));
  assert.deepEqual(failures, []);
  assert.deepEqual(staleBeforeCurrent, []);
  assert.ok(rows.filter((r) => ['keyword','partial'].includes(r.category)).every((r) => r.goldIds.some((id) => r.rankedIds.slice(0, 5).includes(id))), 'no keyword/partial regression');
});

test('CLI help is usage-only and creates no files or temporary roots', async (t) => {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'gate-help-')); t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const result=cli(['--help'],{cwd:base,env:{...process.env,TMPDIR:base}});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/^Usage:/);
  assert.doesNotMatch(result.stdout,/\{\s*"fixture"/);
  assert.equal(result.stderr,'');
  assert.deepEqual(await fs.readdir(base),[]);
});

test('CLI rejects implicit oracle, missing and duplicate provider flags, and lexical provider args', () => {
  const cases=[
    [['hybrid','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','vector-gguf','--baseline','lexical.json','--output','hybrid.json'],'cli_missing_provider_command'],
    [['hybrid','--oracle','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','vector-gguf','--baseline','lexical.json','--output','hybrid.json'],'cli_oracle_requires_deterministic_test'],
    [['lexical','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','fts','--provider-command','fake','--output','lexical.json'],'cli_lexical_forbids_provider_args'],
    [['lexical','--fixture',DEFAULT_FIXTURE,'--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','fts','--output','lexical.json'],'cli_duplicate_flag'],
  ];
  for (const [args,code] of cases) { const r=cli(args); assert.notEqual(r.status,0); assert.equal(r.stderr.trim(),code); }
});

test('library hybrid requires explicit provider mode and oracle is test-only explicit', async () => {
  await assert.rejects(runGate({mode:'hybrid'}),/provider_mode_required/);
  const report=await runGate({mode:'hybrid',providerMode:'oracle',deterministicTest:true});
  assert.equal(report.arm,'hybrid');
  await assert.rejects(runGate({mode:'hybrid',providerMode:'oracle'}),/oracle_requires_deterministic_test/);
});

test('fixture raw/hash/order drift is rejected before execution', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-drift-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const fixture=JSON.parse(await fs.readFile(DEFAULT_FIXTURE,'utf8')); fixture.cases.reverse();
  const fixturePath=path.join(dir,'fixture.json'); await fs.writeFile(fixturePath,JSON.stringify(fixture));
  await assert.rejects(loadAndValidate({fixturePath,manifestPath:DEFAULT_MANIFEST}),/fixture_raw_sha256_drift/);
});

function passingReport(manifest,{profile='deterministicOracle',evidenceKind='diagnostic'}={}) {
  const row=(caseId,language,category,gold='g')=>({caseId,language,category,expected:'answer',goldIds:[gold],currentIds:[gold],rankedIds:[gold],injectedIds:[gold],staleIds:[],privateIds:[],forbiddenIds:[],harmfulIds:[]});
  const lexicalRows=[row('e1','en','paraphrase'),row('e2','en','paraphrase'),row('z1','zh','paraphrase'),row('z2','zh','paraphrase')].map((r)=>({...r,rankedIds:[],injectedIds:[]}));
  const hybridRows=[row('e1','en','paraphrase'),row('e2','en','paraphrase'),row('z1','zh','paraphrase'),row('z2','zh','paraphrase')];
  const lexicalMetrics=scoreRows(lexicalRows),metrics=scoreRows(hybridRows);
  const budget=manifest.latencyProfiles.deterministicOracle;
  return {profile,evidenceKind,executionSource:'oracle',lexical:{rows:lexicalRows,metrics:lexicalMetrics,profile:'providerNeutral',evidenceKind:'diagnostic',executionSource:'providerNeutral',identity:{executionSource:'providerNeutral'}},hybrid:{rows:hybridRows,metrics,profile,evidenceKind,executionSource:'oracle',identity:{executionSource:'oracle'}},providerTruth:{hybridRan:true,requested:'vector-gguf',active:'vector-gguf',model:'bge-m3',dimension:1024,indexed:37,ready:true,fallback:false,lastError:null},restart:{identical:true,extraIndexRequests:0},latency:{searchP50Ms:budget.searchP50MsMax,searchP95Ms:budget.searchP95MsMax,indexMs:budget.indexMsMax}};
}

test('fallback, false provider truth, model, dimension, and indexed count fail closed', async () => {
  const {manifest}=await loadAndValidate();
  for (const patch of [{fallback:true},{hybridRan:false},{model:'other'},{dimension:8},{indexed:36},{ready:false}]) {
    const r=passingReport(manifest); Object.assign(r.providerTruth,patch);
    assert.throws(()=>evaluateCompare(r,manifest),/provider_truth_failed/);
  }
});

test('zero or negative required paraphrase delta is rejected', async () => {
  const {manifest}=await loadAndValidate(); const r=passingReport(manifest);
  r.lexical.rows=r.hybrid.rows.map((x)=>({...x}));
  r.lexical.metrics=scoreRows(r.lexical.rows);
  assert.throws(()=>evaluateCompare(r,manifest),/required_delta_failed/);
});

test('stale, private, forbidden, harmful, and no-answer injection leak is rejected', async () => {
  const {manifest}=await loadAndValidate();
  for (const kind of ['stale','private','forbidden','harmful']) {
    const r=passingReport(manifest); const row=r.hybrid.rows[0]; row.injectedIds=['leak']; row[`${kind}Ids`]=['leak'];
    r.hybrid.metrics=scoreRows(r.hybrid.rows);
    assert.throws(()=>evaluateCompare(r,manifest),/(stale|restricted|privacy)_injection_leak/);
  }
});

test('restart rank/hash drift or an extra index request is rejected', async () => {
  const {manifest}=await loadAndValidate();
  for (const restart of [{identical:false,extraIndexRequests:0},{identical:true,extraIndexRequests:1}]) { const r=passingReport(manifest);r.restart=restart;assert.throws(()=>evaluateCompare(r,manifest),/restart_drift/); }
});

test('p50/p95 use nearest-rank; frozen oracle latency is diagnostic', async () => {
  assert.equal(percentile([9,1,5,3],.5),3); assert.equal(percentile([9,1,5,3],.95),9);
  const {manifest}=await loadAndValidate();
  const oracle=passingReport(manifest); oracle.latency={searchP50Ms:1e9,searchP95Ms:1e9,indexMs:1e9};
  assert.equal(evaluateCompare(oracle,manifest,{profile:'deterministicOracle',evidenceKind:'diagnostic'}).pass,true);
});

test('standalone compare rejects exact oracle-to-real relabel attack and tampered stored metrics', async () => {
  const {manifest}=await loadAndValidate();
  const relabeled=passingReport(manifest);
  relabeled.profile='realGate';relabeled.evidenceKind='measured';relabeled.executionSource='command';
  for(const arm of [relabeled.lexical,relabeled.hybrid]){arm.profile='realGate';arm.evidenceKind='measured';arm.executionSource='command';}
  assert.throws(()=>evaluateCompare(relabeled,manifest,{profile:'realGate',evidenceKind:'measured'}),/measured_compare_requires_live_hybrid/);
  const tampered=passingReport(manifest);tampered.hybrid.metrics.mrr=.5;
  assert.throws(()=>evaluateCompare(tampered,manifest),/stored_metrics_mismatch/);
});

test('controller adjudicates only an observed successful live hybrid and never needs standalone compare', () => {
  const report={profile:'realGate',evidenceKind:'measured',executionSource:'command',acceptance:{pass:true,profile:'realGate',evidenceKind:'measured',latencyGated:true}};
  assert.deepEqual(adjudicateLiveHybridExecution({exitCode:0,externalCompetitors:[],observedExecutionSource:'command',report}),{pass:true,classification:'PASS_LIVE_MEASURED_HYBRID'});
  assert.throws(()=>adjudicateLiveHybridExecution({exitCode:0,externalCompetitors:[],observedExecutionSource:null,report}),/live_hybrid_not_observed/);
  assert.throws(()=>adjudicateLiveHybridExecution({exitCode:0,externalCompetitors:['external test'],observedExecutionSource:'command',report}),/live_hybrid_external_competitor/);
  assert.throws(()=>adjudicateLiveHybridExecution({exitCode:0,externalCompetitors:[],observedExecutionSource:'command',report:{...report,executionSource:'oracle'}}),/live_hybrid_report_contract_invalid/);
  assert.throws(()=>adjudicateLiveHybridExecution({exitCode:0,externalCompetitors:[],observedExecutionSource:'command',report:{...report,acceptance:{...report.acceptance,pass:false}}}),/live_hybrid_acceptance_failed/);
});

test('offline oracle compare passes, never writes live semantic config, and cleans roots', {timeout:60000}, async (t) => {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'gate-cleanup-')); t.after(()=>fs.rm(base,{recursive:true,force:true}));
  const liveMarker=path.join(process.cwd(),'.runtime','semantic.json'); let before=false; try{await fs.access(liveMarker);before=true;}catch{}
  const report=await runGate({mode:'compare',providerMode:'oracle',deterministicTest:true,tempBase:base});
  assert.equal(report.acceptance.pass,true); assert.equal(report.fixture.documents,37); assert.equal(report.restart.extraIndexRequests,0);
  assert.equal(report.profile,'deterministicOracle'); assert.equal(report.evidenceKind,'diagnostic'); assert.equal(report.acceptance.latencyGated,false);
  assert.equal(report.executionSource,'oracle'); assert.match(report.hybrid.indexIdentity,/^[a-f0-9]{64}$/);
  assert.ok(report.latency.searchP50Ms>0); assert.ok(report.latency.searchP95Ms>0); assert.ok(report.latency.indexMs>0);
  assert.deepEqual(await fs.readdir(base),[]);
  let after=false; try{await fs.access(liveMarker);after=true;}catch{} assert.equal(after,before);
  assert.ok(report.hybrid.rows.every((r)=>r.staleIds.every((id)=>!r.injectedIds.includes(id))));
});

test('CLI lexical and explicit-oracle hybrid write bounded reports; compare reads them', {timeout:30000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-cli-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const lexical=path.join(dir,'lexical.json'),hybrid=path.join(dir,'hybrid.json');
  let r=cli(['lexical','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','fts','--output',lexical]);
  assert.equal(r.status,0,r.stderr); assert.equal(r.stdout,'');
  r=cli(['hybrid','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','vector-gguf','--oracle','--deterministic-test','--baseline',lexical,'--output',hybrid]);
  assert.equal(r.status,0,r.stderr); assert.equal(r.stdout,'');
  r=cli(['compare','--manifest',DEFAULT_MANIFEST,'--lexical',lexical,'--hybrid',hybrid]);
  assert.equal(r.status,0,r.stderr); assert.deepEqual(JSON.parse(r.stdout),{pass:true});
  const fixture=JSON.parse(await fs.readFile(DEFAULT_FIXTURE,'utf8')),bytes=await fs.readFile(hybrid,'utf8');
  assert.doesNotMatch(bytes,new RegExp(fixture.documents.find((d)=>d.visibility==='private').text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.doesNotMatch(bytes,new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.ok(bytes.length<100000);
});

test('standalone compare rejects fully relabeled oracle files and tampered metrics', {timeout:90000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-relabel-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const lexical=await runGate({mode:'lexical',tempBase:dir});
  const hybrid=await runGate({mode:'hybrid',providerMode:'oracle',deterministicTest:true,tempBase:dir,baselineReport:lexical});
  for(const arm of [lexical,hybrid]){arm.profile='realGate';arm.evidenceKind='measured';arm.executionSource='command';}
  hybrid.acceptance={...hybrid.acceptance,profile:'realGate',evidenceKind:'measured',latencyGated:true};
  const l=path.join(dir,'lexical.json'),h=path.join(dir,'hybrid.json');await fs.writeFile(l,JSON.stringify(lexical));await fs.writeFile(h,JSON.stringify(hybrid));
  let r=cli(['compare','--manifest',DEFAULT_MANIFEST,'--lexical',l,'--hybrid',h]);assert.notEqual(r.status,0);assert.equal(r.stderr.trim(),'measured_compare_requires_live_hybrid');
  const diagnostic=await runGate({mode:'hybrid',providerMode:'oracle',deterministicTest:true,tempBase:dir});diagnostic.metrics.mrr=0;
  await fs.writeFile(l,JSON.stringify(await runGate({mode:'lexical',tempBase:dir})));await fs.writeFile(h,JSON.stringify(diagnostic));
  r=cli(['compare','--manifest',DEFAULT_MANIFEST,'--lexical',l,'--hybrid',h]);assert.notEqual(r.status,0);assert.equal(r.stderr.trim(),'stored_metrics_mismatch');
});

test('compare fails closed on code, fixture, manifest, query order, provider, model, and dimension drift', {timeout:90000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-identity-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const lexical=await runGate({mode:'lexical',tempBase:dir});
  const hybrid=await runGate({mode:'hybrid',providerMode:'oracle',deterministicTest:true,tempBase:dir});
  const {manifest}=await loadAndValidate();
  const boundedLatency={searchP50Ms:manifest.latencyProfiles.deterministicOracle.searchP50MsMax,searchP95Ms:manifest.latencyProfiles.deterministicOracle.searchP95MsMax,indexMs:manifest.latencyProfiles.deterministicOracle.indexMsMax};
  lexical.latency={...boundedLatency}; hybrid.latency={...boundedLatency};
  for (const [mutate,reason] of [
    [(x)=>x.identity.code='changed','report_identity_code_mismatch'],
    [(x)=>x.identity.fixture='changed','report_identity_fixture_mismatch'],
    [(x)=>x.identity.manifest='changed','report_manifest_input_mismatch'],
    [(x)=>x.identity.queryOrder.reverse(),'report_query_order_mismatch'],
    [(x)=>x.provider.active='fts','provider_truth_failed'],
    [(x)=>x.provider.model='changed','provider_truth_failed'],
    [(x)=>x.provider.dimension=8,'provider_truth_failed'],
  ]) {
    const l=path.join(dir,`l-${crypto.randomUUID()}.json`),h=path.join(dir,`h-${crypto.randomUUID()}.json`);
    const changed=structuredClone(hybrid);mutate(changed);await fs.writeFile(l,JSON.stringify(lexical));await fs.writeFile(h,JSON.stringify(changed));
    const r=cli(['compare','--manifest',DEFAULT_MANIFEST,'--lexical',l,'--hybrid',h]);assert.notEqual(r.status,0);assert.equal(r.stderr.trim(),reason);
  }
});

test('candidate identity binds HEAD plus the exact activation allowlist only', async (t) => {
  const repoRoot=await fs.mkdtemp(path.join(os.tmpdir(),'gate-code-identity-'));t.after(()=>fs.rm(repoRoot,{recursive:true,force:true}));
  for(const relative of CANDIDATE_IDENTITY_FILES){const file=path.join(repoRoot,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,`bound:${relative}\n`);}
  await fs.mkdir(path.join(repoRoot,'.git'));const git=path.join(repoRoot,'fake-git.mjs');await fs.writeFile(git,"#!/usr/bin/env node\nprocess.stdout.write('0123456789abcdef0123456789abcdef01234567\\n');\n");await fs.chmod(git,0o755);
  const first=await candidateCodeIdentity({repoRoot,gitCommand:git});
  assert.match(first,/^[a-f0-9]{64}$/);

  const bound=path.join(repoRoot,CANDIDATE_IDENTITY_FILES[0]);const original=await fs.readFile(bound);
  await fs.appendFile(bound,'candidate mutation\n');
  assert.notEqual(await candidateCodeIdentity({repoRoot,gitCommand:git}),first,'bound file mutation must change identity at the same HEAD');

  const unrelated=path.join(repoRoot,'notes','unrelated.txt');await fs.mkdir(path.dirname(unrelated),{recursive:true});await fs.writeFile(unrelated,'unrelated mutation\n');
  const withBoundMutation=await candidateCodeIdentity({repoRoot,gitCommand:git});await fs.appendFile(unrelated,'more unrelated mutation\n');
  assert.equal(await candidateCodeIdentity({repoRoot,gitCommand:git}),withBoundMutation,'unrelated dirty files must not affect identity');

  await fs.writeFile(bound,original);
  assert.equal(await candidateCodeIdentity({repoRoot,gitCommand:git}),first,'restoring exact bound bytes must restore identity');
});

test('candidate identity binds representative indexing, governance, and prompt-recall transitive dependencies', async (t) => {
  const repoRoot=await fs.mkdtemp(path.join(os.tmpdir(),'gate-code-transitive-'));t.after(()=>fs.rm(repoRoot,{recursive:true,force:true}));
  for(const relative of CANDIDATE_IDENTITY_FILES){const file=path.join(repoRoot,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,`bound:${relative}\n`);}
  const git=path.join(repoRoot,'fake-git.mjs');await fs.writeFile(git,"#!/usr/bin/env node\nprocess.stdout.write('0123456789abcdef0123456789abcdef01234567\\n');\n");await fs.chmod(git,0o755);
  const first=await candidateCodeIdentity({repoRoot,gitCommand:git});
  for(const relative of ['src/engine/fts.ts','src/governance.ts','src/temporal-entities.ts']){
    assert.ok(CANDIDATE_IDENTITY_FILES.includes(relative),`${relative} must be statically bound`);
    const file=path.join(repoRoot,relative),original=await fs.readFile(file);
    await fs.appendFile(file,'transitive mutation\n');
    assert.notEqual(await candidateCodeIdentity({repoRoot,gitCommand:git}),first,`${relative} mutation must change identity`);
    await fs.writeFile(file,original);
    assert.equal(await candidateCodeIdentity({repoRoot,gitCommand:git}),first,`${relative} restored bytes must restore identity`);
  }
  const unrelated=path.join(repoRoot,'src','unrelated-activation-output.ts');await fs.writeFile(unrelated,'ignored\n');
  assert.equal(await candidateCodeIdentity({repoRoot,gitCommand:git}),first,'unrelated files remain ignored');
});

test('candidate identity fails closed with a bounded path-free error when a bound file is missing', async (t) => {
  const repoRoot=await fs.mkdtemp(path.join(os.tmpdir(),'gate-code-identity-missing-'));t.after(()=>fs.rm(repoRoot,{recursive:true,force:true}));
  const git=path.join(repoRoot,'fake-git.mjs');await fs.writeFile(git,"#!/usr/bin/env node\nprocess.stdout.write('0123456789abcdef0123456789abcdef01234567\\n');\n");await fs.chmod(git,0o755);
  await assert.rejects(candidateCodeIdentity({repoRoot,gitCommand:git}),error=>error?.message==='candidate_identity_input_missing');
});

test('real provider command is propagated exactly and restart sends zero extra index request', {timeout:30000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-provider-')); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const provider=path.join(dir,'fake-provider.mjs'),state=path.join(dir,'state.json');
  await fs.writeFile(provider, `
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(DEFAULT_FIXTURE)},'utf8'));
const statePath=${JSON.stringify(state)}, marker=process.argv[2], method=process.argv.at(-1);
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
  const req=JSON.parse(input), old=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{indexRequests:0,markers:[]};old.markers.push(marker);
  if(method==='status'){fs.writeFileSync(statePath,JSON.stringify(old));process.stdout.write(JSON.stringify({id:'vector-gguf',model:req.provider.model,dimension:1024,ready:true,cloud:false}));return;}
  if(method==='index'){old.indexRequests++;fs.writeFileSync(statePath,JSON.stringify(old));process.stdout.write(JSON.stringify({indexed:37}));return;}
  const c=fixture.cases.find(x=>x.query===req.query), docs=new Map(fixture.documents.map(d=>[d.documentId,d]));let ids=c.expected==='answer'?[...c.currentIds,...c.goldIds]:[...c.privateIds,...c.forbiddenIds,...c.harmfulIds];ids.push(...fixture.documents.filter(d=>d.category==='hard-negative').map(d=>d.documentId));
  fs.writeFileSync(statePath,JSON.stringify(old));process.stdout.write(JSON.stringify({hits:[...new Set(ids)].slice(0,10).map((id,i)=>({path:docs.get(id).path,snippet:'bounded',score:.99-i*.03,source:'vector-gguf'}))}));
});`);
  const lexical=await runGate({mode:'lexical',tempBase:dir});
  const command=`${process.execPath} ${provider} exact-marker`;
  const baseline=path.join(dir,'lexical.json'),output=path.join(dir,'hybrid.json');await fs.writeFile(baseline,JSON.stringify(lexical));
  const result=cli(['hybrid','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','vector-gguf','--provider-command',command,'--model','bge-m3','--expected-dimension','1024','--vector-timeout-ms','30000','--vector-index-timeout-ms','600000','--reuse-index-for-restart','--baseline',baseline,'--output',output],{env:{...process.env,TMPDIR:dir}});
  assert.equal(result.status,0,result.stderr);const hybrid=JSON.parse(await fs.readFile(output,'utf8'));
  assert.equal(hybrid.acceptance.pass,true);assert.deepEqual({before:hybrid.restart.indexRequestsBefore,after:hybrid.restart.indexRequestsAfter,extra:hybrid.restart.extraIndexRequests},{before:1,after:1,extra:0});
  const observed=JSON.parse(await fs.readFile(state,'utf8'));assert.equal(observed.indexRequests,1);assert.ok(observed.markers.every((x)=>x==='exact-marker'));
  assert.deepEqual(await fs.readdir(dir).then((xs)=>xs.filter((x)=>x.startsWith('ihow-semantic-gate-'))),[]);
});

async function writeRestartProvider(dir,{indexOnReopen=false,driftManifest=false}={}) {
  const provider=path.join(dir,'restart-provider.mjs'),state=path.join(dir,'provider-state.json');
  await fs.writeFile(provider, `
import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(DEFAULT_FIXTURE)},'utf8')),statePath=${JSON.stringify(state)},method=process.argv.at(-1);
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const req=JSON.parse(input),s=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{index:0,search:0,status:0};s[method]++;
if(method==='status'){if(${driftManifest}&&s.search>=40){const manifest=JSON.parse(fs.readFileSync(req.workspace.indexManifestPath,'utf8'));manifest.modelId='drifted-with-identical-rankings';fs.writeFileSync(req.workspace.indexManifestPath,JSON.stringify(manifest));s.drifted=true;}fs.writeFileSync(statePath,JSON.stringify(s));process.stdout.write(JSON.stringify({id:'vector-gguf',model:req.provider.model,dimension:1024,ready:true,cloud:false}));return;}
if(method==='index'){fs.writeFileSync(statePath,JSON.stringify(s));process.stdout.write(JSON.stringify({indexed:37}));return;}
if(${indexOnReopen}&&s.search===21){const commandKey=Object.keys(process.env).find(k=>k.startsWith('IHOW_GATE_PROVIDER_')),counterKey=Object.keys(process.env).find(k=>k.startsWith('IHOW_GATE_COUNTER_')),wrapper=path.join(path.dirname(process.env[counterKey]),'provider-counter-proxy.mjs'),nested=spawnSync(process.execPath,[wrapper,commandKey,counterKey,'index'],{input:JSON.stringify({method:'index',workspace:req.workspace,provider:req.provider}),encoding:'utf8'});if(nested.status!==0){s.nested={status:nested.status,stderr:nested.stderr};fs.writeFileSync(statePath,JSON.stringify(s));throw new Error('nested_index_failed');}}
const c=fixture.cases.find(x=>x.query===req.query),docs=new Map(fixture.documents.map(d=>[d.documentId,d]));let ids=c.expected==='answer'?[...c.currentIds,...c.goldIds]:[...c.privateIds,...c.forbiddenIds,...c.harmfulIds];ids.push(...fixture.documents.filter(d=>d.category==='hard-negative').map(d=>d.documentId));fs.writeFileSync(statePath,JSON.stringify(s));process.stdout.write(JSON.stringify({hits:[...new Set(ids)].slice(0,10).map((id,i)=>({path:docs.get(id).path,snippet:'bounded',score:.99-i*.03,source:'vector-gguf'}))}));});`);
  return {command:`${process.execPath} ${provider}`,state};
}

async function runContractFailureCli(dir,{reason,preseed}) {
  const lexical=path.join(dir,'lexical.json'),output=path.join(dir,'hybrid.json');
  let result=cli(['lexical','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','fts','--output',lexical],{env:{...process.env,NODE_NO_WARNINGS:'1',TMPDIR:dir}});
  assert.equal(result.status,0,result.stderr);
  if(preseed!==undefined)await fs.writeFile(output,preseed);
  let command;
  if(reason==='restart_drift')({command}=await writeRestartProvider(dir,{indexOnReopen:true}));
  else {
    const provider=path.join(dir,'contract-provider-canary.mjs');
    await fs.writeFile(provider, `
import fs from 'node:fs';
const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(DEFAULT_FIXTURE)},'utf8')),method=process.argv.at(-1);let input='';
process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const req=JSON.parse(input);
if(method==='status'){process.stdout.write(JSON.stringify({id:'vector-gguf',model:'WRONG_MODEL_CANARY',dimension:8,ready:true,cloud:false}));return;}
if(method==='index'){process.stdout.write(JSON.stringify({indexed:37}));return;}
const c=fixture.cases.find(x=>x.query===req.query),docs=new Map(fixture.documents.map(d=>[d.documentId,d]));let ids=c.expected==='answer'?[...c.currentIds,...c.goldIds]:[...c.privateIds,...c.forbiddenIds,...c.harmfulIds];
process.stdout.write(JSON.stringify({hits:[...new Set(ids)].slice(0,10).map((id,i)=>({path:docs.get(id).path,snippet:'PROVIDER_CONTRACT_SNIPPET_CANARY',score:.99-i*.03,source:'vector-gguf'}))}));});`);
    command=`${process.execPath} ${provider} PROVIDER_CONTRACT_ARG_CANARY`;
  }
  result=cli(['hybrid','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','vector-gguf','--provider-command',command,'--model','bge-m3','--expected-dimension','1024','--vector-timeout-ms','30000','--vector-index-timeout-ms','600000','--reuse-index-for-restart','--baseline',lexical,'--output',output],{env:{...process.env,NODE_NO_WARNINGS:'1',TMPDIR:dir,CONTRACT_ENV_CANARY:'CONTRACT_ENV_CANARY_VALUE'}});
  return {result,output};
}

for(const reason of ['restart_drift','provider_contract_mismatch'])test(`hybrid CLI ${reason} atomically replaces stale PASS with a typed bounded FAIL`, {timeout:60000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),`gate-${reason}-`));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const stale='{"pass":true,"outcome":"PASS","canary":"STALE_PASS_CANARY"}\n';
  const {result,output}=await runContractFailureCli(dir,{reason,preseed:stale});
  assert.notEqual(result.status,0);assert.equal(result.stdout,'');assert.equal(result.stderr.trim(),reason);
  const bytes=await fs.readFile(output,'utf8'),artifact=JSON.parse(bytes);
  assert.equal(artifact.reason,reason);assert.equal(artifact.outcome,'FAIL');assert.equal(artifact.pass,false);assert.equal(artifact.stage,'acceptance');assert.notEqual(bytes,stale);
  assert.deepEqual(Object.keys(artifact),['artifactKind','schemaVersion','outcome','pass','stage','reason','profile','evidenceKind','executionSource','identity']);
  assert.ok(Buffer.byteLength(bytes)<=16*1024);
  for(const canary of ['STALE_PASS_CANARY','PROVIDER_CONTRACT_SNIPPET_CANARY','PROVIDER_CONTRACT_ARG_CANARY','WRONG_MODEL_CANARY','CONTRACT_ENV_CANARY_VALUE',dir])assert.doesNotMatch(bytes,new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.deepEqual((await fs.readdir(dir)).filter(name=>name.endsWith('.tmp')),[]);
});

async function writeCurrentNotTop5Provider(dir) {
  const provider=path.join(dir,'private-provider-command-canary.mjs'),state=path.join(dir,'provider-state.json');
  await fs.writeFile(provider, `
import fs from 'node:fs';
const fixture=JSON.parse(fs.readFileSync(${JSON.stringify(DEFAULT_FIXTURE)},'utf8')),statePath=${JSON.stringify(state)},method=process.argv.at(-1);
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const req=JSON.parse(input),s=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{index:0,search:0,status:0};s[method]++;
if(method==='status'){fs.writeFileSync(statePath,JSON.stringify(s));process.stdout.write(JSON.stringify({id:'vector-gguf',model:req.provider.model,dimension:1024,ready:true,cloud:false}));return;}
if(method==='index'){fs.writeFileSync(statePath,JSON.stringify(s));process.stdout.write(JSON.stringify({indexed:37}));return;}
const c=fixture.cases.find(x=>x.query===req.query),docs=new Map(fixture.documents.map(d=>[d.documentId,d])),decoys=fixture.documents.filter(d=>d.category==='hard-negative'||d.type==='distractor').map(d=>d.documentId);
let ids=c.expected==='answer'?[...c.currentIds,...c.goldIds]:[...c.privateIds,...c.forbiddenIds,...c.harmfulIds];
if(c.caseId==='en-paraphrase-auth')ids=[...decoys,...fixture.documents.map(d=>d.documentId).filter(id=>!c.currentIds.includes(id)),...c.currentIds];
fs.writeFileSync(statePath,JSON.stringify(s));process.stdout.write(JSON.stringify({hits:[...new Set(ids)].slice(0,10).map((id,i)=>({path:docs.get(id).path,snippet:'PRIVATE_SNIPPET_CANARY',score:.999-i*.001,source:'vector-gguf'}))}));});`);
  return {command:`${process.execPath} ${provider} PRIVATE_PROVIDER_ARG_CANARY`,state};
}

async function runCurrentNotTop5Cli(dir,{preseed}={}) {
  const lexical=path.join(dir,'lexical.json'),output=path.join(dir,'hybrid.json'),{command}=await writeCurrentNotTop5Provider(dir);
  let result=cli(['lexical','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','fts','--output',lexical],{env:{...process.env,NODE_NO_WARNINGS:'1',TMPDIR:dir,PRIVATE_ENV_CANARY:'PRIVATE_ENV_CANARY_VALUE'}});
  assert.equal(result.status,0,result.stderr);
  if(preseed!==undefined)await fs.writeFile(output,preseed);
  result=cli(['hybrid','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','vector-gguf','--provider-command',command,'--model','bge-m3','--expected-dimension','1024','--vector-timeout-ms','30000','--vector-index-timeout-ms','600000','--reuse-index-for-restart','--baseline',lexical,'--output',output],{env:{...process.env,NODE_NO_WARNINGS:'1',TMPDIR:dir,PRIVATE_ENV_CANARY:'PRIVATE_ENV_CANARY_VALUE'}});
  return {result,lexical,output};
}

test('hybrid CLI acceptance failure writes a bounded typed current_not_top5 artifact', {timeout:30000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-acceptance-fail-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {result,output}=await runCurrentNotTop5Cli(dir);
  assert.notEqual(result.status,0);assert.equal(result.stdout,'');assert.equal(result.stderr.trim(),'current_not_top5');
  const bytes=await fs.readFile(output,'utf8'),artifact=JSON.parse(bytes);
  assert.deepEqual(Object.keys(artifact),['artifactKind','schemaVersion','outcome','pass','stage','reason','profile','evidenceKind','executionSource','identity','diagnostic']);
  assert.deepEqual(artifact,{artifactKind:'semantic-activation-gate-failure',schemaVersion:1,outcome:'FAIL',pass:false,stage:'acceptance',reason:'current_not_top5',profile:'realGate',evidenceKind:'measured',executionSource:'command',identity:artifact.identity,diagnostic:{caseId:'en-paraphrase-auth',topK:5,currentRank:artifact.diagnostic.currentRank}});
  assert.deepEqual(Object.keys(artifact.identity),['code','fixture','manifest','canonical']);
  assert.match(artifact.identity.code,/^[a-f0-9]{64}$/);assert.match(artifact.identity.fixture,/^[a-f0-9]{64}$/);assert.match(artifact.identity.manifest,/^[a-f0-9]{64}$/);assert.match(artifact.identity.canonical,/^[a-f0-9]{64}$/);
  assert.ok(artifact.diagnostic.currentRank===null||(Number.isSafeInteger(artifact.diagnostic.currentRank)&&artifact.diagnostic.currentRank>5));
  assert.ok(Buffer.byteLength(bytes)<=16*1024);
});

test('hybrid acceptance failure atomically replaces stale PASS and redacts execution data', {timeout:30000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-acceptance-replace-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const stale='{"pass":true,"outcome":"PASS","query":"STALE_QUERY_CANARY"}\n';
  const {result,output}=await runCurrentNotTop5Cli(dir,{preseed:stale});assert.notEqual(result.status,0);
  const bytes=await fs.readFile(output,'utf8'),artifact=JSON.parse(bytes),fixture=JSON.parse(await fs.readFile(DEFAULT_FIXTURE,'utf8'));
  assert.equal(artifact.reason,'current_not_top5');assert.notEqual(bytes,stale);
  for(const forbidden of ['query','rows','snippets','text','rankedIds','ranked paths','providerCommand','stdout','stderr','workspace','indexPath','acceptance','arm','error','stack'])assert.equal(Object.hasOwn(artifact,forbidden),false);
  for(const canary of ['STALE_QUERY_CANARY','PRIVATE_SNIPPET_CANARY','PRIVATE_PROVIDER_ARG_CANARY','PRIVATE_ENV_CANARY_VALUE',dir,fixture.cases[0].query,fixture.documents.find(d=>d.visibility==='private').text])assert.doesNotMatch(bytes,new RegExp(canary.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
  assert.deepEqual((await fs.readdir(dir)).filter(name=>name.endsWith('.tmp')),[]);
});

test('compare rejects typed failure artifacts and tampered failure relabel attacks', {timeout:30000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-failure-compare-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {result,lexical,output}=await runCurrentNotTop5Cli(dir);assert.notEqual(result.status,0);
  let compared=cli(['compare','--manifest',DEFAULT_MANIFEST,'--lexical',lexical,'--hybrid',output]);assert.notEqual(compared.status,0);assert.equal(compared.stdout,'');assert.equal(compared.stderr.trim(),'hybrid_input_is_failure_artifact');
  const original=JSON.parse(await fs.readFile(output,'utf8'));
  for(const mutate of [
    x=>x.pass=true,x=>x.outcome='PASS',x=>x.arm='hybrid',x=>x.rows=[],x=>x.acceptance={pass:true},x=>x.diagnostic.caseId='../private/path',x=>x.identity.code='tampered',
  ]) {const tampered=structuredClone(original);mutate(tampered);await fs.writeFile(output,JSON.stringify(tampered));compared=cli(['compare','--manifest',DEFAULT_MANIFEST,'--lexical',lexical,'--hybrid',output]);assert.notEqual(compared.status,0);assert.equal(compared.stdout,'');assert.equal(compared.stderr.trim(),'hybrid_failure_artifact_invalid');}
});

test('restart rejects a secret second index request even when rankings are identical', {timeout:30000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-reindex-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const {command,state}=await writeRestartProvider(dir,{indexOnReopen:true});
  const lexical=await runGate({mode:'lexical',tempBase:dir});let caught;try{await runGate({mode:'hybrid',providerMode:'command',providerCommand:command,baselineReport:lexical,tempBase:dir});}catch(error){caught=error;}
  if(!caught?.restart)assert.fail(JSON.stringify(JSON.parse(await fs.readFile(state,'utf8'))));assert.match(caught?.message||'',/restart_drift/);assert.deepEqual({before:caught.restart.indexRequestsBefore,after:caught.restart.indexRequestsAfter,extra:caught.restart.extraIndexRequests},{before:1,after:2,extra:1});
  assert.equal(JSON.parse(await fs.readFile(state,'utf8')).index,1);
});

test('restart rejects index manifest drift even when rankings are identical', {timeout:30000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-manifest-drift-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const {command,state}=await writeRestartProvider(dir,{driftManifest:true});
  const lexical=await runGate({mode:'lexical',tempBase:dir});await assert.rejects(runGate({mode:'hybrid',providerMode:'command',providerCommand:command,baselineReport:lexical,tempBase:dir}),/restart_drift/);
  assert.equal(JSON.parse(await fs.readFile(state,'utf8')).drifted,true);
});

test('live command hybrid enforces realGate exact threshold pass and epsilon fail', {timeout:60000}, async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-live-latency-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const {command}=await writeRestartProvider(dir);const lexical=await runGate({mode:'lexical',tempBase:dir});
  const runWithClock=async(searchMs,indexMs)=>{const descriptor=Object.getOwnPropertyDescriptor(globalThis,'performance');let now=0,calls=0;Object.defineProperty(globalThis,'performance',{configurable:true,value:{now(){const pair=Math.floor(calls++/2),end=calls%2===0,duration=pair%21===0?indexMs:searchMs;if(end)now+=duration;return now;}}});try{return await runGate({mode:'hybrid',providerMode:'command',providerCommand:command,baselineReport:lexical,tempBase:dir});}finally{Object.defineProperty(globalThis,'performance',descriptor);}};
  const {manifest}=await loadAndValidate(),budget=manifest.latencyProfiles.realGate,exact=await runWithClock(budget.searchP50MsMax,budget.indexMsMax);assert.equal(exact.acceptance.pass,true);assert.equal(exact.acceptance.latencyGated,true);assert.deepEqual(exact.latency,{searchP50Ms:budget.searchP50MsMax,searchP95Ms:budget.searchP50MsMax,indexMs:budget.indexMsMax});
  await assert.rejects(runWithClock(budget.searchP50MsMax+.001,budget.indexMsMax),/latency_threshold_breach/);
});

test('failed CLI output leaves neither report nor atomic temp file', async (t) => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gate-atomic-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const output=path.join(dir,'hybrid.json'),baseline=path.join(dir,'lexical.json');await fs.writeFile(baseline,'{}');
  const r=cli(['hybrid','--fixture',DEFAULT_FIXTURE,'--manifest',DEFAULT_MANIFEST,'--engine','vector-gguf','--oracle','--deterministic-test','--baseline',baseline,'--output',output]);
  assert.notEqual(r.status,0);await assert.rejects(fs.access(output));assert.deepEqual((await fs.readdir(dir)).filter((x)=>x.endsWith('.tmp')),[]);
});

test('cleanup also runs when compare fails before an arm starts', async (t) => {
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'gate-cleanup-fail-')); t.after(()=>fs.rm(base,{recursive:true,force:true}));
  await assert.rejects(runGate({mode:'compare',fixturePath:path.join(base,'missing.json'),tempBase:base}));
  assert.deepEqual(await fs.readdir(base),[]);
});
