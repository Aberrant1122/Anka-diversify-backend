import { AgentFileChange } from "../shared/types";
import { CODE_CRITIQUE_PROMPT } from "../prompts/coding";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";

export class CodeCritic {
  static async critique(changes: AgentFileChange[]): Promise<{ score: number; passed: boolean; critique: string[] }> {
    if (!changes.length) return { score: 1.0, passed: true, critique: [] };

    const diffText = changes.map((c) => `=== FILE: ${c.path} ===\n${c.content}`).join("\n\n");
    const result = await LLMGateway.getInstance().callStructured<{ score: number; passed: boolean; critique: string[]; improvements: string }>({
        stage: PipelineStages.STATIC_REVIEW,
        model: "gpt-4o",
        messages: [
          { role: "system", content: CODE_CRITIQUE_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.1,
        schema: {
          name: "CodeCritiqueSchema",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["score", "passed", "critique", "improvements"],
            properties: {
              score: { type: "number", minimum: 0, maximum: 1 },
              passed: { type: "boolean" },
              critique: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
              improvements: { type: "string" },
            },
          },
          validate: (value: unknown) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Critique must be an object"] };
            const critique = value as Record<string, unknown>;
            if (Object.keys(critique).some((key) => !["score", "passed", "critique", "improvements"].includes(key)) || typeof critique.score !== "number" || !Number.isFinite(critique.score) || critique.score < 0 || critique.score > 1 || typeof critique.passed !== "boolean" || !Array.isArray(critique.critique) || typeof critique.improvements !== "string") return { valid: false, errors: ["Critique fields are invalid"] };
            if (critique.critique.some((item) => typeof item !== "string" || !item.trim())) return { valid: false, errors: ["Critique entries are invalid"] };
            return { valid: true, data: critique as unknown as { score: number; passed: boolean; critique: string[]; improvements: string } };
          },
        },
      });
      return { score: result.content.score, passed: result.content.passed, critique: result.content.critique };
  }
}
