import fs from "fs";
import path from "path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { PrismaClient } from "@prisma/client";
import { postgresAdapter } from "./postgres-adapter";
import { WorkspaceService } from "../workspace-service";
import { HandoffPreviewService } from "../handoff-preview";
import { mainFromBrief, hash } from "../document-contract";
import express from "express";
import jwt from "jsonwebtoken";
import { createWorkspaceRouter } from "../../routes/workspace-routes";
import { createAuthenticateToken } from "../../middleware/auth";
import { sessionVersion } from "../../security/session-version";
jest.mock("../../services/database",()=>({prisma:{}}));
jest.mock("../../config/env",()=>({JWT_SECRET:"disposable-preview-test-secret",ENCRYPTION_KEY:"00000000000000000000000000000000"}));

describe("disposable draft handoff: read-only business persistence",()=>{
  let db:any, preview:HandoffPreviewService, request:any;
  let native:PrismaClient, socket:PGLiteSocketServer;
  const snapshot=async()=>{
    const result:Record<string,unknown>={};
    for(const table of ["WorkspaceHead","WorkspaceDocument","WorkspaceRun","WorkspaceOperation","WorkspaceApproval","WorkspaceEvent"])
      result[table]=(await db.query('SELECT * FROM "'+table+'" ORDER BY "'+(table==='WorkspaceHead'?'projectId':'id')+'"')).rows;
    return result;
  };
  beforeAll(async()=>{
    db=new PGlite();
    await db.exec(fs.readFileSync(path.join(__dirname,"fixtures/legacy-schema.sql"),"utf8"));
    await db.exec(`INSERT INTO users (id,email,password,"updatedAt") VALUES ('owner','sample@example.test','synthetic',now()); INSERT INTO projects (id,name,"userId","updatedAt") VALUES ('p','Sample','owner',now()),('empty','Empty sample','owner',now());`);
    await db.exec(`UPDATE projects SET "githubToken"='PRIVATE-PROJECT-TOKEN-SENTINEL',"localPath"='PRIVATE-PROJECT-PATH-SENTINEL' WHERE id='p';`);
    for(const name of ["20261024170000_workspace_authority","20261024180000_workspace_operations"])
      await db.exec(fs.readFileSync(path.resolve(__dirname,"../../../prisma/migrations",name,"migration.sql"),"utf8"));
    const adapter=postgresAdapter(db), service=new WorkspaceService(adapter);
    const content=mainFromBrief("Disposable sample"); content.questions=[];
    content.brief="PRIVATE-BRIEF-SENTINEL";
    content.legacySources=["PRIVATE-LEGACY-SENTINEL"];
    content.requirements.push({id:"REQ-SECRET",description:"PRIVATE-UNSELECTED-SENTINEL",acceptanceCriteria:[{id:"AC-SECRET",description:"PRIVATE-CRITERION-SENTINEL"}]});
    const main=await service.save("p","owner",{kind:"MAIN",content,expectedVersion:0,reason:"Sample draft"});
    const architecture=await service.save("p","owner",{kind:"ARCHITECTURE",content:{schemaVersion:1,sourceMain:{id:main.id,hash:main.contentHash},overview:"PRIVATE-OVERVIEW-SENTINEL",components:[{id:"COMP-SAMPLE",description:"Sample component"}],dataMigrations:[],interfaces:[],security:["Owner only"],operations:["Local preview"],repositories:[],units:[],questions:[]},expectedVersion:1,reason:"Sample linked draft"});
    socket=new PGLiteSocketServer({db,host:'127.0.0.1',port:0,maxConnections:1});await socket.start();
    native=new PrismaClient({datasources:{db:{url:'postgresql://postgres:postgres@'+socket.getServerConn()+'/postgres?schema=public&connection_limit=1&sslmode=disable'}}});
    preview=new HandoffPreviewService(native);
    request={expectedStateVersion:2,mainId:main.id,mainHash:main.contentHash,architectureId:architecture.id,architectureHash:architecture.contentHash,requirementIds:[content.requirements[0].id],criterionIds:[content.requirements[0].acceptanceCriteria[0].id]};
  },120000);
  afterAll(async()=>{await native?.$disconnect();await socket?.stop();await db?.close();});
  it("returns a deterministic allowlisted UNBOUND draft without approval or writes",async()=>{
    const before=await snapshot(), first=await preview.preview("p","owner",request);
    expect(first).toEqual(await preview.preview("p","owner",request));
    expect(first.purpose).toBe("DRAFT_PREVIEW");expect(first.executionAuthorized).toBe(false);
    expect(first.repositoryBinding).toEqual({status:"UNBOUND",repositories:[],unboundCriterionIds:request.criterionIds});
    expect(JSON.stringify(first)).not.toContain("PRIVATE-");
    expect(await snapshot()).toEqual(before);
    if(process.env.ANKA_PREVIEW_EVIDENCE_OUTPUT)fs.writeFileSync(process.env.ANKA_PREVIEW_EVIDENCE_OUTPUT,JSON.stringify({evidenceClass:'DISPOSABLE_SAMPLE_TEST',nativeHandoffPerformed:false,packet:first,businessRows:Object.fromEntries(Object.entries(before).map(([name,rows])=>[name,(rows as unknown[]).length])),unchangedAfterRepeat:true},null,2));
  });
  it("rejects stale, malformed, cross-project, nonowner and missing-head requests without writes",async()=>{
    const before=await snapshot();
    for(const [project,actor,body,code] of [
      ["p","",request,"AUTHENTICATION_REQUIRED"],
      ["p","other",request,"PROJECT_RESOURCE_NOT_FOUND"],
      ["empty","owner",request,"DRAFT_DOCUMENTS_REQUIRED"],
      ["p","owner",{...request,expectedStateVersion:1},"HANDOFF_STALE"],
      ["p","owner",{...request,mainHash:"0".repeat(64)},"HANDOFF_STALE"],
      ["p","owner",{...request,architectureHash:"0".repeat(64)},"HANDOFF_STALE"],
      ["p","owner",{...request,architectureId:"foreign"},"HANDOFF_STALE"],
      ["p","owner",{...request,criterionIds:["AC-SECRET"]},"HANDOFF_SELECTION_INVALID"],
      ["p","owner",{...request,criterionIds:[...request.criterionIds,...request.criterionIds]},"HANDOFF_SELECTION_INVALID"],
      ["p","owner",{...request,requirementIds:["REQ-UNKNOWN"]},"HANDOFF_SELECTION_INVALID"],
      ["p","owner",{...request,criterionIds:[]},"HANDOFF_SELECTION_INVALID"],
      ["p","owner",{...request,expectedStateVersion:-1},"HANDOFF_SELECTION_INVALID"],
      ["p","owner",{...request,extra:"reject"},"HANDOFF_SELECTION_INVALID"],
    ] as const){
      await expect(preview.preview(project,actor,body)).rejects.toMatchObject({message:code});
      expect(await snapshot()).toEqual(before);
    }
  });
  it("serves the normal owner API with JWT authentication and no business writes",async()=>{
    const adapter=postgresAdapter(db), app=express();app.use(express.json());
    app.use('/projects/:projectId/workspace',createAuthenticateToken(adapter),createWorkspaceRouter(native));
    const server=app.listen(0,'127.0.0.1');
    await new Promise<void>(resolve=>server.once('listening',resolve));
    const base='http://127.0.0.1:'+(server.address() as {port:number}).port;
    const user={id:'owner',password:'synthetic'};
    const token=jwt.sign({userId:user.id,sessionVersion:sessionVersion(user)},'disposable-preview-test-secret');
    const before=await snapshot();
    const send=(project:string,authorized=true)=>fetch(base+'/projects/'+project+'/workspace/handoff-preview',{method:'POST',headers:{'Content-Type':'application/json',...(authorized?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(request)});
    try{
      expect((await send('p',false)).status).toBe(401);
      const result=await send('p');expect(result.status).toBe(200);
      expect((await result.json() as any).data).toEqual(await preview.preview('p','owner',request));
      expect((await send('empty')).status).toBe(422);
      expect((await send('foreign')).status).toBe(404);
      expect(await snapshot()).toEqual(before);
    }finally{await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  },20000);
  it("rejects a newly saved Main until Architecture is relinked, with no preview writes",async()=>{
    const service=new WorkspaceService(postgresAdapter(db));
    const content=mainFromBrief('New disposable sample revision');content.questions=[];
    const revision=await service.save('p','owner',{kind:'MAIN',content,expectedVersion:2,reason:'Sample revision invalidates sourceMain'});
    const before=await snapshot();
    await expect(preview.preview('p','owner',{...request,expectedStateVersion:3,mainId:revision.id,mainHash:revision.contentHash})).rejects.toMatchObject({message:'MAIN_VERSION_MISMATCH'});
    expect(await snapshot()).toEqual(before);
  });
  it("exports only criterion-mapped repositories, leaving unmapped scope explicitly UNBOUND",async()=>{
    await db.exec(`INSERT INTO projects (id,name,"userId","updatedAt") VALUES ('bindings','Disposable bindings','owner',now()); INSERT INTO project_repositories (id,"projectId",name,role,"githubUrl","localPath","updatedAt") VALUES ('repo-a','bindings','A','sample','https://example.test/a','PRIVATE-A',now()),('repo-b','bindings','B','sample','https://example.test/b','PRIVATE-B',now());`);
    const service=new WorkspaceService(postgresAdapter(db)), content=mainFromBrief('Disjoint synthetic repositories');content.questions=[];
    content.requirements=[{id:'REQ-A',description:'A only',acceptanceCriteria:[{id:'AC-A',description:'A passes'}]},{id:'REQ-B',description:'B only',acceptanceCriteria:[{id:'AC-B',description:'B passes'}]},{id:'REQ-UNMAPPED',description:'No mapping',acceptanceCriteria:[{id:'AC-UNMAPPED',description:'Unmapped criterion'}]}];
    const main=await service.save('bindings','owner',{kind:'MAIN',content,expectedVersion:0,reason:'Sample scope'});
    const arch=await service.save('bindings','owner',{kind:'ARCHITECTURE',expectedVersion:1,reason:'Disjoint sample mappings',content:{schemaVersion:1,sourceMain:{id:main.id,hash:main.contentHash},overview:'Sample',components:[{id:'COMP-A',description:'Sample'}],dataMigrations:[],interfaces:[],security:['Owner only'],operations:['Local only'],repositories:[{id:'repo-a',baseline:'a'.repeat(40)},{id:'repo-b',baseline:'b'.repeat(40)}],questions:[],units:['A','B'].map(id=>({id:'UNIT-'+id,title:id,requirementIds:['REQ-'+id],dependsOn:[],repositoryId:'repo-'+id.toLowerCase(),files:[{path:'README.md',action:'modify'}],checks:[{id:'CHECK-'+id,criterionId:'AC-'+id,type:'contains',path:'README.md',expected:id}]}))}});
    const base={expectedStateVersion:2,mainId:main.id,mainHash:main.contentHash,architectureId:arch.id,architectureHash:arch.contentHash};
    const before=await snapshot();
    for(const id of ['A','B']){
      const packet=await preview.preview('bindings','owner',{...base,requirementIds:['REQ-'+id],criterionIds:['AC-'+id]});
      expect(packet.repositoryBinding).toEqual({status:'BOUND',repositories:[{id:'repo-'+id.toLowerCase(),baseline:id.toLowerCase().repeat(40)}],unboundCriterionIds:[]});
    }
    expect((await preview.preview('bindings','owner',{...base,requirementIds:['REQ-UNMAPPED'],criterionIds:['AC-UNMAPPED']})).repositoryBinding).toEqual({status:'UNBOUND',repositories:[],unboundCriterionIds:['AC-UNMAPPED']});
    expect(await snapshot()).toEqual(before);
    const budget={measurementHash:'c'.repeat(64),limits:{totalTimeoutMs:1000,memoryMiB:64,workMiB:32,tmpMiB:16,stdoutBytes:64,stderrBytes:64}};
    const validation=await service.save('bindings','owner',{kind:'ARCHITECTURE',expectedVersion:2,reason:'Sample validation mappings',content:{...(arch.content as any),schemaVersion:2,units:[],validationProfiles:['A','B'].map(id=>({id:'VAL-'+id,title:id,requirementIds:['REQ-'+id],criterionIds:['AC-'+id],repositoryId:'repo-'+id.toLowerCase(),baseline:id.toLowerCase().repeat(40),runtimeProfileHash:'d'.repeat(64),budgetProfile:{...budget,hash:hash(budget)},commands:[{id:'CMD-'+id,criterionId:'AC-'+id,argv:['node','--version'],cwd:'.',timeoutMs:1000}]}))}});
    const beforeValidation=await snapshot();
    const validationPacket=await preview.preview('bindings','owner',{...base,expectedStateVersion:3,architectureId:validation.id,architectureHash:validation.contentHash,requirementIds:['REQ-A'],criterionIds:['AC-A']});
    expect(validationPacket.repositoryBinding).toEqual({status:'BOUND',repositories:[{id:'repo-a',baseline:'a'.repeat(40)}],unboundCriterionIds:[]});
    expect(await snapshot()).toEqual(beforeValidation);
  });
});

