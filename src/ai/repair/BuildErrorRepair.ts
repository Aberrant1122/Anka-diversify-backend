import { getOpenAI } from "../shared/utils";
import { AgentFileChange } from "../shared/types";
import { ValidationRunner } from "../validation/ValidationRunner";
import { buildSelfHealingRepairPrompt } from "../prompts/repair";

export class BuildErrorRepair {
  static async runBuildErrorRepairPass(
    changes: AgentFileChange[],
    localPath: string | null | undefined,
    commands: string[],
    originalMessage: string,
    errorLog: string,
  ): Promise<{ finalChanges: AgentFileChange[]; success: boolean; errorLog?: string }> {
    if (!changes.length || !errorLog) {
      return { finalChanges: changes, success: false, errorLog };
    }

    try {
      const openai = getOpenAI();
      const prompt = buildSelfHealingRepairPrompt({
        errorLog,
        changes,
        originalMessage,
      });

      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: prompt.user },
        ],
        temperature: 0.1,
        max_tokens: 8000,
        response_format: { type: "json_object" },
      });

      const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
      if (Array.isArray(parsed.changes) && parsed.changes.length > 0) {
        const repairMap = new Map<string, AgentFileChange>(parsed.changes.map((c: AgentFileChange) => [c.path, c]));
        const merged: AgentFileChange[] = changes.map((c) => repairMap.get(c.path) || c);
        for (const [p, c] of repairMap) {
          if (!merged.find((m) => m.path === p)) merged.push(c as AgentFileChange);
        }

        if (localPath && commands.length > 0) {
          const val = await ValidationRunner.validateWithShell(merged, localPath, commands);
          if (val.success) {
            return { finalChanges: merged, success: true, errorLog: "" };
          }
          return { finalChanges: merged, success: false, errorLog: val.errors };
        }
        return { finalChanges: merged, success: true, errorLog: "" };
      }
    } catch {}

    return { finalChanges: changes, success: false, errorLog };
  }
}
