import fs from "fs";
import os from "os";
import path from "path";
import { createTaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { RepositoryInvestigationAgent } from "../repository/RepositoryInvestigationAgent";
import { RepositoryToolEngine } from "../../services/repository-tool.engine";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { ManifestGenerator } from "../../services/manifest-generator";
import { LLMGateway } from "../gateway/LLMGateway";
import {
  productionAddEvidence,
  productionIsAuthorityEligible,
} from "./helpers/capability-test-harness";

describe("natural-language destructive target authority regression", () => {
  let workspace: string;
  const request = "Remove the deprecated activity widget and clean every reference to it.";
  const files = [
    "src/components/activity/LegacyActivityWidget.tsx",
    "src/components/activity/LegacyActivityWidget.css",
    "src/components/dashboard/DashboardOverview.tsx",
    "src/components/activity/ActivityFilter.tsx",
  ];
  const contents: Record<string, string> = {
    "src/components/activity/LegacyActivityWidget.tsx": "import './LegacyActivityWidget.css'; export const LegacyActivityWidget = () => null;",
    "src/components/activity/LegacyActivityWidget.css": ".legacy-activity-widget { display: block; }",
    "src/components/dashboard/DashboardOverview.tsx": "import { LegacyActivityWidget } from '../activity/LegacyActivityWidget'; export const DashboardOverview = () => LegacyActivityWidget();",
    "src/components/activity/ActivityFilter.tsx": "export const ActivityFilter = () => null;",
  };
  const classification: TaskClassificationResult = {
    taskType: "DELETE_FILE",
    intent: "DELETE_FILE",
    risk: "HIGH",
    estimatedComplexity: "MEDIUM",
    confidence: 1,
    requiresClarification: false,
    reasoning: "Remove one uniquely identified feature and its references",
  };
  const policy: PolicyContract = {
    goal: request,
    taskType: "DELETE_FILE",
    risk: "HIGH",
    estimatedComplexity: "MEDIUM",
    destructive: true,
    allowedActions: ["modify_file", "delete_file"],
    forbiddenActions: [],
    maxFiles: 5,
    diffCriticEnabled: true,
    pipeline: "REPOSITORY",
    environment: "GENERIC",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [],
    userConstraints: [],
    requiresClarification: false,
  };
  const strictEvidenceStore = (): RepositoryEvidenceStore => {
    const store = new RepositoryEvidenceStore("repo", workspace);
    Object.defineProperty(store, "addEvidence", { value: productionAddEvidence.bind(store) });
    Object.defineProperty(store, "isAuthorityEligible", { value: productionIsAuthorityEligible.bind(store) });
    return store;
  };

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "anka-natural-delete-"));
    for (const file of files) {
      const absolute = path.join(workspace, file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, contents[file]);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test("authorizes the uniquely resolved target cluster and its exact importer cleanup", () => {
    const intent = createTaskIntentSpec(request, classification);
    const evidenceStore = strictEvidenceStore();
    const result = PreExecutionAuthorityClosure.close({
      changes: [
        { path: files[0], action: "delete", content: "", description: "Delete the deprecated widget" },
        { path: files[1], action: "delete", content: "", description: "Delete its stylesheet" },
        { path: files[2], action: "modify", content: "export const DashboardOverview = () => null;", description: "Remove the widget reference" },
      ],
      policy,
      intentSpec: intent,
      evidenceStore,
      existingFiles: files,
      repositoryId: "repo",
      workspaceRoot: workspace,
      stageId: "stage",
    });

    expect(result.valid).toBe(true);
    expect(result.result.approvedPaths).toEqual(expect.arrayContaining(files.slice(0, 3)));
  });

  test("does not widen incoming-edge authority to an unrelated component", () => {
    const intent = createTaskIntentSpec(request, classification);
    const evidenceStore = strictEvidenceStore();
    const result = PreExecutionAuthorityClosure.close({
      changes: [
        { path: files[3], action: "modify", content: "export const ActivityFilter = () => 'changed';", description: "Unrelated change" },
      ],
      policy,
      intentSpec: intent,
      evidenceStore,
      existingFiles: files,
      repositoryId: "repo",
      workspaceRoot: workspace,
      stageId: "stage",
    });

    expect(result.valid).toBe(false);
    expect(result.result.rejectedPaths[0].reason).toContain("NO_TASK_OR_STRUCTURAL_RELATION");
  });

  test("investigation resolves the target before evaluating destructive readiness", async () => {
    const intent = createTaskIntentSpec(request, classification);
    const evidenceStore = strictEvidenceStore();
    const toolEngine = new RepositoryToolEngine(
      files.map((file) => ({ path: file, content: contents[file] })) as never,
      workspace,
    );
    const agent = new RepositoryInvestigationAgent({
      toolEngine,
      evidenceStore,
      intentSpec: intent,
      localPath: workspace,
      maxRounds: 1,
    });

    await agent.investigate();

    expect(intent.resolvedTarget?.candidatePaths).toEqual(expect.arrayContaining(files.slice(0, 2)));
    expect(intent.resolvedTarget?.importerPaths).toContain(files[2]);
  });

  test("manifest proposal ignores advisory evidence IDs even when they exist", async () => {
    const evidenceStore = strictEvidenceStore();
    const advisory = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: files[2],
      provenance: "SEMANTIC_SEARCH",
    });
    const observed = evidenceStore.observeRepository({
      kind: "FILE",
      filePath: files[2],
      provenance: "REPO_READ",
    });
    expect(evidenceStore.isAuthorityEligible(advisory)).toBe(false);
    expect(evidenceStore.isAuthorityEligible(observed)).toBe(true);
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options) => {
      const advisoryManifest = {
        files: [{ path: files[2], action: "modify", description: "Cleanup", dependencies: [], evidenceIds: [advisory.id] }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      };
      expect(options.schema?.validate?.(advisoryManifest).valid).toBe(true);
      return {
        content: advisoryManifest,
        rawResponse: {},
        finishReason: "stop",
        latencyMs: 1,
        model: "test",
        stage: "MANIFEST_GENERATION",
      } as never;
    });

    const generator = new ManifestGenerator({} as never);
    const manifest = await generator.generateManifest(
      request,
      { existingFiles: files, evidenceStore },
      {
        goal: request,
        taskType: "DELETE_FILE",
        risk: "HIGH",
        estimatedComplexity: "MEDIUM",
        destructive: true,
        allowedActions: ["modify_file", "delete_file"],
        forbiddenActions: [],
        maxFiles: 5,
        diffCriticEnabled: true,
        targetPaths: files.slice(0, 3),
        searchScope: files,
      } as never,
    );

    expect(manifest.files[0].evidenceIds).toEqual([]);
  });
});
