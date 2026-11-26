import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "@prisma/client";
import { WorkspaceService } from "../workspace-service";
import { NativeAssignmentService } from "../native-assignment";
import { HandoffPreviewService } from "../handoff-preview";
import { mainFromBrief } from "../document-contract";
import { randomUUID } from "crypto";
import { execFileSync } from "child_process";
import express from "express";
import jwt from "jsonwebtoken";
import { createWorkspaceRouter } from "../../routes/workspace-routes";
import { createAuthenticateToken } from "../../middleware/auth";
import { sessionVersion } from "../../security/session-version";
jest.mock("../../services/database",()=>({prisma:{}}));
jest.mock("../../config/env",()=>({JWT_SECRET:"native-disposable-test-key",ENCRYPTION_KEY:"00000000000000000000000000000000"}));

describe("native manual assignment ledger on disposable Postgres", () => {
  let db:PGlite, socket:PGLiteSocketServer, prisma:PrismaClient, service:NativeAssignmentService, workspace:WorkspaceService;
  let project:string, repo:string, main:any, arch:any, create:any;
  let databaseUrl:string;
  const baseline='a'.repeat(40), commit='b'.repeat(40);
  const receipt=(criterionId='AC-001')=>({criterionId,repositoryId:repo,baseline,commit,testedCommit:commit,status:'PASSED',check:{command:['node','--test','checks.cjs'],exitCode:0,stdout:'Disposable check passed',stderr:''},evidenceLabel:'DISPOSABLE_SAMPLE'});
  const snapshot=async()=>{
    const rows:Record<string,unknown>={};for(const model of ['workspaceHead','workspaceDocument','workspaceOperation','workspaceEvent','workspaceApproval','workspaceRun'])rows[model]=await (prisma as any)[model].findMany({orderBy:model==='workspaceHead'?{projectId:'asc'}:{id:'asc'}});return rows;
  };
  beforeAll(async()=>{
    if(process.env.ANKA_NATIVE_ASSIGNMENT_POSTGRES_URL){
      const url=new URL(process.env.ANKA_NATIVE_ASSIGNMENT_POSTGRES_URL);
      if(process.env.ANKA_LOCAL_REHEARSAL!=='1'||!['127.0.0.1','localhost'].includes(url.hostname)||url.pathname!=='/anka_rehearsal'||url.username!=='anka_rehearsal')throw Error('Disposable native Postgres guard rejected URL');
      const schema='native_assignment_'+randomUUID().replace(/-/g,'');url.searchParams.set('schema',schema);url.searchParams.set('connection_limit','1');databaseUrl=url.toString();
      const bootstrap=new PrismaClient({datasources:{db:{url:process.env.ANKA_NATIVE_ASSIGNMENT_POSTGRES_URL}}});await bootstrap.$executeRawUnsafe('CREATE SCHEMA "'+schema+'"');await bootstrap.$disconnect();
      execFileSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{cwd:path.resolve(__dirname,'../../..'),env:{...process.env,DATABASE_URL:databaseUrl},stdio:'pipe'});
    }else{
      db=new PGlite();const migrations=path.resolve(__dirname,'../../../prisma/migrations');
      for(const name of fs.readdirSync(migrations).filter(n=>fs.existsSync(path.join(migrations,n,'migration.sql'))).sort())await db.exec(fs.readFileSync(path.join(migrations,name,'migration.sql'),'utf8'));
      socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:4});await socket.start();
      databaseUrl='postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres?schema=public&connection_limit=1&sslmode=disable';
    }
    prisma=new PrismaClient({datasources:{db:{url:databaseUrl}}});
    await prisma.user.create({data:{id:'native-owner',email:'native-owner@example.test',password:'synthetic'}});
    await prisma.user.create({data:{id:'native-other',email:'native-other@example.test',password:'synthetic'}});
    workspace=new WorkspaceService(prisma);service=new NativeAssignmentService(prisma);
  },120000);
  afterAll(async()=>{await prisma?.$disconnect();await socket?.stop();await db?.close();});
  beforeEach(async()=>{
    const p=await prisma.project.create({data:{name:'Disposable native sample',userId:'native-owner'}});project=p.id;
    const r=await prisma.projectRepository.create({data:{projectId:project,name:'Sample',role:'documentation',githubUrl:'https://example.test/sample'}});repo=r.id;
    const content=mainFromBrief('Bounded sample note');content.questions=[];content.requirements[0].acceptanceCriteria.push({id:'AC-002',description:'A second check remains missing until returned.'});
    main=await workspace.save(project,'native-owner',{kind:'MAIN',content,expectedVersion:0,reason:'Disposable Main'});
    arch=await workspace.save(project,'native-owner',{kind:'ARCHITECTURE',expectedVersion:1,reason:'Disposable Architecture',content:{schemaVersion:1,sourceMain:{id:main.id,hash:main.contentHash},overview:'Bounded manual work',components:[{id:'COMP-SAMPLE',description:'Sample'}],dataMigrations:[],interfaces:[],security:['Owner scope'],operations:['No dispatch'],repositories:[{id:repo,baseline}],units:[{id:'UNIT-SAMPLE',title:'Sample note',requirementIds:['REQ-001'],dependsOn:[],repositoryId:repo,files:[{path:'README.md',action:'modify'}],checks:['AC-001','AC-002'].map(id=>({id:'CHECK-'+id,criterionId:id,type:'contains',path:'README.md',expected:'reviewed'}))}],questions:[]}});
    const selection={expectedStateVersion:2,mainId:main.id,mainHash:main.contentHash,architectureId:arch.id,architectureHash:arch.contentHash,requirementIds:['REQ-001'],criterionIds:['AC-001','AC-002']};
    const packet=await new HandoffPreviewService(prisma).preview(project,'native-owner',selection);
    create={...selection,packetHash:packet.packetHash,idempotencyKey:'native-create-001',sessionReference:'Synthetic current native session',authorizationNote:'Owner explicitly confirms only this disposable README scope.',acknowledgeAuthorization:true,files:[{repositoryId:repo,path:'README.md',action:'modify'}]};
  });
  it('registers one immutable manual assignment; exact retry creates no extra business records or runs',async()=>{
    const assignment=await service.create(project,'native-owner',create), before=await snapshot();
    expect(assignment.context.providerDispatchAuthorized).toBe(false);expect(assignment.context.authorizedBy).toBe('native-owner');
    expect((await service.create(project,'native-owner',create)).id).toBe(assignment.id);expect(await snapshot()).toEqual(before);
    expect(await prisma.workspaceRun.count({where:{projectId:project}})).toBe(0);expect(await prisma.workspaceApproval.count({where:{projectId:project}})).toBe(0);
    expect(assignment.criteria.map(c=>c.status)).toEqual(['MISSING','MISSING']);
    await expect(prisma.workspaceOperation.update({where:{id:assignment.id},data:{context:{forged:true}}})).rejects.toThrow();
  });
  it('rejects changed replay payload, competing keys/overlapping work, unsafe files and stale scope',async()=>{
    const a=await service.create(project,'native-owner',create), before=await snapshot();
    await expect(service.create(project,'native-owner',{...create,sessionReference:'Different'})).rejects.toMatchObject({code:'NATIVE_IDEMPOTENCY_CONFLICT'});
    const selection={...create,expectedStateVersion:3,idempotencyKey:'native-create-002'};
    const packet=await new HandoffPreviewService(prisma).preview(project,'native-owner',Object.fromEntries(['expectedStateVersion','mainId','mainHash','architectureId','architectureHash','requirementIds','criterionIds'].map(k=>[k,(selection as any)[k]])));
    await expect(service.create(project,'native-owner',{...selection,packetHash:packet.packetHash})).rejects.toMatchObject({code:'NATIVE_SCOPE_ALREADY_ASSIGNED'});
    await expect(service.create(project,'native-owner',{...create,idempotencyKey:'native-create-003',files:[{repositoryId:repo,path:'../private',action:'modify'}]})).rejects.toMatchObject({code:'SCOPE_PATH_INVALID'});
    await expect(service.recovery(project,'native-other',a.id)).rejects.toMatchObject({code:'PROJECT_RESOURCE_NOT_FOUND'});
    expect(await snapshot()).toEqual(before);
  });
  it('rejects mismatched tested commits, scope and contradictory receipts, with exact replay protection',async()=>{
    const a=await service.create(project,'native-owner',create);
    const input={expectedStateVersion:3,idempotencyKey:'native-evidence-001',receipt:receipt()};
    const before=await snapshot();
    await expect(service.evidence(project,'native-owner',a.id,{...input,receipt:{...input.receipt,testedCommit:'c'.repeat(40)}})).rejects.toMatchObject({code:'NATIVE_EVIDENCE_COMMIT_OR_RESULT_MISMATCH'});
    await expect(service.evidence(project,'native-owner',a.id,{...input,receipt:{...input.receipt,repositoryId:'foreign'}})).rejects.toMatchObject({code:'NATIVE_EVIDENCE_SCOPE_MISMATCH'});expect(await snapshot()).toEqual(before);
    const result=await service.evidence(project,'native-owner',a.id,input), after=await snapshot();
    expect(result.criteria.map(c=>c.status)).toEqual(['PASSED','MISSING']);expect(result.accepted).toBe(false);expect(result.independentVerification).toBe('NOT_PERFORMED');
    expect((await service.evidence(project,'native-owner',a.id,input)).evidence).toEqual(result.evidence);expect(await snapshot()).toEqual(after);
    await expect(service.evidence(project,'native-owner',a.id,{...input,expectedStateVersion:4,idempotencyKey:'native-evidence-002',receipt:{...input.receipt,status:'FAILED',check:{...input.receipt.check,exitCode:1}}})).rejects.toMatchObject({code:'NATIVE_EVIDENCE_CONFLICT'});
    expect(await snapshot()).toEqual(after);
  });
  it('recovers persisted scope/evidence from a fresh service without writes and records only explicit owner-reported metrics',async()=>{
    const a=await service.create(project,'native-owner',create);
    await service.evidence(project,'native-owner',a.id,{expectedStateVersion:3,idempotencyKey:'native-evidence-001',receipt:receipt()});
    const fresh=new NativeAssignmentService(prisma), before=await snapshot(), recovered=await fresh.recovery(project,'native-owner',a.id);
    expect(recovered.context.packet.documents.main.id).toBe(main.id);expect(recovered.context.files).toEqual(create.files);expect(recovered.criteria[1].status).toBe('MISSING');expect(recovered.recoveryObservations).toEqual([]);expect(await snapshot()).toEqual(before);
    const observation={expectedStateVersion:4,idempotencyKey:'native-recovery-001',sessionReference:'Fresh synthetic owner session',repeatedContextCount:0,acknowledgeOwnerReported:true};
    const observed=await fresh.observeRecovery(project,'native-owner',a.id,observation);expect(observed.recoveryObservations[0].measurementClass).toBe('OWNER_REPORTED');
    const after=await snapshot();await fresh.observeRecovery(project,'native-owner',a.id,observation);expect(await snapshot()).toEqual(after);
  });
  it('retains old assignment history but rejects new evidence when documents change',async()=>{
    const a=await service.create(project,'native-owner',create);const updated=structuredClone(main.content);updated.purpose='New scope requires reauthorization';
    await workspace.save(project,'native-owner',{kind:'MAIN',content:updated,expectedVersion:3,reason:'Disposable concurrent revision'});
    const before=await snapshot(), recovered=await service.recovery(project,'native-owner',a.id);expect(recovered.authorityCurrent).toBe(false);
    await expect(service.evidence(project,'native-owner',a.id,{expectedStateVersion:4,idempotencyKey:'native-evidence-001',receipt:receipt()})).rejects.toMatchObject({code:'HANDOFF_STALE'});expect(await snapshot()).toEqual(before);
  });
  it('keeps not-run, failed and mixed-commit owner reports distinct from acceptance',async()=>{
    const a=await service.create(project,'native-owner',create);
    const notRun={...receipt(),status:'NOT_RUN',commit:null,testedCommit:null,check:{command:[],exitCode:null,stdout:'',stderr:''}};
    await service.evidence(project,'native-owner',a.id,{expectedStateVersion:3,idempotencyKey:'native-notrun-001',receipt:notRun});
    const failed={...receipt('AC-002'),status:'FAILED',check:{...receipt().check,exitCode:1}};
    const incomplete=await service.evidence(project,'native-owner',a.id,{expectedStateVersion:4,idempotencyKey:'native-failed-002',receipt:failed});
    expect(incomplete.criteria.map(c=>c.status)).toEqual(['NOT_RUN','FAILED']);expect(incomplete.accepted).toBe(false);
    await service.evidence(project,'native-owner',a.id,{expectedStateVersion:5,idempotencyKey:'native-newcommit-001',receipt:{...receipt(),commit:'c'.repeat(40),testedCommit:'c'.repeat(40)}});
    const mixed=await service.evidence(project,'native-owner',a.id,{expectedStateVersion:6,idempotencyKey:'native-newcommit-002',receipt:{...receipt('AC-002'),commit:'d'.repeat(40),testedCommit:'d'.repeat(40)}});
    expect(mixed.criteria.map(c=>c.status)).toEqual(['PASSED','PASSED']);expect(mixed.nextDecision).toMatch(/different commits/);expect(mixed.accepted).toBe(false);expect(mixed.evidence).toHaveLength(4);
  });
  it('collapses competing independent-client claims to one assignment and one state transition',async()=>{
    const clients=[new PrismaClient({datasources:{db:{url:databaseUrl}}}),new PrismaClient({datasources:{db:{url:databaseUrl}}})];
    try{
      if(process.env.ANKA_NATIVE_ASSIGNMENT_POSTGRES_URL){const pids=await Promise.all(clients.map(c=>c.$queryRawUnsafe<Array<{pid:number}>>('SELECT pg_backend_pid() AS pid')));expect(pids[0][0].pid).not.toBe(pids[1][0].pid);}
      const results=await Promise.allSettled(clients.map(c=>new NativeAssignmentService(c).create(project,'native-owner',create)));
      expect(results.some(r=>r.status==='fulfilled')).toBe(true);
      for(const r of results)if(r.status==='rejected')expect(['STATE_CONFLICT','HANDOFF_STALE']).toContain(r.reason.code);
      const replay=await service.create(project,'native-owner',create);expect(replay.id).toBeTruthy();
      expect(await prisma.workspaceOperation.count({where:{projectId:project,kind:'NATIVE_ASSIGNMENT'}})).toBe(1);
      expect((await prisma.workspaceHead.findUnique({where:{projectId:project}}))?.stateVersion).toBe(3);
      expect(await prisma.workspaceEvent.count({where:{projectId:project,kind:'NATIVE_ASSIGNMENT_RECORDED'}})).toBe(1);
    }finally{await Promise.all(clients.map(c=>c.$disconnect()));}
  },30000);
  it('marks removed repository bindings stale and refuses evidence without mutating the ledger',async()=>{
    const a=await service.create(project,'native-owner',create);
    await prisma.projectRepository.delete({where:{id:repo}});
    const before=await snapshot();expect((await service.recovery(project,'native-owner',a.id)).authorityCurrent).toBe(false);
    await expect(service.evidence(project,'native-owner',a.id,{expectedStateVersion:3,idempotencyKey:'native-evidence-001',receipt:receipt()})).rejects.toMatchObject({code:'HANDOFF_STALE'});
    expect(await snapshot()).toEqual(before);
  });
  it('uses the normal JWT owner route, defaults off, and rejects unauthorized/cross-project recovery',async()=>{
    const oldFlag=process.env.ANKA_NATIVE_WORKFLOW_ENABLED,app=express();app.use(express.json());app.use('/projects/:projectId/workspace',createAuthenticateToken(prisma),createWorkspaceRouter(prisma));
    const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));
    const url='http://127.0.0.1:'+(server.address() as {port:number}).port+'/projects/'+project+'/workspace/native-assignments';
    const token=jwt.sign({userId:'native-owner',sessionVersion:sessionVersion({id:'native-owner',password:'synthetic'})},'native-disposable-test-key');
    const headers={'Content-Type':'application/json',Authorization:'Bearer '+token};
    try{
      process.env.ANKA_NATIVE_WORKFLOW_ENABLED='false';expect((await fetch(url,{headers})).status).toBe(503);
      process.env.ANKA_NATIVE_WORKFLOW_ENABLED='true';expect((await fetch(url)).status).toBe(401);
      const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(create)});expect(response.status).toBe(200);const a=(await response.json() as any).data;
      const before=await snapshot();const recovered=await fetch(url+'/'+a.id+'/recovery',{headers});expect(recovered.status).toBe(200);expect((await recovered.json() as any).data.context.packet.documents.main.id).toBe(main.id);expect(await snapshot()).toEqual(before);
      expect((await fetch(url+'/foreign-assignment/recovery',{headers})).status).toBe(404);
    }finally{if(oldFlag===undefined)delete process.env.ANKA_NATIVE_WORKFLOW_ENABLED;else process.env.ANKA_NATIVE_WORKFLOW_ENABLED=oldFlag;await new Promise<void>(resolve=>server.close(()=>resolve()));}
  },30000);
});
