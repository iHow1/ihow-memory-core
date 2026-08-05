#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openCore } from '../src/core.ts';
import { selectPromptRecall, renderPromptRecall } from '../src/prompt-recall.ts';

const HERE=path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE=path.join(HERE,'..','eval','semantic-activation','v1','fixture.json');
export const DEFAULT_MANIFEST=path.join(HERE,'..','eval','semantic-activation','v1','manifest.json');
export const MANIFEST_KEYS=['version','fixtureRawSha256','canonicalDatasetSha256','documentCount','documentComposition','caseCount','orderedCaseIds','languageCounts','categoryCounts','model','selectorPolicy','searchPolicy','latencyProfiles','acceptance'];
const SHA=(v)=>crypto.createHash('sha256').update(v).digest('hex');
const canonical=(v)=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?`[${v.map(canonical).join(',')}]`:`{${Object.keys(v).sort().map((k)=>`${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
const equal=(a,b)=>canonical(a)===canonical(b);
const countBy=(xs)=>Object.fromEntries([...new Set(xs)].sort().map((k)=>[k,xs.filter((x)=>x===k).length]));
export const CANDIDATE_IDENTITY_FILES=Object.freeze([
  'scripts/semantic-activation-gate.mjs',
  'eval/semantic-activation/v1/fixture.json',
  'eval/semantic-activation/v1/manifest.json',
  'examples/ollama-embedding-provider.mjs',
  'src/core.ts',
  'src/activation-ledger.ts',
  'src/anchors.ts',
  'src/checkpoint-schema.ts',
  'src/checkpoints.ts',
  'src/decay.ts',
  'src/engine/fts.ts',
  'src/engine/manifest.ts',
  'src/engine/retrieval.ts',
  'src/evaluation.ts',
  'src/forget.ts',
  'src/gardener.ts',
  'src/governance.ts',
  'src/memory-proposals.ts',
  'src/prompt-recall.ts',
  'src/query-intent.ts',
  'src/recall-quality.ts',
  'src/recall-readiness.ts',
  'src/runtime-events.ts',
  'src/store/checkpoints.ts',
  'src/store/events.ts',
  'src/store/files.ts',
  'src/store/lock.ts',
  'src/temporal-entities.ts',
  'src/time.ts',
  'src/transcript.ts',
  'src/types.ts',
  'src/workspace.ts',
]);
export async function candidateCodeIdentity({repoRoot=path.join(HERE,'..'),gitCommand='git'}={}){
  let head;
  try{head=execFileSync(gitCommand,['rev-parse','HEAD'],{cwd:repoRoot,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim();}
  catch{throw new Error('candidate_identity_head_unavailable');}
  if(!/^[a-f0-9]{40,64}$/i.test(head))throw new Error('candidate_identity_head_invalid');
  const parts=[`head\0${head.toLowerCase()}\n`];
  for(const relative of CANDIDATE_IDENTITY_FILES){
    let bytes;try{bytes=await fs.readFile(path.join(repoRoot,relative));}catch{throw new Error('candidate_identity_input_missing');}
    parts.push(`file\0${relative}\0${SHA(bytes)}\n`);
  }
  return SHA(parts.join(''));
}

export function percentile(values,p){if(!values.length)return null;return [...values].sort((a,b)=>a-b)[Math.ceil(p*values.length)-1];}

export async function loadAndValidate({fixturePath=DEFAULT_FIXTURE,manifestPath=DEFAULT_MANIFEST}={}){
  const [raw,manifestRaw]=await Promise.all([fs.readFile(fixturePath),fs.readFile(manifestPath,'utf8')]);
  const fixture=JSON.parse(raw);const manifest=JSON.parse(manifestRaw);
  if(!equal(Object.keys(manifest),MANIFEST_KEYS))throw new Error('manifest_exact_keys_drift');
  const checks=[[SHA(raw),manifest.fixtureRawSha256,'fixture_raw_sha256_drift'],[SHA(canonical(fixture)),manifest.canonicalDatasetSha256,'canonical_dataset_sha256_drift'],[fixture.documents.length,37,'fixture_document_count_not_37'],[fixture.documents.length,manifest.documentCount,'manifest_document_count_drift'],[fixture.cases.length,manifest.caseCount,'case_count_drift'],[fixture.cases.map((c)=>c.caseId),manifest.orderedCaseIds,'case_order_drift'],[countBy(fixture.cases.map((c)=>c.language)),manifest.languageCounts,'language_count_drift'],[countBy(fixture.cases.map((c)=>c.category)),manifest.categoryCounts,'category_count_drift'],[countBy(fixture.documents.map((d)=>d.category)),manifest.documentComposition,'document_composition_drift']];
  for(const [a,e,code] of checks)if(!equal(a,e))throw new Error(code);
  const ids=fixture.documents.map((d)=>d.documentId),paths=fixture.documents.map((d)=>d.path);
  if(new Set(ids).size!==37||new Set(paths).size!==37)throw new Error('document_identity_drift');
  if(fixture.documents.some((d)=>!/^memory\/.+\.md$/.test(d.path)))throw new Error('document_path_contract_drift');
  return{fixture,manifest,hashes:{fixture:SHA(raw),canonical:SHA(canonical(fixture)),manifest:SHA(manifestRaw)}};
}

export function scoreRows(rows){const answer=rows.filter((r)=>r.expected==='answer');const lang=(l)=>answer.filter((r)=>r.language===l);const recall=(xs)=>xs.length?xs.filter((r)=>r.goldIds.some((id)=>r.rankedIds.slice(0,5).includes(id))).length/xs.length:0;const mrr=(xs)=>xs.length?xs.reduce((s,r)=>{const ranks=r.goldIds.map((id)=>r.rankedIds.indexOf(id)+1).filter(Boolean);return s+(ranks.length?1/Math.min(...ranks):0);},0)/xs.length:0;const na=rows.filter((r)=>r.expected==='no-answer');return{recall5:recall(answer),enRecall5:recall(lang('en')),zhRecall5:recall(lang('zh')),mrr:mrr(answer),noAnswerAccuracy:na.length?na.filter((r)=>r.injectedIds.length===0).length/na.length:1};}

const PROFILE_EVIDENCE={deterministicOracle:'diagnostic',realGate:'measured'};
function validateProfileEvidence(profile,evidenceKind){if(PROFILE_EVIDENCE[profile]!==evidenceKind)throw new Error('profile_evidence_mismatch');}
const ACCEPTANCE_FAILURE_REASONS=new Set(['measured_compare_requires_live_hybrid','profile_evidence_mismatch','execution_source_mismatch','report_arm_profile_mismatch','stored_metrics_mismatch','provider_truth_failed','provider_contract_mismatch','required_delta_failed','mrr_regression','language_recall_failed','lexical_strong_top5_regression','current_not_top5','stale_ranked_before_current','no_answer_accuracy_failed','restricted_injection_leak','stale_injection_leak','restart_drift','latency_profile_invalid','latency_threshold_breach','diagnostic_redaction_failed']);
const FAILURE_ARTIFACT_KEYS=['artifactKind','schemaVersion','outcome','pass','stage','reason','profile','evidenceKind','executionSource','identity'];
const FAILURE_IDENTITY_KEYS=['code','fixture','manifest','canonical'];
const FAILURE_DIAGNOSTIC_KEYS=['caseId','topK','currentRank'];
const boundedCaseId=(value)=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value)?value:null;
function safeFailureIdentity(value){const out={};for(const key of FAILURE_IDENTITY_KEYS){if(!validHash(value?.[key]))return null;out[key]=value[key];}return out;}
function validateFailureArtifact(value){
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const expected=value.reason==='current_not_top5'?[...FAILURE_ARTIFACT_KEYS,'diagnostic']:FAILURE_ARTIFACT_KEYS;if(!equal(Object.keys(value),expected))return false;
  if(value.artifactKind!=='semantic-activation-gate-failure'||value.schemaVersion!==1||value.outcome!=='FAIL'||value.pass!==false||value.stage!=='acceptance'||!ACCEPTANCE_FAILURE_REASONS.has(value.reason))return false;
  if(PROFILE_EVIDENCE[value.profile]!==value.evidenceKind||value.executionSource!==(value.evidenceKind==='measured'?'command':'oracle')||!safeFailureIdentity(value.identity)||!equal(Object.keys(value.identity),FAILURE_IDENTITY_KEYS))return false;
  if(value.reason==='current_not_top5'){const d=value.diagnostic;if(!d||typeof d!=='object'||Array.isArray(d)||!equal(Object.keys(d),FAILURE_DIAGNOSTIC_KEYS)||!boundedCaseId(d.caseId)||d.topK!==5||!(d.currentRank===null||(Number.isSafeInteger(d.currentRank)&&d.currentRank>0)))return false;}
  return Buffer.byteLength(`${JSON.stringify(value,null,2)}\n`)<=16*1024;
}
function failureArtifact(report,reason,diagnostic){
  try{
    const identity=safeFailureIdentity(report?.hybrid?.identity);if(!identity)throw new Error('unsafe_identity');
    const out={artifactKind:'semantic-activation-gate-failure',schemaVersion:1,outcome:'FAIL',pass:false,stage:'acceptance',reason,profile:report.profile,evidenceKind:report.evidenceKind,executionSource:report.executionSource,identity};
    if(reason==='current_not_top5'){const caseId=boundedCaseId(diagnostic?.caseId),currentRank=diagnostic?.currentRank;if(!caseId||!(currentRank===null||(Number.isSafeInteger(currentRank)&&currentRank>0)))throw new Error('unsafe_diagnostic');out.diagnostic={caseId,topK:5,currentRank};}
    if(!validateFailureArtifact(out))throw new Error('invalid_artifact');return out;
  }catch{
    const identity=safeFailureIdentity(report?.hybrid?.identity);if(!identity)return null;const out={artifactKind:'semantic-activation-gate-failure',schemaVersion:1,outcome:'FAIL',pass:false,stage:'acceptance',reason:'diagnostic_redaction_failed',profile:report?.profile,evidenceKind:report?.evidenceKind,executionSource:report?.executionSource,identity};return validateFailureArtifact(out)?out:null;
  }
}

function directAcceptanceError(hybrid,reason){
  const error=new Error(reason),artifact=failureArtifact({profile:hybrid?.profile,evidenceKind:hybrid?.evidenceKind,executionSource:hybrid?.executionSource,hybrid},reason);
  if(artifact)error.acceptanceFailureArtifact=artifact;
  return error;
}

function evaluateAcceptance(report,manifest,{profile=report?.profile,evidenceKind=report?.evidenceKind,allowMeasured=false}={}){
  const fail=(c,diagnostic)=>{const error=new Error(c),artifact=failureArtifact(report,c,diagnostic);if(artifact)error.acceptanceFailureArtifact=artifact;throw error;};const {lexical,hybrid,providerTruth,restart,latency}=report;
  if(evidenceKind==='measured'&&!allowMeasured)fail('measured_compare_requires_live_hybrid');
  if(PROFILE_EVIDENCE[profile]!==evidenceKind)fail('profile_evidence_mismatch');
  if(report.profile!==profile||report.evidenceKind!==evidenceKind)fail('profile_evidence_mismatch');
  if(report.executionSource!==(evidenceKind==='measured'?'command':'oracle')||lexical?.executionSource!=='providerNeutral'||lexical?.identity?.executionSource!=='providerNeutral'||hybrid?.executionSource!==report.executionSource||hybrid?.identity?.executionSource!==report.executionSource)fail('execution_source_mismatch');
  const lexicalMatches=lexical?.profile==='providerNeutral'&&lexical?.evidenceKind==='diagnostic';if(!lexicalMatches||hybrid?.profile!==profile||hybrid?.evidenceKind!==evidenceKind)fail('report_arm_profile_mismatch');
  const lexicalMetrics=scoreRows(lexical.rows),hybridMetrics=scoreRows(hybrid.rows);if(!equal(lexical.metrics,lexicalMetrics)||!equal(hybrid.metrics,hybridMetrics))fail('stored_metrics_mismatch');
  if(!providerTruth?.hybridRan||providerTruth.requested!=='vector-gguf'||providerTruth.active!=='vector-gguf'||providerTruth.model!==manifest.model.id||providerTruth.dimension!==manifest.model.expectedDimension||providerTruth.indexed!==37||!providerTruth.ready||providerTruth.fallback||providerTruth.lastError)fail('provider_truth_failed');
  const para=(arm,l)=>arm.rows.filter((r)=>r.category==='paraphrase'&&(!l||r.language===l));const recall=(rows)=>rows.filter((r)=>r.goldIds.some((id)=>r.rankedIds.slice(0,5).includes(id))).length/rows.length;
  const deltas={paraphraseRecallAt5:recall(para(hybrid))-recall(para(lexical)),en:recall(para(hybrid,'en'))-recall(para(lexical,'en')),zh:recall(para(hybrid,'zh'))-recall(para(lexical,'zh')),mrr:hybridMetrics.mrr-lexicalMetrics.mrr};
  if(deltas.paraphraseRecallAt5<manifest.acceptance.paraphraseRecallAt5DeltaMin||deltas.en<manifest.acceptance.paraphraseRecallAt5DeltaEnMin||deltas.zh<manifest.acceptance.paraphraseRecallAt5DeltaZhMin)fail('required_delta_failed');
  if(deltas.mrr<manifest.acceptance.mrrRegressionMin)fail('mrr_regression');if(hybridMetrics.enRecall5<manifest.acceptance.answerRecallAt5EnMin||hybridMetrics.zhRecall5<manifest.acceptance.answerRecallAt5ZhMin)fail('language_recall_failed');
  const h=new Map(hybrid.rows.map((r)=>[r.caseId,r]));for(const r of lexical.rows.filter((x)=>['keyword','partial'].includes(x.category))){if(r.goldIds.some((id)=>r.rankedIds.slice(0,5).includes(id))&&!h.get(r.caseId)?.goldIds.some((id)=>h.get(r.caseId).rankedIds.slice(0,5).includes(id)))fail('lexical_strong_top5_regression');}
  for(const r of hybrid.rows.filter((x)=>x.expected==='answer'&&x.currentIds.length)){const cr=Math.min(...r.currentIds.map((id)=>r.rankedIds.indexOf(id)).filter((i)=>i>=0));if(!Number.isFinite(cr)||cr>=5)fail('current_not_top5',{caseId:r.caseId,currentRank:Number.isFinite(cr)?cr+1:null});for(const id of r.staleIds){const sr=r.rankedIds.indexOf(id);if(sr>=0&&sr<cr)fail('stale_ranked_before_current');}}
  if(hybridMetrics.noAnswerAccuracy<manifest.acceptance.noAnswerAccuracyMin)fail('no_answer_accuracy_failed');const forbidden=new Set(hybrid.rows.flatMap((r)=>[...r.privateIds,...r.forbiddenIds,...r.harmfulIds]));if(hybrid.rows.some((r)=>r.injectedIds.some((id)=>forbidden.has(id))))fail('restricted_injection_leak');if(hybrid.rows.some((r)=>r.staleIds.some((id)=>r.injectedIds.includes(id))))fail('stale_injection_leak');
  if(!restart?.identical||restart.extraIndexRequests!==0)fail('restart_drift');const budget=manifest.latencyProfiles[profile];if(!budget)fail('latency_profile_invalid');if(evidenceKind==='measured'&&(latency.searchP50Ms>budget.searchP50MsMax||latency.searchP95Ms>budget.searchP95MsMax||latency.indexMs>budget.indexMsMax))fail('latency_threshold_breach');return{pass:true,deltas,profile,evidenceKind,latencyGated:evidenceKind==='measured'};
}
export function evaluateCompare(report,manifest,options={}){return evaluateAcceptance(report,manifest,{...options,allowMeasured:false});}

export function adjudicateLiveHybridExecution({exitCode,externalCompetitors,observedExecutionSource,report}={}){
  if(observedExecutionSource!=='command')throw new Error('live_hybrid_not_observed');
  if(!Array.isArray(externalCompetitors))throw new Error('live_hybrid_competitor_evidence_invalid');
  if(externalCompetitors.length)throw new Error('live_hybrid_external_competitor');
  if(exitCode!==0)throw new Error('live_hybrid_process_failed');
  if(report?.profile!=='realGate'||report?.evidenceKind!=='measured'||report?.executionSource!=='command'||report?.acceptance?.profile!=='realGate'||report?.acceptance?.evidenceKind!=='measured'||report?.acceptance?.latencyGated!==true)throw new Error('live_hybrid_report_contract_invalid');
  if(report.acceptance.pass!==true)throw new Error('live_hybrid_acceptance_failed');
  return{pass:true,classification:'PASS_LIVE_MEASURED_HYBRID'};
}

const boundedDocumentId=(value)=>typeof value==='string'&&/^[A-Za-z0-9._:-]{1,128}$/.test(value)?value:null;
export async function seed(core,fixture,exerciseApi){for(const d of fixture.documents){const abs=path.join(core.workspace.spaceDir,d.path);await fs.mkdir(path.dirname(abs),{recursive:true});const flagged=d.visibility==='forbidden'||d.visibility==='harmful',documentId=boundedDocumentId(d.documentId),supersededBy=boundedDocumentId(d.supersededBy);await fs.writeFile(abs,`---\nstatus: "promoted"\nreviewed: true\ntype: "${flagged?'flagged':'fact'}"${documentId?`\ndocument_id: "${documentId}"`:''}${supersededBy?`\nsuperseded_by: "${supersededBy}"`:''}\n---\n\n${d.text}\n`);}if(exerciseApi){const p=await core.write_candidate({text:'Temporary activation harness API probe.',autoPromote:false});const x=await core.promote(p.path,{scope:'harness-probe',title:'harness-probe'});await fs.rm(path.join(core.workspace.spaceDir,x.path));}}
const idForPath=(fixture,value)=>fixture.documents.find((d)=>d.path===value)?.documentId||null;
const boundedRow=(c,rankedIds,injectedIds,semanticEvidence)=>({caseId:c.caseId,language:c.language,category:c.category,expected:c.expected,goldIds:c.goldIds,currentIds:c.currentIds,staleIds:c.staleIds,privateIds:c.privateIds,forbiddenIds:c.forbiddenIds,harmfulIds:c.harmfulIds,restartProbe:c.restartProbe,rankedIds,injectedIds,semanticEvidence});
const splitCommand=(s)=>s.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)?.map((x)=>x.replace(/^["']|["']$/g,''))||[];
const validHash=(value)=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
async function readCounters(counterPath){let value;try{value=JSON.parse(await fs.readFile(counterPath,'utf8'));}catch{throw new Error('provider_counter_unreadable');}for(const key of ['status','index','search'])if(!Number.isSafeInteger(value?.[key])||value[key]<0)throw new Error('provider_counter_invalid');return{status:value.status,index:value.index,search:value.search};}
async function wrapProviderCommand(root,command){const parts=splitCommand(command);if(!parts.length)throw new Error('provider_command_empty');const token=crypto.randomBytes(12).toString('hex'),commandKey=`IHOW_GATE_PROVIDER_${token}`,counterKey=`IHOW_GATE_COUNTER_${token}`,wrapper=path.join(root,'provider-counter-proxy.mjs'),counterPath=path.join(root,'provider-counters.json');await fs.writeFile(counterPath,JSON.stringify({status:0,index:0,search:0}),{flag:'wx'});await fs.writeFile(wrapper,`import fs from 'node:fs';import {spawn} from 'node:child_process';\nconst command=JSON.parse(process.env[process.argv[2]]||'null'),counterPath=process.env[process.argv[3]],method=process.argv.at(-1);if(!Array.isArray(command)||!command.length||!counterPath||!['status','index','search'].includes(method))process.exit(125);let counters;try{counters=JSON.parse(fs.readFileSync(counterPath,'utf8'));for(const key of ['status','index','search'])if(!Number.isSafeInteger(counters[key])||counters[key]<0)throw 0;counters[method]++;const tmp=counterPath+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(counters),{flag:'wx'});fs.renameSync(tmp,counterPath);}catch{process.exit(125)}const child=spawn(command[0],[...command.slice(1),method],{stdio:'inherit'});for(const signal of ['SIGTERM','SIGINT','SIGHUP'])process.on(signal,()=>child.kill(signal));child.on('error',()=>process.exit(127));child.on('exit',(code,signal)=>{if(signal)process.kill(process.pid,signal);else process.exit(code??1)});\n`,{flag:'wx'});const previous={[commandKey]:process.env[commandKey],[counterKey]:process.env[counterKey]};process.env[commandKey]=JSON.stringify(parts);process.env[counterKey]=counterPath;return{command:`${JSON.stringify(process.execPath)} ${JSON.stringify(wrapper)} ${commandKey} ${counterKey}`,counterPath,restore(){for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}};}
async function providerStatus(command,workspace,model,timeoutMs){const [bin,...args]=splitCommand(command);if(!bin)throw new Error('provider_command_empty');return await new Promise((resolve,reject)=>{const child=spawn(bin,[...args,'status'],{stdio:['pipe','pipe','pipe']});let out='',err='';const timer=setTimeout(()=>{child.kill('SIGTERM');reject(new Error('provider_status_timeout'));},timeoutMs);child.stdout.on('data',(c)=>out+=c);child.stderr.on('data',(c)=>err+=c);child.on('error',reject);child.on('close',(code)=>{clearTimeout(timer);if(code!==0)return reject(new Error(`provider_status_failed:${code}`));try{resolve(JSON.parse(out||'{}'));}catch{reject(new Error('provider_status_invalid_json'));}});child.stdin.end(JSON.stringify({method:'status',workspace:{root:workspace.root,space:workspace.space,memoryDir:workspace.memoryDir,indexPath:workspace.indexPath,indexManifestPath:workspace.indexManifestPath},provider:{id:'vector-gguf',model}}));});}
async function indexIdentity(indexManifestPath){try{const parsed=JSON.parse(await fs.readFile(indexManifestPath,'utf8'));if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return null;const {updatedAt,...stable}=parsed;return SHA(canonical(stable));}catch{return null;}}

async function runArm({mode,fixture,manifest,hashes,root,providerCommand,model,expectedDimension,vectorTimeoutMs,vectorIndexTimeoutMs,rebuild=true}){
  const options=mode==='hybrid'?{root,space:'gate',engine:'vector-gguf',vectorProviderCommand:providerCommand,vectorModel:model,vectorTimeoutMs,vectorIndexTimeoutMs}:{root,space:'gate',engine:'fts'};const core=await openCore(options);if(rebuild)await seed(core,fixture,mode==='lexical');
  const start=performance.now();if(rebuild)await core.rebuild();const indexMs=performance.now()-start;const rows=[],latencies=[];
  for(const c of fixture.cases){const t=performance.now();const hits=await core.search(c.query,{limit:manifest.searchPolicy.topK});latencies.push(performance.now()-t);const rankedIds=hits.map((h)=>idForPath(fixture,h.path)).filter(Boolean);const eligible=hits.filter((h)=>{const d=fixture.documents.find((x)=>x.path===h.path);return d&&d.visibility==='public'&&d.state==='current'&&d.type!=='distractor';});const selection=await selectPromptRecall(core.workspace,c.query,eligible,{...manifest.selectorPolicy});renderPromptRecall(selection);const injectedIds=selection.included.map((i)=>idForPath(fixture,i.path)).filter(Boolean);const evidence=hits.filter((h)=>Number.isFinite(h.semanticScore)).slice(0,10).map((h)=>({documentId:idForPath(fixture,h.path),score:h.semanticScore}));rows.push(boundedRow(c,rankedIds,injectedIds,evidence));}
  const status=await core.status();let pstatus=null;if(mode==='hybrid')pstatus=await providerStatus(providerCommand,core.workspace,model,vectorTimeoutMs);const manifestIdentity=await indexIdentity(core.workspace.indexManifestPath);
  return{arm:mode,identity:{code:await candidateCodeIdentity(),fixture:hashes.fixture,manifest:hashes.manifest,canonical:hashes.canonical,queryOrder:manifest.orderedCaseIds},rows,metrics:scoreRows(rows),latency:{searchP50Ms:percentile(latencies,.5),searchP95Ms:percentile(latencies,.95),indexMs},provider:mode==='hybrid'?{requested:'vector-gguf',active:status.provider.id,model:status.provider.model,reportedModel:pstatus.model??null,dimension:pstatus.dimension??null,indexed:status.index.documents,ready:status.capabilities.semantic,fallback:status.provider.fallback===true,lastError:status.provider.lastError||status.index.lastError||null}:null,indexIdentity:manifestIdentity,indexPathIdentity:SHA(path.resolve(core.workspace.indexPath)),workspace:core.workspace};
}

function publicArm(arm,profile,evidenceKind,executionSource){return{arm:arm.arm,profile,evidenceKind,executionSource,identity:{...arm.identity,executionSource},rows:arm.rows,metrics:arm.metrics,latency:arm.latency,provider:arm.provider,indexIdentity:arm.indexIdentity};}
function validateIdentity(a,b){for(const key of ['code','fixture','manifest','canonical'])if(a?.identity?.[key]!==b?.identity?.[key])throw new Error(`report_identity_${key}_mismatch`);if(!equal(a.identity.queryOrder,b.identity.queryOrder))throw new Error('report_query_order_mismatch');}
function comparison(lexicalReport,hybridReport,manifest,{profile=hybridReport?.profile,evidenceKind=hybridReport?.evidenceKind,allowMeasured=false}={}){validateIdentity(lexicalReport,hybridReport);if(lexicalReport.arm!=='lexical'||hybridReport.arm!=='hybrid')throw new Error('report_arm_mismatch');const executionSource=hybridReport.executionSource;const providerTruth={hybridRan:true,...hybridReport.provider};const report={profile,evidenceKind,executionSource,lexical:lexicalReport,hybrid:hybridReport,providerTruth,restart:hybridReport.restart,latency:hybridReport.latency};return evaluateAcceptance(report,manifest,{profile,evidenceKind,allowMeasured});}

export async function runGate({mode='compare',fixturePath=DEFAULT_FIXTURE,manifestPath=DEFAULT_MANIFEST,providerMode,providerCommand,model,expectedDimension,vectorTimeoutMs=30000,vectorIndexTimeoutMs=600000,reuseIndexForRestart=true,baselineReport,deterministicTest=false,keepTemp=false,tempBase=os.tmpdir(),profile,evidenceKind}={}){
  if(!['lexical','hybrid','compare'].includes(mode))throw new Error('invalid_mode');if(mode!=='lexical'&&!providerMode)throw new Error('provider_mode_required');if(providerMode==='oracle'&&!deterministicTest)throw new Error('oracle_requires_deterministic_test');if(providerMode&&!['oracle','command'].includes(providerMode))throw new Error('provider_mode_invalid');
  const loaded=await loadAndValidate({fixturePath,manifestPath});if(mode!=='lexical'){profile=providerMode==='oracle'?'deterministicOracle':'realGate';evidenceKind=providerMode==='oracle'?'diagnostic':'measured';model??=loaded.manifest.model.id;expectedDimension??=loaded.manifest.model.expectedDimension;if(providerMode==='command'&&!providerCommand)throw new Error('provider_command_required');if(model!==loaded.manifest.model.id)throw new Error('model_manifest_mismatch');if(expectedDimension!==loaded.manifest.model.expectedDimension)throw new Error('dimension_manifest_mismatch');if(providerMode==='oracle'){const script=fileURLToPath(import.meta.url);providerCommand=`${JSON.stringify(process.execPath)} ${JSON.stringify(script)} --deterministic-oracle-provider ${JSON.stringify(fixturePath)}`;}}else{profile??='providerNeutral';evidenceKind??='diagnostic';}if(profile!=='providerNeutral')validateProfileEvidence(profile,evidenceKind);
  const roots=[];const make=async(label)=>{const r=await fs.mkdtemp(path.join(tempBase,`ihow-semantic-gate-${label}-`));roots.push(r);return r;};
  try{
    if(mode==='lexical')return publicArm(await runArm({mode,...loaded,root:await make('lexical')}),profile,evidenceKind,'providerNeutral');
    if(mode==='hybrid'){const root=await make('hybrid'),proxy=await wrapProviderCommand(root,providerCommand),executionSource=providerMode;try{if(baselineReport&&(baselineReport.profile!=='providerNeutral'||baselineReport.evidenceKind!=='diagnostic'||baselineReport.executionSource!=='providerNeutral'||baselineReport.identity?.executionSource!=='providerNeutral'))throw new Error('hybrid_baseline_must_be_provider_neutral');const arm=await runArm({mode,...loaded,root,providerCommand:proxy.command,model,expectedDimension,vectorTimeoutMs,vectorIndexTimeoutMs});const before=await readCounters(proxy.counterPath);const reopened=reuseIndexForRestart?await runArm({mode,...loaded,root:arm.workspace.root,providerCommand:proxy.command,model,expectedDimension,vectorTimeoutMs,vectorIndexTimeoutMs,rebuild:false}):arm;const after=await readCounters(proxy.counterPath),extraIndexRequests=after.index-before.index;if(!Number.isSafeInteger(extraIndexRequests)||extraIndexRequests<0)throw new Error('provider_counter_invalid');const probes=new Set(loaded.fixture.cases.filter((c)=>c.restartProbe).map((c)=>c.caseId));const project=(a)=>a.rows.filter((r)=>probes.has(r.caseId)).map((r)=>({caseId:r.caseId,rankedIds:r.rankedIds,injectedIds:r.injectedIds})),sameIndexIdentity=validHash(arm.indexIdentity)&&validHash(reopened.indexIdentity)&&arm.indexIdentity===reopened.indexIdentity,sameIndexPathIdentity=arm.indexPathIdentity===reopened.indexPathIdentity,sameProbeProjection=equal(project(arm),project(reopened));const out=publicArm(arm,profile,evidenceKind,executionSource);out.restart={identical:sameIndexIdentity&&sameIndexPathIdentity&&sameProbeProjection&&extraIndexRequests===0,sameIndexIdentity,sameIndexPathIdentity,sameProbeProjection,indexRequestsBefore:before.index,indexRequestsAfter:after.index,extraIndexRequests};if(!out.restart.identical){const error=directAcceptanceError(out,'restart_drift');error.restart=out.restart;throw error;}if(out.provider.dimension!==expectedDimension||out.provider.reportedModel!==model)throw directAcceptanceError(out,'provider_contract_mismatch');if(baselineReport)out.acceptance=comparison(baselineReport,out,loaded.manifest,{profile,evidenceKind,allowMeasured:providerMode==='command'});return out;}finally{proxy.restore();}}
    const lexical=await runGate({mode:'lexical',fixturePath,manifestPath,tempBase});const hybrid=await runGate({mode:'hybrid',fixturePath,manifestPath,providerMode,providerCommand,model,expectedDimension,vectorTimeoutMs,vectorIndexTimeoutMs,reuseIndexForRestart,baselineReport:lexical,deterministicTest,tempBase});return{fixture:{documents:37,cases:20},identity:{...lexical.identity,executionSource:providerMode},profile,evidenceKind,executionSource:providerMode,lexical,hybrid,providerTruth:{hybridRan:true,...hybrid.provider},restart:hybrid.restart,latency:hybrid.latency,acceptance:hybrid.acceptance};
  }finally{if(!keepTemp)await Promise.all(roots.map((r)=>fs.rm(r,{recursive:true,force:true})));}
}

async function atomicWrite(target,value){const abs=path.resolve(target),dir=path.dirname(abs);await fs.mkdir(dir,{recursive:true});const tmp=path.join(dir,`.${path.basename(abs)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);try{await fs.writeFile(tmp,`${JSON.stringify(value,null,2)}\n`,{flag:'wx'});await fs.rename(tmp,abs);}finally{await fs.rm(tmp,{force:true});}}
const USAGE=`Usage:\n  semantic-activation-gate.mjs lexical --fixture FILE --manifest FILE --engine fts --output FILE\n  semantic-activation-gate.mjs hybrid --fixture FILE --manifest FILE --engine vector-gguf --provider-command CMD --model MODEL --expected-dimension N --vector-timeout-ms N --vector-index-timeout-ms N --reuse-index-for-restart --baseline FILE --output FILE\n  semantic-activation-gate.mjs compare --manifest FILE --lexical FILE --hybrid FILE\n  semantic-activation-gate.mjs --help\n`;
function parseCli(args){if(equal(args,['--help']))return{help:true};const mode=args[0];if(!['lexical','hybrid','compare'].includes(mode))throw new Error('cli_invalid_mode');const flags={};for(let i=1;i<args.length;i++){const k=args[i];if(!k.startsWith('--'))throw new Error('cli_unknown_argument');if(Object.hasOwn(flags,k))throw new Error('cli_duplicate_flag');if(k==='--reuse-index-for-restart'||k==='--oracle'||k==='--deterministic-test')flags[k]=true;else{if(i+1>=args.length||args[i+1].startsWith('--'))throw new Error('cli_missing_flag_value');flags[k]=args[++i];}}return{mode,flags};}
const allowed={lexical:new Set(['--fixture','--manifest','--engine','--output']),hybrid:new Set(['--fixture','--manifest','--engine','--provider-command','--model','--expected-dimension','--vector-timeout-ms','--vector-index-timeout-ms','--reuse-index-for-restart','--baseline','--output','--oracle','--deterministic-test']),compare:new Set(['--manifest','--lexical','--hybrid'])};
function required(flags,names){for(const n of names)if(!Object.hasOwn(flags,n))throw new Error(`cli_missing_${n.slice(2).replaceAll('-','_')}`);}
function safeJson(p,code){if(typeof p!=='string'||!p.endsWith('.json')||p.includes('\0'))throw new Error(code);return p;}
function positiveInt(value,code){const n=Number(value);if(!Number.isSafeInteger(n)||n<=0)throw new Error(code);return n;}
async function cliMain(args){const parsed=parseCli(args);if(parsed.help){process.stdout.write(USAGE);return;}const {mode,flags}=parsed;if(mode==='lexical'&&Object.keys(flags).some((k)=>k.includes('provider')||k==='--model'||k.includes('dimension')||k==='--oracle'))throw new Error('cli_lexical_forbids_provider_args');for(const k of Object.keys(flags))if(!allowed[mode].has(k))throw new Error('cli_unknown_flag');
  if(mode==='lexical'){required(flags,['--fixture','--manifest','--engine','--output']);if(flags['--engine']!=='fts')throw new Error('cli_engine_mismatch');if(Object.keys(flags).some((k)=>k.includes('provider')||k==='--model'||k.includes('dimension')||k==='--oracle'))throw new Error('cli_lexical_forbids_provider_args');const out=safeJson(flags['--output'],'cli_unsafe_output_path');const report=await runGate({mode,fixturePath:flags['--fixture'],manifestPath:flags['--manifest']});await atomicWrite(out,report);return;}
  if(mode==='hybrid'){required(flags,['--fixture','--manifest','--engine','--baseline','--output']);if(flags['--engine']!=='vector-gguf')throw new Error('cli_engine_mismatch');if(flags['--oracle']&&!flags['--deterministic-test'])throw new Error('cli_oracle_requires_deterministic_test');if(!flags['--oracle'])required(flags,['--provider-command','--model','--expected-dimension','--vector-timeout-ms','--vector-index-timeout-ms','--reuse-index-for-restart']);const baselinePath=safeJson(flags['--baseline'],'cli_unsafe_baseline_path'),out=safeJson(flags['--output'],'cli_unsafe_output_path');if(path.resolve(out)===path.resolve(baselinePath))throw new Error('cli_output_baseline_collision');const baseline=JSON.parse(await fs.readFile(baselinePath,'utf8'));try{const report=await runGate({mode,fixturePath:flags['--fixture'],manifestPath:flags['--manifest'],providerMode:flags['--oracle']?'oracle':'command',providerCommand:flags['--provider-command'],model:flags['--model'],expectedDimension:flags['--expected-dimension']?positiveInt(flags['--expected-dimension'],'cli_invalid_expected_dimension'):undefined,vectorTimeoutMs:flags['--vector-timeout-ms']?positiveInt(flags['--vector-timeout-ms'],'cli_invalid_vector_timeout_ms'):30000,vectorIndexTimeoutMs:flags['--vector-index-timeout-ms']?positiveInt(flags['--vector-index-timeout-ms'],'cli_invalid_vector_index_timeout_ms'):600000,reuseIndexForRestart:flags['--reuse-index-for-restart']===true,baselineReport:baseline,deterministicTest:flags['--deterministic-test']===true});await atomicWrite(out,report);}catch(error){if(validateFailureArtifact(error?.acceptanceFailureArtifact))await atomicWrite(out,error.acceptanceFailureArtifact);throw error;}return;}
  required(flags,['--manifest','--lexical','--hybrid']);const manifestRaw=await fs.readFile(flags['--manifest'],'utf8'),manifest=JSON.parse(manifestRaw),lexical=JSON.parse(await fs.readFile(safeJson(flags['--lexical'],'cli_unsafe_lexical_path'),'utf8')),hybrid=JSON.parse(await fs.readFile(safeJson(flags['--hybrid'],'cli_unsafe_hybrid_path'),'utf8'));if(Object.hasOwn(hybrid,'artifactKind'))throw new Error(validateFailureArtifact(hybrid)?'hybrid_input_is_failure_artifact':'hybrid_failure_artifact_invalid');if(lexical.identity?.manifest!==SHA(manifestRaw)||hybrid.identity?.manifest!==SHA(manifestRaw))throw new Error('report_manifest_input_mismatch');const profile=hybrid.profile,evidenceKind=hybrid.evidenceKind;if(hybrid.acceptance&&(hybrid.acceptance.profile!==profile||hybrid.acceptance.evidenceKind!==evidenceKind))throw new Error('profile_evidence_mismatch');comparison(lexical,hybrid,manifest,{profile,evidenceKind});process.stdout.write(`${JSON.stringify({pass:true})}\n`);
}

async function oracleProvider(fixturePath){const req=JSON.parse(await new Promise((resolve)=>{let s='';process.stdin.on('data',(c)=>s+=c);process.stdin.on('end',()=>resolve(s));}));const fixture=JSON.parse(await fs.readFile(fixturePath,'utf8'));if(req.method==='status')return{id:'vector-gguf',model:req.provider.model,ready:true,cloud:false,dimension:1024};if(req.method==='index')return{indexed:fixture.documents.length};const c=fixture.cases.find((x)=>x.query===req.query),docs=new Map(fixture.documents.map((d)=>[d.documentId,d]));let ids=c?.expected==='answer'?[...c.currentIds,...c.goldIds]:[...(c?.privateIds||[]),...(c?.forbiddenIds||[]),...(c?.harmfulIds||[])];ids.push(...fixture.documents.filter((d)=>d.category==='hard-negative').map((d)=>d.documentId));return{hits:[...new Set(ids)].slice(0,10).map((id,i)=>{const d=docs.get(id);return{path:d.path,snippet:d.text,score:Math.max(.60,.99-i*.03),source:'vector-gguf'};})};}
const args=process.argv.slice(2);if(args[0]==='--deterministic-oracle-provider'){process.stdout.write(JSON.stringify(await oracleProvider(args[1])));}else if(import.meta.url===`file://${process.argv[1]}`){try{await cliMain(args);}catch(e){const raw=String(e?.message||'gate_execution_failed'),safe=/^[a-z0-9_]+$/.test(raw)?raw:(raw.match(/^(vector_provider_[a-z0-9_]+)/)?.[1]||'gate_execution_failed');process.stderr.write(`${safe}\n`);process.exitCode=1;}}
