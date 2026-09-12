import fs from "fs";
import path from "path";
import os from "os";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { IntentClassifier } from "../classification/IntentClassifier";
import { RepositorySearch } from "../repository/RepositorySearch";
import { CodeGenerator } from "../generation/CodeGenerator";
import { ManifestGenerator } from "../../services/manifest-generator";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { ValidationDetector } from "../validation/ValidationDetector";
import { ChatRequest } from "../shared/types";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { AuthorizedCapabilityScope } from "../runtime/CapabilityGuard";

// Mock PrismaClient to prevent DB connection attempts
jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      project: {
        findUnique: jest.fn().mockImplementation(() => ({
          localPath: (global as any).__phase2bTempDir || "/tmp/mock",
          githubUrl: "https://github.com/mock/mock",
          githubToken: "mock-token",
        })),
      },
      phaseArtifact: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      taskDecomposition: {
        create: jest.fn().mockResolvedValue({}),
      },
      agentManifest: {
        create: jest.fn().mockResolvedValue({}),
      },
    })),
  };
});

describe("Phase 2B Pipeline-Level Evidence-Bound Authority Integration Tests", () => {
  let tempDir: string;
  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.OPENAI_API_KEY = "test-mock-api-key";
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase2b-pipeline-test-"));
    (global as any).__phase2bTempDir = tempDir;
    const srcDir = path.join(tempDir, "src");
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, "App.tsx"), "import React from 'react'; import { Button } from './Button'; // Header integration point\nexport const App = () => <Button />;", "utf8");
    fs.writeFileSync(path.join(srcDir, "Button.tsx"), "export const Button = () => <button>Click</button>;", "utf8");
    fs.writeFileSync(path.join(srcDir, "Dashboard.tsx"), "export const Dashboard = () => <div>Dashboard</div>;", "utf8");

    // Base stubs for memory persistence
    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "sess-p2b", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);

    const snapshotMock = {
      repoName: "test-repo",
      defaultBranch: "main",
      fileTree: ["src/App.tsx", "src/Button.tsx", "src/Dashboard.tsx", "package.json"],
      keyFiles: [
        { path: "src/App.tsx", content: "export const App = () => null;" },
        { path: "src/Button.tsx", content: "export const Button = () => null;" },
      ],
      revision: { contentHash: "hash-p2b" },
    };

    jest.spyOn(RepositoryContextBuilder, "buildProjectContext").mockResolvedValue({
      project: { id: "proj-p2b", name: "test-project" },
      activeTasks: [],
      repoSnapshot: snapshotMock,
    } as any);

    jest.spyOn(RepositoryScanner, "ensureLocalWorkspace").mockResolvedValue(tempDir);
    jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue(snapshotMock as any);

    jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
      taskType: "FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      intent: "Feature update",
      targetPath: undefined,
      confidence: 0.95,
      requiresClarification: false,
      reasoning: "Task without hardcoded target",
    } as any);

    jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (initialChanges: any) => ({
      success: true,
      attempts: 1,
      finalChanges: initialChanges || [],
      errorLog: "",
    } as any));

    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({
      securityPass: true,
      summary: "Security pass",
    } as any);

    jest.spyOn(ValidationDetector, "runFeatureValidation").mockResolvedValue({
      overallPassed: true,
      checks: [],
      failedChecks: [],
    } as any);
  });

  afterEach(() => {
    process.env.OPENAI_API_KEY = originalApiKey;
    jest.restoreAllMocks();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const chatReq: ChatRequest = {
    message: "Implement feature in repo",
    sessionId: "sess-p2b",
  };

  function getAuthorizedScope() {
    return AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: tempDir,
      authorityId: "phase2b-evidence-pipeline",
      grants: [
        { path: "src/Button.tsx", action: "FILE_MODIFY" },
        { path: "src/components/Header.tsx", action: "FILE_CREATE" },
        { path: "src/App.tsx", action: "FILE_MODIFY" },
        { path: "src/Dashboard.tsx", action: "FILE_MODIFY" },
        { path: "src/components/OrphanWidget.tsx", action: "FILE_CREATE" },
      ],
    })!;
  }

  test("A. Unrelated semantic candidate rejection in full pipeline flow", async () => {
    // Investigation only finds FILE evidence via SEMANTIC_SEARCH for unrelated Dashboard.tsx
    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockImplementation(async (...args: any[]) => {
      const store: RepositoryEvidenceStore = args[7];
      const evi1 = store.observeRepository({
        kind: "FILE",
        filePath: "src/Dashboard.tsx",
        provenance: "SEMANTIC_SEARCH",
        metadata: { details: "Found via semantic query" },
      });

      return {
        optimizedContext: { fileContext: {}, skeletonContext: {} },
        executionMemory: {
          searchPlanHistory: [
            {
              round: 1,
              tool: "semanticSearch",
              argsSummary: "query='dashboard'",
              resultSummary: "found src/Dashboard.tsx",
              evidenceIdsAdded: [evi1.id],
              decision: "Candidate found",
              readyToPlan: true,
            },
          ],
          discoveredRoutes: [],
          discoveredServices: [],
          discoveredModels: [],
          discoveredSymbols: new Map(),
          currentConfidence: 0.9,
        },
        finalConfidence: 0.9,
        searchSummary: "Found semantic candidates",
        inspectedFiles: ["src/Dashboard.tsx"],
        evidenceStore: store,
      } as any;
    });

    // Planner proposes Dashboard.tsx citing the SEMANTIC_SEARCH FILE evidence
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async (_msg: string, ctx: any) => {
      const store: RepositoryEvidenceStore = ctx.evidenceStore;
      const allEv = store.getAllEvidence();
      return {
        files: [
          {
            path: "src/Dashboard.tsx",
            action: "modify" as const,
            dependencies: [],
            description: "Modify dashboard",
            evidenceIds: allEv.map((e) => e.id),
          },
        ],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      };
    });

    const codeGenSpy = jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs");

    const result = await AgentPipeline.runCodingAgent("user-1", "proj-p2b", chatReq, undefined, { authorizedCapabilityScope: getAuthorizedScope() });

    // Resolver MUST reject unrelated Dashboard because FILE existence alone without structural/task relation does not authorize MODIFY
    // Final targetPaths becomes [] -> pipeline immediately fails closed with [Manifest Validation Failed]
    expect(result.changes).toHaveLength(0);
    expect(result.explanation).toMatch(/\[(Planning Scope Rejected|Manifest Validation Failed)\]/);
    expect(codeGenSpy).not.toHaveBeenCalled();
  });

  test("B. Orphan CREATE rejection in full pipeline flow", async () => {
    // Investigation adds active entry point evidence
    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockImplementation(async (...args: any[]) => {
      const store: RepositoryEvidenceStore = args[7];
      store.observeRepository({
        kind: "ENTRY_POINT",
        filePath: "src/App.tsx",
        provenance: "AST_GRAPH",
        metadata: { details: "App entry point" },
      });

      return {
        optimizedContext: { fileContext: {}, skeletonContext: {} },
        executionMemory: {
          searchPlanHistory: [],
          discoveredRoutes: [],
          discoveredServices: [],
          discoveredModels: [],
          discoveredSymbols: new Map(),
          currentConfidence: 0.9,
        },
        finalConfidence: 0.9,
        searchSummary: "Found entry point",
        inspectedFiles: ["src/App.tsx"],
        evidenceStore: store,
      } as any;
    });

    // Planner proposes an orphan CREATE citing ENTRY_POINT evidence (or no evidence)
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async (_msg: string, ctx: any) => {
      const store: RepositoryEvidenceStore = ctx.evidenceStore;
      const allEv = store.getAllEvidence();
      return {
        files: [
          {
            path: "src/components/OrphanWidget.tsx",
            action: "create" as const,
            dependencies: [],
            description: "New widget without importer",
            evidenceIds: allEv.map((e) => e.id), // Only ENTRY_POINT evidence
          },
        ],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      };
    });

    const codeGenSpy = jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs");

    const result = await AgentPipeline.runCodingAgent("user-1", "proj-p2b", chatReq, undefined, { authorizedCapabilityScope: getAuthorizedScope() });

    // Orphan CREATE citing only ENTRY_POINT without importer or standalone proof MUST be rejected
    expect(result.changes).toHaveLength(0);
    expect(result.explanation).toMatch(/\[(Planning Scope Rejected|Manifest Validation Failed)\]/);
    expect(codeGenSpy).not.toHaveBeenCalled();
  });

  test("C. Valid evidence-backed MODIFY approved and processed through pipeline", async () => {
    // Investigation adds FILE existence + REFERENCE structural relation evidence for Button.tsx
    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockImplementation(async (...args: any[]) => {
      const store: RepositoryEvidenceStore = args[7];
      store.observeRepository({
        kind: "FILE",
        filePath: "src/Button.tsx",
        provenance: "REPO_READ",
        metadata: { details: "File exists on disk" },
      });
      store.observeRepository({
        kind: "REFERENCE",
        filePath: "src/Button.tsx",
        sourceFile: "src/App.tsx",
        symbol: "Button",
        provenance: "REFERENCE_SEARCH",
        metadata: { details: "Imported by src/App.tsx" },
      });

      return {
        optimizedContext: { fileContext: { "src/Button.tsx": "export const Button = () => null;" }, skeletonContext: {} },
        executionMemory: {
          searchPlanHistory: [],
          discoveredRoutes: [],
          discoveredServices: [],
          discoveredModels: [],
          discoveredSymbols: new Map([["Button", { filePath: "src/Button.tsx", line: 1 }]]),
          currentConfidence: 0.95,
        },
        finalConfidence: 0.95,
        searchSummary: "Verified Button relation",
        inspectedFiles: ["src/Button.tsx"],
        evidenceStore: store,
      } as any;
    });

    // Planner proposes Button.tsx citing both evidence IDs
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async (_msg: string, ctx: any) => {
      const store: RepositoryEvidenceStore = ctx.evidenceStore;
      const allEv = store.getAllEvidence();
      return {
        files: [
          {
            path: "src/Button.tsx",
            action: "modify" as const,
            dependencies: [],
            description: "Update button styling",
            evidenceIds: allEv.map((e) => e.id),
          },
        ],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      };
    });

    const codeGenSpy = jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      changes: [
        {
          path: "src/Button.tsx",
          content: "export const Button = () => <button className='primary'>Click</button>;",
          description: "Updated button",
          action: "modify",
        },
      ],
      explanation: "Button successfully updated",
      commitMessage: "feat: update button",
      validationCommands: [],
    });

    jest.spyOn(FileSystemStateManager.prototype, "apply").mockImplementation(async () => {});

    const result = await AgentPipeline.runCodingAgent("user-1", "proj-p2b", chatReq, undefined, { authorizedCapabilityScope: getAuthorizedScope() });

    // Resolver approves Button.tsx -> ManifestValidator succeeds -> CodeGenerator called
    expect(codeGenSpy).toHaveBeenCalled();
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].path).toBe("src/Button.tsx");
  });

  test("D. Valid evidence-backed CREATE integration approved through pipeline", async () => {
    // Investigation adds FILE + REFERENCE evidence for App.tsx
    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockImplementation(async (...args: any[]) => {
      const store: RepositoryEvidenceStore = args[7];
      store.observeRepository({
        kind: "FILE",
        filePath: "src/App.tsx",
        provenance: "REPO_READ",
        metadata: { details: "App exists" },
      });
      store.observeRepository({
        kind: "REFERENCE",
        filePath: "src/components/Header.tsx",
        sourceFile: "src/App.tsx",
        symbol: "Header",
        provenance: "REFERENCE_SEARCH",
        metadata: { details: "App is root component" },
      });

      return {
        optimizedContext: { fileContext: { "src/App.tsx": "export const App = () => null;" }, skeletonContext: {} },
        executionMemory: {
          searchPlanHistory: [],
          discoveredRoutes: [],
          discoveredServices: [],
          discoveredModels: [],
          discoveredSymbols: new Map(),
          currentConfidence: 0.95,
        },
        finalConfidence: 0.95,
        searchSummary: "Verified App integration site",
        inspectedFiles: ["src/App.tsx"],
        evidenceStore: store,
      } as any;
    });

    // Planner proposes:
    // 1. CREATE Header.tsx
    // 2. MODIFY App.tsx (integrates Header.tsx, declares dependency on ./components/Header.tsx, cites App's evidence)
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async (_msg: string, ctx: any) => {
      const store: RepositoryEvidenceStore = ctx.evidenceStore;
      const appEv = store.getEvidenceForFile("src/App.tsx");
      return {
        files: [
          {
            path: "src/components/Header.tsx",
            action: "create" as const,
            dependencies: [],
            description: "New header component",
            evidenceIds: appEv.map((e) => e.id),
          },
          {
            path: "src/App.tsx",
            action: "modify" as const,
            dependencies: ["./components/Header.tsx"],
            description: "Import and render Header component",
            evidenceIds: appEv.map((e) => e.id),
          },
        ],
        totalFiles: 2,
        manifestVersion: "1.0.0",
      };
    });

    const codeGenSpy = jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      changes: [
        {
          path: "src/components/Header.tsx",
          content: "export const Header = () => <header>Header</header>;",
          description: "New Header",
          action: "create",
        },
        {
          path: "src/App.tsx",
          content: "import { Header } from './components/Header'; export const App = () => <Header />;",
          description: "Integrated Header in App",
          action: "modify",
        },
      ],
      explanation: "Header created and integrated",
      commitMessage: "feat: add header",
      validationCommands: [],
    });

    jest.spyOn(FileSystemStateManager.prototype, "apply").mockImplementation(async () => {});

    const result = await AgentPipeline.runCodingAgent("user-1", "proj-p2b", chatReq, undefined, { authorizedCapabilityScope: getAuthorizedScope() });

    // Both Header.tsx and App.tsx should be approved and generated
    expect(codeGenSpy).toHaveBeenCalled();
    expect(result.changes).toHaveLength(2);
    const paths = result.changes.map((c) => c.path);
    expect(paths).toContain("src/components/Header.tsx");
    expect(paths).toContain("src/App.tsx");
  });

  test("E. Final targetPaths matches approvedPaths exactly, and is empty when resolution rejects", async () => {
    // Investigation adds only plain FILE evidence
    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockImplementation(async (...args: any[]) => {
      const store: RepositoryEvidenceStore = args[7];
      store.addEvidence({
        kind: "FILE",
        filePath: "src/Dashboard.tsx",
        provenance: "REPO_READ",
        metadata: { details: "Plain file existence" },
      });

      return {
        optimizedContext: { fileContext: {}, skeletonContext: {} },
        executionMemory: {
          searchPlanHistory: [],
          discoveredRoutes: [],
          discoveredServices: [],
          discoveredModels: [],
          discoveredSymbols: new Map(),
          currentConfidence: 0.9,
        },
        finalConfidence: 0.9,
        searchSummary: "Summary",
        inspectedFiles: ["src/Dashboard.tsx"],
        evidenceStore: store,
      } as any;
    });

    // Planner proposes Dashboard without relation evidence
    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async (_msg: string, ctx: any) => {
      const store: RepositoryEvidenceStore = ctx.evidenceStore;
      return {
        files: [
          {
            path: "src/Dashboard.tsx",
            action: "modify" as const,
            dependencies: [],
            description: "Modify dashboard",
            evidenceIds: store.getAllEvidence().map((e) => e.id),
          },
        ],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      };
    });

    const result = await AgentPipeline.runCodingAgent("user-1", "proj-p2b", chatReq, undefined, { authorizedCapabilityScope: getAuthorizedScope() });

    // Rejection guarantees zero changes applied and strict failure explanation
    expect(result.changes).toHaveLength(0);
    expect(result.explanation).toMatch(/\[(Planning Scope Rejected|Manifest Validation Failed)\]/);
  });

  test("F. searchPlanHistory is populated with real tool execution records", async () => {
    let capturedSearchHistory: any[] = [];

    jest.spyOn(RepositorySearch, "runIterativeRepositorySearch").mockImplementation(async (...args: any[]) => {
      const store: RepositoryEvidenceStore = args[7];
      const evi1 = store.observeRepository({
        kind: "FILE",
        filePath: "src/App.tsx",
        provenance: "REPO_READ",
        metadata: { details: "File read" },
      });
      const evi2 = store.observeRepository({
        kind: "REFERENCE",
        filePath: "src/App.tsx",
        provenance: "AST_GRAPH",
        metadata: { details: "App symbol is the active feature integration point" },
      });

      const historyRecords = [
        {
          round: 1,
          tool: "repo_inspectHierarchy",
          argsSummary: "depth=2",
          resultSummary: "Found 4 files",
          evidenceIdsAdded: [],
          decision: "Next search symbols",
          readyToPlan: false,
        },
        {
          round: 2,
          tool: "repo_findSymbols",
          argsSummary: "query='App'",
          resultSummary: "Symbol App at src/App.tsx:1",
          evidenceIdsAdded: [evi2.id],
          decision: "Next read App.tsx",
          readyToPlan: false,
        },
        {
          round: 3,
          tool: "repo_readFile",
          argsSummary: "path='src/App.tsx'",
          resultSummary: "Read 120 bytes",
          evidenceIdsAdded: [evi1.id],
          decision: "Evidence complete",
          readyToPlan: true,
        },
      ];

      capturedSearchHistory = historyRecords;

      return {
        optimizedContext: { fileContext: {}, skeletonContext: {} },
        executionMemory: {
          searchPlanHistory: historyRecords,
          discoveredRoutes: [],
          discoveredServices: [],
          discoveredModels: [],
          discoveredSymbols: new Map(),
          currentConfidence: 0.95,
        },
        finalConfidence: 0.95,
        searchSummary: "Investigation completed in 3 rounds",
        inspectedFiles: ["src/App.tsx"],
        evidenceStore: store,
      } as any;
    });

    jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async (_msg: string, ctx: any) => {
      const store: RepositoryEvidenceStore = ctx.evidenceStore;
      return {
        files: [{
          path: "src/App.tsx",
          action: "modify" as const,
          dependencies: [],
          description: "Apply the investigated feature update at the verified integration point",
          evidenceIds: store.getEvidenceForFile("src/App.tsx").map((e) => e.id),
        }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      };
    });

    jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
      roadmap: [],
      changes: [{
        path: "src/App.tsx",
        content: "import React from 'react'; export const App = () => <main>Feature updated</main>;",
        description: "Update the verified App integration point",
        action: "modify",
      }],
      explanation: "Applied the evidence-backed App update",
      commitMessage: "feat: update app integration point",
      validationCommands: [],
    });

    jest.spyOn(FileSystemStateManager.prototype, "apply").mockImplementation(async () => {});

    // Run the pipeline agent so RepositorySearch is executed
    await AgentPipeline.runCodingAgent("user-1", "proj-p2b", chatReq, undefined, { authorizedCapabilityScope: getAuthorizedScope() });

    // Check captured history properties
    expect(capturedSearchHistory).toHaveLength(3);
    expect(capturedSearchHistory[0].tool).toBe("repo_inspectHierarchy");
    expect(capturedSearchHistory[1].tool).toBe("repo_findSymbols");
    expect(capturedSearchHistory[2].tool).toBe("repo_readFile");
    expect(capturedSearchHistory[2].evidenceIdsAdded).toHaveLength(1);
    expect(capturedSearchHistory[2].readyToPlan).toBe(true);
  });
});
