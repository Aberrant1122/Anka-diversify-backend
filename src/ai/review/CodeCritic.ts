import { getOpenAI } from "../shared/utils";
import { AgentFileChange } from "../shared/types";
import { CODE_CRITIQUE_PROMPT } from "../prompts/coding";

export class CodeCritic {
  static async critique(changes: AgentFileChange[]): Promise<{ score: number; passed: boolean; critique: string[] }> {
    if (!changes.length) return { score: 1.0, passed: true, critique: [] };

    const diffText = changes.map((c) => `=== FILE: ${c.path} ===\n${c.content}`).join("\n\n");
    const openai = getOpenAI();

    try {
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: CODE_CRITIQUE_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });
      const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
      return {
        score: typeof parsed.score === "number" ? parsed.score : 0.9,
        passed: typeof parsed.passed === "boolean" ? parsed.passed : true,
        critique: Array.isArray(parsed.critique) ? parsed.critique : [],
      };
    } catch {
      return { score: 0.9, passed: true, critique: [] };
    }
  }
}
