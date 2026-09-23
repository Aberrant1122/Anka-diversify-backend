import crypto from "crypto";
import path from "path";
import type {
  FileManifest,
  ProspectiveEdgeRelation,
  ProspectiveFeatureGraphProposal,
  ProspectiveNodeRole,
  ValidationError,
  VerifiedProspectiveFeatureGraph,
} from "../../types";
import { describeFrameworkRoute } from "../repository/FrameworkRouteMatcher";
import type { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import type { RepositoryArchitectureSummary } from "./RepositoryArchitectureDetector";
import {
  ManifestDependencyConfigurationFile,
  ManifestDependencyResolver,
} from "./ManifestDependencyResolver";

export type GraphRepairDisposition =
  | "LOCAL_CORRECTION"
  | "FRESH_MANIFEST"
  | "FRESH_AUTHORIZATION"
  | "FULL_STAGE_REINVESTIGATION";

export interface ProspectiveGraphContext {
  stageId: string;
  userClauseId: string;
  workspaceRoot: string;
  repositoryRevision: string;
  existingFiles: readonly string[];
  architecture: RepositoryArchitectureSummary;
  installedPackages?: readonly string[];
  configurationFiles?: ManifestDependencyConfigurationFile[];
  monorepo?: MonorepoDescriptor | null;
}

export interface ProspectiveGraphResult {
  valid: boolean;
  errors: ValidationError[];
  graph?: VerifiedProspectiveFeatureGraph;
  disposition?: GraphRepairDisposition;
}

const ROLES = new Set<ProspectiveNodeRole>([
  "ROUTE", "COMPONENT", "CHILD_COMPONENT", "MODULE", "EXISTING_DEPENDENCY", "INTEGRATION_ROOT",
]);
const RELATIONS = new Set<ProspectiveEdgeRelation>([
  "RENDERS", "IMPORTS", "DEPENDS_ON", "REGISTERS", "ROUTES_TO",
]);
const SPECIFIER_RELATIONS = new Set<ProspectiveEdgeRelation>(["IMPORTS", "DEPENDS_ON", "RENDERS", "REGISTERS"]);

function normalizePath(value: string): string | null {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) return null;
  const slash = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (slash.startsWith("/") || /^[A-Za-z]:\//.test(slash)) return null;
  const segments = slash.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  const normalized = path.posix.normalize(slash);
  return normalized === slash ? normalized : null;
}

function graphError(message: string, paths: string[] = []): ValidationError {
  return {
    type: "prospective-topology",
    affectedFiles: paths,
    message,
    suggestion: "Produce a coherent typed topology using only current-revision repository identities and already-declared candidates.",
  };
}

function canonicalNodeId(input: {
  workspaceRoot: string;
  repositoryRevision: string;
  path: string;
  kind: string;
  role: string;
}): string {
  return `node:${crypto.createHash("sha256").update([
    input.workspaceRoot.replace(/\\/g, "/").toLowerCase(),
    input.repositoryRevision,
    input.path.toLowerCase(),
    input.kind,
    input.role,
  ].join("\0")).digest("hex")}`;
}

function isRoleCompatible(
  role: ProspectiveNodeRole,
  filePath: string,
  architecture: RepositoryArchitectureSummary,
): boolean {
  if (role === "ROUTE") {
    const route = describeFrameworkRoute(filePath);
    if (!route || architecture.framework !== "NEXT_JS" || architecture.router === "HYBRID" || architecture.router === "NONE") return false;
    return architecture.router === "APP_ROUTER"
      ? route.framework === "NEXT_APP_ROUTER"
      : route.framework === "NEXT_PAGES_ROUTER";
  }
  if (role === "COMPONENT" || role === "CHILD_COMPONENT") return /\.(?:tsx|jsx|vue|svelte)$/i.test(filePath);
  if (role === "EXISTING_DEPENDENCY") return true;
  if (role === "INTEGRATION_ROOT") {
    const normalized = filePath.toLowerCase();
    return architecture.existingEntryPoints.some((entry) => entry.replace(/\\/g, "/").toLowerCase() === normalized) ||
      architecture.primaryActiveEntryPoint?.replace(/\\/g, "/").toLowerCase() === normalized;
  }
  return /\.(?:[cm]?[jt]sx?|json|css|scss)$/i.test(filePath);
}

function fingerprint(graph: Omit<VerifiedProspectiveFeatureGraph, "fingerprint">): string {
  const nodes = [...graph.nodes]
    .map((node) => `${node.kind}:${node.role}:${node.action || "reference"}:${node.path}:${node.symbol || ""}`)
    .sort();
  const byId = new Map(graph.nodes.map((node) => [node.id, node.path]));
  const edges = [...graph.edges]
    .map((edge) => `${byId.get(edge.sourceId)}:${edge.relation}:${edge.canonicalTargetPath}:${edge.canonicalSpecifier || ""}`)
    .sort();
  const roots = graph.featureRoots.map((id) => byId.get(id) || id).sort();
  return crypto.createHash("sha256").update(JSON.stringify({
    stageId: graph.stageId,
    repositoryRevision: graph.repositoryRevision,
    nodes,
    edges,
    roots,
  })).digest("hex");
}

function validateConnectivity(graph: VerifiedProspectiveFeatureGraph): ValidationError[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const reachable = new Set(graph.featureRoots);
  const queue = [...graph.featureRoots];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const edge of graph.edges) {
      if (edge.sourceId !== source || reachable.has(edge.targetId)) continue;
      reachable.add(edge.targetId);
      queue.push(edge.targetId);
    }
  }
  return graph.nodes
    .filter((node) => node.kind === "PROSPECTIVE" && !reachable.has(node.id))
    .map((node) => graphError(`Prospective supporting node '${node.path}' is disconnected from every verified feature root.`, [node.path]));
}

/** Canonicalizes an authority-zero model proposal against current repository facts. */
export function canonicalizeProspectiveFeatureGraph(
  proposal: ProspectiveFeatureGraphProposal,
  manifest: Pick<FileManifest, "files">,
  context: ProspectiveGraphContext,
): ProspectiveGraphResult {
  const errors: ValidationError[] = [];
  if (!proposal || !Array.isArray(proposal.nodes) || !Array.isArray(proposal.edges) || !Array.isArray(proposal.featureRoots)) {
    return { valid: false, errors: [graphError("Prospective topology has an invalid envelope.")], disposition: "FRESH_MANIFEST" };
  }
  if (!context.stageId || !context.userClauseId || !context.workspaceRoot || !context.repositoryRevision) {
    return { valid: false, errors: [graphError("Prospective topology is missing a trusted stage, clause, workspace, or revision binding.")], disposition: "FULL_STAGE_REINVESTIGATION" };
  }

  const existing = new Map(context.existingFiles.map((file) => [file.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(), file.replace(/\\/g, "/").replace(/^\.\//, "")]));
  const planned = new Map(manifest.files.map((file) => [file.path.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(), file]));
  const temporary = new Map<string, VerifiedProspectiveFeatureGraph["nodes"][number]>();
  const canonicalIds = new Set<string>();

  for (const node of proposal.nodes) {
    const normalized = normalizePath(node?.path);
    if (!node || typeof node.temporaryId !== "string" || !node.temporaryId || temporary.has(node.temporaryId) || !normalized || !ROLES.has(node.role) || !["PROSPECTIVE", "EXISTING"].includes(node.kind)) {
      errors.push(graphError("Prospective topology contains an invalid or duplicate node.", normalized ? [normalized] : []));
      continue;
    }
    const current = existing.get(normalized.toLowerCase());
    const declaration = planned.get(normalized.toLowerCase());
    if (node.kind === "PROSPECTIVE" && (current || !declaration || declaration.action !== "create")) {
      errors.push(graphError(`Prospective node '${normalized}' is not an absent declared CREATE candidate.`, [normalized]));
      continue;
    }
    if (node.kind === "EXISTING" && !current) {
      errors.push(graphError(`Existing graph node '${normalized}' does not exist in the current repository revision.`, [normalized]));
      continue;
    }
    if (!isRoleCompatible(node.role, normalized, context.architecture)) {
      errors.push(graphError(`Role '${node.role}' is incompatible with '${normalized}' and the detected repository architecture.`, [normalized]));
      continue;
    }
    const id = canonicalNodeId({ ...context, path: normalized, kind: node.kind, role: node.role });
    if (canonicalIds.has(id)) {
      errors.push(graphError(`Multiple model nodes collapse to the same canonical identity for '${normalized}'.`, [normalized]));
      continue;
    }
    canonicalIds.add(id);
    temporary.set(node.temporaryId, {
      id,
      path: current || normalized,
      kind: node.kind,
      role: node.role,
      ...(declaration ? { action: declaration.action } : {}),
      // Existing exported symbols require a repository export index proof.
      // Until that proof is supplied, keep only the exact canonical file identity.
      ...(node.kind === "PROSPECTIVE" && typeof node.symbol === "string" && node.symbol.trim()
        ? { symbol: node.symbol.trim() }
        : {}),
    });
  }

  const resolver = new ManifestDependencyResolver({
    existingFiles: context.existingFiles,
    manifestFiles: manifest.files.map((file) => file.path),
    installedPackages: context.installedPackages || context.architecture.installedPackages,
    configurationFiles: context.configurationFiles,
    monorepo: context.monorepo,
  });
  const edges: VerifiedProspectiveFeatureGraph["edges"] = [];
  const edgeKeys = new Set<string>();
  for (const edge of proposal.edges) {
    const source = temporary.get(edge?.sourceId);
    const target = temporary.get(edge?.targetId);
    if (!edge || !source || !target || !RELATIONS.has(edge.relation)) {
      errors.push(graphError("Prospective topology edge references an unknown endpoint or relation."));
      continue;
    }
    const key = `${source.id}:${edge.relation}:${target.id}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    let canonicalSpecifier: string | undefined;
    if (SPECIFIER_RELATIONS.has(edge.relation)) {
      canonicalSpecifier = resolver.canonicalSpecifierFor(source.path, target.path) || undefined;
      if (!canonicalSpecifier) {
        errors.push(graphError(`No deterministic module specifier exists from '${source.path}' to '${target.path}'.`, [source.path, target.path]));
        continue;
      }
    }
    edges.push({
      sourceId: source.id,
      targetId: target.id,
      relation: edge.relation,
      canonicalTargetPath: target.path,
      ...(canonicalSpecifier ? { canonicalSpecifier } : {}),
    });
  }

  const roots: string[] = [];
  for (const temporaryId of proposal.featureRoots) {
    const node = temporary.get(temporaryId);
    if (!node) {
      errors.push(graphError(`Feature root '${temporaryId}' does not reference a known node.`));
      continue;
    }
    const validRoot = node.role === "INTEGRATION_ROOT" || (node.role === "ROUTE" && Boolean(describeFrameworkRoute(node.path)));
    if (!validRoot) {
      errors.push(graphError(`Node '${node.path}' is not a deterministic feature root.`, [node.path]));
      continue;
    }
    roots.push(node.id);
  }
  if (roots.length === 0) errors.push(graphError("Prospective topology has no deterministic feature root."));

  if (errors.length > 0) return { valid: false, errors, disposition: "FRESH_MANIFEST" };
  const withoutFingerprint: Omit<VerifiedProspectiveFeatureGraph, "fingerprint"> = {
    authority: 0,
    stageId: context.stageId,
    userClauseId: context.userClauseId,
    workspaceRoot: context.workspaceRoot,
    repositoryRevision: context.repositoryRevision,
    nodes: [...temporary.values()].sort((left, right) => left.id.localeCompare(right.id)),
    edges: edges.sort((left, right) => `${left.sourceId}:${left.relation}:${left.targetId}`.localeCompare(`${right.sourceId}:${right.relation}:${right.targetId}`)),
    featureRoots: [...new Set(roots)].sort(),
  };
  const graph: VerifiedProspectiveFeatureGraph = { ...withoutFingerprint, fingerprint: fingerprint(withoutFingerprint) };
  const connectivityErrors = validateConnectivity(graph);
  return connectivityErrors.length > 0
    ? { valid: false, errors: connectivityErrors, disposition: "FRESH_MANIFEST" }
    : { valid: true, errors: [], graph };
}

/** Ensures exact authorization filtering did not leave a dependency-incoherent subset. */
export function closeProspectiveGraphAfterAuthorization(
  graph: VerifiedProspectiveFeatureGraph,
  approvedPaths: readonly string[],
): ProspectiveGraphResult {
  const approved = new Set(approvedPaths.map((value) => value.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase()));
  const rejectedPlannedNodes = graph.nodes.filter((node) => node.action && !approved.has(node.path.toLowerCase()));
  if (rejectedPlannedNodes.length > 0) {
    return {
      valid: false,
      errors: [graphError("Authorization filtering rejected a planned graph node required by the coherent feature.", rejectedPlannedNodes.map((node) => node.path))],
      disposition: "FRESH_AUTHORIZATION",
    };
  }
  const survivingNodes = graph.nodes.filter((node) => node.kind === "EXISTING" || approved.has(node.path.toLowerCase()));
  const survivingIds = new Set(survivingNodes.map((node) => node.id));
  const brokenEdges = graph.edges.filter((edge) => survivingIds.has(edge.sourceId) !== survivingIds.has(edge.targetId));
  if (brokenEdges.length > 0) {
    const paths = brokenEdges.flatMap((edge) => [edge.canonicalTargetPath]);
    return {
      valid: false,
      errors: [graphError("Authorization filtering broke a required prospective topology edge.", paths)],
      disposition: "FRESH_AUTHORIZATION",
    };
  }
  const survivingRoots = graph.featureRoots.filter((id) => survivingIds.has(id));
  const withoutFingerprint: Omit<VerifiedProspectiveFeatureGraph, "fingerprint"> = {
    ...graph,
    nodes: survivingNodes,
    edges: graph.edges.filter((edge) => survivingIds.has(edge.sourceId) && survivingIds.has(edge.targetId)),
    featureRoots: survivingRoots,
  };
  const closed: VerifiedProspectiveFeatureGraph = { ...withoutFingerprint, fingerprint: fingerprint(withoutFingerprint) };
  const errors = validateConnectivity(closed);
  return errors.length > 0 || (closed.nodes.some((node) => node.kind === "PROSPECTIVE") && closed.featureRoots.length === 0)
    ? { valid: false, errors: errors.length > 0 ? errors : [graphError("Authorization filtering removed every feature root.")], disposition: "FRESH_AUTHORIZATION" }
    : { valid: true, errors: [], graph: closed };
}

export function validateProspectiveGraphBinding(
  graph: VerifiedProspectiveFeatureGraph,
  expected: Pick<ProspectiveGraphContext, "stageId" | "userClauseId" | "workspaceRoot" | "repositoryRevision">,
): ProspectiveGraphResult {
  const bindingMatches = graph.authority === 0 &&
    graph.stageId === expected.stageId &&
    graph.userClauseId === expected.userClauseId &&
    path.resolve(graph.workspaceRoot) === path.resolve(expected.workspaceRoot) &&
    graph.repositoryRevision === expected.repositoryRevision;
  return bindingMatches
    ? { valid: true, errors: [], graph }
    : {
        valid: false,
        errors: [graphError("Prospective topology binding is stale or belongs to another stage, clause, workspace, or repository revision.")],
        disposition: "FULL_STAGE_REINVESTIGATION",
      };
}

export function classifyGraphFailure(error: ValidationError): GraphRepairDisposition {
  if (/workspace|revision|architecture/i.test(error.message)) return "FULL_STAGE_REINVESTIGATION";
  if (/authorization/i.test(error.message)) return "FRESH_AUTHORIZATION";
  if (/specifier/i.test(error.message)) return "LOCAL_CORRECTION";
  return "FRESH_MANIFEST";
}
