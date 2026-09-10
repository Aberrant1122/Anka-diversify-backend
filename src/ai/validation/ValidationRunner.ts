import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { AgentFileChange } from "../shared/types";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";

import { ValidationEnvironmentPolicy } from "./ValidationEnvironmentPolicy";

const execAsync = promisify(exec);

interface StaticReviewAdvisory {
  suspectedCriticalErrors: boolean;
  findings: string[];
  analysis: string;
  recommendations: string[];
}

const staticReviewAdvisorySchema = {
  name: "StaticReviewAdvisorySchema",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["suspectedCriticalErrors", "findings", "analysis", "recommendations"],
    properties: {
      suspectedCriticalErrors: { type: "boolean" },
      findings: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
      analysis: { type: "string", minLength: 1 },
      recommendations: { type: "array", maxItems: 50, items: { type: "string", minLength: 1 } },
    },
  },
  validate: (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { valid: false, errors: ["Static review advisory must be an object"] };
    }
    const advisory = value as Record<string, unknown>;
    const allowedKeys = ["suspectedCriticalErrors", "findings", "analysis", "recommendations"];
    if (
      Object.keys(advisory).some((key) => !allowedKeys.includes(key)) ||
      typeof advisory.suspectedCriticalErrors !== "boolean" ||
      !Array.isArray(advisory.findings) ||
      advisory.findings.length > 50 ||
      typeof advisory.analysis !== "string" || !advisory.analysis.trim() ||
      !Array.isArray(advisory.recommendations) ||
      advisory.recommendations.length > 50
    ) {
      return { valid: false, errors: ["Static review advisory fields are invalid"] };
    }
    if (
      advisory.findings.some((item) => typeof item !== "string" || !item.trim()) ||
      advisory.recommendations.some((item) => typeof item !== "string" || !item.trim())
    ) {
      return { valid: false, errors: ["Static review advisory entries are invalid"] };
    }
    return { valid: true, data: advisory as unknown as StaticReviewAdvisory };
  },
};

export class ValidationRunner {
  static async validateWithShell(
    _changes: AgentFileChange[],
    localPath: string | null | undefined,
    commands: string[],
  ): Promise<{ success: boolean; errors: string; warnings?: string[] }> {
    if (!localPath) {
      return { success: false, errors: "Validation failed: localPath is missing, null, or undefined." };
    }

    try {
      const stat = await fs.promises.stat(localPath);
      if (!stat.isDirectory()) {
        return { success: false, errors: `Validation failed: localPath "${localPath}" is not a directory.` };
      }
    } catch {
      return { success: false, errors: `Validation failed: localPath "${localPath}" does not exist or is inaccessible.` };
    }

    const executableCommands = commands.slice(0, 2).filter((command) => typeof command === "string" && command.trim().length > 0);
    if (executableCommands.length === 0) {
      return {
        success: false,
        errors: "Validation remains unverified: no deterministic validation commands were executed.",
      };
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    for (const cmd of executableCommands) {
      const env = ValidationEnvironmentPolicy.getSanitizedEnv(cmd);
      try {
        const { stdout, stderr } = await execAsync(cmd, {
          cwd: localPath,
          env,
          timeout: 60000,
        });

        // When execAsync succeeds, the command exited with code 0
        const stderrStr = String(stderr || "").trim();
        if (stderrStr) {
          warnings.push(`${cmd} warning:\n${stderrStr.slice(0, 1500)}`);
        }
      } catch (err: any) {
        // execAsync threw an error -> non-zero exit code or timeout
        const stdoutStr = err.stdout ? String(err.stdout) : "";
        const stderrStr = err.stderr ? String(err.stderr) : "";
        const msgStr = err.message ? String(err.message) : "";
        const fullErr = (stdoutStr + "\n" + stderrStr + "\n" + msgStr).trim();
        errors.push(`${cmd} failed (exit code ${err.code || "unknown"}):\n${fullErr.slice(0, 3000)}`);
      }
    }

    return errors.length === 0
      ? { success: true, errors: "", warnings }
      : { success: false, errors: errors.join("\n\n"), warnings };
  }

  static async selfReviewChanges(changes: AgentFileChange[]): Promise<{ success: boolean; errors: string; warnings?: string[] }> {
    if (!changes.length) return { success: true, errors: "" };

    const changesText = changes.map((c) => `=== ${c.path} ===\n${c.content}`).join("\n\n");

    try {
      const review = await LLMGateway.getInstance().callStructured<StaticReviewAdvisory>({
        stage: PipelineStages.STATIC_REVIEW,
        messages: [
          {
            role: "system",
            content: `You are an advisory static-code reviewer.
Analyze proposed file changes for suspected syntax or compilation problems.
Your response is an advisory assessment only. It does not establish validation success or failure.

Respond ONLY with valid JSON:
{
  "suspectedCriticalErrors": boolean,
  "findings": ["suspected issue"],
  "analysis": "advisory explanation",
  "recommendations": ["recommended deterministic check"]
}`,
          },
          { role: "user", content: changesText },
        ],
        temperature: 0,
        maxTokens: 2000,
        schema: staticReviewAdvisorySchema,
      });

      const advisoryDetails = [
        ...review.content.findings,
        review.content.analysis.trim(),
        ...review.content.recommendations.map((item) => `Recommendation: ${item}`),
      ].filter(Boolean).join("\n");
      return {
        success: false,
        errors: "Deterministic validation was not run; validation remains unverified.",
        warnings: advisoryDetails ? [`Model advisory: ${advisoryDetails}`] : [],
      };
    } catch {
      return {
        success: false,
        errors: "Deterministic validation was not run; validation remains unverified.",
        warnings: ["Advisory model review was unavailable."],
      };
    }
  }
}
