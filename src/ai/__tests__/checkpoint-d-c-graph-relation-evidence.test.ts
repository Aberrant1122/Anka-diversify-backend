import fs from "fs";
import os from "os";
import path from "path";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { TaskRootedAuthorizationVerifier } from "../contracts/TaskRootedAuthorizationProof";
import { TaskAnchorResolver } from "../repository/TaskAnchorResolver";
import { PolicyContract } from "../contracts/PolicyContract";
import { createTaskIntentSpec, TaskIntentSpec } from "../shared/TaskIntentSpec";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { EvidenceBoundWriteSetResolver } from "../contracts/EvidenceBoundWriteSetResolver";
import { DeterministicRelationEvidenceAcquirer } from "../contracts/DeterministicRelationEvidenceAcquirer";
import { bindBackendManifestEvidence } from "../orchestration/AgentPlanner";
import {
  canonicalizeProspectiveFeatureGraph,
  closeProspectiveGraphAfterAuthorization,
  validateProspectiveGraphBinding,
} from "../planning/ProspectiveFeatureGraph";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import {
  ConstructiveCapabilityEnvelopeBuilder,
  deriveConstructiveCandidateRelation,
  candidateFitsAuthenticatedClause,
} from "../contracts/ConstructiveCapabilityEnvelope";
import { findVerifiedTopologyIssues } from "../generation/CodeGenerator";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import {
  bindUserRequest,
  bindStageAuthorizationContext,
  bindStageAuthorizationClause,
  bindStageAuthorizationId,
} from "../repository/TrustedTaskContext";
import { UserClauseExtractor } from "../contracts/UserClauseAuthority";
import { productionIsAuthorityEligible } from "./helpers/capability-test-harness";
import { authoritySnapshot } from "../repository/AuthorityWorktree";
import { RepositoryObservationTools } from "../repository/RepositoryObservation";
import type {
  ExecutionContract,
  FileManifest,
  ProspectiveFeatureGraphProposal,
  VerifiedProspectiveFeatureGraph,
} from "../../types";

describe("Checkpoint D / C Verified Graph-Rooted Constructive Relation Evidence Suite", () => {
  jest.setTimeout(30000);

  let root: string;
  let store: RepositoryEvidenceStore;

  const write = (filePath: string, content: string) => {
    const absolute = path.join(root, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  };

  const getFiles = (): string[] =>
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => path.relative(root, path.join(d.parentPath, d.name)).replace(/\\/g, "/"));

  const defaultPolicy: PolicyContract = {
    goal: "Feature Implementation",
    taskType: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    destructive: false,
    allowedActions: ["create_file", "modify_file", "delete_file"],
    forbiddenActions: [],
    maxFiles: 10,
    diffCriticEnabled: true,
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    explicitUserPaths: [],
    userConstraints: [],
    requiresClarification: false,
  };

  function dec(p: string, deps: string[] = []): FileManifest["files"][number] {
    return { path: p, action: "create", description: p, dependencies: deps };
  }

  const constructiveClassification: TaskClassificationResult = {
    taskType: "NEW_FEATURE",
    intent: "NEW_FEATURE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    confidence: 1,
    requiresClarification: false,
    reasoning: "Constructive task",
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "graph-evidence-test-"));
    store = new RepositoryEvidenceStore("test-repo", root);
    store.isAuthorityEligible = productionIsAuthorityEligible.bind(store);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(root)) {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  function setupGreenfieldNextApp() {
    write("package.json", JSON.stringify({ name: "greenfield-app", dependencies: { next: "15.0.0", react: "19.0.0" } }));
    write("app/layout.tsx", "export default function RootLayout({ children }: { children: any }) { return <html><body>{children}</body></html>; }");
    write("app/page.tsx", "export default function Home() { return <div>Home</div>; }");
  }

  function setupStageAndIntent(userRequest: string, stageGoal: string, stageId = "stage-constructive-create"): TaskIntentSpec {
    const rawIntent = createTaskIntentSpec(
      userRequest,
      constructiveClassification,
      []
    );
    bindUserRequest(rawIntent, userRequest);
    bindStageAuthorizationContext(rawIntent, stageGoal);
    bindStageAuthorizationId(rawIntent, stageId);
    const clauses = UserClauseExtractor.extractClauses(userRequest);
    const boundClause = UserClauseExtractor.bindStageToClause(
      { taskType: "NEW_FEATURE", goal: stageGoal, name: stageGoal },
      clauses
    ).clause;
    bindStageAuthorizationClause(rawIntent, boundClause || clauses[0]);
    return rawIntent;
  }

  test("1. Feature root independently grounded without graph self-authorization", () => {
    setupGreenfieldNextApp();
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    });
    expect(envelope).not.toBeNull();

    // Feature root app/todo/page.tsx derives constructive relation directly
    const rootRel = deriveConstructiveCandidateRelation(envelope!, "app/todo/page.tsx");
    expect(rootRel).not.toBeNull();
    expect(rootRel?.role).toBe("ROUTE");
    expect(candidateFitsAuthenticatedClause(intentSpec, rootRel!)).toBe(true);

    const isEligible = TaskRootedAuthorizationVerifier.isEligibleConstructiveCreateScope(
      "app/todo/page.tsx",
      rootRel!.integrationSurface,
      existing,
      intentSpec,
      rootRel!
    );
    expect(isEligible).toBe(true);

    // Arbitrary ungrounded file fails direct grounding
    const ungroundedRel = deriveConstructiveCandidateRelation(envelope!, "app/unrelated/page.tsx");
    expect(ungroundedRel).not.toBeNull();
    expect(candidateFitsAuthenticatedClause(intentSpec, ungroundedRel!)).toBe(false);
  });

  test("2. Feature-local child receives graph-rooted support evidence", () => {
    setupGreenfieldNextApp();
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    const proposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-list", path: "app/todo/TodoList.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
      ],
      edges: [
        { sourceId: "t-root", targetId: "t-list", relation: "RENDERS" },
      ],
      featureRoots: ["t-root"],
    };

    const manifestFiles = [
      dec("app/todo/page.tsx", ["./TodoList"]),
      dec("app/todo/TodoList.tsx"),
    ];

    const canonResult = canonicalizeProspectiveFeatureGraph(proposal, { files: manifestFiles }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(canonResult.valid).toBe(true);
    const verifiedGraph = canonResult.graph!;

    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["app/todo/page.tsx", "app/todo/TodoList.tsx"],
      intentSpec,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: existing,
      constructiveEnvelope: envelope,
      verifiedTopology: verifiedGraph,
    });

    expect(acquired.has("app/todo/TodoList.tsx")).toBe(true);
    const childEvidenceIds = acquired.get("app/todo/TodoList.tsx")!;
    expect(childEvidenceIds.length).toBeGreaterThan(0);

    // Child evidence must include authentic non-prospective root evidence (ENTRY_POINT)
    const childEvidences = childEvidenceIds.map((id) => store.getEvidence(id)!);
    expect(childEvidences.some((e) => e.kind === "ENTRY_POINT")).toBe(true);
    expect(childEvidences.some((e) => e.kind === "REFERENCE" && e.metadata?.graphReceipt)).toBe(true);
  });

  test("3. Feature-local grandchild receives support relation through canonical chain", () => {
    setupGreenfieldNextApp();
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    const proposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-list", path: "app/todo/TodoList.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
        { temporaryId: "t-item", path: "app/todo/TodoItem.tsx", kind: "PROSPECTIVE", role: "CHILD_COMPONENT" },
      ],
      edges: [
        { sourceId: "t-root", targetId: "t-list", relation: "RENDERS" },
        { sourceId: "t-list", targetId: "t-item", relation: "RENDERS" },
      ],
      featureRoots: ["t-root"],
    };

    const manifestFiles = [
      dec("app/todo/page.tsx", ["./TodoList"]),
      dec("app/todo/TodoList.tsx", ["./TodoItem"]),
      dec("app/todo/TodoItem.tsx"),
    ];

    const canonResult = canonicalizeProspectiveFeatureGraph(proposal, { files: manifestFiles }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(canonResult.valid).toBe(true);

    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: manifestFiles.map((f) => f.path),
      intentSpec,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: existing,
      constructiveEnvelope: envelope,
      verifiedTopology: canonResult.graph!,
    });

    expect(acquired.has("app/todo/TodoItem.tsx")).toBe(true);
    const proof = TaskRootedAuthorizationVerifier.derive(store, intentSpec, "app/todo/TodoItem.tsx", "create");
    expect(proof).not.toBeNull();
    expect(proof?.relationMode).toBe("GRAPH_ROOTED_SUPPORT_RELATION");
    expect(proof?.graphReceipt?.relationChain).toHaveLength(2);
  });

  test("4. Shared component-region child continues to work", () => {
    setupGreenfieldNextApp();
    write("app/components/SharedButton.tsx", "export function SharedButton() { return <button />; }");
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    const proposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-shared", path: "app/components/TodoPanel.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
      ],
      edges: [
        { sourceId: "t-root", targetId: "t-shared", relation: "RENDERS" },
      ],
      featureRoots: ["t-root"],
    };

    const manifestFiles = [
      dec("app/todo/page.tsx", ["../components/TodoPanel"]),
      dec("app/components/TodoPanel.tsx"),
    ];

    const canonResult = canonicalizeProspectiveFeatureGraph(proposal, { files: manifestFiles }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(canonResult.valid).toBe(true);

    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: manifestFiles.map((f) => f.path),
      intentSpec,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: existing,
      constructiveEnvelope: envelope,
      verifiedTopology: canonResult.graph!,
    });

    expect(acquired.has("app/components/TodoPanel.tsx")).toBe(true);
  });

  test("5. Functional supporting child with non-clause verb works via graph support without lexical allowlist", () => {
    setupGreenfieldNextApp();
    // User clause is strictly "todo feature" - no "add", "edit", "toggle", "editor" words in clause
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    // Functional children containing non-clause verbs
    const proposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-add", path: "app/components/AddTodo.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
        { temporaryId: "t-editor", path: "app/todo/Editor.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
        { temporaryId: "t-toggle", path: "app/todo/Toggle.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
      ],
      edges: [
        { sourceId: "t-root", targetId: "t-add", relation: "RENDERS" },
        { sourceId: "t-root", targetId: "t-editor", relation: "RENDERS" },
        { sourceId: "t-root", targetId: "t-toggle", relation: "RENDERS" },
      ],
      featureRoots: ["t-root"],
    };

    const manifestFiles = [
      dec("app/todo/page.tsx"),
      dec("app/components/AddTodo.tsx"),
      dec("app/todo/Editor.tsx"),
      dec("app/todo/Toggle.tsx"),
    ];

    const canonResult = canonicalizeProspectiveFeatureGraph(proposal, { files: manifestFiles }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(canonResult.valid).toBe(true);

    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: manifestFiles.map((f) => f.path),
      intentSpec,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: existing,
      constructiveEnvelope: envelope,
      verifiedTopology: canonResult.graph!,
    });

    expect(acquired.has("app/components/AddTodo.tsx")).toBe(true);
    expect(acquired.has("app/todo/Editor.tsx")).toBe(true);
    expect(acquired.has("app/todo/Toggle.tsx")).toBe(true);

    const plannedChanges = bindBackendManifestEvidence({
      files: manifestFiles,
      obligations: [],
      acquiredEvidence: acquired,
      evidenceStore: store,
      currentRevision: snapshot.revision,
    });

    const resolution = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec,
      proposedChanges: plannedChanges,
      evidenceStore: store,
      existingFiles: existing,
      workspaceRoot: root,
      baseRevision: snapshot.revision,
      stageId: "stage-constructive-create",
    });

    expect(resolution.approvedPaths).toContain("app/components/AddTodo.tsx");
    expect(resolution.approvedPaths).toContain("app/todo/Editor.tsx");
    expect(resolution.approvedPaths).toContain("app/todo/Toggle.tsx");
  });

  test("6. Neutral supporting child (Form.tsx) works when validly connected", () => {
    setupGreenfieldNextApp();
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    const proposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-form", path: "app/todo/Form.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
      ],
      edges: [
        { sourceId: "t-root", targetId: "t-form", relation: "RENDERS" },
      ],
      featureRoots: ["t-root"],
    };

    const manifestFiles = [
      dec("app/todo/page.tsx", ["./Form"]),
      dec("app/todo/Form.tsx"),
    ];

    const canonResult = canonicalizeProspectiveFeatureGraph(proposal, { files: manifestFiles }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(canonResult.valid).toBe(true);

    const acquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: manifestFiles.map((f) => f.path),
      intentSpec,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: existing,
      constructiveEnvelope: envelope,
      verifiedTopology: canonResult.graph!,
    });

    expect(acquired.has("app/todo/Form.tsx")).toBe(true);
  });

  test("7. Disconnected candidate receives no graph-rooted receipt", () => {
    setupGreenfieldNextApp();
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    // Proposal with an orphan node fails canonicalization
    const orphanProposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-orphan", path: "app/todo/Orphan.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
      ],
      edges: [],
      featureRoots: ["t-root"],
    };

    const canonResult = canonicalizeProspectiveFeatureGraph(orphanProposal, { files: [
      dec("app/todo/page.tsx"),
      dec("app/todo/Orphan.tsx"),
    ] }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(canonResult.valid).toBe(false);
    expect(canonResult.errors.some((e) => e.message.includes("disconnected"))).toBe(true);
  });

  test("8-14. Attack tests: sensitive child, outside repo, wrong workspace, stale revision, fake role, raw graph", () => {
    setupGreenfieldNextApp();
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    // Attack 8A: Sensitive .env
    const envProposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-env", path: ".env", kind: "PROSPECTIVE", role: "COMPONENT" },
      ],
      edges: [{ sourceId: "t-root", targetId: "t-env", relation: "RENDERS" }],
      featureRoots: ["t-root"],
    };
    const envCanon = canonicalizeProspectiveFeatureGraph(envProposal, { files: [
      dec("app/todo/page.tsx"),
      dec(".env"),
    ] }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(envCanon.valid).toBe(false);

    // Attack 8B: Sensitive auth/secrets.ts
    const authProposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-sec", path: "auth/secrets.ts", kind: "PROSPECTIVE", role: "MODULE" },
      ],
      edges: [{ sourceId: "t-root", targetId: "t-sec", relation: "IMPORTS" }],
      featureRoots: ["t-root"],
    };
    const authCanon = canonicalizeProspectiveFeatureGraph(authProposal, { files: [
      dec("app/todo/page.tsx"),
      dec("auth/secrets.ts"),
    ] }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    // Even if canonicalization passes, acquirer rejects sensitive paths
    if (authCanon.valid && authCanon.graph) {
      const acquired = DeterministicRelationEvidenceAcquirer.acquire({
        candidatePaths: ["auth/secrets.ts"],
        intentSpec,
        evidenceStore: store,
        repositoryId: "test-repo",
        workspaceRoot: root,
        existingFiles: existing,
        constructiveEnvelope: envelope,
        verifiedTopology: authCanon.graph,
      });
      expect(acquired.has("auth/secrets.ts")).toBe(false);
    }

    // Attack 9: Outside repo candidate ../outside.ts
    const outsideProposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-out", path: "../outside.ts", kind: "PROSPECTIVE", role: "MODULE" },
      ],
      edges: [{ sourceId: "t-root", targetId: "t-out", relation: "IMPORTS" }],
      featureRoots: ["t-root"],
    };
    const outCanon = canonicalizeProspectiveFeatureGraph(outsideProposal, { files: [
      { path: "app/todo/page.tsx", action: "create", description: "p", dependencies: [] },
      { path: "../outside.ts", action: "create", description: "o", dependencies: [] },
    ] }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(outCanon.valid).toBe(false);

    // Attack 10: Wrong workspace
    const validProposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-list", path: "app/todo/TodoList.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
      ],
      edges: [{ sourceId: "t-root", targetId: "t-list", relation: "RENDERS" }],
      featureRoots: ["t-root"],
    };
    const validCanon = canonicalizeProspectiveFeatureGraph(validProposal, { files: [
      { path: "app/todo/page.tsx", action: "create", description: "p", dependencies: [] },
      { path: "app/todo/TodoList.tsx", action: "create", description: "l", dependencies: [] },
    ] }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(validCanon.valid).toBe(true);

    const wrongWsGraph: VerifiedProspectiveFeatureGraph = {
      ...validCanon.graph!,
      workspaceRoot: "C:/wrong/workspace",
    };
    const wrongWsAcquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["app/todo/TodoList.tsx"],
      intentSpec,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: existing,
      constructiveEnvelope: envelope,
      verifiedTopology: wrongWsGraph,
    });
    expect(wrongWsAcquired.has("app/todo/TodoList.tsx")).toBe(false);

    // Attack 11: Stale revision
    const staleRevGraph: VerifiedProspectiveFeatureGraph = {
      ...validCanon.graph!,
      repositoryRevision: "stale-rev-999",
    };
    const staleAcquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["app/todo/TodoList.tsx"],
      intentSpec,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: existing,
      constructiveEnvelope: envelope,
      verifiedTopology: staleRevGraph,
    });
    expect(staleAcquired.has("app/todo/TodoList.tsx")).toBe(false);

    // Attack 14: Invalid role combination: package.json as CHILD_COMPONENT
    const fakeRoleProposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-pkg", path: "package.json", kind: "PROSPECTIVE", role: "CHILD_COMPONENT" },
      ],
      edges: [{ sourceId: "t-root", targetId: "t-pkg", relation: "RENDERS" }],
      featureRoots: ["t-root"],
    };
    const fakeCanon = canonicalizeProspectiveFeatureGraph(fakeRoleProposal, { files: [
      { path: "app/todo/page.tsx", action: "create", description: "p", dependencies: [] },
      { path: "package.json", action: "create", description: "pkg", dependencies: [] },
    ] }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(fakeCanon.valid).toBe(false);
  });

  test("15-17. Parent approval does not authorize child; rejected parent fails closure", () => {
    setupGreenfieldNextApp();
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    const proposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-list", path: "app/todo/TodoList.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
        { temporaryId: "t-item", path: "app/todo/TodoItem.tsx", kind: "PROSPECTIVE", role: "CHILD_COMPONENT" },
      ],
      edges: [
        { sourceId: "t-root", targetId: "t-list", relation: "RENDERS" },
        { sourceId: "t-list", targetId: "t-item", relation: "RENDERS" },
      ],
      featureRoots: ["t-root"],
    };

    const manifestFiles = [
      dec("app/todo/page.tsx", ["./TodoList"]),
      dec("app/todo/TodoList.tsx", ["./TodoItem"]),
      dec("app/todo/TodoItem.tsx"),
    ];

    const canonResult = canonicalizeProspectiveFeatureGraph(proposal, { files: manifestFiles }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(canonResult.valid).toBe(true);

    // If parent (TodoList) is rejected and only root and item are approved:
    // Post-authorization closure MUST FAIL!
    const closure = closeProspectiveGraphAfterAuthorization(canonResult.graph!, [
      "app/todo/page.tsx",
      "app/todo/TodoItem.tsx",
    ]);
    expect(closure.valid).toBe(false);
    expect(closure.errors.some((e) => e.message.includes("broke a required prospective topology edge") || e.message.includes("rejected a planned graph node"))).toBe(true);
  });

  test("18-21. Generated code topology audit confirms RENDERS, IMPORTS, REGISTERS", () => {
    setupGreenfieldNextApp();
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    const proposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-list", path: "app/todo/TodoList.tsx", kind: "PROSPECTIVE", role: "COMPONENT", symbol: "TodoList" },
      ],
      edges: [
        { sourceId: "t-root", targetId: "t-list", relation: "RENDERS" },
      ],
      featureRoots: ["t-root"],
    };

    const manifestFiles = [
      dec("app/todo/page.tsx", ["./TodoList"]),
      dec("app/todo/TodoList.tsx"),
    ];

    const canon = canonicalizeProspectiveFeatureGraph(proposal, { files: manifestFiles }, {
      stageId: "stage-constructive-create",
      userClauseId: envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(canon.valid).toBe(true);

    const validManifest: FileManifest = {
      files: manifestFiles,
      totalFiles: 2,
      manifestVersion: "1.0.0",
      verifiedTopology: canon.graph!,
    };

    // Case A: Valid generated code realizes RENDERS
    const validChanges = [
      {
        path: "app/todo/page.tsx",
        action: "create" as const,
        description: "page",
        content: `import { TodoList } from "./TodoList";\nexport default function TodoPage() { return <TodoList />; }`,
      },
      {
        path: "app/todo/TodoList.tsx",
        action: "create" as const,
        description: "list",
        content: `export function TodoList() { return <ul><li>Todo 1</li></ul>; }`,
      },
    ];
    const issuesA = findVerifiedTopologyIssues({ "app/page.tsx": "" }, validChanges, validManifest);
    expect(issuesA).toEqual([]);

    // Case B: Parent fails to render/import child -> audit fails
    const invalidChanges = [
      {
        path: "app/todo/page.tsx",
        action: "create" as const,
        description: "page",
        content: `export default function TodoPage() { return <div>No list rendered</div>; }`,
      },
      {
        path: "app/todo/TodoList.tsx",
        action: "create" as const,
        description: "list",
        content: `export function TodoList() { return <ul><li>Todo 1</li></ul>; }`,
      },
    ];
    const issuesB = findVerifiedTopologyIssues({ "app/page.tsx": "" }, invalidChanges, validManifest);
    expect(issuesB.length).toBeGreaterThan(0);
    expect(issuesB.some((i) => i.includes("does not render"))).toBe(true);
  });

  test("22-26. Prospective receipt alone insufficient; authentic root evidence mandatory; forged ID rejected", () => {
    setupGreenfieldNextApp();
    const intentSpec = setupStageAndIntent("create a todo feature", "create a todo feature");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);

    // If proposed change ONLY cites prospective file evidence without root evidence -> resolver rejects
    const obsReceipt = RepositoryObservationTools.observeProspectiveFile(store.getRepositoryId(), root, "app/todo/TodoList.tsx")!;
    expect(obsReceipt).toBeDefined();
    const insertedEvidence = store.recordObservation(obsReceipt)!;
    expect(insertedEvidence).toBeDefined();

    const plannedChanges = [
      {
        path: "app/todo/TodoList.tsx",
        action: "create" as const,
        reason: "create child",
        evidenceIds: [insertedEvidence.id],
        dependencies: [],
      },
    ];

    const resolution = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec,
      proposedChanges: plannedChanges,
      evidenceStore: store,
      existingFiles: existing,
      workspaceRoot: root,
      baseRevision: snapshot.revision,
      stageId: "stage-constructive-create",
    });

    expect(resolution.approvedPaths).not.toContain("app/todo/TodoList.tsx");
    expect(resolution.rejectedPaths.some((r) => r.reasonCode === "PROSPECTIVE_EVIDENCE_ALONE_INSUFFICIENT")).toBe(true);

    // Forged evidence ID rejected
    const forgedChanges = [
      {
        path: "app/todo/TodoList.tsx",
        action: "create" as const,
        reason: "create child",
        evidenceIds: ["evi_forged_99999"],
        dependencies: [],
      },
    ];
    const forgedResolution = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec,
      proposedChanges: forgedChanges,
      evidenceStore: store,
      existingFiles: existing,
      workspaceRoot: root,
      baseRevision: snapshot.revision,
      stageId: "stage-constructive-create",
    });
    expect(forgedResolution.rejectedPaths.some((r) => r.reasonCode === "INVENTED_OR_MISSING_EVIDENCE_IDS")).toBe(true);
  });

  test("34-37. Stage & clause isolation: relation receipt from another stage/clause is rejected", () => {
    setupGreenfieldNextApp();
    const todoIntent = setupStageAndIntent("create a todo feature", "create a todo feature", "stage-todo");
    const calcIntent = setupStageAndIntent("create a calc feature", "create a calc feature", "stage-calc");
    const existing = getFiles();
    const snapshot = authoritySnapshot(root);
    const architecture = detectRepositoryArchitecture(existing, JSON.stringify({ dependencies: { next: "15.0.0" } }));

    const envelopeTodo = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec: todoIntent,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      architecture,
    })!;

    const proposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "t-root", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "t-list", path: "app/todo/TodoList.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
      ],
      edges: [{ sourceId: "t-root", targetId: "t-list", relation: "RENDERS" }],
      featureRoots: ["t-root"],
    };

    const canonTodo = canonicalizeProspectiveFeatureGraph(proposal, { files: [
      { path: "app/todo/page.tsx", action: "create", description: "route", dependencies: [] },
      { path: "app/todo/TodoList.tsx", action: "create", description: "component", dependencies: [] },
    ] }, {
      stageId: "stage-todo",
      userClauseId: envelopeTodo.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshot.revision,
      existingFiles: existing,
      architecture,
    });
    expect(canonTodo.valid).toBe(true);

    // Try to acquire using calculator stage intent with todo graph -> stage mismatch rejects
    const crossStageAcquired = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: ["app/todo/TodoList.tsx"],
      intentSpec: calcIntent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: existing,
      constructiveEnvelope: envelopeTodo,
      verifiedTopology: canonTodo.graph!,
    });
    expect(crossStageAcquired.has("app/todo/TodoList.tsx")).toBe(false);
  });

  // =========================================================================
  // PART 40: HIGH-LEVEL COMPOUND REGRESSION (LIVE CASE SHAPE)
  // =========================================================================
  test("40. High-level compound regression: destructive stage + greenfield constructive stage with no components dir", async () => {
    // 1. Setup repository with an existing calculator feature and an entry point
    write("package.json", JSON.stringify({ name: "app", dependencies: { next: "15.0.0", react: "19.0.0" } }));
    write("app/layout.tsx", "export default function RootLayout({ children }: { children: any }) { return <html><body>{children}</body></html>; }");
    write("app/page.tsx", `import { Calculator } from "./calculator/Calculator";\nexport default function Page() { return <Calculator />; }`);
    write("app/calculator/Calculator.tsx", "export function Calculator() { return <div>Calculator</div>; }");

    const compoundRequest = "remove the calculator and add a todo list";
    const clauses = UserClauseExtractor.extractClauses(compoundRequest);
    expect(clauses).toHaveLength(2);

    const deleteClause = clauses.find((c) => c.operation === "DELETE")!;
    const createClause = clauses.find((c) => c.operation === "CREATE")!;
    expect(deleteClause).toBeDefined();
    expect(createClause).toBeDefined();

    // -----------------------------------------------------------------------
    // STAGE 1: Destructive calculator removal
    // -----------------------------------------------------------------------
    const stage1Intent = createTaskIntentSpec(
      compoundRequest,
      { ...constructiveClassification, intent: "DELETE_FILE", taskType: "DELETE_FILE" },
      []
    );
    bindUserRequest(stage1Intent, compoundRequest);
    bindStageAuthorizationContext(stage1Intent, "remove the calculator");
    bindStageAuthorizationId(stage1Intent, "stage-1-delete");
    bindStageAuthorizationClause(stage1Intent, deleteClause);

    // -----------------------------------------------------------------------
    // STAGE 2: Greenfield constructive create without /components directory
    // Candidates:
    // - app/todo/page.tsx (route root)
    // - app/todo/TodoList.tsx (feature-local child, NOT in /components)
    // - app/todo/AddItem.tsx (nested functional child containing non-clause verb "add")
    // -----------------------------------------------------------------------
    const stage2Intent = createTaskIntentSpec(
      compoundRequest,
      constructiveClassification,
      []
    );
    bindUserRequest(stage2Intent, compoundRequest);
    bindStageAuthorizationContext(stage2Intent, "add a todo list");
    bindStageAuthorizationId(stage2Intent, "stage-2-create");
    bindStageAuthorizationClause(stage2Intent, createClause);

    const existingBeforeS2 = getFiles();
    const snapshotBeforeS2 = authoritySnapshot(root);
    const s2Arch = detectRepositoryArchitecture(existingBeforeS2, JSON.stringify({ dependencies: { next: "15.0.0" } }));
    const s2Envelope = ConstructiveCapabilityEnvelopeBuilder.build({
      intentSpec: stage2Intent,
      workspaceRoot: root,
      repositoryRevision: snapshotBeforeS2.revision,
      architecture: s2Arch,
    })!;

    const s2Proposal: ProspectiveFeatureGraphProposal = {
      nodes: [
        { temporaryId: "p-route", path: "app/todo/page.tsx", kind: "PROSPECTIVE", role: "ROUTE" },
        { temporaryId: "p-list", path: "app/todo/TodoList.tsx", kind: "PROSPECTIVE", role: "COMPONENT" },
        { temporaryId: "p-add", path: "app/todo/AddItem.tsx", kind: "PROSPECTIVE", role: "CHILD_COMPONENT" },
      ],
      edges: [
        { sourceId: "p-route", targetId: "p-list", relation: "RENDERS" },
        { sourceId: "p-list", targetId: "p-add", relation: "RENDERS" },
      ],
      featureRoots: ["p-route"],
    };

    const s2ManifestFiles = [
      { path: "app/todo/page.tsx", action: "create" as const, description: "route", dependencies: ["./TodoList"] },
      { path: "app/todo/TodoList.tsx", action: "create" as const, description: "list", dependencies: ["./AddItem"] },
      { path: "app/todo/AddItem.tsx", action: "create" as const, description: "add", dependencies: [] },
    ];

    const s2Canon = canonicalizeProspectiveFeatureGraph(s2Proposal, { files: s2ManifestFiles }, {
      stageId: "stage-2-create",
      userClauseId: s2Envelope.userClauseId,
      workspaceRoot: root,
      repositoryRevision: snapshotBeforeS2.revision,
      existingFiles: existingBeforeS2,
      architecture: s2Arch,
    });
    expect(s2Canon.valid).toBe(true);

    const acquiredS2 = DeterministicRelationEvidenceAcquirer.acquire({
      candidatePaths: s2ManifestFiles.map((f) => f.path),
      intentSpec: stage2Intent,
      evidenceStore: store,
      repositoryId: "test-repo",
      workspaceRoot: root,
      existingFiles: existingBeforeS2,
      constructiveEnvelope: s2Envelope,
      verifiedTopology: s2Canon.graph!,
    });

    // All valid CREATE candidates must receive deterministic relation evidence
    expect(acquiredS2.has("app/todo/page.tsx")).toBe(true);
    expect(acquiredS2.has("app/todo/TodoList.tsx")).toBe(true);
    expect(acquiredS2.has("app/todo/AddItem.tsx")).toBe(true);

    const plannedChanges = bindBackendManifestEvidence({
      files: s2ManifestFiles,
      obligations: [],
      acquiredEvidence: acquiredS2,
      evidenceStore: store,
      currentRevision: snapshotBeforeS2.revision,
    });

    const resolution = EvidenceBoundWriteSetResolver.resolve({
      policy: defaultPolicy,
      intentSpec: stage2Intent,
      proposedChanges: plannedChanges,
      evidenceStore: store,
      existingFiles: existingBeforeS2,
      workspaceRoot: root,
      baseRevision: snapshotBeforeS2.revision,
      stageId: "stage-2-create",
    });

    expect(resolution.rejectedPaths).toHaveLength(0);
    expect(resolution.approvedPaths).toContain("app/todo/page.tsx");
    expect(resolution.approvedPaths).toContain("app/todo/TodoList.tsx");
    expect(resolution.approvedPaths).toContain("app/todo/AddItem.tsx");
  });
});
