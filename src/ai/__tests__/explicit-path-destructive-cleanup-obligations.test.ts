import fs from "fs";
import os from "os";
import path from "path";
import { DestructiveTargetResolver } from "../contracts/DestructiveTargetResolver";
import { EvidenceBoundWriteSetResolver, PlannedChange } from "../contracts/EvidenceBoundWriteSetResolver";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskRootedAuthorizationVerifier } from "../contracts/TaskRootedAuthorizationProof";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { FileActionObligation } from "../shared/TaskExecutionPlan";
import { createTaskIntentSpec, TaskIntentSpec } from "../shared/TaskIntentSpec";
import { TaskClassificationResult } from "../classification/TaskTypes";
import { productionIsAuthorityEligible } from "./helpers/capability-test-harness";

const request =
  "Delete components/legacy-badge.tsx and clean up only its direct imports and references. Do not modify or delete unrelated files.";
const target = "components/legacy-badge.tsx";
const pageImporter = "app/reports/page.tsx";
const bannerImporter = "components/system-banner.tsx";

const classification: TaskClassificationResult = {
  taskType: "DELETE_FILE",
  intent: "DELETE_FILE",
  targetPath: target,
  risk: "MEDIUM",
  estimatedComplexity: "SMALL",
  confidence: 1,
  requiresClarification: false,
  reasoning: "Explicit destructive cleanup regression",
};

const policy: PolicyContract = {
  goal: request,
  taskType: "DELETE_FILE",
  risk: "MEDIUM",
  estimatedComplexity: "SMALL",
  destructive: true,
  allowedActions: ["delete_file", "remove_imports", "update_references", "modify_file"],
  forbiddenActions: ["create_new_files"],
  maxFiles: 8,
  diffCriticEnabled: true,
  pipeline: "REPOSITORY",
  environment: "REACT_TS",
  repositoryRequired: true,
  expectedFiles: [],
  validationType: "TYPESCRIPT_BUILD",
  explicitUserPaths: [target],
  userConstraints: ["Only direct imports and references may be cleaned up"],
  requiresClarification: false,
};

describe("explicit-path destructive cleanup obligation propagation", () => {
  let root: string;
  let evidenceStore: RepositoryEvidenceStore;

  const write = (filePath: string, content: string): void => {
    const absolute = path.join(root, filePath);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content);
  };

  const repositoryFiles = (): string[] =>
    fs
      .readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).replace(/\\/g, "/"));

  const resolveExplicitTarget = (targetPath?: string) =>
    DestructiveTargetResolver.resolve(request, repositoryFiles(), {
      isDestructive: true,
      taskType: "DELETE_FILE",
      targetPath,
      evidenceStore,
      repositoryId: "repo",
      localPath: root,
    });

  const expectedObligations = [
    { path: pageImporter, role: "DEPENDENCY_CLEANUP", requiredAction: "modify" },
    { path: target, role: "PRIMARY_TARGET", requiredAction: "delete" },
    { path: bannerImporter, role: "DEPENDENCY_CLEANUP", requiredAction: "modify" },
  ];

  const obligationShape = (obligations: FileActionObligation[]) =>
    obligations
      .map(({ path: obligationPath, role, requiredAction }) => ({
        path: obligationPath,
        role,
        requiredAction,
      }))
      .sort((left, right) => left.path.localeCompare(right.path));

  const createIntent = (): TaskIntentSpec => createTaskIntentSpec(request, classification, [target]);

  const proposedFrom = (obligations: FileActionObligation[]): PlannedChange[] =>
    obligations.map((obligation) => ({
      path: obligation.path,
      action: obligation.requiredAction,
      reason:
        obligation.role === "PRIMARY_TARGET"
          ? "Delete the explicit legacy badge target"
          : "Clean up an authenticated direct importer",
      evidenceIds: [...obligation.evidenceIds],
      dependencies: [],
    }));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "anka-explicit-cleanup-"));
    write("tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } } }));
    write(target, "export const LegacyBadge = () => null;");
    write(
      pageImporter,
      "import { LegacyBadge } from '@/components/legacy-badge'; export default function Page() { return LegacyBadge(); }",
    );
    write(
      bannerImporter,
      "import { LegacyBadge } from './legacy-badge'; export const SystemBanner = () => LegacyBadge();",
    );
    evidenceStore = new RepositoryEvidenceStore("repo", root);
    evidenceStore.isAuthorityEligible = productionIsAuthorityEligible.bind(evidenceStore);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    ["structured targetPath", target],
    ["path extracted from original user text", undefined],
  ])("preserves hydrated obligations through the %s explicit-path branch", (_branch, targetPath) => {
    const resolution = resolveExplicitTarget(targetPath);

    expect(resolution.status).toBe("RESOLVED");
    expect(resolution.resolvedTarget?.resolutionSource).toBe("EXPLICIT_PATH");
    expect(resolution.resolvedTarget?.candidatePaths).toEqual([target]);
    const obligations = resolution.resolvedTarget?.actionObligations;
    expect(obligations).toBeDefined();
    expect(obligationShape(obligations ?? [])).toEqual(expectedObligations);
    expect(obligations?.every((obligation) => obligation.evidenceIds.length > 0)).toBe(true);
  });

  test("real resolver obligations drive reverse-import MODIFY proofs and fail-closed DELETE closure", () => {
    const resolution = resolveExplicitTarget();
    const obligations = resolution.resolvedTarget?.actionObligations;
    if (!resolution.resolvedTarget || !obligations) {
      throw new Error("explicit-path resolution must return hydrated action obligations");
    }

    const intent = createIntent();
    intent.resolvedTarget = resolution.resolvedTarget;

    for (const importer of [pageImporter, bannerImporter]) {
      const proof = TaskRootedAuthorizationVerifier.derive(evidenceStore, intent, importer, "modify");
      expect(proof).not.toBeNull();
      const edgeEvidence = evidenceStore.validateEvidenceIds([...(proof?.edgeEvidenceIds ?? [])]).evidence;
      expect(edgeEvidence).toHaveLength(1);
      expect(edgeEvidence[0]).toMatchObject({
        kind: "IMPORT",
        sourceFile: importer,
        filePath: target,
      });
      expect(evidenceStore.isAuthorityEligible(edgeEvidence[0])).toBe(true);
    }

    const proposedChanges = proposedFrom(obligations);
    const authorized = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec: intent,
      proposedChanges,
      evidenceStore,
      existingFiles: repositoryFiles(),
      targetRepositoryId: "repo",
      workspaceRoot: root,
      stageId: "explicit-cleanup",
      runId: "explicit-cleanup-run",
    });

    expect([...authorized.approvedPaths].sort()).toEqual([pageImporter, target, bannerImporter].sort());
    expect(authorized.rejectedPaths).toEqual([]);

    const withoutBannerCleanup = EvidenceBoundWriteSetResolver.resolve({
      policy,
      intentSpec: intent,
      proposedChanges: proposedChanges.filter((change) => change.path !== bannerImporter),
      evidenceStore,
      existingFiles: repositoryFiles(),
      targetRepositoryId: "repo",
      workspaceRoot: root,
      stageId: "explicit-cleanup-missing-importer",
      runId: "explicit-cleanup-run",
    });
    expect(withoutBannerCleanup.approvedPaths).not.toContain(target);
    expect(withoutBannerCleanup.rejectedPaths.find((item) => item.path === target)?.reason).toContain(
      "REJECT_DEPENDENCY",
    );
  });

  test("unrelated, unauthenticated, stale, transitive, and caller-invented reverse paths remain rejected", () => {
    write("components/random-panel.tsx", "export const RandomPanel = () => null;");
    write("components/semantic-neighbor.tsx", "export const SemanticNeighbor = () => null;");
    write("components/repo-read-only.tsx", "export const RepoReadOnly = () => null;");
    write("components/other-component.tsx", "export const OtherComponent = () => null;");
    write(
      "components/other-importer.tsx",
      "import { OtherComponent } from './other-component'; export const OtherImporter = OtherComponent;",
    );
    write("components/model-invented.tsx", "export const ModelInvented = () => null;");
    write(
      "components/outside-closure.tsx",
      "import { OtherComponent } from './other-component'; export const OutsideClosure = OtherComponent;",
    );

    evidenceStore.observeRepository({ kind: "FILE", filePath: "components/repo-read-only.tsx", provenance: "REPO_READ" });
    evidenceStore.addEvidence({
      kind: "FILE",
      filePath: "components/semantic-neighbor.tsx",
      provenance: "SEMANTIC_SEARCH",
      metadata: { relevanceScore: 1 },
    });
    evidenceStore.addEvidence({
      kind: "IMPORT",
      sourceFile: "components/repo-read-only.tsx",
      filePath: target,
      provenance: "REPO_READ",
    });

    const resolution = resolveExplicitTarget();
    const intent = createIntent();
    intent.resolvedTarget = resolution.resolvedTarget;
    const obligationPaths = new Set(resolution.resolvedTarget?.actionObligations?.map((item) => item.path));

    // A + F: a path absent from the resolver-issued closure has no reverse-cleanup authority.
    expect(obligationPaths.has("components/random-panel.tsx")).toBe(false);
    expect(TaskRootedAuthorizationVerifier.derive(evidenceStore, intent, "components/random-panel.tsx", "modify")).toBeNull();

    // B: semantic proximity is advisory only.
    expect(TaskRootedAuthorizationVerifier.derive(evidenceStore, intent, "components/semantic-neighbor.tsx", "modify")).toBeNull();

    // C: REPO_READ and caller-shaped IMPORT data without an authenticated current edge are insufficient.
    expect(TaskRootedAuthorizationVerifier.derive(evidenceStore, intent, "components/repo-read-only.tsx", "modify")).toBeNull();

    // D: an edge hydrated at an older revision does not survive removal from current repository bytes.
    write("components/stale-importer.tsx", "import { LegacyBadge } from './legacy-badge'; export const Stale = LegacyBadge;");
    expect(resolveExplicitTarget().resolvedTarget?.actionObligations?.some((item) => item.path === "components/stale-importer.tsx")).toBe(true);
    write("components/stale-importer.tsx", "export const Stale = () => null;");
    expect(TaskRootedAuthorizationVerifier.derive(evidenceStore, intent, "components/stale-importer.tsx", "modify")).toBeNull();

    // E + J: importing another component does not join the explicit target's reverse closure.
    for (const importer of ["components/other-importer.tsx", "components/outside-closure.tsx"]) {
      expect(TaskRootedAuthorizationVerifier.derive(evidenceStore, intent, importer, "modify")).toBeNull();
    }

    // G: caller-invented cleanup data with the wrong required action is ignored by independent re-resolution.
    const malformedIntent = createIntent();
    if (!resolution.resolvedTarget) throw new Error("expected explicit resolved target");
    malformedIntent.resolvedTarget = {
      ...resolution.resolvedTarget,
      actionObligations: [
        ...(resolution.resolvedTarget.actionObligations ?? []),
        {
          path: "components/random-panel.tsx",
          role: "DEPENDENCY_CLEANUP",
          requiredAction: "delete",
          evidenceIds: [],
        },
      ],
    };
    expect(TaskRootedAuthorizationVerifier.derive(evidenceStore, malformedIntent, "components/random-panel.tsx", "modify")).toBeNull();

    // H: only the direct importer is in scope; its importer receives no transitive reverse authority.
    write("components/direct-bridge.tsx", "import { LegacyBadge } from './legacy-badge'; export const Bridge = LegacyBadge;");
    write("components/transitive-importer.tsx", "import { Bridge } from './direct-bridge'; export const Transitive = Bridge;");
    const transitiveResolution = resolveExplicitTarget();
    expect(transitiveResolution.resolvedTarget?.actionObligations?.some((item) => item.path === "components/direct-bridge.tsx")).toBe(true);
    expect(transitiveResolution.resolvedTarget?.actionObligations?.some((item) => item.path === "components/transitive-importer.tsx")).toBe(false);
    expect(TaskRootedAuthorizationVerifier.derive(evidenceStore, intent, "components/transitive-importer.tsx", "modify")).toBeNull();

    // I: a model-invented cleanup candidate remains unrelated even when the file exists.
    expect(TaskRootedAuthorizationVerifier.derive(evidenceStore, intent, "components/model-invented.tsx", "modify")).toBeNull();
  });
});
