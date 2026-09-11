import OpenAI from "openai";
import { FileManifest, ValidationError, ExecutionContract } from "../../types";
import { RepositoryArchitectureSummary } from "./RepositoryArchitectureDetector";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";

export interface ManifestCorrectionContext {
  existingFiles?: string[];
  architecture?: RepositoryArchitectureSummary;
  relevantFiles?: Array<{ path: string; content: string }>;
}

function normalizeBoundedPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

export class ManifestCorrectionEngine {
  /**
   * Performs ONE bounded correction attempt on a rejected FileManifest.
   * Feeds the exact validation errors and grounded architecture constraints
   * to the model to produce a corrected manifest that adheres to rules.
   */
  public static async attemptCorrection(
    rejectedManifest: FileManifest,
    validationErrors: ValidationError[],
    userRequest: string,
    context: ManifestCorrectionContext,
    contract: ExecutionContract,
    openaiClient: OpenAI
  ): Promise<FileManifest | null> {
    const errorList = validationErrors
      .map((e) => `• [${e.type}] ${e.message} (Suggestion: ${e.suggestion})`)
      .join("\n");

    const arch = context.architecture;
    let archSection = "";
    if (arch) {
      archSection = `VERIFIED REPOSITORY ARCHITECTURE:
- Framework: ${arch.framework}
- Router Type: ${arch.router}
- Existing Entry Points: ${arch.existingEntryPoints.join(", ") || "(none detected)"}
- Architecture Guidelines:
${arch.guidelines.map((g) => `  * ${g}`).join("\n")}
`;
    }

    let relevantFilesSection = "";
    if (context.relevantFiles && context.relevantFiles.length > 0) {
      relevantFilesSection = `RELEVANT EXISTING FILES IN REPOSITORY:\n` +
        context.relevantFiles
          .slice(0, 6)
          .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 1500)}`)
          .join("\n\n");
    }

    const systemPrompt = `You are a File Manifest Correction Agent for Anka OS AI Coding Agent.
A previously generated File Manifest was REJECTED by deterministic validation rules.
Your task is to fix ALL validation errors and output ONE corrected FileManifest JSON.

CRITICAL RULES:
1. Fix all validation errors listed below.
2. If orphan errors were detected:
   - Ensure created files are connected by adding them to the 'dependencies' array of the file(s) that import/use them.
   - For example, if 'components/Calculator.tsx' imports 'lib/calculatorLogic.ts', 'components/Calculator.tsx' MUST declare './calculatorLogic.ts' (or '@/lib/calculatorLogic') in its dependencies array.
3. Follow the verified repository architecture:
   - If the project uses Next.js App Router (app/), do NOT create pages/ or src/pages/ files. Use app/**/page.tsx or embed/modify in existing app/page.tsx and existing components.
   - If the project uses Next.js Pages Router (pages/), do NOT create app/ or src/app/ files.
   - If the project already has existing components (e.g. components/Calculator.tsx, components/CalculatorButton.tsx, components/CalculatorDisplay.tsx), prefer modifying/reusing them over creating duplicate or parallel files.
4. Keep corrections bounded to planning metadata and dependencies. A manifest never grants or changes mutation authority.
5. Keep totalFiles <= maxFiles (${contract.maxFiles}).
6. If external-dependency-missing errors were detected:
   - You MUST NOT use or invent uninstalled packages. Only use packages listed in installed external packages (${arch?.installedPackages?.join(", ") || "none"}), or implement using standard library/native JS.
7. Output ONLY valid JSON matching the FileManifest schema.

JSON SCHEMA:
{
  "files": [
    {
      "path": "relative/path/from/project/root.ts",
      "action": "create" | "modify" | "delete",
      "dependencies": ["array", "of", "import", "paths"],
      "description": "Human-readable purpose of this file"
    }
  ],
  "totalFiles": number,
  "manifestVersion": "1.0.0"
}`;

    const userPrompt = `USER REQUEST:
${userRequest}

${archSection}
${relevantFilesSection}

REJECTED MANIFEST:
${JSON.stringify(rejectedManifest, null, 2)}

VALIDATION ERRORS:
${errorList}

Generate a corrected, valid FileManifest JSON that resolves all validation errors.`;

    try {
      const allowedActionByPath = new Map<string, "create" | "modify" | "delete">();
      for (const file of rejectedManifest.files || []) {
        const path = normalizeBoundedPath(file.path);
        if (path && ["create", "modify", "delete"].includes(file.action)) allowedActionByPath.set(path, file.action);
      }
      for (const obligation of contract.actionObligations || []) {
        const path = normalizeBoundedPath(obligation.path);
        if (path) allowedActionByPath.set(path, obligation.requiredAction);
      }
      const gateway = LLMGateway.getInstance();
      const response = await gateway.callStructured<{
        files: any[];
        totalFiles: number;
        manifestVersion: string;
      }>({
        stage: PipelineStages.MANIFEST_CORRECTION,
        openaiClient,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        schema: {
          name: "ManifestCorrectionSchema",
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
                    dependencies: { type: "array", items: { type: "string" } },
                    description: { type: "string" },
                    estimatedLines: { type: "number" },
                  },
                  required: ["path", "action", "dependencies", "description"],
                },
              },
              totalFiles: { type: "number" },
              manifestVersion: { type: "string" },
            },
            required: ["files", "totalFiles", "manifestVersion"],
          },
          validate: (parsed) => {
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.keys(parsed).some((key) => !["files", "totalFiles", "manifestVersion"].includes(key)) || !Array.isArray(parsed.files) || parsed.files.length === 0 || parsed.files.length > contract.maxFiles || parsed.totalFiles !== parsed.files.length || parsed.manifestVersion !== "1.0.0") return { valid: false, errors: ["Invalid corrected manifest envelope"] };
            const seen = new Set<string>();
            for (const file of parsed.files) {
              const path = normalizeBoundedPath(file?.path);
              if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).some((key) => !["path", "action", "dependencies", "description", "estimatedLines"].includes(key)) || !path || seen.has(path) || allowedActionByPath.get(path) !== file.action) return { valid: false, errors: ["Correction contains an unauthorized path or action"] };
              seen.add(path);
              if (!Array.isArray(file.dependencies) || new Set(file.dependencies).size !== file.dependencies.length || file.dependencies.some((dep: unknown) => typeof dep !== "string" || !dep.trim() || dep.includes("\0") || dep.replace(/\\/g, "/").split("/").includes("..")) || typeof file.description !== "string" || !file.description.trim() || (file.estimatedLines !== undefined && (!Number.isInteger(file.estimatedLines) || file.estimatedLines < 0))) return { valid: false, errors: ["Correction entry fields are invalid"] };
            }
            return { valid: true, data: parsed };
          },
        },
      });

      const parsed = response.content;
      if (!parsed || !Array.isArray(parsed.files)) {
        return null;
      }

      const normalizedFiles = parsed.files.map((f: any) => ({
        path: normalizeBoundedPath(f.path)!,
        action: f.action,
        dependencies: f.dependencies,
        description: f.description,
        estimatedLines: f.estimatedLines,
      }));

      return {
        files: normalizedFiles,
        totalFiles: normalizedFiles.length,
        manifestVersion: parsed.manifestVersion,
      };
    } catch (err: any) {
      console.warn("[ManifestCorrectionEngine] Correction attempt failed:", err?.message || err);
      return null;
    }
  }
}
