import { PrismaClient } from "@prisma/client";
import { PRReview } from "../shared/types";
import { GitHubService } from "./GitHubService";
import { decrypt } from "../../utils/encryption";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";

const prisma = new PrismaClient();

export class PullRequestReviewer {
  static async reviewPullRequest(projectId: string, prNumber: number): Promise<PRReview> {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project?.githubUrl) throw new Error("No GitHub repository connected to this project");

    const token = project.githubToken ? decrypt(project.githubToken) : undefined;

    const [diff, prs] = await Promise.all([
      GitHubService.getPullRequestDiff(project.githubUrl, prNumber, token),
      GitHubService.listPullRequests(project.githubUrl, token),
    ]);

    const pr = prs.find((p) => p.number === prNumber);
    const prMeta = pr
      ? `PR #${pr.number}: ${pr.title}\nAuthor: ${pr.author}\nBranch: ${pr.headBranch} → ${pr.baseBranch}\n${pr.body ? `\nDescription:\n${pr.body}` : ""}`
      : `PR #${prNumber}`;

    const result = await LLMGateway.getInstance().callStructured<PRReview>({
      stage: PipelineStages.STATIC_REVIEW,
      model: "gpt-4o",
      temperature: 0.3,
      maxTokens: 1500,
      messages: [
        {
          role: "system",
          content: `You are a senior code reviewer. Analyze the pull request diff and return a JSON object with:
{
  "summary": "2-3 sentence overview of what this PR does",
  "risks": ["list of specific risks, bugs, or security concerns found in the diff"],
  "suggestions": ["list of concrete improvement suggestions"],
  "verdict": "approve" | "request_changes" | "needs_discussion",
  "qualityScore": 0-100
}
Be specific and reference actual code from the diff. Keep each risk/suggestion under 120 characters.`,
        },
        {
          role: "user",
          content: `${prMeta}\n\n--- DIFF ---\n${diff}`,
        },
      ],
      schema: {
        name: "PullRequestReviewSchema",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["summary", "risks", "suggestions", "verdict", "qualityScore"],
          properties: {
            summary: { type: "string", minLength: 1 },
            risks: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 120 } },
            suggestions: { type: "array", maxItems: 50, items: { type: "string", minLength: 1, maxLength: 120 } },
            verdict: { type: "string", enum: ["approve", "request_changes", "needs_discussion"] },
            qualityScore: { type: "number", minimum: 0, maximum: 100 },
          },
        },
        validate: (value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Review must be an object"] };
          const review = value as Record<string, unknown>;
          if (Object.keys(review).some((key) => !["summary", "risks", "suggestions", "verdict", "qualityScore"].includes(key))) return { valid: false, errors: ["Review contains unknown fields"] };
          if (typeof review.summary !== "string" || !review.summary.trim() || !Array.isArray(review.risks) || !Array.isArray(review.suggestions) || !["approve", "request_changes", "needs_discussion"].includes(String(review.verdict)) || typeof review.qualityScore !== "number" || !Number.isFinite(review.qualityScore) || review.qualityScore < 0 || review.qualityScore > 100) return { valid: false, errors: ["Review fields are invalid"] };
          if (review.risks.some((item) => typeof item !== "string" || !item.trim() || item.length > 120) || review.suggestions.some((item) => typeof item !== "string" || !item.trim() || item.length > 120)) return { valid: false, errors: ["Review lists are invalid"] };
          return { valid: true, data: review as unknown as PRReview };
        },
      },
    });
    return result.content;
  }
}
