import OpenAI from "openai";
import { FileManifest, ExecutionContract, SubTask } from "../types";
import { MANIFEST_GENERATION_PROMPT } from "./prompts";

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
   * Generates a FileManifest JSON using OpenAI based on user request and contract constraints.
   */
  public async generateManifest(
    userRequest: string,
    repositoryContext: { existingFiles?: string[]; repoSnapshot?: any },
    contract: ExecutionContract,
    subTaskScope?: SubTask
  ): Promise<FileManifest> {
    const existingFileList = repositoryContext.existingFiles || [];

    let contextText = `USER REQUEST:\n${userRequest}\n\n`;
    contextText += `EXECUTION CONTRACT CONSTRAINTS:\n`;
    contextText += `- Task Goal: ${contract.goal}\n`;
    contextText += `- Pipeline: ${contract.pipeline}\n`;
    contextText += `- Environment: ${contract.environment}\n`;
    contextText += `- Max Files Allowed: ${contract.maxFiles}\n`;
    contextText += `- Target Paths: ${contract.targetPaths.join(", ") || "(project-wide)"}\n`;
    contextText += `- Allowed Actions: ${contract.allowedActions.join(", ")}\n`;
    contextText += `- Forbidden Actions: ${contract.forbiddenActions.join(", ")}\n\n`;

    if (subTaskScope) {
      contextText += `SUB-TASK SCOPE:\n`;
      contextText += `- SubTask ID: ${subTaskScope.id}\n`;
      contextText += `- Category: ${subTaskScope.category}\n`;
      contextText += `- Target Files: ${subTaskScope.targetFiles.join(", ")}\n`;
      contextText += `- Dependencies: ${subTaskScope.dependencies.join(", ")}\n\n`;
    }

    contextText += `EXISTING REPOSITORY FILES (SAMPLE):\n`;
    contextText += existingFileList.slice(0, 50).map((f) => `- ${f}`).join("\n");
    if (existingFileList.length > 50) {
      contextText += `\n... and ${existingFileList.length - 50} more files.`;
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
      // Fallback minimal manifest to avoid breaking process
      return this.buildFallbackManifest(userRequest, contract, subTaskScope);
    }
  }

  /**
   * Validates and normalizes raw parsed JSON into a valid FileManifest structure.
   */
  private normalizeParsedManifest(parsed: any, contract: ExecutionContract): FileManifest {
    const filesArray = Array.isArray(parsed.files) ? parsed.files : [];

    const normalizedFiles = filesArray.map((f: any, idx: number) => ({
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
  }

  /**
   * Builds a safe fallback manifest when LLM invocation or JSON parsing fails.
   */
  private buildFallbackManifest(
    userRequest: string,
    contract: ExecutionContract,
    subTaskScope?: SubTask
  ): FileManifest {
    if (contract.pipeline === "STANDALONE" || contract.environment === "HTML_CSS_JS") {
      return {
        files: [
          {
            path: "index.html",
            action: "create",
            dependencies: ["./style.css", "./script.js"],
            description: "Main HTML page",
          },
          {
            path: "style.css",
            action: "create",
            dependencies: [],
            description: "CSS styling sheet",
          },
          {
            path: "script.js",
            action: "create",
            dependencies: [],
            description: "JS logic file",
          },
        ],
        totalFiles: 3,
        manifestVersion: "1.0.0",
      };
    }

    if (subTaskScope && subTaskScope.targetFiles.length > 0) {
      const files = subTaskScope.targetFiles.map((tf) => ({
        path: tf,
        action: "create" as const,
        dependencies: [],
        description: `Target file for ${subTaskScope.category}`,
      }));
      return {
        files,
        totalFiles: files.length,
        manifestVersion: "1.0.0",
      };
    }

    const defaultPath = contract.targetPaths.length > 0 && !contract.targetPaths.includes("project-wide")
      ? `${contract.targetPaths[0]}/index.ts`
      : "src/index.ts";

    return {
      files: [
        {
          path: defaultPath,
          action: "create",
          dependencies: [],
          description: "Fallback manifest file entry",
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
  }
}
