import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { getOpenAI } from "../shared/utils";
import { AgentFileChange } from "../shared/types";

const execAsync = promisify(exec);

export class ValidationRunner {
  static async validateWithShell(
    changes: AgentFileChange[],
    localPath: string,
    commands: string[],
  ): Promise<{ success: boolean; errors: string }> {
    for (const change of changes) {
      const abs = path.join(localPath, change.path);
      if (change.action === "delete" || change.isDeleted) {
        if (fs.existsSync(abs)) {
          await fs.promises.rm(abs, { recursive: true, force: true });
        }
      } else {
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, change.content, "utf8");
      }
    }

    const errors: string[] = [];
    for (const cmd of commands.slice(0, 2)) {
      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: localPath, timeout: 60000 });
        const out = String(stdout || "") + "\n" + String(stderr || "");
        if (/error TS|Error:|✖|FAILED|Failed to compile|SyntaxError/i.test(out)) {
          errors.push(`${cmd}:\n${out.slice(0, 3000)}`);
        }
      } catch (err: any) {
        const stdoutStr = err.stdout ? String(err.stdout) : "";
        const stderrStr = err.stderr ? String(err.stderr) : "";
        const msgStr = err.message ? String(err.message) : "";
        const fullErr = (stdoutStr + "\n" + stderrStr + "\n" + msgStr).trim();
        errors.push(`${cmd} failed (exit code ${err.code || "unknown"}):\n${fullErr.slice(0, 3000)}`);
      }
    }

    return errors.length === 0 ? { success: true, errors: "" } : { success: false, errors: errors.join("\n\n") };
  }

  static async selfReviewChanges(changes: AgentFileChange[]): Promise<{ success: boolean; errors: string }> {
    if (!changes.length) return { success: true, errors: "" };

    const changesText = changes.map((c) => `=== ${c.path} ===\n${c.content}`).join("\n\n");
    const openai = getOpenAI();

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

    try {
      const result = JSON.parse(completion.choices[0]?.message?.content || "{}");
      const hasCritical = typeof result.hasCriticalErrors === "boolean" ? result.hasCriticalErrors : Boolean(result.hasErrors && result.errors);
      const errorMsg = result.criticalErrors || (hasCritical ? result.errors : "") || "";
      return { success: !hasCritical, errors: errorMsg };
    } catch {
      return { success: true, errors: "" };
    }
  }
}
