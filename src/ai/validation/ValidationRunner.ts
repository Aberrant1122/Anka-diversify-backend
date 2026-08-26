import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { getOpenAI } from "../shared/utils";
import { AgentFileChange } from "../shared/types";

import { ValidationEnvironmentPolicy } from "./ValidationEnvironmentPolicy";

const execAsync = promisify(exec);

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

    const errors: string[] = [];
    const warnings: string[] = [];

    for (const cmd of commands.slice(0, 2)) {
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

  static async selfReviewChanges(changes: AgentFileChange[]): Promise<{ success: boolean; errors: string }> {
    if (!changes.length) return { success: true, errors: "" };

    const changesText = changes.map((c) => `=== ${c.path} ===\n${c.content}`).join("\n\n");
    const openai = getOpenAI();

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "system",
            content: `You are an Objective Static Code Auditor.
Analyze proposed file changes strictly for CRITICAL SYNTAX or COMPILATION ERRORS.

Respond ONLY with valid JSON:
{
  "hasCriticalErrors": boolean,
  "criticalErrors": "description if any",
  "suggestions": []
}`,
          },
          { role: "user", content: changesText },
        ],
        temperature: 0,
        max_tokens: 2000,
        response_format: { type: "json_object" },
      });

      const result = JSON.parse(completion.choices[0]?.message?.content || "{}");
      const hasCritical = typeof result.hasCriticalErrors === "boolean" ? result.hasCriticalErrors : Boolean(result.hasErrors && result.errors);
      const errorMsg = result.criticalErrors || (hasCritical ? result.errors : "") || "";
      return { success: !hasCritical, errors: errorMsg };
    } catch {
      return { success: false, errors: "LLM static review failed to return valid JSON." };
    }
  }
}
