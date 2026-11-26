import type { BaselineValidationOperation } from '@prisma/client';
import { hash, parseMain } from './document-contract';

// Owner/project-scoped callers supply the immutable bound Main revision. Never
// spread stored worker receipts, provenance records, command argv or host paths.
export function baselineOperationView(op: BaselineValidationOperation, current: boolean, main?: {id:string;contentHash:string;content:unknown} | null) {
  const a=op.authority as any,b=a?.binding,r=op.result as any;
  const profiles=Array.isArray(b?.profiles)?b.profiles:[];
  let criteria:{requirementId:string;criterionId:string}[]=[],scopeVerified=false;
  try {
    if(main && main.id===b?.main?.id && main.contentHash===b.main.hash && hash(main.content)===main.contentHash && hash(b)===a.bindingHash && hash(a.plan)===a.planHash){
      const document=parseMain(main.content);
      criteria=document.requirements.flatMap(req=>req.acceptanceCriteria.map(c=>({requirementId:req.id,criterionId:c.id})));
      scopeVerified=true;
    }
  }catch{ /* Invalid historical scope is explicit; never substitute current docs. */ }
  const covered=[...new Set<string>(profiles.flatMap((p:any)=>Array.isArray(p.criterionIds)?p.criterionIds:[]))].sort();
  const cleanupConfirmed=!!r?.cleanup?.confirmed && r.cleanup.operationId===op.id && r.cleanup.jobId===op.jobId && typeof r.cleanupRecordId==='string' && r.cleanupRecordId.length>0 && r.cleanup.recordId===r.cleanupRecordId && ['COMPLETED','FAILED','CONFLICTED'].includes(op.status);
  const evidenceClass=['CONTRACT_TEST','DYNAMIC_ISOLATED_COMMAND_CHECKS'].includes(r?.evidenceClass)?r.evidenceClass:['CONTRACT_TEST','DYNAMIC_ISOLATED_COMMAND_CHECKS'].includes(r?.execution?.evidenceClass)?r.execution.evidenceClass:'NO_EXECUTION';
  const rawResults=Array.isArray(r?.execution?.results)?r.execution.results:[];
  const expected=Array.isArray(a?.plan?.commands)?a.plan.commands:[];
  const results=expected.map((c:any,i:number)=>{const found=rawResults[i],v=found&&found.profileId===c.profileId&&found.id===c.id&&found.criterionId===c.criterionId?found:{};
    const limits=profiles.find((p:any)=>p.id===c.profileId)?.budgetProfile?.limits,measured=v.measurements;
    return {profileId:c.profileId,id:c.id,criterionId:c.criterionId,exitCode:Number.isInteger(v.exitCode)?v.exitCode:null,signal:v.signal==null?null:['SIGKILL','SIGTERM','SIGSEGV','SIGABRT','SIGINT','SIGPIPE','SIGXCPU','SIGXFSZ'].includes(v.signal)?v.signal:'UNKNOWN',timedOut:v.timedOut===true,outputLimitExceeded:v.outputLimitExceeded===true||v.outputLimitCause!=null,resourceLimitExceeded:v.resourceLimitExceeded===true||measured?.oomKilled===true||!!(limits&&measured&&(measured.rssBytes>limits.memoryMiB*1048576||measured.tmpBytes>limits.tmpMiB*1048576||measured.workBytes>limits.workMiB*1048576||measured.wallMs>c.timeoutMs||measured.cpuMs>c.timeoutMs)),sourceWriteAttempted:measured?.sourceWriteAttempted===true};});
  const measured=r?.execution?.measurements;
  const failed=measured?.sourceUnchanged===false||measured?.dependencyUnchanged===false||results.some((v:any)=>v.exitCode!==0||v.signal!==null||v.timedOut||v.outputLimitExceeded||v.resourceLimitExceeded||v.sourceWriteAttempted);
  const passed=evidenceClass!=='NO_EXECUTION'&&r?.passed===true&&!failed&&results.length>0&&results.length===rawResults.length&&cleanupConfirmed&&op.status==='COMPLETED';
  return {
    id:op.id,runId:op.runId,purpose:'BASELINE_VALIDATION' as const,status:op.status,stateVersion:op.stateVersion,authorityCurrent:current,createdAt:op.createdAt,
    authority:{main:{id:b?.main?.id,hash:b?.main?.hash},architecture:{id:b?.architecture?.id,hash:b?.architecture?.hash},approvalId:a?.approvalId,bindingHash:a?.bindingHash,planHash:a?.planHash,selectedProfileIds:Array.isArray(b?.selectedProfileIds)?b.selectedProfileIds:[],scopeVerified,criteria,coveredCriterionIds:covered,unassessedCriterionIds:criteria.filter(c=>!covered.includes(c.criterionId)).map(c=>c.criterionId),profiles:profiles.map((p:any)=>({id:p.id,repositoryId:p.repositoryId,baseline:p.baseline,requirementIds:p.requirementIds,criterionIds:p.criterionIds,runtimeProfileHash:p.runtimeProfileHash,budgetProfileHash:p.budgetProfile?.hash,measurementHash:p.budgetProfile?.measurementHash,commands:Array.isArray(p.commands)?p.commands.map((c:any)=>({id:c.id,criterionId:c.criterionId})):[]}))},
    result:r?{evidenceClass,outcome:!current||r.authorityCurrentAtResult===false||r.authorityCurrent===false?'STALE':failed?'FAILED':evidenceClass==='CONTRACT_TEST'&&passed?'CONTRACT_TEST_PASSED':passed?'PASSED':op.status==='FAILED'?'FAILED':'INCOMPLETE',passed,authorityCurrent:current,authorityCurrentAtCompletion:r.authorityCurrent===true,acceptedForCurrentAuthority:false,results}:null,
    cleanup:{confirmed:cleanupConfirmed,canRequest:['PREPARING','RUNNING','CLEANUP_REQUIRED'].includes(op.status),retryEligible:cleanupConfirmed&&['FAILED','CONFLICTED'].includes(op.status)},
  };
}

// Generic workspace event feeds must not provide an alternate raw receipt path.
// Immutable stored events remain intact; only their public projection changes.
export function baselineSafeEvent<T extends {kind:string;payload:unknown}>(event:T):T {
  return event.kind.startsWith('BASELINE_VALIDATION_')?{...event,payload:{purpose:'BASELINE_VALIDATION'}} as T:event;
}
