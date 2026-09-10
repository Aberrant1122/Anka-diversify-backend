import OpenAI from "openai";
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
  [key: string]: any;
}

function isSafeManifestPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) return false;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) && normalized.split("/").every((part) => part && part !== "." && part !== "..");
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

    if (repositoryContext.resolvedTarget) {
      const rt = repositoryContext.resolvedTarget;
      contextText += `RESOLVED LOGICAL FEATURE TARGET:\n`;
      contextText += `- Feature Name: ${rt.featureName}\n`;
      contextText += `- Target Files to DELETE: ${rt.candidatePaths.join(", ")}\n`;
      if (rt.importerPaths && rt.importerPaths.length > 0) {
        contextText += `- Importers Requiring Cleanup (action: modify): ${rt.importerPaths.join(", ")}\n`;
      }
      contextText += `- Manifest Planning Rule: Include every resolved target file with action "delete" and every importer with action "modify". Every file in your manifest MUST cite its verified evidence IDs from the list below in "evidenceIds": [...]. Never invent evidence IDs.\n\n`;
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
        contextText += `- Path: "${ob.path}" | Required Action: "${ob.requiredAction}" | Role: ${ob.role} | Evidence IDs: [${ob.evidenceIds.join(", ")}]\n`;
      }
      contextText += `- CONTRACT ENFORCEMENT: Any deviation between your manifest's action and the required action above will trigger an immediate MANIFEST_ACTION_MISMATCH rejection.\n\n`;
    }

    if (repositoryContext.evidenceStore) {
      const summary = repositoryContext.evidenceStore.getAllEvidence().slice(-30);
      if (summary.length > 0) {
        contextText += `VERIFIED REPOSITORY EVIDENCE (YOU MUST CITE VALID EVIDENCE IDS IN evidenceIds[]):\n`;
        for (const e of summary) {
          contextText += `- ID: "${e.id}" | Kind: ${e.kind} | Path: "${e.filePath}"${e.symbol ? ` | Symbol: "${e.symbol}"` : ""}${e.sourceFile ? ` | Source: "${e.sourceFile}"` : ""}\n`;
        }
        contextText += `- EVIDENCE CITATION MANDATE: Every file in your manifest MUST cite 1 or more evidence IDs from the list above in "evidenceIds": ["..."] proving why it exists and relates to the task. CREATE operations must cite integration evidence (e.g. the component integrating it). Never invent evidence IDs.\n\n`;
      }
    }

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
        model: process.env.OPENAI_AGENT_MODEL || "gpt-4o",
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
                    evidenceIds: { type: "array", items: { type: "string" } },
                  },
                  required: ["path", "action", "dependencies", "evidenceIds"],
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
            const knownEvidence = new Set((repositoryContext.evidenceStore?.getAllEvidence?.() || []).map((e: any) => e.id));
            const obligationMap = new Map(obligations.map((item) => [item.path.replace(/\\/g, "/").replace(/^\.\//, ""), item.requiredAction]));
            const paths = new Set<string>();
            for (const file of parsed.files) {
              if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).some((key) => !["path", "action", "description", "dependencies", "evidenceIds"].includes(key))) return { valid: false, errors: ["Manifest entry contains unknown fields"] };
              const normalized = typeof file.path === "string" ? file.path.replace(/\\/g, "/").replace(/^\.\//, "") : "";
              if (!isSafeManifestPath(file.path) || paths.has(normalized) || !["create", "modify", "delete"].includes(file.action)) return { valid: false, errors: ["Manifest path/action is invalid"] };
              paths.add(normalized);
              if (obligationMap.has(normalized) && obligationMap.get(normalized) !== file.action) return { valid: false, errors: [`MANIFEST_ACTION_MISMATCH: ${normalized}`] };
              if (file.description !== undefined && (typeof file.description !== "string" || !file.description.trim())) return { valid: false, errors: ["Manifest description is invalid"] };
              if (!Array.isArray(file.dependencies) || new Set(file.dependencies).size !== file.dependencies.length || file.dependencies.some((dep: unknown) => typeof dep !== "string" || !dep.trim() || dep.includes("\0") || dep.replace(/\\/g, "/").split("/").includes(".."))) return { valid: false, errors: ["Manifest dependencies are invalid"] };
              if (!Array.isArray(file.evidenceIds) || new Set(file.evidenceIds).size !== file.evidenceIds.length || file.evidenceIds.some((id: unknown) => typeof id !== "string" || !id.trim() || (knownEvidence.size > 0 && !knownEvidence.has(id)))) return { valid: false, errors: ["Manifest evidence IDs are invalid"] };
              if (knownEvidence.size > 0 && file.evidenceIds.length === 0) return { valid: false, errors: ["Manifest entry lacks repository evidence"] };
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
   * Enforces FileActionObligation contract:
   *  - action must match requiredAction (throws MANIFEST_ACTION_MISMATCH on deviation)
   *  - evidenceIds from the obligation are merged when the model returns none
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

      // Obligation enforcement: required action must match model action
      const obligation = obligationByPath.get(cleanPath);
      if (obligation && obligation.requiredAction !== action) {
        throw new Error(
          `MANIFEST_ACTION_MISMATCH: path "${cleanPath}" has requiredAction "${obligation.requiredAction}" ` +
          `but model produced "${action}". Obligation contract violated.`
        );
      }

      if (!Array.isArray(f.dependencies) || !Array.isArray(f.evidenceIds)) throw new Error("MANIFEST_GENERATION_FAILED: Missing manifest arrays");
      const dependencies = f.dependencies.map((d: string) => d.replace(/\\/g, "/"));

      // Merge obligation evidenceIds when model returned none
      let evidenceIds = [...f.evidenceIds] as string[];
      if (evidenceIds.length === 0 && obligation && obligation.evidenceIds.length > 0) {
        evidenceIds = [...obligation.evidenceIds];
      }

      normalizedFiles.push({
        path: cleanPath,
        action,
        dependencies,
        evidenceIds,
        description: typeof f.description === "string" ? f.description : undefined,
      });

    }

    if (normalizedFiles.length === 0) {
      throw new Error("MANIFEST_GENERATION_FAILED: No valid files remained after normalization");
    }

    return {
      files: normalizedFiles,
      totalFiles: normalizedFiles.length,
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
