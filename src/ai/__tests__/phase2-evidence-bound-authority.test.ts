import path from "path";
import { EvidenceBoundWriteSetResolver, PlannedChange } from "../contracts/EvidenceBoundWriteSetResolver";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { PolicyContract, POLICY_RULES } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { ManifestValidator } from "../../services/manifest-validator";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { verifyExpectedFileVersions } from "../validation/FileVersionGuard";
import { RepositoryToolEngine } from "../../services/repository-tool.engine";
import { RepositoryInvestigationAgent } from "../repository/RepositoryInvestigationAgent";

describe("Phase 2 — Evidence-Bound Repository Investigation & Write Authority Tests", () => {
  const defaultPolicy: PolicyContract = {
    goal: "Add user profile settings",
    taskType: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    destructive: false,
    allowedActions: ["create_files", "modify_file", "add_imports", "write_types"],
    forbiddenActions: ["delete_file", "delete_folder"],
    maxFiles: 10,
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

  const defaultIntent: TaskIntentSpec = {
    goal: "Add user profile settings",
    operations: [{ kind: "MODIFY", subject: "user profile" }],
    constraints: [],
    acceptanceCriteria: ["Profile settings functional"],
    destructive: false,
    requiresClarification: false,
    taskType: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    explicitUserPaths: [],
  };

  // 1. Search agent chooses tools dynamically
  test("1. Search agent chooses tools dynamically without static round scripts", async () => {
    const fakeSnapshot = [
      { path: "src/App.tsx", content: "import React from 'react'; export function App() { return <div>App</div>; }" },
      { path: "src/components/Header.tsx", content: "export function Header() { return <header>Header</header>; }" },
    ];
    const toolEngine = new RepositoryToolEngine(fakeSnapshot);
    const evidenceStore = new RepositoryEvidenceStore("test-repo");

    const agent = new RepositoryInvestigationAgent({
      toolEngine,
      evidenceStore,
      intentSpec: defaultIntent,
    });

    const result = await agent.investigate();
    expect(result.roundsExecuted).toBeGreaterThanOrEqual(1);
    expect(result.readyToPlan).toBe(true);
    expect(evidenceStore.getAllEvidence().length).toBeGreaterThan(0);
  });

  // 2. No fixed first-keyword / second-keyword mapping
  test("2. Investigation loop is not bound to positional keyword extraction", async () => {
    const fakeSnapshot = [
      { path: "src/services/auth.ts", content: "export class AuthService {}" },
      { path: "src/controllers/auth.controller.ts", content: "import { AuthService } from '../services/auth';" },
    ];
    const toolEngine = new RepositoryToolEngine(fakeSnapshot);
    const evidenceStore = new RepositoryEvidenceStore("test-repo");

    const intent: TaskIntentSpec = {
      ...defaultIntent,
      goal: "Implement multi-factor authentication",
      operations: [{ kind: "MODIFY", subject: "multi-factor authentication" }],
    };

    const agent = new RepositoryInvestigationAgent({
      toolEngine,
      evidenceStore,
      intentSpec: intent,
    });

    const result = await agent.investigate();
    expect(result.readyToPlan).toBe(true);
  });

  // 3. Evidence IDs backend-generated
  test("3. Evidence IDs are strictly backend-generated with 'evi_' prefix", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const ev = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/components/Header.tsx",
      provenance: "REPO_READ",
    });

    expect(ev.id).toMatch(/^evi_\d+_[a-z0-9]+$/);
    expect(evidenceStore.hasEvidence(ev.id)).toBe(true);
  });

  // 4. Invented evidence ID rejected
  test("4. Invented / hallucinated evidence IDs are rejected by resolver", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const proposed: PlannedChange[] = [
      {
        path: "src/App.tsx",
        action: "modify",
        reason: "Update App",
        evidenceIds: ["evi_invented_9999"],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/App.tsx"],
    });

    expect(res.approvedPaths).not.toContain("src/App.tsx");
    expect(res.rejectedPaths.some((r) => r.path === "src/App.tsx" && r.reason.includes("Cited non-existent"))).toBe(true);
  });

  // 5. Semantic-only candidate rejected
  test("5. Semantic candidate without verifiable file existence is rejected", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const ev = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/GhostComponent.tsx",
      provenance: "SEMANTIC_SEARCH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/GhostComponent.tsx",
        action: "modify",
        reason: "Ghost update",
        evidenceIds: [ev.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/App.tsx"], // GhostComponent does not exist
    });

    expect(res.approvedPaths).toHaveLength(0);
    expect(res.rejectedPaths.some((r) => r.reason.includes("does not exist in repository"))).toBe(true);
  });

  // 6. Read-file evidence proves existence only; relation required
  test("6. FILE existence alone does not authorize MODIFY without task relation", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const ev = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/App.tsx",
      provenance: "REPO_READ",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/App.tsx",
        action: "modify",
        reason: "Update App",
        evidenceIds: [ev.id],
        dependencies: [],
      },
    ];

    // With FILE existence only and no relation, MODIFY is rejected
    const resWithoutRelation = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/App.tsx"],
    });
    expect(resWithoutRelation.approvedPaths).not.toContain("src/App.tsx");
    expect(resWithoutRelation.rejectedPaths.some((r) => r.path === "src/App.tsx" && r.reason.includes("relation"))).toBe(true);

    // With relation evidence added (e.g. explicit user path or symbol/reference), MODIFY is authorized
    const intentWithExplicitPath: TaskIntentSpec = {
      ...defaultIntent,
      explicitUserPaths: ["src/App.tsx"],
    };
    const resWithRelation = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: intentWithExplicitPath,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/App.tsx"],
    });
    expect(resWithRelation.approvedPaths).toContain("src/App.tsx");
  });

  // 7. Import / reference evidence accepted
  test("7. Reference evidence proves relationship to callers", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evFile = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/components/Button.tsx",
      provenance: "REPO_READ",
    });
    const evRef = evidenceStore.addEvidence({
      kind: "REFERENCE",
      filePath: "src/components/Button.tsx",
      sourceFile: "src/components/Header.tsx",
      provenance: "REFERENCE_SEARCH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/components/Button.tsx",
        action: "modify",
        reason: "Update button",
        evidenceIds: [evFile.id, evRef.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/components/Button.tsx", "src/components/Header.tsx"],
    });

    expect(res.approvedPaths).toContain("src/components/Button.tsx");
  });

  // 8. CREATE requires integration evidence
  test("8. CREATE is authorized when parent modification imports it", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evHeader = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/components/Header.tsx",
      provenance: "REPO_READ",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/components/Header.tsx",
        action: "modify",
        reason: "Import new toggle",
        evidenceIds: [evHeader.id],
        dependencies: ["./ThemeToggle"],
      },
      {
        path: "src/components/ThemeToggle.tsx",
        action: "create",
        reason: "New dark mode toggle",
        evidenceIds: [evHeader.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/components/Header.tsx"],
    });

    expect(res.approvedPaths).toContain("src/components/Header.tsx");
    expect(res.approvedPaths).toContain("src/components/ThemeToggle.tsx");
  });

  // 9. Orphan CREATE rejected
  test("9. Orphan CREATE without integration proof is rejected", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evHeader = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/components/Header.tsx",
      provenance: "REPO_READ",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/components/OrphanWidget.tsx",
        action: "create",
        reason: "Isolated component",
        evidenceIds: [evHeader.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/components/Header.tsx"],
    });

    expect(res.approvedPaths).not.toContain("src/components/OrphanWidget.tsx");
    expect(res.rejectedPaths.some((r) => r.path === "src/components/OrphanWidget.tsx" && r.reason.includes("Orphan CREATE"))).toBe(true);
  });

  // 10. DELETE requires structured destructive intent
  test("10. DELETE operation without destructive intent is rejected", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const ev = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/legacy.ts",
      provenance: "REPO_READ",
    });

    const constructiveIntent: TaskIntentSpec = {
      ...defaultIntent,
      destructive: false, // NOT destructive
    };

    const proposed: PlannedChange[] = [
      {
        path: "src/legacy.ts",
        action: "delete",
        reason: "Remove legacy file",
        evidenceIds: [ev.id],
        dependencies: [],
      },
    ];

    const constructivePolicy: PolicyContract = {
      ...defaultPolicy,
      allowedActions: ["modify_file", "create_files", "delete_file"],
    };

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: constructivePolicy,
      intentSpec: constructiveIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/legacy.ts"],
    });

    expect(res.approvedPaths).not.toContain("src/legacy.ts");
    expect(res.rejectedPaths.some((r) => r.path === "src/legacy.ts" && r.reason.includes("without structured destructive intent"))).toBe(true);
  });

  // 11. Active entry is not automatic authority
  test("11. Active entry points are not auto-added unless proposed by planner", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    evidenceStore.addEvidence({
      kind: "ENTRY_POINT",
      filePath: "src/App.tsx",
      provenance: "ARCHITECTURE_DETECTOR",
    });
    const evButton = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/components/Button.tsx",
      provenance: "REPO_READ",
    });
    const evBtnSym = evidenceStore.addEvidence({
      kind: "SYMBOL",
      filePath: "src/components/Button.tsx",
      symbol: "Button",
      provenance: "AST_GRAPH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/components/Button.tsx",
        action: "modify",
        reason: "Change button text",
        evidenceIds: [evButton.id, evBtnSym.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/App.tsx", "src/components/Button.tsx"],
    });

    expect(res.approvedPaths).toEqual(["src/components/Button.tsx"]);
    expect(res.approvedPaths).not.toContain("src/App.tsx");
  });

  // 12. Stylesheet ownership evidence
  test("12. Stylesheet requires proven import or dependency evidence", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evApp = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/App.tsx",
      provenance: "REPO_READ",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/App.tsx",
        action: "modify",
        reason: "Import theme CSS",
        evidenceIds: [evApp.id],
        dependencies: ["./theme.css"],
      },
      {
        path: "src/theme.css",
        action: "create",
        reason: "New theme CSS",
        evidenceIds: [evApp.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/App.tsx"],
    });

    expect(res.approvedPaths).toContain("src/theme.css");
  });

  // 13. Unrelated candidate rejection
  test("13. High-score unrelated candidate is rejected without task evidence", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evUnrelated = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/unrelated/Dashboard.tsx",
      provenance: "SEMANTIC_SEARCH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/unrelated/Dashboard.tsx",
        action: "modify",
        reason: "Unrelated file",
        evidenceIds: [evUnrelated.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/unrelated/Dashboard.tsx"],
    });

    // Unrelated candidate rejected
    expect(res.approvedPaths).not.toContain("src/unrelated/Dashboard.tsx");
    expect(res.rejectedPaths.some((r) => r.path === "src/unrelated/Dashboard.tsx" && r.reason.includes("relation"))).toBe(true);
  });

  // 14. Monorepo workspace isolation
  test("14. Monorepo workspace boundaries are enforced", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const ev = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "packages/frontend/src/App.tsx",
      provenance: "REPO_READ",
    });

    const monorepoPolicy: PolicyContract = {
      ...defaultPolicy,
      workspaceRoot: "packages/frontend",
    };

    const proposed: PlannedChange[] = [
      {
        path: "packages/backend/src/server.ts",
        action: "modify",
        reason: "Cross workspace edit",
        evidenceIds: [ev.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: monorepoPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["packages/backend/src/server.ts", "packages/frontend/src/App.tsx"],
      monorepo: { isMonorepo: true, type: "npm", packageManager: "npm", workspaces: [] } as any,
    });

    expect(res.approvedPaths).not.toContain("packages/backend/src/server.ts");
    expect(res.rejectedPaths.some((r) => r.reason.includes("lies outside workspace root"))).toBe(true);
  });

  // 15. Multi-repo evidence isolation
  test("15. Evidence from foreign repository cannot authorize target repo write", () => {
    const evidenceStore = new RepositoryEvidenceStore("repo-A");
    const evForeign = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/ForeignService.ts",
      provenance: "REPO_READ",
      repositoryId: "repo-B", // Belongs to repo-B
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/ForeignService.ts",
        action: "modify",
        reason: "Edit foreign service",
        evidenceIds: [evForeign.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/ForeignService.ts"],
      targetRepositoryId: "repo-A", // Target is repo-A
    });

    expect(res.approvedPaths).toHaveLength(0);
    expect(res.rejectedPaths.some((r) => r.reason.includes("originated from outside the target repository"))).toBe(true);
  });

  // 16. Manifest receives exact final write set
  test("16. ExecutionContract targetPaths matches approved write set exactly", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const ev = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/Button.tsx",
      provenance: "REPO_READ",
    });
    const evSym = evidenceStore.addEvidence({
      kind: "SYMBOL",
      filePath: "src/Button.tsx",
      symbol: "Button",
      provenance: "AST_GRAPH",
    });

    const proposed: PlannedChange[] = [
      { path: "src/Button.tsx", action: "modify", reason: "Update", evidenceIds: [ev.id, evSym.id], dependencies: [] },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/Button.tsx"],
    });

    expect(res.approvedPaths).toEqual(["src/Button.tsx"]);
  });

  // 17. ManifestValidator still rejects unauthorized path
  test("17. ManifestValidator rejects paths not in final ExecutionContract targetPaths", () => {
    const contract = {
      ...defaultPolicy,
      targetPaths: ["src/Approved.tsx"],
      contextScope: ["src/Approved.tsx"],
      searchScope: ["src"],
    } as any;

    const validator = new ManifestValidator(contract, {
      existingFiles: ["src/Approved.tsx", "src/Rogue.tsx"],
    });

    const validation = validator.validate({
      files: [
        { path: "src/Approved.tsx", action: "modify", dependencies: [], description: "Approved" },
        { path: "src/Rogue.tsx", action: "modify", dependencies: [], description: "Unauthorized rogue" },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    });

    expect(validation.valid).toBe(false);
    expect(
      validation.errors.some(
        (e) => (e.affectedFiles && e.affectedFiles.includes("src/Rogue.tsx")) || e.message.includes("targetPaths")
      )
    ).toBe(true);
  });

  // 18. Local change remains local
  test("18. Local change task only authorizes the local target", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const evBtn = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/components/PrimaryButton.tsx",
      provenance: "REPO_READ",
    });
    const evBtnSym = evidenceStore.addEvidence({
      kind: "SYMBOL",
      filePath: "src/components/PrimaryButton.tsx",
      symbol: "PrimaryButton",
      provenance: "AST_GRAPH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/components/PrimaryButton.tsx",
        action: "modify",
        reason: "Change button text to Continue",
        evidenceIds: [evBtn.id, evBtnSym.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: defaultIntent,
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/components/PrimaryButton.tsx", "src/App.tsx", "src/index.css"],
    });

    expect(res.approvedPaths).toEqual(["src/components/PrimaryButton.tsx"]);
    expect(res.approvedPaths).not.toContain("src/App.tsx");
    expect(res.approvedPaths).not.toContain("src/index.css");
  });

  // 19. Unknown feature works through investigation
  test("19. Unknown feature 'zen workspace switch' works via evidence investigation", () => {
    const evidenceStore = new RepositoryEvidenceStore("test-repo");
    const ev = evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "src/workspace/ZenMode.tsx",
      provenance: "REPO_READ",
    });
    const evSym = evidenceStore.addEvidence({
      kind: "SYMBOL",
      filePath: "src/workspace/ZenMode.tsx",
      symbol: "ZenMode",
      provenance: "AST_GRAPH",
    });

    const proposed: PlannedChange[] = [
      {
        path: "src/workspace/ZenMode.tsx",
        action: "modify",
        reason: "Add switch toggle",
        evidenceIds: [ev.id, evSym.id],
        dependencies: [],
      },
    ];

    const res = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: { ...defaultIntent, goal: "Add a zen workspace switch" },
      proposedChanges: proposed,
      evidenceStore,
      existingFiles: ["src/workspace/ZenMode.tsx"],
    });

    expect(res.approvedPaths).toContain("src/workspace/ZenMode.tsx");
  });

  // 20. Identical task semantics with different wording produce equivalent behavior
  test("20. Rephrased prompts with identical semantics authorize the same target paths", () => {
    const evidenceStore1 = new RepositoryEvidenceStore("test-repo");
    const ev1 = evidenceStore1.addEvidence({ kind: "FILE", filePath: "src/nav.tsx", provenance: "REPO_READ" });
    const evSym1 = evidenceStore1.addEvidence({ kind: "SYMBOL", filePath: "src/nav.tsx", symbol: "Navbar", provenance: "AST_GRAPH" });
    const res1 = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: { ...defaultIntent, goal: "Add logout button to navbar" },
      proposedChanges: [{ path: "src/nav.tsx", action: "modify", reason: "Logout button", evidenceIds: [ev1.id, evSym1.id], dependencies: [] }],
      evidenceStore: evidenceStore1,
      existingFiles: ["src/nav.tsx"],
    });

    const evidenceStore2 = new RepositoryEvidenceStore("test-repo");
    const ev2 = evidenceStore2.addEvidence({ kind: "FILE", filePath: "src/nav.tsx", provenance: "REPO_READ" });
    const evSym2 = evidenceStore2.addEvidence({ kind: "SYMBOL", filePath: "src/nav.tsx", symbol: "Navbar", provenance: "AST_GRAPH" });
    const res2 = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: { ...defaultIntent, goal: "Put a sign out action inside the navigation bar" },
      proposedChanges: [{ path: "src/nav.tsx", action: "modify", reason: "Sign out action", evidenceIds: [ev2.id, evSym2.id], dependencies: [] }],
      evidenceStore: evidenceStore2,
      existingFiles: ["src/nav.tsx"],
    });

    expect(res1.approvedPaths).toEqual(res2.approvedPaths);
  });
});
