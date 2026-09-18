import OpenAI from "openai";
import { FileManifest, ValidationError, ExecutionContract } from "../../types";
import { RepositoryArchitectureSummary } from "./RepositoryArchitectureDetector";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { MonorepoDescriptor } from "../workspace/MonorepoDetector";
import {
  ManifestDependencyConfigurationFile,
  ManifestDependencyResolver,
} from "./ManifestDependencyResolver";

export interface ManifestCorrectionContext {
  existingFiles?: string[];
  architecture?: RepositoryArchitectureSummary;
  relevantFiles?: Array<{ path: string; content: string }>;
  configurationFiles?: ManifestDependencyConfigurationFile[];
  monorepo?: MonorepoDescriptor | null;
}

function normalizeBoundedPath(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) return null;
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) return null;
  return normalized;
}

export function normalizeManifestDependencyIntent(
  manifest: FileManifest,
  context: ManifestCorrectionContext
): FileManifest {
  const resolver = new ManifestDependencyResolver({
    existingFiles: context.existingFiles || [],
    manifestFiles: (manifest.files || []).map((file) => file.path),
    installedPackages: context.architecture?.installedPackages || [],
    configurationFiles: context.configurationFiles,
    monorepo: context.monorepo,
  });
  const files = (manifest.files || []).map((file) => {
    const repositoryDependencies: NonNullable<typeof file.repositoryDependencies> = [];
    const externalPackages: NonNullable<typeof file.externalPackages> = [];
    const unresolvedDependencies: string[] = [];
    const candidates = [
      ...(file.dependencies || []).map((value) => ({ value, intent: "LEGACY" as const, relation: undefined })),
      ...(file.repositoryDependencies || []).map((dependency) => ({ value: dependency.path, intent: "REPOSITORY" as const, relation: dependency.relation })),
      ...(file.externalPackages || []).map((dependency) => ({
        value: dependency.subpath ? `${dependency.packageName}/${dependency.subpath.replace(/^\/+/, "")}` : dependency.packageName,
        intent: "EXTERNAL" as const,
        relation: undefined,
      })),
    ];
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const normalizedValue = candidate.value.replace(/\\/g, "/").trim();
      if (seen.has(normalizedValue)) continue;
      seen.add(normalizedValue);
      const resolution = resolver.resolve(file.path, { value: normalizedValue, intent: candidate.intent });
      if (resolution.classification === "REPOSITORY") {
        repositoryDependencies.push({ path: resolution.resolvedPath, ...(candidate.relation ? { relation: candidate.relation } : {}) });
      } else if (resolution.classification === "EXTERNAL") {
        externalPackages.push({ packageName: resolution.packageName, ...(resolution.subpath ? { subpath: resolution.subpath } : {}) });
      } else {
        unresolvedDependencies.push(normalizedValue);
      }
    }
    return {
      ...file,
      dependencies: unresolvedDependencies,
      repositoryDependencies,
      externalPackages,
    };
  });
  return { ...manifest, files, totalFiles: files.length };
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
    const normalizedRejectedManifest = normalizeManifestDependencyIntent(rejectedManifest, context);
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
2. If orphan errors were detected, connect created files using repositoryDependencies. Use aliases only when verified repository configuration proves them.
3. Follow the verified repository architecture:
   - If the project uses Next.js App Router (app/), do NOT create pages/ or src/pages/ files. Use app/**/page.tsx or embed/modify in existing app/page.tsx and existing components.
   - If the project uses Next.js Pages Router (pages/), do NOT create app/ or src/app/ files.
   - If the project already has verified reusable files for the requested feature, prefer modifying/reusing them over creating duplicate or parallel files.
4. Keep corrections bounded to planning metadata and dependencies. A manifest never grants or changes mutation authority.
5. Keep totalFiles <= maxFiles (${contract.maxFiles}).
6. If external-dependency-missing errors were detected:
   - You MUST NOT use or invent uninstalled packages. Only use packages listed in installed external packages (${arch?.installedPackages?.join(", ") || "none"}), or implement using standard library/native JS.
7. Output ONLY valid JSON matching the FileManifest schema.
8. Prefer repositoryDependencies for repository paths and externalPackages for npm/Node packages. Typed fields express intent only; backend verification remains authoritative.

JSON SCHEMA:
{
  "files": [
    {
      "path": "relative/path/from/project/root.ts",
      "action": "create" | "modify" | "delete",
      "dependencies": ["array", "of", "import", "paths"],
      "repositoryDependencies": [{ "path": "repository/path", "relation": "imports" }],
      "externalPackages": [{ "packageName": "package-name", "subpath": "optional/subpath" }],
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
${JSON.stringify(normalizedRejectedManifest, null, 2)}

VALIDATION ERRORS:
${errorList}

Generate a corrected, valid FileManifest JSON that resolves all validation errors.`;

    try {
      const allowedActionByPath = new Map<string, "create" | "modify" | "delete">();
      for (const file of normalizedRejectedManifest.files || []) {
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
                    repositoryDependencies: {
                      type: "array",
                      items: { type: "object", additionalProperties: false, properties: { path: { type: "string" }, relation: { type: "string" } }, required: ["path"] },
                    },
                    externalPackages: {
                      type: "array",
                      items: { type: "object", additionalProperties: false, properties: { packageName: { type: "string" }, subpath: { type: "string" } }, required: ["packageName"] },
                    },
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
              if (!file || typeof file !== "object" || Array.isArray(file) || Object.keys(file).some((key) => !["path", "action", "dependencies", "repositoryDependencies", "externalPackages", "description", "estimatedLines"].includes(key)) || !path || seen.has(path) || allowedActionByPath.get(path) !== file.action) return { valid: false, errors: ["Correction contains an unauthorized path or action"] };
              seen.add(path);
              if (!Array.isArray(file.dependencies) || new Set(file.dependencies).size !== file.dependencies.length || file.dependencies.some((dep: unknown) => typeof dep !== "string" || !dep.trim() || dep.includes("\0") || dep.replace(/\\/g, "/").split("/").includes("..")) || typeof file.description !== "string" || !file.description.trim() || (file.estimatedLines !== undefined && (!Number.isInteger(file.estimatedLines) || file.estimatedLines < 0))) return { valid: false, errors: ["Correction entry fields are invalid"] };
              if (file.repositoryDependencies !== undefined && (!Array.isArray(file.repositoryDependencies) || file.repositoryDependencies.some((dep: unknown) => !dep || typeof dep !== "object" || Array.isArray(dep) || typeof (dep as Record<string, unknown>).path !== "string"))) return { valid: false, errors: ["Correction repositoryDependencies are invalid"] };
              if (file.externalPackages !== undefined && (!Array.isArray(file.externalPackages) || file.externalPackages.some((dep: unknown) => !dep || typeof dep !== "object" || Array.isArray(dep) || typeof (dep as Record<string, unknown>).packageName !== "string"))) return { valid: false, errors: ["Correction externalPackages are invalid"] };
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
        repositoryDependencies: f.repositoryDependencies,
        externalPackages: f.externalPackages,
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
