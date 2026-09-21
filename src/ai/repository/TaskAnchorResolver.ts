import { authoritySnapshot, withAuthoritySnapshot } from "./AuthorityWorktree";
import { trustedUserRequest, trustedStageAuthorizationContext } from "./TrustedTaskContext";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "./RepositoryEvidenceStore";
import { RepositoryObservationTools } from "./RepositoryObservation";
import { describeFrameworkRoute, selectFrameworkRoutes, supportsStaticRouteDiscovery } from "./FrameworkRouteMatcher";
import { isExistingPrimaryUIRefinement, detectPrimaryActiveEntryPoint } from "../planning/RepositoryArchitectureDetector";
import { discoverStaticApiRegistrations, isApiArchitectureTask, routeResourceTokens, taskWordTokens, testExercisesRoute } from "./StaticApiArchitecture";

export interface ResolvedRuntimeRouteAnchor {
  readonly runtimeRoute: string;
  readonly routePattern: string;
  readonly filePath: string;
}

export interface TaskAnchorResolution {
  readonly anchors: readonly ResolvedRuntimeRouteAnchor[];
  readonly uiAnchors: readonly string[];
  readonly apiAnchors: readonly string[];
  readonly testAnchors: readonly string[];
  readonly ambiguousRoutes: readonly string[];
  readonly ambiguousApiResources: readonly string[];
}

function taskText(intentSpec: TaskIntentSpec): string {
  return trustedStageAuthorizationContext(intentSpec) ?? trustedUserRequest(intentSpec) ?? "";
}

export function isConstructiveFeatureRequest(intentSpec: TaskIntentSpec): boolean {
  if (intentSpec.destructive) return false;
  if (
    intentSpec.taskType === "BUG_FIX" ||
    intentSpec.taskType === "REFACTOR" ||
    intentSpec.taskType === "DELETE_FILE" ||
    intentSpec.taskType === "DELETE_FOLDER"
  ) {
    return false;
  }
  const stageContext = trustedStageAuthorizationContext(intentSpec);
  const userRequest = trustedUserRequest(intentSpec);
  const request = stageContext ?? userRequest;
  if (!request) return false;

  if (isExistingPrimaryUIRefinement(request)) return false;

  const text = `${userRequest || ""} ${stageContext || ""} ${intentSpec.goal || ""}`;
  const hasConstructiveKeywords = /\b(add|create|implement|build|introduce|new)\b.*\b(list|task|component|widget|page|view|panel|modal|item|element|screen|profile|cart|dashboard)\b/i.test(text);

  return hasConstructiveKeywords;
}

export class TaskAnchorResolver {
  private static resolveUniqueUiCompositionRoot(
    intentSpec: TaskIntentSpec,
    files: ReadonlyMap<string, string>,
  ): string | null {
    const isUi = isExistingPrimaryUIRefinement(trustedUserRequest(intentSpec) ?? "") || isExistingPrimaryUIRefinement(trustedStageAuthorizationContext(intentSpec) ?? "");
    if (intentSpec.destructive || !isUi) return null;

    const bootstrapPattern = /^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/)?(?:main|index)\.[cm]?[jt]sx?$/i;
    const mountPattern = /(?:\bcreateRoot\s*\(|\bReactDOM\.render\s*\(|\bcreateApp\s*\([^)]*\)\.mount\s*\(|\bnew\s+Vue\s*\()/;
    const candidates = [...files.entries()]
      .filter(([filePath, encoded]) => {
        if (!bootstrapPattern.test(filePath)) return false;
        const source = Buffer.from(encoded, "base64").toString("utf8");
        return mountPattern.test(source);
      })
      .map(([filePath]) => filePath);

    return candidates.length === 1 ? candidates[0] : null;
  }

  public static extractRuntimeRouteHints(intentSpec: TaskIntentSpec): string[] {
    const matches = taskText(intentSpec).match(/(?:https?:\/\/[^\s"'`<>]+|(?<![\w./\\])\/[^\s"'`<>]*)/g) || [];
    const hints = new Set<string>();
    for (const raw of matches) {
      const trimmed = raw.replace(/[),.;]+$/, "");
      try {
        const pathname = /^https?:\/\//.test(trimmed) ? new URL(trimmed).pathname : trimmed.split(/[?#]/, 1)[0];
        if (pathname.startsWith("/")) hints.add(pathname || "/");
      } catch {
        // Invalid URLs are advisory text, not route anchors.
      }
    }
    return [...hints];
  }

  public static resolve(input: {
    readonly intentSpec: TaskIntentSpec;
    readonly repositoryFiles: readonly string[];
    readonly repositoryId: string;
    readonly workspaceRoot?: string;
    readonly evidenceStore: RepositoryEvidenceStore;
  }): TaskAnchorResolution {
    if (!input.workspaceRoot || !input.evidenceStore.getCanonicalWorkspaceRoot()) return { anchors: [], uiAnchors: [], apiAnchors: [], testAnchors: [], ambiguousRoutes: [], ambiguousApiResources: [] };
    return withAuthoritySnapshot(input.workspaceRoot, () => this.resolveBatch(input));
  }

  private static resolveBatch(input: Parameters<typeof TaskAnchorResolver.resolve>[0]): TaskAnchorResolution {
    if (!input.workspaceRoot || !input.evidenceStore.getCanonicalWorkspaceRoot()) return { anchors: [], uiAnchors: [], apiAnchors: [], testAnchors: [], ambiguousRoutes: [], ambiguousApiResources: [] };
    const snapshot = authoritySnapshot(input.workspaceRoot);
    const files = snapshot.files;
    if (snapshot.hasUnsupportedLinks) return { anchors: [], uiAnchors: [], apiAnchors: [], testAnchors: [], ambiguousRoutes: this.extractRuntimeRouteHints(input.intentSpec), ambiguousApiResources: [] };
    const descriptors = [...files.keys()].map(describeFrameworkRoute).filter((value): value is NonNullable<typeof value> => value !== null);
    const anchors: ResolvedRuntimeRouteAnchor[] = [];
    const uiAnchors: string[] = [];
    const apiAnchors: string[] = [];
    const testAnchors: string[] = [];
    const ambiguousRoutes: string[] = [];
    const ambiguousApiResources: string[] = [];

    const filesToCheck = input.repositoryFiles && input.repositoryFiles.length > 0
      ? input.repositoryFiles.filter((f) => files.has(f))
      : [...files.keys()];

    const uiCompositionRoot = this.resolveUniqueUiCompositionRoot(input.intentSpec, files);
    if (uiCompositionRoot && filesToCheck.includes(uiCompositionRoot)) {
      const receipt = RepositoryObservationTools.observeUiCompositionAnchor(
        input.repositoryId,
        input.workspaceRoot,
        uiCompositionRoot,
      );
      if (receipt && input.evidenceStore.recordObservation(receipt)) uiAnchors.push(uiCompositionRoot);
    } else if (isConstructiveFeatureRequest(input.intentSpec)) {
      const detectedEntryPoint = detectPrimaryActiveEntryPoint(filesToCheck);
      if (detectedEntryPoint && files.has(detectedEntryPoint)) {
        const receipt = RepositoryObservationTools.observeUiCompositionAnchor(
          input.repositoryId,
          input.workspaceRoot,
          detectedEntryPoint,
        );
        if (receipt && input.evidenceStore.recordObservation(receipt)) uiAnchors.push(detectedEntryPoint);
      }
    }

    for (const runtimeRoute of supportsStaticRouteDiscovery(files) ? this.extractRuntimeRouteHints(input.intentSpec) : []) {
      const matches = selectFrameworkRoutes(descriptors, runtimeRoute);
      if (matches.length !== 1) {
        if (matches.length > 1) ambiguousRoutes.push(runtimeRoute);
        continue;
      }
      const match = matches[0];
      const receipt = RepositoryObservationTools.observeRuntimeRouteAnchor(
        input.repositoryId,
        input.workspaceRoot,
        match.filePath,
        runtimeRoute,
      );
      if (!receipt) continue;
      const evidence = input.evidenceStore.recordObservation(receipt);
      if (!evidence) continue;
      anchors.push({ runtimeRoute, routePattern: match.routePattern, filePath: match.filePath });
    }

    const request = taskText(input.intentSpec);
    if (!input.intentSpec.destructive && isApiArchitectureTask(request)) {
      const taskTokens = taskWordTokens(request);
      const scored = discoverStaticApiRegistrations(input.workspaceRoot).map((registration) => ({
        registration,
        score: routeResourceTokens(registration.routePrefix).filter((token) => taskTokens.has(token)).length,
      })).filter((candidate) => candidate.score > 0);
      const bestScore = Math.max(0, ...scored.map((candidate) => candidate.score));
      const matching = scored.filter((candidate) => candidate.score === bestScore).map((candidate) => candidate.registration);
      const routeFiles = [...new Set(matching.map((registration) => registration.routeFile))];
      if (routeFiles.length === 1) {
        const selected = matching.find((registration) => registration.routeFile === routeFiles[0])!;
        const receipt = RepositoryObservationTools.observeApiRouteAnchor(
          input.repositoryId, input.workspaceRoot, selected.registrationFile, selected.routeFile, selected.routePrefix,
        );
        if (receipt && input.evidenceStore.recordObservation(receipt)) {
          apiAnchors.push(selected.routeFile);
          for (const [filePath, encoded] of files) {
            if (!/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(filePath)) continue;
            const source = Buffer.from(encoded, "base64").toString("utf8");
            if (!testExercisesRoute(source, selected.routePrefix)) continue;
            const testReceipt = RepositoryObservationTools.observeApiTestAnchor(input.repositoryId, input.workspaceRoot, filePath, selected.routePrefix);
            if (testReceipt && input.evidenceStore.recordObservation(testReceipt)) testAnchors.push(filePath);
          }
        }
      } else if (routeFiles.length > 1) {
        ambiguousApiResources.push(...[...new Set(matching.flatMap((registration) => routeResourceTokens(registration.routePrefix).filter((token) => taskTokens.has(token))))]);
      }
    }

    return { anchors, uiAnchors, apiAnchors, testAnchors, ambiguousRoutes, ambiguousApiResources };
  }
}
