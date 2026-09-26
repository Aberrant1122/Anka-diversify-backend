import path from "path";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import { NODE_BUILTIN_MODULES } from "./RepositoryArchitectureDetector";

export type ManifestDependencyIntent = "LEGACY" | "REPOSITORY" | "EXTERNAL";

export interface ManifestDependencyCandidate {
  value: string;
  intent: ManifestDependencyIntent;
}

export interface ManifestDependencyConfigurationFile {
  path: string;
  content: string;
}

export interface ManifestDependencyResolverContext {
  existingFiles: Iterable<string>;
  manifestFiles: Iterable<string>;
  installedPackages: Iterable<string>;
  configurationFiles?: ManifestDependencyConfigurationFile[];
  monorepo?: MonorepoDescriptor | null;
}

export type ManifestDependencyResolution =
  | { classification: "REPOSITORY"; value: string; resolvedPath: string; source: "REPOSITORY" | "MANIFEST" | "ALIAS" | "WORKSPACE" }
  | { classification: "EXTERNAL"; value: string; packageName: string; subpath?: string }
  | { classification: "UNRESOLVED_LOCAL"; value: string; reason: string }
  | { classification: "UNRESOLVED"; value: string; reason: string };

interface AliasRule {
  pattern: string;
  targets: string[];
  configDirectory: string;
  baseUrl: string;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function normalizeRepoPath(value: string): string {
  return path.posix.normalize(normalizeSlashes(value).replace(/^\.\//, "")).replace(/^\.\//, "");
}

function isAbsoluteLike(value: string): boolean {
  return value.startsWith("/") || value.startsWith("//") || /^[A-Za-z]:\//.test(value);
}

function isInsideRepository(value: string): boolean {
  return value !== ".." && !value.startsWith("../") && !path.posix.isAbsolute(value);
}

function stripJsonComments(value: string): string {
  let output = "";
  let inString = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    const next = value[index + 1];
    if (lineComment) {
      if (character === "\n" || character === "\r") {
        lineComment = false;
        output += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      } else if (character === "\n" || character === "\r") {
        output += character;
      }
      continue;
    }
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      index++;
    } else if (character === "/" && next === "*") {
      blockComment = true;
      index++;
    } else {
      output += character;
    }
  }
  return output.replace(/,\s*([}\]])/g, "$1");
}

function parseAliasRules(files: ManifestDependencyConfigurationFile[] = []): AliasRule[] {
  const rules: AliasRule[] = [];
  for (const file of files) {
    const configPath = normalizeRepoPath(file.path);
    if (!/(^|\/)(?:tsconfig|jsconfig)(?:\.[^/]*)?\.json$/i.test(configPath)) continue;
    try {
      const parsed = JSON.parse(stripJsonComments(file.content));
      const compilerOptions = parsed?.compilerOptions;
      if (!compilerOptions || typeof compilerOptions !== "object") continue;
      const paths = compilerOptions.paths;
      if (!paths || typeof paths !== "object" || Array.isArray(paths)) continue;
      const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
      for (const [pattern, rawTargets] of Object.entries(paths)) {
        if (!pattern || !Array.isArray(rawTargets)) continue;
        const targets = rawTargets.filter((target): target is string => typeof target === "string" && !!target.trim());
        if (targets.length > 0) {
          rules.push({ pattern, targets, configDirectory: path.posix.dirname(configPath), baseUrl });
        }
      }
    } catch {
      // Invalid repository configuration grants no alias resolution authority.
    }
  }
  return rules;
}

function matchAlias(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf("*");
  if (star < 0) return pattern === specifier ? "" : null;
  if (pattern.indexOf("*", star + 1) >= 0) return null;
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return null;
  return specifier.slice(prefix.length, specifier.length - suffix.length);
}

function substituteAliasTarget(target: string, wildcard: string): string {
  return target.includes("*") ? target.replace("*", wildcard) : target;
}

/**
 * Terminal extensions that JS/TS module resolution appends implicitly. Only
 * these may be omitted from a canonical specifier or inferred while matching;
 * stylesheets, JSON, and other assets keep their exact terminal extension.
 */
const CODE_MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);

function extensionless(value: string): string {
  const slash = value.lastIndexOf("/");
  const dot = value.lastIndexOf(".");
  return dot > slash ? value.slice(0, dot) : value;
}

/** Strips exactly one terminal code-module extension; null for non-code targets. */
function codeModuleIdentity(value: string): string | null {
  const slash = value.lastIndexOf("/");
  const dot = value.lastIndexOf(".");
  if (dot <= slash + 1) return null;
  return CODE_MODULE_EXTENSIONS.has(value.slice(dot).toLowerCase()) ? value.slice(0, dot) : null;
}

/** Projects a repository-relative target path onto its import specifier path. */
function moduleSpecifierPath(value: string): string {
  const identity = codeModuleIdentity(value);
  return identity === null ? value : identity.replace(/\/index$/, "");
}

function uniqueRepositoryMatch(matches: string[]): string | null {
  const identities = new Set(matches.map((file) => file.toLowerCase()));
  return identities.size === 1 ? matches[0] : null;
}

/**
 * Exact identity wins. Otherwise a candidate may only omit one code-module
 * extension (or a code-module /index). The legacy extensionless rule remains a
 * last-resort fallback for dotless candidates. Inferred matches must be unique.
 */
function findRepositoryMatch(candidate: string, files: string[]): string | null {
  const normalized = normalizeRepoPath(candidate).toLowerCase();
  const exact = files.find((file) => file.toLowerCase() === normalized);
  if (exact) return exact;
  if (normalized.endsWith("/")) return null;

  const moduleMatches = files.filter((file) => {
    const identity = codeModuleIdentity(file.toLowerCase());
    return identity !== null && (identity === normalized || identity === `${normalized}/index`);
  });
  if (moduleMatches.length > 0) return uniqueRepositoryMatch(moduleMatches);

  const dotless = extensionless(normalized) === normalized;
  const legacyMatches = files.filter((file) => {
    const fileNoExtension = extensionless(file.toLowerCase());
    return (dotless && fileNoExtension === normalized) || fileNoExtension === `${normalized}/index`;
  });
  return legacyMatches.length > 0 ? uniqueRepositoryMatch(legacyMatches) : null;
}

function hasRepositoryDirectoryPrefix(value: string, files: string[]): boolean {
  const first = value.split("/")[0]?.toLowerCase();
  return !!first && files.some((file) => file.toLowerCase().startsWith(`${first}/`));
}

function externalPackage(value: string, installedPackages: Set<string>): { packageName: string; subpath?: string } | null {
  const clean = value.replace(/^node:/, "");
  if (value.startsWith("node:") || NODE_BUILTIN_MODULES.has(clean)) {
    return { packageName: clean };
  }
  if (clean.startsWith("@")) {
    const match = clean.match(/^(@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*)(?:\/(.+))?$/i);
    return match ? { packageName: match[1], subpath: match[2] || undefined } : null;
  }
  const match = clean.match(/^([a-z0-9][a-z0-9._~-]*)(?:\/(.+))?$/i);
  if (!match) return null;
  if (match[2] && !installedPackages.has(match[1])) return null;
  return { packageName: match[1], subpath: match[2] || undefined };
}

export function normalizeManifestDependencyValue(value: string): string {
  return normalizeSlashes(value).trim();
}

/**
 * Classifies a dependency without granting file-system or mutation authority.
 * Repository, same-manifest, configured-alias, and workspace reality always
 * take precedence over the model-provided intent field.
 */
export class ManifestDependencyResolver {
  private readonly existingFiles: string[];
  private readonly manifestFiles: string[];
  private readonly allRepositoryFiles: string[];
  private readonly installedPackages: Set<string>;
  private readonly aliasRules: AliasRule[];
  private readonly monorepo?: MonorepoDescriptor | null;

  constructor(context: ManifestDependencyResolverContext) {
    this.existingFiles = Array.from(context.existingFiles, normalizeRepoPath);
    this.manifestFiles = Array.from(context.manifestFiles, normalizeRepoPath);
    this.allRepositoryFiles = Array.from(new Set([...this.existingFiles, ...this.manifestFiles]));
    this.installedPackages = new Set(context.installedPackages);
    this.aliasRules = parseAliasRules(context.configurationFiles);
    this.monorepo = context.monorepo;
  }

  public resolve(ownerPath: string, candidate: ManifestDependencyCandidate): ManifestDependencyResolution {
    const value = normalizeManifestDependencyValue(candidate.value);
    if (!value || value.includes("\0")) {
      return { classification: "UNRESOLVED", value, reason: "Dependency is empty or contains a null byte" };
    }
    if (isAbsoluteLike(value)) {
      return { classification: "UNRESOLVED_LOCAL", value, reason: "Absolute dependency paths are outside the repository namespace" };
    }

    const relative = value.startsWith("./") || value.startsWith("../");
    if (relative) {
      const resolved = normalizeRepoPath(path.posix.join(path.posix.dirname(normalizeRepoPath(ownerPath)), value));
      if (!isInsideRepository(resolved)) {
        return { classification: "UNRESOLVED_LOCAL", value, reason: "Relative dependency escapes the repository" };
      }
      return this.resolveRepositoryCandidate(value, resolved, "REPOSITORY", true);
    }
    if (value.split("/").some((segment) => segment === "." || segment === ".." || !segment)) {
      return { classification: "UNRESOLVED_LOCAL", value, reason: "Dependency contains invalid path traversal segments" };
    }

    const direct = findRepositoryMatch(value, this.allRepositoryFiles);
    if (direct) return this.repositoryResult(value, direct);

    // Backwards-compatible exact-only handling for the legacy root marker.
    // It grants no alias expansion: repository/manifest reality must already
    // contain the exact suffix, while unresolved values still fail closed.
    if (value.startsWith("@/")) {
      const legacyRootMatch = findRepositoryMatch(value.slice(2), this.allRepositoryFiles);
      if (legacyRootMatch) return this.repositoryResult(value, legacyRootMatch);
    }

    for (const rule of this.aliasRules) {
      const wildcard = matchAlias(rule.pattern, value);
      if (wildcard === null) continue;
      for (const target of rule.targets) {
        const resolved = normalizeRepoPath(path.posix.join(rule.configDirectory, rule.baseUrl, substituteAliasTarget(target, wildcard)));
        if (!isInsideRepository(resolved)) {
          return { classification: "UNRESOLVED_LOCAL", value, reason: "Configured alias resolves outside the repository" };
        }
        const match = findRepositoryMatch(resolved, this.allRepositoryFiles);
        if (match) return this.repositoryResult(value, match, "ALIAS");
      }
      return { classification: "UNRESOLVED_LOCAL", value, reason: "Configured repository alias did not resolve" };
    }

    const workspace = this.resolveWorkspace(value);
    if (workspace) return workspace;

    const external = externalPackage(value, this.installedPackages);
    if (external) return { classification: "EXTERNAL", value, ...external };

    const pathLike = value.includes("/") && (extensionless(value) !== value || hasRepositoryDirectoryPrefix(value, this.allRepositoryFiles));
    if (pathLike || value.startsWith("@/") || candidate.intent === "REPOSITORY") {
      return { classification: "UNRESOLVED_LOCAL", value, reason: "Repository dependency did not resolve" };
    }
    return { classification: "UNRESOLVED", value, reason: "Dependency is neither a resolvable repository reference nor an unambiguous package specifier" };
  }

  /**
   * Produces a deterministic module specifier for an already-canonical source
   * and target. This is identity projection only; it grants no authority.
   */
  public canonicalSpecifierFor(ownerPath: string, targetPath: string): string | null {
    const owner = normalizeRepoPath(ownerPath);
    const target = findRepositoryMatch(targetPath, this.allRepositoryFiles);
    if (!owner || !target) return null;

    const ownerWorkspace = this.workspaceForPath(owner);
    const targetWorkspace = this.workspaceForPath(target);
    if (ownerWorkspace?.name !== targetWorkspace?.name) {
      if (!ownerWorkspace || !targetWorkspace || !ownerWorkspace.dependencies.has(targetWorkspace.name)) return null;
      let subpath = target.slice(targetWorkspace.relativePath.length).replace(/^\/+/, "");
      subpath = subpath.replace(/^src\//, "");
      subpath = moduleSpecifierPath(subpath);
      const workspaceSpecifier = subpath ? `${targetWorkspace.name}/${subpath}` : targetWorkspace.name;
      const resolved = this.resolve(owner, { value: workspaceSpecifier, intent: "REPOSITORY" });
      return resolved.classification === "REPOSITORY" && resolved.resolvedPath.toLowerCase() === target.toLowerCase()
        ? workspaceSpecifier
        : null;
    }

    let relative = normalizeSlashes(path.posix.relative(path.posix.dirname(owner), target));
    relative = moduleSpecifierPath(relative);
    if (!relative.startsWith(".")) relative = `./${relative}`;
    const resolved = this.resolve(owner, { value: relative, intent: "REPOSITORY" });
    return resolved.classification === "REPOSITORY" && resolved.resolvedPath.toLowerCase() === target.toLowerCase()
      ? relative
      : null;
  }

  private workspaceForPath(filePath: string) {
    if (!this.monorepo?.isMonorepo) return null;
    const normalized = normalizeRepoPath(filePath);
    return [...this.monorepo.workspaces]
      .sort((left, right) => right.relativePath.length - left.relativePath.length)
      .find((workspace) => normalized === workspace.relativePath || normalized.startsWith(`${workspace.relativePath}/`)) || null;
  }

  private resolveRepositoryCandidate(value: string, resolved: string, source: "REPOSITORY" | "ALIAS", knownLocal: boolean): ManifestDependencyResolution {
    const match = findRepositoryMatch(resolved, this.allRepositoryFiles);
    if (match) return this.repositoryResult(value, match, source);
    return knownLocal
      ? { classification: "UNRESOLVED_LOCAL", value, reason: "Repository dependency did not resolve" }
      : { classification: "UNRESOLVED", value, reason: "Dependency did not resolve" };
  }

  private repositoryResult(value: string, resolvedPath: string, forcedSource?: "REPOSITORY" | "ALIAS"): ManifestDependencyResolution {
    const source = forcedSource || (this.manifestFiles.some((file) => file.toLowerCase() === resolvedPath.toLowerCase()) ? "MANIFEST" : "REPOSITORY");
    return { classification: "REPOSITORY", value, resolvedPath, source };
  }

  private resolveWorkspace(value: string): ManifestDependencyResolution | null {
    if (!this.monorepo?.isMonorepo) return null;
    for (const workspace of this.monorepo.workspaces) {
      if (value !== workspace.name && !value.startsWith(`${workspace.name}/`)) continue;
      if (value === workspace.name) {
        return { classification: "REPOSITORY", value, resolvedPath: workspace.packageJsonPath, source: "WORKSPACE" };
      }
      const subpath = value.slice(workspace.name.length + 1);
      for (const candidate of [`${workspace.relativePath}/${subpath}`, `${workspace.relativePath}/src/${subpath}`]) {
        const match = findRepositoryMatch(candidate, this.allRepositoryFiles);
        if (match) return { classification: "REPOSITORY", value, resolvedPath: match, source: "WORKSPACE" };
      }
      return { classification: "UNRESOLVED_LOCAL", value, reason: "Workspace-local dependency did not resolve" };
    }
    return null;
  }
}
