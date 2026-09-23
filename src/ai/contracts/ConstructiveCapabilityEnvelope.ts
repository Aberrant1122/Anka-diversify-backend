import path from "path";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import {
  trustedStageAuthorizationClause,
  trustedStageAuthorizationId,
  trustedUserRequest,
} from "../repository/TrustedTaskContext";
import { UserAuthorizedClause, UserClauseExtractor, singularizeWord } from "./UserClauseAuthority";
import { TargetPathExtractor } from "./TargetPathExtractor";

export type ConstructiveCandidateRole = "ROUTE" | "COMPONENT" | "MODULE";

export interface ConstructiveRegionFact {
  readonly role: ConstructiveCandidateRole;
  readonly root: string;
  readonly integrationSurface: string;
  readonly allowedExtensions: readonly string[];
  readonly terminalNames?: readonly string[];
  readonly maxRelativeDepth: number;
}

export interface ConstructiveArchitectureFacts {
  readonly sourceRoots: readonly string[];
  readonly integrationSurfaces: readonly string[];
  readonly routeConventions: readonly ConstructiveRegionFact[];
  readonly componentRegions: readonly ConstructiveRegionFact[];
  readonly moduleRegions: readonly ConstructiveRegionFact[];
  readonly forbiddenRegions: readonly string[];
}

export interface ConstructiveArchitectureSummary {
  readonly framework: string;
  readonly constructiveFacts?: ConstructiveArchitectureFacts;
}

export interface ConstructiveCapabilityEnvelope {
  readonly directWriteAuthority: 0;
  readonly stageId: string;
  readonly repositoryRevision: string;
  readonly userClauseId: string;
  readonly workspaceRoot: string;
  readonly framework: string;
  readonly facts: ConstructiveArchitectureFacts;
}

export interface ConstructiveCandidateRelation {
  readonly candidatePath: string;
  readonly role: ConstructiveCandidateRole;
  readonly workspaceRoot: string;
  readonly architectureRoot: string;
  readonly integrationSurface: string;
  readonly repositoryRevision: string;
  readonly stageId: string;
  readonly userClauseId: string;
  readonly semanticTokens: readonly string[];
}

const ROLE_STRUCTURAL_TOKENS: Readonly<Record<ConstructiveCandidateRole, ReadonlySet<string>>> = {
  ROUTE: new Set(["route", "page", "endpoint", "api", "index"]),
  COMPONENT: new Set(["component", "widget", "panel", "view", "screen", "modal", "card", "item", "list", "container", "element", "wrapper", "header", "footer", "button", "bar", "dialog", "drawer", "table", "row", "form", "input", "box", "banner", "dashboard"]),
  MODULE: new Set(["module", "route", "endpoint", "api", "controller"]),
};

function authenticatedCreateClause(intent: TaskIntentSpec): UserAuthorizedClause | undefined {
  const alreadyBound = trustedStageAuthorizationClause(intent);
  if (alreadyBound) return alreadyBound.operation === "CREATE" && alreadyBound.entityTokens.length > 0
    ? alreadyBound
    : undefined;

  const request = trustedUserRequest(intent);
  if (!request) return undefined;
  const clauses = UserClauseExtractor.extractClauses(request);
  if (clauses.length === 1) {
    return clauses[0].operation === "CREATE" && clauses[0].entityTokens.length > 0
      ? clauses[0]
      : undefined;
  }
  const binding = UserClauseExtractor.bindStageToClause({
    taskType: intent.taskType,
    goal: intent.goal,
    name: intent.goal,
    targetPath: intent.explicitUserPaths[0],
  }, clauses);
  return binding.clause?.operation === "CREATE" && binding.clause.entityTokens.length > 0
    ? binding.clause
    : undefined;
}

export function authenticatedConstructiveClause(intent: TaskIntentSpec): UserAuthorizedClause | undefined {
  return authenticatedCreateClause(intent);
}

export class ConstructiveCapabilityEnvelopeBuilder {
  public static build(input: {
    readonly intentSpec: TaskIntentSpec;
    readonly workspaceRoot: string;
    readonly repositoryRevision: string;
    readonly architecture: ConstructiveArchitectureSummary;
  }): ConstructiveCapabilityEnvelope | null {
    const clause = authenticatedCreateClause(input.intentSpec);
    const stageId = trustedStageAuthorizationId(input.intentSpec);
    if (!clause || !stageId || !input.workspaceRoot || !input.repositoryRevision) return null;
    const facts = input.architecture.constructiveFacts;
    if (!facts || facts.integrationSurfaces.length === 0) return null;

    return Object.freeze({
      directWriteAuthority: 0 as const,
      stageId,
      repositoryRevision: input.repositoryRevision,
      userClauseId: clause.id,
      workspaceRoot: path.resolve(input.workspaceRoot),
      framework: input.architecture.framework,
      facts,
    });
  }
}

function relativeCandidate(region: ConstructiveRegionFact, candidatePath: string): string | null {
  const root = normalizeRepoPath(region.root).replace(/\/$/, "");
  const candidate = normalizeRepoPath(candidatePath);
  if (!candidate || candidate.startsWith("../") || path.isAbsolute(candidatePath)) return null;
  if (root && candidate !== root && !candidate.startsWith(`${root}/`)) return null;
  const relative = root ? candidate.slice(root.length).replace(/^\//, "") : candidate;
  if (!relative || relative.split("/").length > region.maxRelativeDepth) return null;
  return relative;
}

function relationForRegion(
  envelope: ConstructiveCapabilityEnvelope,
  region: ConstructiveRegionFact,
  candidatePath: string,
): ConstructiveCandidateRelation | null {
  const relative = relativeCandidate(region, candidatePath);
  if (!relative) return null;
  const basename = path.posix.basename(relative);
  const extension = basename.match(/(\.module\.css|\.[^.]+)$/i)?.[1]?.toLowerCase() ?? "";
  if (!region.allowedExtensions.includes(extension)) return null;
  const stem = basename.slice(0, -extension.length);
  if (region.terminalNames && !region.terminalNames.includes(stem.toLowerCase())) return null;

  const relativeParts = relative.split("/");
  const semanticParts = region.terminalNames
    ? relativeParts.slice(0, -1)
    : [...relativeParts.slice(0, -1), stem];
  const structuralTokens = ROLE_STRUCTURAL_TOKENS[region.role];
  let semanticTokens = semanticParts
    .flatMap((part) => TargetPathExtractor.tokenizeEntity(part).map(singularizeWord))
    .filter((token) => !structuralTokens.has(token));
  if (semanticTokens.length === 0) {
    semanticTokens = TargetPathExtractor.tokenizeEntity(stem).map(singularizeWord);
  }
  if (semanticTokens.length === 0) return null;

  return Object.freeze({
    candidatePath: normalizeRepoPath(candidatePath),
    role: region.role,
    workspaceRoot: envelope.workspaceRoot,
    architectureRoot: normalizeRepoPath(region.root),
    integrationSurface: normalizeRepoPath(region.integrationSurface),
    repositoryRevision: envelope.repositoryRevision,
    stageId: envelope.stageId,
    userClauseId: envelope.userClauseId,
    semanticTokens: Object.freeze(semanticTokens),
  });
}

export function deriveConstructiveCandidateRelation(
  envelope: ConstructiveCapabilityEnvelope,
  candidatePath: string,
): ConstructiveCandidateRelation | null {
  const regions = [
    ...envelope.facts.routeConventions,
    ...envelope.facts.componentRegions,
    ...envelope.facts.moduleRegions,
  ];
  for (const region of regions) {
    const relation = relationForRegion(envelope, region, candidatePath);
    if (relation) return relation;
  }
  return null;
}

export function candidateFitsAuthenticatedClause(
  intent: TaskIntentSpec,
  relation: ConstructiveCandidateRelation,
): boolean {
  const clause = authenticatedCreateClause(intent);
  if (!clause || clause.id !== relation.userClauseId) return false;
  if (intent.explicitUserPaths.map(normalizeRepoPath).includes(relation.candidatePath)) return true;
  const clauseTokens = new Set(clause.entityTokens.map(singularizeWord));
  return relation.semanticTokens.length > 0 && relation.semanticTokens.every((token) => clauseTokens.has(token));
}
