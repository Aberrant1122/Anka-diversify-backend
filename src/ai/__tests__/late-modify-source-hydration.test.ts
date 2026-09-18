import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { AuthoritativeSourceHydrator } from "../manifest/AuthoritativeSourceHydrator";
import { CodeGenerator } from "../generation/CodeGenerator";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { bindUserRequest } from "../repository/TrustedTaskContext";
import { verifyFileVersionsFromDisk } from "../validation/FileVersionGuard";
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

function mockGatewayResponse(codeGenContent: unknown) {
  jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
    if (options.stage === PipelineStages.ROADMAP_PLANNING) {
      return mockGateway(
        {
          roadmap: [
            { phase: 1, title: "Execute change", targetFiles: ["src/A.ts"], description: "Work" },
          ],
        },
        PipelineStages.ROADMAP_PLANNING,
      ) as any;
    }
    return mockGateway(codeGenContent, PipelineStages.CODE_GENERATION) as any;
  });
}

describe("Two-Tier Authoritative Source Hydration", () => {
  let workspace: string;
  let originalApiKey: string | undefined;

  beforeEach(() => {
    originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "test-mock-api-key";
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "anka-late-hydration-"));
    fs.mkdirSync(path.join(workspace, "src"), { recursive: true });
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
    jest.restoreAllMocks();
    if (fs.existsSync(workspace)) {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  const basePolicy: PolicyContract = {
    goal: "Test goal",
    taskType: "NEW_FEATURE",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    destructive: false,
    allowedActions: ["modify_file", "create_file"],
    forbiddenActions: ["delete_file"],
    maxFiles: 5,
    diffCriticEnabled: false,
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [],
    userConstraints: [],
    requiresClarification: false,
  };

  const baseIntent: TaskIntentSpec = {
    goal: "Test goal",
    operations: [{ kind: "MODIFY", subject: "target" }],
    constraints: [],
    acceptanceCriteria: [],
    destructive: false,
    requiresClarification: false,
    taskType: "NEW_FEATURE",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    explicitUserPaths: [],
  };

  // ─── CASE 1: CONTRACT TARGET ABSENT FROM MANIFEST ─────────────────────────
  test("CASE 1: Contract target absent from manifest hydrates into source map with zero write authority", () => {
    fs.writeFileSync(path.join(workspace, "src", "A.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(workspace, "src", "B.ts"), "export const b = 2;");

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        { path: "src/A.ts", action: "modify", dependencies: [], description: "Modify A" },
      ],
    };

    const contract: ExecutionContract = {
      goal: "Update components",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: [],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/A.ts", "src/B.ts"],
      allowedActions: ["modify_file"],
      forbiddenActions: [],
      maxFiles: 5,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: false,
      actionObligations: [
        { path: "src/A.ts", requiredAction: "modify", role: "PRIMARY_TARGET", evidenceIds: [] },
        { path: "src/B.ts", requiredAction: "modify", role: "DEPENDENCY_CLEANUP", evidenceIds: [] },
      ],
    };

    const hydration = AuthoritativeSourceHydrator.hydrateModifySources(
      manifest,
      workspace,
      ["src/A.ts", "src/B.ts"],
      {},
      contract,
    );

    expect(hydration.success).toBe(true);
    expect(hydration.modifyTargetsCount).toBe(2);
    expect(hydration.hydratedCount).toBe(2);
    expect(hydration.missingCount).toBe(0);

    // B.ts source is loaded from active worktree
    expect(hydration.authoritativeModifySources["src/B.ts"]).toBeDefined();
    expect(hydration.authoritativeModifySources["src/B.ts"].content).toBe("export const b = 2;");
    expect(hydration.mergedSourceMap["src/B.ts"]).toBe("export const b = 2;");

    // Planning manifest remains completely unchanged (B.ts absent from manifest)
    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].path).toBe("src/A.ts");
    expect(manifest.files.some((f) => f.path === "src/B.ts")).toBe(false);
  });

  // ─── CASE 2: LATE EXISTING MODIFY ─────────────────────────────────────────
  test("CASE 2: Late existing modify without pre-hydration hydrates before patch validation and resolves to AgentFileChange", async () => {
    fs.writeFileSync(path.join(workspace, "src", "B.ts"), "export const value = 100;");

    mockGatewayResponse({
      explanation: "Modify B.ts with patch",
      commitMessage: "fix: update B",
      changes: [
        {
          path: "src/B.ts",
          action: "modify",
          description: "Update value",
          edits: [
            {
              oldText: "export const value = 100;",
              newText: "export const value = 200;",
            },
          ],
        },
      ],
    });

    // mergedSourceMap deliberately does NOT contain src/B.ts
    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Update value in B",
      { intent: "BUG_FIX" },
      { fileContext: {}, skeletonContext: {} },
      "system prompt",
      undefined,
      null,
      {},
      {},
      undefined,
      workspace,
    );

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].path).toBe("src/B.ts");
    expect(result.changes[0].action).toBe("modify");
    expect(result.changes[0].content).toBe("export const value = 200;");
  });

  // ─── CASE 3: UNAUTHORIZED EXISTING LATE MODIFY (READ != WRITE) ────────────
  test("CASE 3: Existing file hydrates and resolves but is rejected by PreExecutionAuthorityClosure without evidence (READ != WRITE)", async () => {
    fs.writeFileSync(path.join(workspace, "src", "unrelated.ts"), "export const secret = 'original';");

    mockGatewayResponse({
      explanation: "Unrelated modify",
      commitMessage: "feat: touch unrelated",
      changes: [
        {
          path: "src/unrelated.ts",
          action: "modify",
          description: "Modify secret",
          edits: [
            {
              oldText: "export const secret = 'original';",
              newText: "export const secret = 'modified';",
            },
          ],
        },
      ],
    });

    // Generation succeeds in resolving patch because file exists in workspace
    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Fix unrelated issue",
      { intent: "BUG_FIX" },
      { fileContext: {}, skeletonContext: {} },
      "system prompt",
      undefined,
      null,
      {},
      {},
      undefined,
      workspace,
    );

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].path).toBe("src/unrelated.ts");

    // But PreExecutionAuthorityClosure MUST reject it because evidence is absent
    const intent: TaskIntentSpec = { ...baseIntent };
    bindUserRequest(intent, "Repair src/other.ts");
    const evidenceStore = new RepositoryEvidenceStore("test-repo", workspace);

    const closure = PreExecutionAuthorityClosure.close({
      changes: result.changes,
      policy: basePolicy,
      intentSpec: intent,
      evidenceStore,
      existingFiles: ["src/unrelated.ts"],
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "stage-1",
    });

    expect(closure.valid).toBe(false);
    expect(closure.result.approvedPaths).not.toContain("src/unrelated.ts");
    expect(closure.result.rejectedPaths.some((r) => r.path === "src/unrelated.ts")).toBe(true);
  });

  // ─── CASE 4: AUTHORIZED LATE MODIFY ───────────────────────────────────────
  test("CASE 4: Authorized late modify hydrates, resolves, and is approved by PreExecutionAuthorityClosure with authentic evidence", async () => {
    fs.writeFileSync(
      path.join(workspace, "src", "consumer.ts"),
      "import { calculateTotal } from './service'; calculateTotal();",
    );
    fs.writeFileSync(
      path.join(workspace, "src", "service.ts"),
      "export function calculateTotal() { return 1; }",
    );

    mockGatewayResponse({
      explanation: "Update service function",
      commitMessage: "feat: update service",
      changes: [
        {
          path: "src/service.ts",
          action: "modify",
          description: "Update calculateTotal",
          edits: [
            {
              oldText: "export function calculateTotal() { return 1; }",
              newText: "export function calculateTotal() { return 2; }",
            },
          ],
        },
      ],
    });

    // src/service.ts is NOT pre-hydrated
    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Update calculateTotal in src/consumer.ts",
      { intent: "BUG_FIX" },
      { fileContext: {}, skeletonContext: {} },
      "system prompt",
      undefined,
      null,
      {},
      {},
      undefined,
      workspace,
    );

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].path).toBe("src/service.ts");
    expect(result.changes[0].content).toContain("return 2;");

    // Authentic evidence binding
    const intent: TaskIntentSpec = { ...baseIntent };
    bindUserRequest(intent, "Repair src/consumer.ts");
    const evidenceStore = new RepositoryEvidenceStore("test-repo", workspace);
    evidenceStore.observeRepository({
      kind: "REFERENCE",
      filePath: "src/service.ts",
      sourceFile: "src/consumer.ts",
      symbol: "calculateTotal",
      provenance: "REFERENCE_SEARCH",
    });

    const closure = PreExecutionAuthorityClosure.close({
      changes: result.changes,
      policy: basePolicy,
      intentSpec: intent,
      evidenceStore,
      existingFiles: ["src/consumer.ts", "src/service.ts"],
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "stage-1",
    });

    expect(closure.valid).toBe(true);
    expect(closure.result.approvedPaths).toEqual(["src/service.ts"]);
  });

  // ─── CASE 5: MISSING MODIFY TARGET ────────────────────────────────────────
  test("CASE 5: Missing modify target fails closed with PATCH_SOURCE_FILE_NOT_FOUND and does not convert to CREATE", async () => {
    // src/missing.ts does not exist
    mockGatewayResponse({
      explanation: "Modify missing file",
      commitMessage: "fix: missing",
      changes: [
        {
          path: "src/missing.ts",
          action: "modify",
          description: "Edit missing file",
          edits: [
            {
              oldText: "nonexistent",
              newText: "replacement",
            },
          ],
        },
      ],
    });

    await expect(
      CodeGenerator.generateRoadmapAndDiffs(
        "Modify missing file",
        { intent: "BUG_FIX" },
        { fileContext: {}, skeletonContext: {} },
        "system prompt",
        undefined,
        null,
        {},
        {},
        undefined,
        workspace,
      ),
    ).rejects.toThrow("PATCH_SOURCE_FILE_NOT_FOUND");
  });

  // ─── CASE 6: PATH TRAVERSAL ───────────────────────────────────────────────
  test("CASE 6: Path traversal (../../outside.ts) is rejected before read and outside bytes never enter source map", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-outside-"));
    const outsideFile = path.join(outsideDir, "outside.ts");
    fs.writeFileSync(outsideFile, "export const secret = 'outside_leak';");

    try {
      mockGatewayResponse({
        explanation: "Traversal attempt",
        commitMessage: "fix: traversal",
        changes: [
          {
            path: "../../outside.ts",
            action: "modify",
            description: "Escape workspace",
            edits: [
              {
                oldText: "export const secret = 'outside_leak';",
                newText: "export const secret = 'tampered';",
              },
            ],
          },
        ],
      });

      await expect(
        CodeGenerator.generateRoadmapAndDiffs(
          "Escape workspace",
          { intent: "BUG_FIX" },
          { fileContext: {}, skeletonContext: {} },
          "system prompt",
          undefined,
          null,
          {},
          {},
          undefined,
          workspace,
        ),
      ).rejects.toThrow("PATCH_SOURCE_FILE_NOT_FOUND");

      // Verify AuthoritativeSourceHydrator explicitly rejects path traversal
      const hydResult = AuthoritativeSourceHydrator.readWorktreeSource("../../outside.ts", workspace);
      expect(hydResult).toBeNull();
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  // ─── CASE 7: CREATE PROPOSAL ──────────────────────────────────────────────
  test("CASE 7: CREATE proposal requires no source hydration and functions normally", async () => {
    mockGatewayResponse({
      explanation: "Create new file",
      commitMessage: "feat: new file",
      changes: [
        {
          path: "src/new-component.tsx",
          action: "create",
          content: "export default function NewComp() { return <div>New</div>; }",
          description: "Create new component",
        },
      ],
    });

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Create new component",
      { intent: "NEW_FEATURE" },
      { fileContext: {}, skeletonContext: {} },
      "system prompt",
      undefined,
      null,
      {},
      {},
      undefined,
      workspace,
    );

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].path).toBe("src/new-component.tsx");
    expect(result.changes[0].action).toBe("create");
    expect(result.changes[0].content).toContain("export default function NewComp()");
  });

  // ─── CASE 8: DELETE PROPOSAL ──────────────────────────────────────────────
  test("CASE 8: DELETE proposal creates no accidental hydration-based authorization", async () => {
    fs.writeFileSync(path.join(workspace, "src", "old.ts"), "export const old = true;");

    // Tier 1 with contract having requiredAction: "delete"
    const contract: ExecutionContract = {
      goal: "Delete old file",
      taskType: "DELETE_FILE",
      risk: "HIGH",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "GENERIC",
      repositoryRequired: true,
      expectedFiles: [],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/old.ts"],
      allowedActions: ["delete_file"],
      forbiddenActions: [],
      maxFiles: 1,
      searchScope: ["src"],
      contextScope: ["src"],
      diffCriticEnabled: false,
      actionObligations: [
        { path: "src/old.ts", requiredAction: "delete", role: "PRIMARY_TARGET", evidenceIds: [] },
      ],
    };

    // Hydration must NOT treat delete target as modify
    const hydration = AuthoritativeSourceHydrator.hydrateModifySources(
      null,
      workspace,
      ["src/old.ts"],
      {},
      contract,
    );

    expect(hydration.modifyTargetsCount).toBe(0);
    expect(hydration.hydratedCount).toBe(0);
    expect(hydration.authoritativeModifySources["src/old.ts"]).toBeUndefined();
  });

  // ─── CASE 9: STALE SOURCE SAFETY ──────────────────────────────────────────
  test("CASE 9: Late-hydrated file mutated on disk fails FileVersionGuard stale-source check", async () => {
    const initialContent = "export const config = { port: 3000 };";
    fs.writeFileSync(path.join(workspace, "src", "config.ts"), initialContent);

    mockGatewayResponse({
      explanation: "Update port",
      commitMessage: "feat: update port",
      changes: [
        {
          path: "src/config.ts",
          action: "modify",
          description: "Change port",
          edits: [
            {
              oldText: "export const config = { port: 3000 };",
              newText: "export const config = { port: 8080 };",
            },
          ],
        },
      ],
    });

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Change port",
      { intent: "CONFIG_CHANGE" },
      { fileContext: {}, skeletonContext: {} },
      "system prompt",
      undefined,
      null,
      {},
      {},
      undefined,
      workspace,
    );

    expect(result.expectedSourceHashes).toBeDefined();
    const initialSha = crypto.createHash("sha256").update(initialContent, "utf8").digest("hex");
    expect(result.expectedSourceHashes!["src/config.ts"]).toBe(initialSha);

    // External process mutates file on disk concurrently
    fs.writeFileSync(path.join(workspace, "src", "config.ts"), "export const config = { port: 9999 };");

    // FileVersionGuard must detect stale source
    const guardCheck = await verifyFileVersionsFromDisk(result.expectedSourceHashes!, workspace);
    expect(guardCheck.valid).toBe(false);
    if (!guardCheck.valid) {
      expect(guardCheck.error.code).toBe("STALE_SOURCE_FILE");
      expect(guardCheck.error.path).toBe("src/config.ts");
    }
  });

  // ─── CASE 10: MULTIPLE LATE MODIFY TARGETS ────────────────────────────────
  test("CASE 10: Multiple late modify targets hydrate safely without duplicates and remain independently authority-gated", async () => {
    fs.writeFileSync(path.join(workspace, "src", "B.ts"), "export const b = 1;");
    fs.writeFileSync(path.join(workspace, "src", "C.ts"), "export const c = 2;");

    mockGatewayResponse({
      explanation: "Modify B and C",
      commitMessage: "feat: update B and C",
      changes: [
        {
          path: "src/B.ts",
          action: "modify",
          description: "Update B",
          edits: [{ oldText: "export const b = 1;", newText: "export const b = 10;" }],
        },
        {
          path: "src/C.ts",
          action: "modify",
          description: "Update C",
          edits: [{ oldText: "export const c = 2;", newText: "export const c = 20;" }],
        },
      ],
    });

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Update B and C",
      { intent: "NEW_FEATURE" },
      { fileContext: {}, skeletonContext: {} },
      "system prompt",
      undefined,
      null,
      {},
      {},
      undefined,
      workspace,
    );

    expect(result.changes).toHaveLength(2);
    expect(result.expectedSourceHashes!["src/B.ts"]).toBeDefined();
    expect(result.expectedSourceHashes!["src/C.ts"]).toBeDefined();

    // Authority closure: evidence exists for B.ts, but NOT for C.ts
    const intent: TaskIntentSpec = { ...baseIntent };
    bindUserRequest(intent, "Repair src/B.ts");
    const evidenceStore = new RepositoryEvidenceStore("test-repo", workspace);
    evidenceStore.observeRepository({
      kind: "SYMBOL",
      filePath: "src/B.ts",
      symbol: "b",
      provenance: "AST_GRAPH",
    });

    const closure = PreExecutionAuthorityClosure.close({
      changes: result.changes,
      policy: basePolicy,
      intentSpec: intent,
      evidenceStore,
      existingFiles: ["src/B.ts", "src/C.ts"],
      repositoryId: "test-repo",
      workspaceRoot: workspace,
      stageId: "stage-1",
    });

    // Entire group fails closed because C.ts has no evidence
    expect(closure.valid).toBe(false);
    expect(closure.result.approvedPaths).toEqual(["src/B.ts"]);
    expect(closure.result.rejectedPaths.some((r) => r.path === "src/C.ts")).toBe(true);
  });
});
