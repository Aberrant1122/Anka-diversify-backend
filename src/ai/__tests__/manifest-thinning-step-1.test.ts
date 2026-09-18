import fs from "fs";
import os from "os";
import path from "path";
import { CodeGenerator } from "../generation/CodeGenerator";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { AuthorizedCapabilityScope, CapabilityGuard } from "../runtime/CapabilityGuard";
import { bindUserRequest } from "../repository/TrustedTaskContext";
import type { ExecutionContract, FileManifest } from "../../types";

function mockGateway(content: unknown, stage: string = PipelineStages.CODE_GENERATION) {
  return {
    content,
    rawResponse: {},
    finishReason: "stop",
    latencyMs: 1,
    model: "test-model",
    stage,
  };
}

describe("Manifest Thinning Step 1 — Advisory Audit Demotion", () => {
  let workspace: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "anka-thinning-step1-"));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(workspace)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  const basePolicy: PolicyContract = {
    goal: "Step 1 test policy",
    taskType: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "SMALL",
    destructive: false,
    allowedActions: ["create_file", "modify_file"],
    forbiddenActions: ["delete_file"],
    maxFiles: 5,
    diffCriticEnabled: true,
    pipeline: "STANDALONE",
    environment: "HTML_CSS_JS",
    repositoryRequired: false,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [],
    userConstraints: [],
    requiresClarification: false,
  };

  const baseIntent: TaskIntentSpec = {
    goal: basePolicy.goal,
    operations: [{ kind: "CREATE", subject: "approved target" }],
    constraints: [],
    acceptanceCriteria: [],
    destructive: false,
    requiresClarification: false,
    taskType: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "SMALL",
    explicitUserPaths: [],
  };

  const standaloneContract: ExecutionContract = {
    goal: "Implement standalone features",
    taskType: "NEW_FEATURE",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    pipeline: "STANDALONE",
    environment: "HTML_CSS_JS",
    repositoryRequired: false,
    expectedFiles: ["src/approved.ts"],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: ["src/approved.ts"],
    allowedActions: ["create", "modify"],
    forbiddenActions: ["delete"],
    maxFiles: 5,
    searchScope: ["src"],
    contextScope: ["src"],
    diffCriticEnabled: false,
  };

  // 1. EXACT MATCH STILL PASSES
  test("1. EXACT MATCH STILL PASSES: Planning manifest matches generated change without observations", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValueOnce(
      mockGateway({
        explanation: "Exact match proposal",
        commitMessage: "feat: approved",
        changes: [
          { path: "src/approved.ts", action: "create", content: "export const approved = true;", description: "create approved" },
        ],
      }) as any,
    );

    const planningManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "src/approved.ts", action: "create", description: "Approved", dependencies: [] }],
    };

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Create approved",
      { intent: "FEATURE" },
      { fileContext: {}, skeletonContext: {} },
      "system prompt",
      standaloneContract,
      planningManifest,
    );

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].path).toBe("src/approved.ts");
    expect(result.manifestObservations).toEqual([]);
  });

  // 2. UNPLANNED GENERATED PATH DOES NOT HARD FAIL
  test("2. UNPLANNED GENERATED PATH DOES NOT HARD FAIL: Discovery beyond manifest continues with advisory audit", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValueOnce(
      mockGateway({
        explanation: "Discovered additional path",
        commitMessage: "feat: approved and late discovery",
        changes: [
          { path: "src/approved.ts", action: "create", content: "export const approved = true;", description: "create approved" },
          { path: "src/late-discovered.ts", action: "create", content: "export const late = true;", description: "late discovered" },
        ],
      }) as any,
    );

    const planningManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "src/approved.ts", action: "create", description: "Approved", dependencies: [] }],
    };

    // Must NOT throw GENERATED_MANIFEST_MISMATCH
    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Create approved",
      { intent: "FEATURE" },
      { fileContext: {}, skeletonContext: {} },
      "system prompt",
      standaloneContract,
      planningManifest,
    );

    // Both proposals returned to allow downstream deterministic authority evaluation
    expect(result.changes).toHaveLength(2);
    expect(result.changes.map((c) => c.path)).toEqual(["src/approved.ts", "src/late-discovered.ts"]);

    // Non-authoritative advisory audit observation recorded
    expect(result.manifestObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/late-discovered.ts",
          reason: "UNPLANNED_PATH",
          actualAction: "create",
        }),
      ]),
    );
  });

  // 3. ACTION DIFFERENCE IS ADVISORY AT MANIFEST BOUNDARY
  test("3. ACTION DIFFERENCE IS ADVISORY AT MANIFEST BOUNDARY: Manifest mismatch is recorded as advisory audit only", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValueOnce(
      mockGateway({
        explanation: "Differing action proposed",
        commitMessage: "refactor: delete instead of modify",
        changes: [
          { path: "src/approved.ts", action: "delete", isDeleted: true, content: "", description: "Delete" },
        ],
      }) as any,
    );

    const planningManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "src/approved.ts", action: "modify", description: "Planned as modify", dependencies: [] }],
    };

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Refactor approved",
      { intent: "FEATURE" },
      { fileContext: {}, skeletonContext: {} },
      "system prompt",
      standaloneContract,
      planningManifest,
    );

    expect(result.changes[0].action).toBe("delete");
    expect(result.manifestObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "src/approved.ts",
          reason: "PLANNED_ACTION_DIFFERED",
          plannedAction: "modify",
          actualAction: "delete",
        }),
      ]),
    );
  });

  // 4. UNAUTHORIZED LATE TARGET STILL FAILS DOWNSTREAM
  test("4. UNAUTHORIZED LATE TARGET STILL FAILS DOWNSTREAM: Downstream PreExecutionAuthorityClosure rejects late proposal lacking deterministic evidence", () => {
    const evidence = new RepositoryEvidenceStore("repo", workspace);
    bindUserRequest(baseIntent, "Modify src/a.ts");
    fs.writeFileSync(path.join(workspace, "src/a.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(workspace, "src/unauthorized-late.ts"), "export const u = 1;");

    // Only src/a.ts has authentic AST evidence
    evidence.observeRepository({ kind: "SYMBOL", filePath: "src/a.ts", symbol: "a", provenance: "AST_GRAPH" });

    // Proposal contains both a.ts and an unauthorized late target
    const generatedChanges = [
      { path: "src/a.ts", action: "modify" as const, content: "export const a = 2;", description: "modify a" },
      { path: "src/unauthorized-late.ts", action: "modify" as const, content: "export const u = 2;", description: "unauthorized" },
    ];

    const closure = PreExecutionAuthorityClosure.close({
      changes: generatedChanges,
      policy: { ...basePolicy, allowedActions: ["modify_file"] },
      intentSpec: baseIntent,
      evidenceStore: evidence,
      existingFiles: ["src/a.ts", "src/unauthorized-late.ts"],
      repositoryId: "repo",
      workspaceRoot: workspace,
      stageId: "stage-1",
    });

    // Invariant: demoting manifest mismatch does NOT authorize mutation
    expect(closure.valid).toBe(false);
    expect(closure.result.rejectedPaths).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/unauthorized-late.ts" }),
      ]),
    );
  });

  // 5. AUTHORIZED LATE TARGET CAN PASS AUTHORITY CLOSURE
  test("5. AUTHORIZED LATE TARGET CAN PASS AUTHORITY CLOSURE: Late target with authentic relation evidence passes closure", () => {
    const evidence = new RepositoryEvidenceStore("repo", workspace);
    bindUserRequest(baseIntent, "Repair src/consumer.ts");
    fs.writeFileSync(path.join(workspace, "src/consumer.ts"), "import { helper } from './helper'; helper();");
    fs.writeFileSync(path.join(workspace, "src/helper.ts"), "export function helper() { return 1; }");

    // Authentic relation evidence discovered by task-grounded anchor
    evidence.observeRepository({
      kind: "REFERENCE",
      filePath: "src/helper.ts",
      sourceFile: "src/consumer.ts",
      symbol: "helper",
      provenance: "REFERENCE_SEARCH",
    });

    const lateGeneratedProposal = [
      { path: "src/helper.ts", action: "modify" as const, content: "export function helper() { return 2; }", description: "repair helper" },
    ];

    const closure = PreExecutionAuthorityClosure.close({
      changes: lateGeneratedProposal,
      policy: { ...basePolicy, allowedActions: ["modify_file"] },
      intentSpec: baseIntent,
      evidenceStore: evidence,
      existingFiles: ["src/consumer.ts", "src/helper.ts"],
      repositoryId: "repo",
      workspaceRoot: workspace,
      stageId: "stage-1",
    });

    expect(closure.valid).toBe(true);
    expect(closure.result.approvedPaths).toEqual(["src/helper.ts"]);
  });

  // 6. DELETE SAFETY REMAINS STRICT
  test("6. DELETE SAFETY REMAINS STRICT: Destructive delete action requires independent capability authorization", () => {
    fs.writeFileSync(path.join(workspace, "src/approved.ts"), "export const approved = true;");
    const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: workspace,
      authorityId: "auth-scope-test",
      grants: [{ path: "src/approved.ts", action: "FILE_MODIFY" }],
    })!;

    const guard = CapabilityGuard.create({
      workspaceRoot: workspace,
      scopeId: "stage-test",
      authorizedScope,
    });

    // FILE_MODIFY is granted
    expect(guard.authorize({ path: "src/approved.ts", action: "FILE_MODIFY", scopeId: "stage-test" }).allowed).toBe(true);

    // FILE_DELETE is denied even for the exact same path
    const deleteDecision = guard.authorize({ path: "src/approved.ts", action: "FILE_DELETE", scopeId: "stage-test" });
    expect(deleteDecision.allowed).toBe(false);
    expect(deleteDecision.code).toBe("CAPABILITY_ACTION_NOT_DECLARED");
  });

  // 7. PATH TRAVERSAL / REPOSITORY ESCAPE REMAINS REJECTED
  test("7. PATH TRAVERSAL / REPOSITORY ESCAPE REMAINS REJECTED: Boundary protection independently rejects path traversal", () => {
    fs.writeFileSync(path.join(workspace, "src/approved.ts"), "export const approved = true;");
    const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: workspace,
      authorityId: "auth-scope-test",
      grants: [{ path: "src/approved.ts", action: "FILE_MODIFY" }],
    })!;

    const guard = CapabilityGuard.create({
      workspaceRoot: workspace,
      scopeId: "stage-test",
      authorizedScope,
    });

    const escapeDecision = guard.authorize({
      path: "../../outside.ts",
      action: "FILE_MODIFY",
      scopeId: "stage-test",
    });
    expect(escapeDecision.allowed).toBe(false);
  });
});
