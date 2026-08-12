import { PrismaClient } from "@prisma/client";
import { getOpenAI } from "../shared/utils";
import { PRReview } from "../shared/types";
import { GitHubService } from "./GitHubService";
import { decrypt } from "../../utils/encryption";

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

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.3,
      max_tokens: 1500,
      response_format: { type: "json_object" },
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
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    try {
      return JSON.parse(raw) as PRReview;
    } catch {
      return {
        summary: "Could not parse AI review response.",
        risks: [],
        suggestions: [],
        verdict: "needs_discussion",
        qualityScore: 50,
      };
    }
  }
}
