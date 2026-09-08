import OpenAI from "openai";
import { FileManifest, ExecutionContract, SubTask } from "../types";
import { MANIFEST_GENERATION_PROMPT } from "../ai/prompts/coding";
import {
  detectRepositoryArchitecture,
  detectPrimaryActiveEntryPoint,
  isExistingPrimaryUIRefinement,
  buildRepositoryUISystemPromptSection,
  RepositoryArchitectureSummary,
} from "../ai/planning/RepositoryArchitectureDetector";

export interface ManifestPlanningContext {
  existingFiles?: string[];
  repoSnapshot?: any;
  architecture?: RepositoryArchitectureSummary;
  relevantFiles?: Array<{ path: string; content: string }>;
  baselineDiagnostics?: Array<{ filePath?: string; errorCode?: string; symbolName?: string; message: string }>;
  [key: string]: any;
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
      const response = await this.openai.chat.completions.create({
        model: process.env.OPENAI_AGENT_MODEL || "gpt-4o",
        messages: [
          { role: "system", content: MANIFEST_GENERATION_PROMPT },
          { role: "user", content: contextText },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      });

      const rawContent = response.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(rawContent);

      return this.normalizeParsedManifest(parsed, contract);
    } catch (err: any) {
      console.error("[ManifestGenerator] Error calling OpenAI or parsing manifest:", err?.message || err);
      // Fail closed per Phase 1B specifications: never invent fallback paths
      throw new Error(`MANIFEST_GENERATION_FAILED: ${err?.message || "Failed to generate valid file manifest"}`);
    }
  }

  /**
   * Validates and normalizes raw parsed JSON into a valid FileManifest structure.
   */
  private normalizeParsedManifest(parsed: any, contract: ExecutionContract): FileManifest {
    if (!parsed || typeof parsed !== "object") {
      throw new Error("MANIFEST_GENERATION_FAILED: Parsed manifest is not an object");
    }

    const filesArray = Array.isArray(parsed.files) ? parsed.files : [];
    if (filesArray.length === 0) {
      throw new Error("MANIFEST_GENERATION_FAILED: Manifest contains no files");
    }

    const normalizedFiles: FileManifest["files"] = [];
    const seenPaths = new Set<string>();

    for (const f of filesArray) {
      if (!f || typeof f.path !== "string" || !f.path.trim()) {
        throw new Error("MANIFEST_GENERATION_FAILED: File entry missing path");
      }

      const cleanPath = f.path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
      if (seenPaths.has(cleanPath)) continue;
      seenPaths.add(cleanPath);

      let action: "create" | "modify" | "delete" = "create";
      if (f.action === "modify" || f.action === "delete" || f.action === "create") {
        action = f.action;
      }

      const dependencies = Array.isArray(f.dependencies)
        ? f.dependencies.map((d: any) => String(d).trim().replace(/\\/g, "/")).filter(Boolean)
        : [];

      const evidenceIds = Array.isArray(f.evidenceIds)
        ? f.evidenceIds.map((id: any) => String(id).trim()).filter(Boolean)
        : [];

      normalizedFiles.push({
        path: cleanPath,
        action,
        dependencies,
        evidenceIds,
        description: typeof f.description === "string" ? f.description : undefined,
      });

      if (normalizedFiles.length >= contract.maxFiles) {
        break;
      }
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
