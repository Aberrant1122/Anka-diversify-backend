import OpenAI from "openai";
import { FileManifest, ValidationError, ExecutionContract } from "../../types";
import { RepositoryArchitectureSummary } from "./RepositoryArchitectureDetector";

export interface ManifestCorrectionContext {
  existingFiles?: string[];
  architecture?: RepositoryArchitectureSummary;
  relevantFiles?: Array<{ path: string; content: string }>;
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
4. If modify-source-missing errors were detected:
   - You MUST NOT attempt to MODIFY a file that does not exist in the repository. Either change action to 'create' if creating a genuinely new file, or target an existing file present in the repository.
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
      const response = await openaiClient.chat.completions.create({
        model: process.env.OPENAI_AGENT_MODEL || "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });

      const rawContent = response.choices[0]?.message?.content || "{}";
      const parsed = JSON.parse(rawContent);

      if (!parsed || !Array.isArray(parsed.files)) {
        return null;
      }

      const normalizedFiles = parsed.files.map((f: any, idx: number) => ({
        path: typeof f.path === "string" ? f.path : `src/file_${idx}.ts`,
        action: ["create", "modify", "delete"].includes(f.action) ? f.action : "create",
        dependencies: Array.isArray(f.dependencies) ? f.dependencies : [],
        description: typeof f.description === "string" ? f.description : "File declaration",
        estimatedLines: typeof f.estimatedLines === "number" ? f.estimatedLines : undefined,
      }));

      return {
        files: normalizedFiles,
        totalFiles: normalizedFiles.length,
        manifestVersion: parsed.manifestVersion || "1.0.0",
      };
    } catch (err: any) {
      console.warn("[ManifestCorrectionEngine] Correction attempt failed:", err?.message || err);
      return null;
    }
  }
}
