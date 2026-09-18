import OpenAI from "openai";
import path from "path";
import { FileManifest, ExecutionContract, SubTask, FileActionObligation } from "../types";
import { MANIFEST_GENERATION_PROMPT } from "../ai/prompts/coding";
import {
  detectRepositoryArchitecture,
  detectPrimaryActiveEntryPoint,
  isExistingPrimaryUIRefinement,
  buildRepositoryUISystemPromptSection,
  RepositoryArchitectureSummary,
} from "../ai/planning/RepositoryArchitectureDetector";
import { LLMGateway } from "../ai/gateway/LLMGateway";
import { PipelineStages } from "../ai/gateway/PipelineStage";

export interface ManifestPlanningContext {
  existingFiles?: string[];
  repoSnapshot?: any;
  architecture?: RepositoryArchitectureSummary;
  relevantFiles?: Array<{ path: string; content: string }>;
  baselineDiagnostics?: Array<{ filePath?: string; errorCode?: string; symbolName?: string; message: string }>;
  actionObligations?: FileActionObligation[];
  priorVerifiedTargets?: Array<{ path: string; action: "create" | "modify" | "delete" }>;
  [key: string]: any;
}

function isSafeManifestPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) return false;
  // A literal escaped-dot is a search-pattern artifact, not a repository path.
  // Reject it at proposal ingress; do not rewrite it into a different target.
  if (/\\\./.test(value)) return false;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) && normalized.split("/").every((part) => part && part !== "." && part !== "..");
}

/**
 * Validates a module specifier without rejecting ordinary parent-relative
 * imports. Relative dependencies are resolved from their owning manifest file
 * and must remain inside the repository namespace.
 */
function isSafeManifestDependency(ownerPath: string, value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) return false;

  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;

  if (normalized === "." || normalized === "..") return false;
  if (normalized.startsWith("./") || normalized.startsWith("../")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(ownerPath), normalized));
    return resolved !== ".." && !resolved.startsWith("../") && !path.posix.isAbsolute(resolved);
  }

  // Bare packages and configured aliases are validated later by the manifest
  // validator. They must not contain traversal segments of their own.
  return normalized.split("/").every((segment) => segment !== "." && segment !== "..");
}

function isRepositoryDependencyIntent(ownerPath: string, value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const dependency = value as Record<string, unknown>;
  return Object.keys(dependency).every((key) => ["path", "relation"].includes(key)) &&
    isSafeManifestDependency(ownerPath, dependency.path) &&
    (dependency.relation === undefined || (typeof dependency.relation === "string" && !!dependency.relation.trim()));
}

function isExternalPackageIntent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const dependency = value as Record<string, unknown>;
  return Object.keys(dependency).every((key) => ["packageName", "subpath"].includes(key)) &&
    typeof dependency.packageName === "string" && !!dependency.packageName.trim() &&
    (dependency.subpath === undefined || (typeof dependency.subpath === "string" && !!dependency.subpath.trim()));
}

export class ManifestGenerator {
  private openai: OpenAI;

  constructor(openaiClient?: OpenAI) {
    if (openaiClient) {
      this.openai = openaiClient;
    } else {
      const apiKey = process.env.OPENAI_API_KEY || "";
      this.openai = new OpenAI({ apiKey });
    }
  }

  /**
   * Generates a FileManifest JSON using OpenAI based on contract constraints and repository evidence.
   *
   * Invariants (Phase 1B):
   * 1. Fails closed with MANIFEST_GENERATION_FAILED if OpenAI fails or output is malformed.
   * 2. Zero invented paths (no src/index.ts, <target>/index.ts, src/file_0.ts).
   * 3. No prompt-keyword feature/template branching.
   */
  public async generateManifest(
    userRequest: string,
    repositoryContext: ManifestPlanningContext,
    contract: ExecutionContract,
    subTaskScope?: SubTask
  ): Promise<FileManifest> {
    const existingFileList = repositoryContext.existingFiles || [];
    const arch = repositoryContext.architecture || detectRepositoryArchitecture(existingFileList);

    // If standalone pipeline, return standalone web files without guessing repo paths
    if (contract.pipeline === "STANDALONE" || contract.environment === "HTML_CSS_JS") {
      const existingWeb = existingFileList.filter((f) => /\.(?:html|css|js)$/i.test(f));
      const files = existingWeb.length > 0
        ? existingWeb.map((p) => ({ path: p, action: "modify" as const, dependencies: [] as string[], description: `Update ${p}` }))
        : [
            { path: "index.html", action: "create" as const, dependencies: ["./style.css", "./script.js"], description: "Main HTML page" },
            { path: "style.css", action: "create" as const, dependencies: [], description: "CSS stylesheet" },
            { path: "script.js", action: "create" as const, dependencies: [], description: "JS logic file" },
          ];
      return {
        files,
        totalFiles: files.length,
        manifestVersion: "1.0.0",
      };
    }

    let contextText = `USER REQUEST:\n${userRequest}\n\n`;
    contextText += `EXECUTION CONTRACT CONSTRAINTS:\n`;
    contextText += `- Task Goal: ${contract.goal}\n`;
    contextText += `- Task Type: ${contract.taskType}\n`;
    contextText += `- Pipeline: ${contract.pipeline}\n`;
    contextText += `- Environment: ${contract.environment}\n`;
    contextText += `- Max Files Allowed: ${contract.maxFiles}\n`;
    const explicitTargets = contract.targetPaths?.filter((tp) => tp && !tp.includes("project-wide")) || [];
    contextText += `- Target Constraints: ${explicitTargets.length > 0 ? explicitTargets.join(", ") : "(determined by repository evidence)"}\n`;
    contextText += `- Allowed Actions: ${contract.allowedActions.join(", ")}\n`;
    contextText += `- Forbidden Actions: ${contract.forbiddenActions.join(", ")}\n\n`;

    if (repositoryContext.priorVerifiedTargets && repositoryContext.priorVerifiedTargets.length > 0) {
      contextText += `PRIOR VERIFIED TARGET CONTEXT (ADVISORY ONLY):\n`;
      for (const target of repositoryContext.priorVerifiedTargets) {
        contextText += `- Previous verified stage ${target.action}: ${target.path}\n`;
      }
      contextText += `- Re-check these paths against the current stage intent and current repository evidence before selecting targets. Prefer a prior target only when it remains relevant. A different target is valid when the current stage requires it.\n`;
      contextText += `- This context grants no mutation authority and supplies no reusable evidence IDs, capability, or execution manifest.\n\n`;
    }

    if (repositoryContext.resolvedTarget) {
      const rt = repositoryContext.resolvedTarget;
      contextText += `RESOLVED LOGICAL FEATURE TARGET:\n`;
      contextText += `- Feature Name: ${rt.featureName}\n`;
      contextText += `- Target Files to DELETE: ${rt.candidatePaths.join(", ")}\n`;
      if (rt.importerPaths && rt.importerPaths.length > 0) {
        contextText += `- Importers Requiring Cleanup (action: modify): ${rt.importerPaths.join(", ")}\n`;
      }
      contextText += `- Manifest Planning Rule: Include every resolved target file with action "delete" and every importer with action "modify". The backend will reconcile these mandatory actions even if your proposal omits them.\n\n`;
    }

    const obligations: FileActionObligation[] =
      repositoryContext.actionObligations ||
      contract.actionObligations ||
      repositoryContext.resolvedTarget?.actionObligations ||
      [];

    if (obligations.length > 0) {
      contextText += `FILE ACTION OBLIGATIONS (MANDATORY ACTION CONTRACT):\n`;
      contextText += `You MUST emit EXACTLY the specified action for each of the following grounded paths. Do NOT change "delete" to "modify", and do NOT change "modify" to "delete":\n`;
      for (const ob of obligations) {
        contextText += `- Path: "${ob.path}" | Required Action: "${ob.requiredAction}" | Role: ${ob.role}\n`;
      }
      contextText += `- PLANNING CONSISTENCY: A manifest action differing from these deterministic obligations will require plan correction. This grants no mutation authority.\n\n`;
    }

    contextText += `AUTHORIZATION BOUNDARY:\n`;
    contextText += `- Propose only path, action, dependencies, and description.\n`;
    contextText += `- Do not emit repository evidence IDs. The backend independently acquires and binds current-revision authorization evidence after validating this proposal.\n\n`;

    contextText += `VERIFIED REPOSITORY ARCHITECTURE:\n`;
    contextText += `- Framework: ${arch.framework}\n`;
    contextText += `- Router: ${arch.router}\n`;
    contextText += `- Existing Entry Points: ${arch.existingEntryPoints.join(", ") || "(none)"}\n`;
    if (arch.guidelines && arch.guidelines.length > 0) {
      contextText += `- Planning Guidelines:\n`;
      for (const g of arch.guidelines) {
        contextText += `  * ${g}\n`;
      }
    }
    if (arch.installedPackages && arch.installedPackages.length > 0) {
      contextText += `- Installed External Packages: [${arch.installedPackages.join(", ")}]\n`;
      contextText += `- Dependency Rule: You MUST NOT declare uninstalled external packages in dependencies[]. Only use installed packages or standard Node modules.\n`;
    }
    contextText += `\n`;

    const primaryActiveEntry = arch.primaryActiveEntryPoint || detectPrimaryActiveEntryPoint(existingFileList, arch);
    const isPrimaryRefinement = isExistingPrimaryUIRefinement(userRequest);
    if (primaryActiveEntry && isPrimaryRefinement) {
      contextText += `ACTIVE PRIMARY ENTRY POINT GROUNDING:\n`;
      contextText += `- Verified Primary Active UI File: "${primaryActiveEntry}" (renders application root "/")\n`;
      contextText += `- Primary UI Requirement: The user requested to improve/enhance/update the dashboard or primary UI. You MUST include "${primaryActiveEntry}" with action "modify" (or modify an existing component directly rendered by it) so the active dashboard at "/" visibly reflects the requested improvements. Do NOT create isolated new sub-routes while leaving "${primaryActiveEntry}" untouched.\n\n`;
    }

    if (contract.environment === "REACT_TS" || arch.existingUIComponents.length > 0) {
      const uiSystemSection = buildRepositoryUISystemPromptSection(arch, {
        isComprehensiveUI: contract.maxFiles >= 3,
        isSmallComponent: contract.maxFiles <= 1,
      });
      if (uiSystemSection) {
        contextText += uiSystemSection;
      }
    }

    if (repositoryContext.relevantFiles && repositoryContext.relevantFiles.length > 0) {
      contextText += `RELEVANT EXISTING FILES IN REPOSITORY:\n`;
      for (const f of repositoryContext.relevantFiles.slice(0, 8)) {
        contextText += `--- ${f.path} ---\n${f.content.slice(0, 1500)}\n\n`;
      }
    }

    if (repositoryContext.baselineDiagnostics && Array.isArray(repositoryContext.baselineDiagnostics) && repositoryContext.baselineDiagnostics.length > 0) {
      contextText += `AUTHORITATIVE COMPILER / BUILD DIAGNOSTICS (PROVEN REPOSITORY DEFECTS):\n`;
      for (const diag of repositoryContext.baselineDiagnostics) {
        contextText += `- File: ${diag.filePath || "(unknown)"} | Code: ${diag.errorCode || "BUILD_ERROR"}${diag.symbolName ? ` | Symbol: ${diag.symbolName}` : ""}\n`;
        contextText += `  Message: ${diag.message}\n`;
      }
      contextText += `- Manifest Planning Rule: You MUST prioritize modifying the exact failing files listed above. Do not include speculative unrelated files without concrete import/dependency evidence.\n\n`;
    }

    if (subTaskScope) {
      contextText += `SUB-TASK SCOPE:\n`;
      contextText += `- SubTask ID: ${subTaskScope.id}\n`;
      contextText += `- Category: ${subTaskScope.category}\n`;
      contextText += `- Target Files: ${subTaskScope.targetFiles.join(", ")}\n`;
      contextText += `- Dependencies: ${subTaskScope.dependencies.join(", ")}\n\n`;
    }

    contextText += `ALL EXISTING REPOSITORY FILES:\n`;
    contextText += existingFileList.slice(0, 60).map((f) => `- ${f}`).join("\n");
    if (existingFileList.length > 60) {
      contextText += `\n... and ${existingFileList.length - 60} more files.`;
    }

    try {
      const gateway = LLMGateway.getInstance();
      const response = await gateway.callStructured<{ files: any[]; totalFiles: number; manifestVersion: string }>({
        stage: PipelineStages.MANIFEST_GENERATION,
        openaiClient: this.openai,
        messages: [
          { role: "system", content: MANIFEST_GENERATION_PROMPT },
          { role: "user", content: contextText },
        ],
        temperature: 0.2,
        schema: {
          name: "FileManifestSchema",
          strict: false,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              files: {
                type: "array",
                minItems: 1,
                maxItems: contract.maxFiles,
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    path: { type: "string" },
                    action: { type: "string", enum: ["create", "modify", "delete"] },
                    description: { type: "string" },
                    dependencies: { type: "array", items: { type: "string" } },
                    repositoryDependencies: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: { path: { type: "string" }, relation: { type: "string" } },
                        required: ["path"],
                      },
                    },
                    externalPackages: {
                      type: "array",
                      items: {
                        type: "object",
                        additionalProperties: false,
                        properties: { packageName: { type: "string" }, subpath: { type: "string" } },
                        required: ["packageName"],
                      },
                    },
                    // Temporary compatibility only. Legacy providers may still
                    // return this field, but it is never authorization input.
                    evidenceIds: { description: "Ignored legacy field. Do not emit." },
                  },
                  required: ["path", "action", "dependencies"],
                },
              },
              totalFiles: { type: "number" },
              manifestVersion: { type: "string", enum: ["1.0.0"] },
            },
            required: ["files", "totalFiles", "manifestVersion"],
          },
          validate: (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => !["files", "totalFiles", "manifestVersion"].includes(key))) return { valid: false, errors: ["Parsed manifest is not an exact object"] };
            if (!Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > contract.maxFiles) return { valid: false, errors: ["Manifest file count is invalid"] };
            if (parsed.totalFiles !== parsed.files.length || parsed.manifestVersion !== "1.0.0") return { valid: false, errors: ["Manifest metadata is inconsistent"] };
            const paths = new Set<string>();
            for (const file of parsed.files) {
              if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).some((key) => !["path", "action", "description", "dependencies", "repositoryDependencies", "externalPackages", "evidenceIds"].includes(key))) return { valid: false, errors: ["Manifest entry contains unknown fields"] };
              const normalized = typeof file.path === "string" ? file.path.replace(/\\/g, "/").replace(/^\.\//, "") : "";
              if (!isSafeManifestPath(file.path) || paths.has(normalized) || !["create", "modify", "delete"].includes(file.action)) return { valid: false, errors: ["Manifest path/action is invalid"] };
              paths.add(normalized);
              if (file.description !== undefined && (typeof file.description !== "string" || !file.description.trim())) return { valid: false, errors: ["Manifest description is invalid"] };
              if (!Array.isArray(file.dependencies) || new Set(file.dependencies).size !== file.dependencies.length || file.dependencies.some((dep: unknown) => !isSafeManifestDependency(normalized, dep))) return { valid: false, errors: ["Manifest dependencies are invalid"] };
              if (file.repositoryDependencies !== undefined && (!Array.isArray(file.repositoryDependencies) || file.repositoryDependencies.some((dep: unknown) => !isRepositoryDependencyIntent(normalized, dep)))) return { valid: false, errors: ["Manifest repositoryDependencies are invalid"] };
              if (file.externalPackages !== undefined && (!Array.isArray(file.externalPackages) || file.externalPackages.some((dep: unknown) => !isExternalPackageIntent(dep)))) return { valid: false, errors: ["Manifest externalPackages are invalid"] };
              // evidenceIds is accepted only for legacy wire compatibility.
              // Its contents are deliberately not inspected: backend binding
              // replaces the field before any authority resolver is invoked.
            }
            return { valid: true, data: parsed };
          },
        },
      });

      return this.normalizeParsedManifest(response.content, contract, obligations);
    } catch (err: any) {
      console.error("[ManifestGenerator] Error calling OpenAI or parsing manifest:", err?.message || err);
      // Fail closed per Phase 1B specifications: never invent fallback paths
      throw new Error(`MANIFEST_GENERATION_FAILED: ${err?.message || "Failed to generate valid file manifest"}`);
    }
  }

  /**
   * Validates and normalizes raw parsed JSON into a valid FileManifest structure.
   * Reconciles trusted FileActionObligations into an untrusted model proposal.
   * Model-supplied evidenceIds are always discarded.
   */
  private normalizeParsedManifest(
    parsed: any,
    contract: ExecutionContract,
    obligations: FileActionObligation[] = []
  ): FileManifest {
    if (!parsed || typeof parsed !== "object") {
      throw new Error("MANIFEST_GENERATION_FAILED: Parsed manifest is not an object");
    }

    const filesArray = Array.isArray(parsed.files) ? parsed.files : [];
    if (filesArray.length === 0) {
      throw new Error("MANIFEST_GENERATION_FAILED: Manifest contains no files");
    }

    // Build obligation lookup by normalised path for O(1) enforcement
    const obligationByPath = new Map<string, FileActionObligation>();
    for (const ob of obligations) {
      obligationByPath.set(ob.path.trim().replace(/\\/g, "/").replace(/^\.\//,  ""), ob);
    }

    const normalizedFiles: FileManifest["files"] = [];
    const seenPaths = new Set<string>();

    for (const f of filesArray) {
      if (!f || typeof f.path !== "string" || !f.path.trim()) {
        throw new Error("MANIFEST_GENERATION_FAILED: File entry missing path");
      }

      const cleanPath = f.path.trim().replace(/\\/g, "/").replace(/^\.\//,  "");
      if (!isSafeManifestPath(f.path) || seenPaths.has(cleanPath)) {
        throw new Error("MANIFEST_GENERATION_FAILED: Unsafe or duplicate file path");
      }
      seenPaths.add(cleanPath);

      if (f.action !== "modify" && f.action !== "delete" && f.action !== "create") throw new Error("MANIFEST_GENERATION_FAILED: Invalid file action");
      const action: "create" | "modify" | "delete" = f.action;

      // Trusted obligations override conflicting model intent. The model can
      // neither remove nor mutate a backend-required action.
      const obligation = obligationByPath.get(cleanPath);
      const reconciledAction = obligation?.requiredAction ?? action;

      if (!Array.isArray(f.dependencies)) throw new Error("MANIFEST_GENERATION_FAILED: Missing manifest dependencies");
      const dependencies = f.dependencies.map((d: string) => d.replace(/\\/g, "/"));
      const repositoryDependencies = Array.isArray(f.repositoryDependencies)
        ? f.repositoryDependencies.map((dependency: { path: string; relation?: string }) => ({
            path: dependency.path.replace(/\\/g, "/"),
            ...(dependency.relation ? { relation: dependency.relation } : {}),
          }))
        : undefined;
      const externalPackages = Array.isArray(f.externalPackages)
        ? f.externalPackages.map((dependency: { packageName: string; subpath?: string }) => ({
            packageName: dependency.packageName.trim(),
            ...(dependency.subpath ? { subpath: dependency.subpath.replace(/^\/+/, "") } : {}),
          }))
        : undefined;

      normalizedFiles.push({
        path: cleanPath,
        action: reconciledAction,
        dependencies,
        repositoryDependencies,
        externalPackages,
        evidenceIds: [],
        description: typeof f.description === "string" ? f.description : undefined,
      });

    }

    const deleteObligationPaths = obligations
      .filter((obligation) => obligation.requiredAction === "delete")
      .map((obligation) => obligation.path.trim().replace(/\\/g, "/").replace(/^\.\//, ""));
    for (const obligation of obligations) {
      const obligationPath = obligation.path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      if (!isSafeManifestPath(obligation.path)) {
        throw new Error(`MANIFEST_GENERATION_FAILED: Unsafe trusted obligation path "${obligation.path}"`);
      }
      if (seenPaths.has(obligationPath)) continue;
      seenPaths.add(obligationPath);
      normalizedFiles.push({
        path: obligationPath,
        action: obligation.requiredAction,
        dependencies: obligation.role === "DEPENDENCY_CLEANUP" ? [...deleteObligationPaths] : [],
        evidenceIds: [],
        description: `${obligation.role}: ${obligation.requiredAction} ${obligationPath}`,
      });
    }

    if (obligations.length > contract.maxFiles) {
      throw new Error("MANIFEST_GENERATION_FAILED: Trusted obligations exceed the execution contract file limit");
    }

    // Mandatory backend obligations are retained first when an over-broad
    // model proposal would otherwise exceed the contract file limit.
    const obligationPaths = new Set(obligations.map((obligation) => obligation.path.trim().replace(/\\/g, "/").replace(/^\.\//, "")));
    const boundedFiles = [
      ...normalizedFiles.filter((file) => obligationPaths.has(file.path)),
      ...normalizedFiles.filter((file) => !obligationPaths.has(file.path)),
    ].slice(0, contract.maxFiles);

    if (boundedFiles.length === 0) {
      throw new Error("MANIFEST_GENERATION_FAILED: No valid files remained after normalization");
    }

    return {
      files: boundedFiles,
      totalFiles: boundedFiles.length,
      manifestVersion: "1.0.0",
    };
  }

  /**
   * Diagnostic / test fallback helper. Production generateManifest() fails closed.
   */
  public buildFallbackManifest(
    userRequest: string,
    contract: ExecutionContract,
    repositoryContext?: ManifestPlanningContext,
    subTaskScope?: SubTask
  ): FileManifest {
    const obligations: FileActionObligation[] =
      repositoryContext?.actionObligations ||
      contract.actionObligations ||
      repositoryContext?.resolvedTarget?.actionObligations ||
      [];

    if (obligations.length > 0) {
      const files: FileManifest["files"] = obligations.map((ob) => {
        const evs = repositoryContext?.evidenceStore?.getEvidenceForFile(ob.path) || [];
        const evIds = ob.evidenceIds && ob.evidenceIds.length > 0 ? ob.evidenceIds : evs.map((e: any) => e.id);
        const deletePaths = obligations.filter((o) => o.requiredAction === "delete").map((o) => o.path);
        return {
          path: ob.path,
          action: ob.requiredAction,
          evidenceIds: evIds,
          dependencies: ob.requiredAction === "modify" ? deletePaths : [],
          description: `${ob.role}: ${ob.requiredAction} ${ob.path}`,
        };
      });
      return {
        files,
        totalFiles: files.length,
        manifestVersion: "1.0.0",
      };
    }

    if (repositoryContext?.resolvedTarget) {
      const rt = repositoryContext.resolvedTarget;
      const files: FileManifest["files"] = [];
      for (const p of rt.candidatePaths) {
        const evs = repositoryContext.evidenceStore?.getEvidenceForFile(p) || [];
        files.push({
          path: p,
          action: "delete",
          evidenceIds: evs.map((e: any) => e.id),
          dependencies: [],
          description: `Delete ${rt.featureName} target file`,
        });
      }
      for (const imp of rt.importerPaths || []) {
        const evs = repositoryContext.evidenceStore?.getEvidenceForFile(imp) || [];
        files.push({
          path: imp,
          action: "modify",
          dependencies: rt.candidatePaths,
          evidenceIds: evs.map((e: any) => e.id),
          description: `Clean up references to deleted ${rt.featureName}`,
        });
      }
      if (files.length > 0) {
        return {
          files,
          totalFiles: files.length,
          manifestVersion: "1.0.0",
        };
      }
    }

    const rawTarget = contract.targetPaths.find((tp) => tp && !tp.includes("project-wide"));
    if (rawTarget) {
      const normalizedTarget = rawTarget.replace(/\\/g, "/").replace(/^\.\//, "");
      return {
        files: [
          {
            path: normalizedTarget,
            action: "create",
            dependencies: [],
            description: `Target file for ${userRequest}`,
          },
        ],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      };
    }
    throw new Error("MANIFEST_GENERATION_FAILED: No target files available for manifest fallback");
  }
}
