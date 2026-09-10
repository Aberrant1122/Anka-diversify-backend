import fs from "fs";
import path from "path";
import { AgentFileChange, ExecutionContract } from "../shared/types";
import { ValidationRunner } from "../validation/ValidationRunner";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { buildSelfHealingRepairPrompt } from "../prompts/repair";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { isLLMError } from "../gateway/LLMError";

interface BuildRepairPayload {
  changes: AgentFileChange[];
}

function normalizeRepairPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function isSafeRepairPath(value: string): boolean {
  if (!value || value !== value.trim() || value.includes("\0")) return false;
  const normalized = normalizeRepairPath(value);
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return normalized.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

export class BuildErrorRepair {
  static async runBuildErrorRepairPass(
    changes: AgentFileChange[],
    localPath: string | null | undefined,
    commands: string[],
    originalMessage: string,
    errorLog: string,
    fsManager?: FileSystemStateManager,
    executionContract?: ExecutionContract | null,
  ): Promise<{ finalChanges: AgentFileChange[]; success: boolean; errorLog?: string }> {
    if (!changes.length || !errorLog) {
      return { finalChanges: changes, success: false, errorLog };
    }

    // AI Step 9A: Disable legacy full-file repair fallback for REPOSITORY pipeline
    if (executionContract?.pipeline === "REPOSITORY") {
      return { finalChanges: changes, success: false, errorLog };
    }

    try {
      const prompt = buildSelfHealingRepairPrompt({
        errorLog,
        changes,
        originalMessage,
        outputContract: "fullContent",
      });

      const allowedChanges = new Map(changes.map((change) => [normalizeRepairPath(change.path), change]));
      const result = await LLMGateway.getInstance().callStructured<BuildRepairPayload>({
        stage: PipelineStages.REPAIR,
        model: "gpt-4o",
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: 0.1,
        maxTokens: 8000,
        schema: {
          name: "BuildErrorRepairSchema",
          strict: false,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["changes"],
            properties: {
              changes: {
                type: "array",
                minItems: 1,
                items: {
                  oneOf: [
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["path", "content", "description", "action"],
                      properties: {
                        path: { type: "string", minLength: 1 },
                        content: { type: "string", minLength: 1 },
                        description: { type: "string", minLength: 1 },
                        action: { const: "create" },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["path", "content", "description", "action"],
                      properties: {
                        path: { type: "string", minLength: 1 },
                        content: { type: "string", minLength: 1 },
                        description: { type: "string", minLength: 1 },
                        action: { const: "modify" },
                      },
                    },
                    {
                      type: "object",
                      additionalProperties: false,
                      required: ["path", "content", "description", "action", "isDeleted"],
                      properties: {
                        path: { type: "string", minLength: 1 },
                        content: { const: "" },
                        description: { type: "string", minLength: 1 },
                        action: { const: "delete" },
                        isDeleted: { const: true },
                      },
                    },
                  ],
                },
              },
            },
          },
          validate: (value: unknown) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Repair payload must be an object"] };
            const payload = value as Record<string, unknown>;
            if (Object.keys(payload).some((key) => key !== "changes") || !Array.isArray(payload.changes) || payload.changes.length === 0) {
              return { valid: false, errors: ["Repair payload must contain only a non-empty changes array"] };
            }
            for (const item of payload.changes) {
              if (!item || typeof item !== "object" || Array.isArray(item)) return { valid: false, errors: ["Repair change must be an object"] };
              const change = item as Record<string, unknown>;
              const allowedKeys = new Set(["path", "content", "description", "action", "isDeleted"]);
              if (Object.keys(change).some((key) => !allowedKeys.has(key))) return { valid: false, errors: ["Repair change contains unknown fields"] };
              if (typeof change.path !== "string" || !isSafeRepairPath(change.path) || typeof change.content !== "string" || typeof change.description !== "string" || change.description.trim().length === 0 || !["create", "modify", "delete"].includes(String(change.action))) {
                return { valid: false, errors: ["Repair change fields are invalid"] };
              }
              const original = allowedChanges.get(normalizeRepairPath(change.path));
              if (!original) return { valid: false, errors: ["Repair path is outside the supplied change set"] };
              if (original.action && change.action !== original.action) return { valid: false, errors: ["Repair action does not match the supplied change"] };
              if (change.action === "delete") {
                if (change.content !== "" || change.isDeleted !== true) return { valid: false, errors: ["Delete repair shape is invalid"] };
              } else if (change.content.length === 0 || change.isDeleted !== undefined) {
                return { valid: false, errors: ["Writable repair requires non-empty content and cannot be marked deleted"] };
              }
            }
            return { valid: true, data: payload as unknown as BuildRepairPayload };
          },
        },
      });

      if (result.content.changes.length > 0) {
        const repairMap = new Map<string, AgentFileChange>(result.content.changes.map((c) => [c.path, c]));
        const merged: AgentFileChange[] = changes.map((c) => repairMap.get(c.path) || c);
        for (const [p, c] of repairMap) {
          if (!merged.find((m) => m.path === p)) merged.push(c as AgentFileChange);
        }

        if (localPath && commands.length > 0) {
          if (fsManager) {
            await fsManager.apply(merged, localPath);
          } else {
            for (const change of merged) {
              try {
                const abs = path.join(localPath, change.path);
                if (change.action === "delete" || change.isDeleted) {
                  if (fs.existsSync(abs)) await fs.promises.rm(abs, { recursive: true, force: true });
                } else {
                  await fs.promises.mkdir(path.dirname(abs), { recursive: true });
                  await fs.promises.writeFile(abs, change.content, "utf8");
                }
              } catch {}
            }
          }

          const val = await ValidationRunner.validateWithShell(merged, localPath, commands);
          if (val.success) {
            return { finalChanges: merged, success: true, errorLog: "" };
          }
          return { finalChanges: merged, success: false, errorLog: val.errors };
        }
        // Without a deterministic build command, this remains a repair proposal only.
        return { finalChanges: merged, success: false, errorLog };
      }
    } catch (error) {
      if (isLLMError(error)) throw error;
    }

    return { finalChanges: changes, success: false, errorLog };
  }
}
