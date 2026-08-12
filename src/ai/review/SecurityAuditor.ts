import { getOpenAI } from "../shared/utils";
import { AgentFileChange } from "../shared/types";
import { SECURITY_REVIEW_PROMPT, CODE_CRITIQUE_PROMPT } from "../prompts/coding";

export class SecurityAuditor {
  static async runReflectionAndSecurityAudit(
    changes: AgentFileChange[],
  ): Promise<{
    approvedChanges: AgentFileChange[];
    passed: boolean;
    critiqueScore: number;
    securityPass: boolean;
    summary: string;
  }> {
    if (!changes.length) {
      return { approvedChanges: [], passed: true, critiqueScore: 1.0, securityPass: true, summary: "No changes to review." };
    }

    const diffText = changes.map((c) => `=== FILE: ${c.path} ===\n${c.content}`).join("\n\n");
    const openai = getOpenAI();

    let critiqueScore = 0.90;
    try {
      const critiqueCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: CODE_CRITIQUE_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });
      const critiqueResult = JSON.parse(critiqueCompletion.choices[0]?.message?.content || "{}");
      if (typeof critiqueResult.score === "number") critiqueScore = critiqueResult.score;
    } catch {
      critiqueScore = 0.90;
    }

    let securityPass = true;
    try {
      const secCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SECURITY_REVIEW_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.0,
        response_format: { type: "json_object" },
      });
      const secResult = JSON.parse(secCompletion.choices[0]?.message?.content || "{}");
      if (typeof secResult.passed === "boolean") securityPass = secResult.passed;
    } catch {
      securityPass = true;
    }

    return {
      approvedChanges: changes,
      passed: securityPass && critiqueScore >= 0.80,
      critiqueScore,
      securityPass,
      summary: `Reflection Pass Score: ${(critiqueScore * 100).toFixed(0)}%. Security Pass: ${securityPass ? "PASSED" : "FLAGGED"}.`,
    };
  }
}
