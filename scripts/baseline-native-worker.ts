import { PrismaClient } from "@prisma/client";
import { BaselineValidationService } from "../src/workspace/baseline-validation-service";
import { baselineDocuments } from "../src/workspace/__tests__/baseline-fixture";
import readline from "readline";
(async () => {
  const url = new URL(process.env.ANKA_REHEARSAL_DATABASE_URL || "");
  if (
    process.env.ANKA_LOCAL_REHEARSAL !== "1" ||
    url.hostname !== "127.0.0.1" ||
    url.protocol !== "postgresql:" ||
    url.username !== "anka_rehearsal" ||
    url.password !== "synthetic" ||
    url.pathname !== "/anka_rehearsal" ||
    !/^anka_rehearsal_[a-f0-9]{32}$/.test(
      url.searchParams.get("schema") || "",
    ) ||
    [...url.searchParams.keys()].some(
      (k) => !["schema", "connection_limit"].includes(k),
    )
  )
    throw Error("Synthetic scoped loopback only");
  const db = new PrismaClient({ datasources: { db: { url: url.href } } });
  try {
    if (process.argv[2] === "setup") {
      const f = await baselineDocuments(db, "project", "owner");
      // Authorize an alternate run before any claim, so native checks can
      // prove a different run/key cannot evade the project-wide active-job guard.
      await f.baseline.authorize('project','owner',{
        ...f.runInput,expectedVersion:f.claimInput.expectedVersion,
        idempotencyKey:'native-preauthorized-alternate',
      });
      console.log(JSON.stringify({...f.claimInput,expectedVersion:f.claimInput.expectedVersion+1}));
      return;
    }
    const request = JSON.parse(process.env.ANKA_BASELINE_CLAIM || "{}");
    if (process.argv[2] === 'guards') {
      const service=new BaselineValidationService(db);
      const run=await db.workspaceRun.findUniqueOrThrow({where:{id:request.runId}});
      const runs=await db.workspaceRun.findMany({where:{projectId:'project',purpose:'BASELINE_VALIDATION'}});
      const alternate=runs.find(r=>r.id!==run.id);
      if(runs.length!==2||!alternate)throw Error('Native alternate run missing');
      const operation=await db.baselineValidationOperation.findFirstOrThrow({where:{projectId:'project'}});
      if(operation.status!=='PREPARING')throw Error('Native claim state invalid');
      const outcomes:{stage:string;action:string;code:string}[]=[];
      const denied=async(stage:string,action:string,call:()=>Promise<unknown>)=>{
        try{await call();throw Error('Project-wide cleanup guard allowed '+action);}
        catch(e:any){if(e.code!=='BASELINE_CLEANUP_REQUIRED')throw e;outcomes.push({stage,action,code:e.code});}
      };
      for(const stage of ['PREPARING','CLEANUP_REQUIRED']){
        if(stage==='CLEANUP_REQUIRED')await service.requestCleanup('project','owner',operation.id);
        const head=await db.workspaceHead.findUniqueOrThrow({where:{projectId:'project'}}),a=run.authority as any;
        await denied(stage,'AUTHORIZE_FRESH_KEY',()=>service.authorize('project','owner',{
          approvalId:run.approvalId,expectedVersion:head.stateVersion,
          expectedBindingHash:a.bindingHash,expectedPlanHash:a.planHash,
          idempotencyKey:'native-guard-authorize-'+stage.replace(/_/g,'-'),retryOfOperationId:null,
        }));
        await denied(stage,'CLAIM_PREAUTHORIZED_ALTERNATE_RUN',()=>service.claim('project','owner',{
          runId:alternate.id,expectedVersion:head.stateVersion,
          expectedBindingHash:a.bindingHash,expectedPlanHash:a.planHash,
          idempotencyKey:'native-guard-claim-'+stage.replace(/_/g,'-'),
        }));
        if((await db.workspaceHead.findUniqueOrThrow({where:{projectId:'project'}})).stateVersion!==head.stateVersion)
          throw Error('Denied guard attempt changed authority');
      }
      const operations=await db.baselineValidationOperation.count({where:{projectId:'project'}}),events=await db.workspaceEvent.count({where:{projectId:'project',kind:'BASELINE_VALIDATION_PREPARING'}});
      if(operations!==1||events!==1)throw Error('Project guard created a second job');
      console.log(JSON.stringify({preauthorizedRuns:2,outcomes,durableOperations:operations,preparingEvents:events,actualRuntimeDispatched:false,passed:true}));
      return;
    }
    if (process.env.ANKA_BASELINE_RACE_VARIANT === "different-key")
      request.idempotencyKey += "-" + process.env.ANKA_BASELINE_WORKER_INDEX;
    const [{ pid }] = await db.$queryRawUnsafe<{ pid: number }[]>(
      "SELECT pg_backend_pid() AS pid",
    );
    console.log(JSON.stringify({ ready: true, pid }));
    await new Promise<void>((resolve) =>
      readline
        .createInterface({ input: process.stdin })
        .once("line", () => resolve()),
    );
    try {
      const result = await new BaselineValidationService(db).claim(
        "project",
        "owner",
        request,
      );
      console.log(
        JSON.stringify({
          outcome: result.reused ? "REUSED" : "CLAIMED",
          operationId: result.operation.id,
        }),
      );
    } catch (e: any) {
      if (
        !["STATE_CONFLICT", "BASELINE_OPERATION_ALREADY_CLAIMED"].includes(
          e.code,
        )
      )
        throw e;
      console.log(JSON.stringify({ outcome: e.code }));
    }
  } finally {
    await db.$disconnect();
  }
})().catch(() => {
  console.error("Native baseline rehearsal worker failed");
  process.exitCode = 1;
});
