import { PrismaClient } from "@prisma/client";
import { getOpenAI } from "../shared/utils";
import { GitHubService } from "./GitHubService";
import { decrypt } from "../../utils/encryption";

const prisma = new PrismaClient();

export class PullRequestDescription {
  static async generatePRDescription(projectId: string, prNumber: number): Promise<{ title: string; description: string }> {
    const project = await prisma.project.findUnique({ where: { id: projectId } });
    if (!project?.githubUrl) throw new Error("No GitHub repository connected to this project");

    const token = project.githubToken ? decrypt(project.githubToken) : undefined;

    const [diff, prs] = await Promise.all([
      GitHubService.getPullRequestDiff(project.githubUrl, prNumber, token),
      GitHubService.listPullRequests(project.githubUrl, token),
    ]);

    const pr = prs.find((p) => p.number === prNumber);
    const prMeta = pr
      ? `Branch: ${pr.headBranch} → ${pr.baseBranch}\nChanged files: ${pr.changedFiles}, +${pr.additions} -${pr.deletions} lines`
      : `PR #${prNumber}`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      temperature: 0.4,
      max_tokens: 800,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a senior engineer writing a GitHub pull request description. Based on the diff, produce a clear, professional PR description.
Return JSON: { "title": "concise PR title under 72 chars", "description": "markdown body with ## Summary, ## Changes, ## Testing sections" }`,
        },
        {
          role: "user",
          content: `${prMeta}\n\n--- DIFF ---\n${diff.slice(0, 8000)}`,
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    try {
      return JSON.parse(raw) as { title: string; description: string };
    } catch {
      return { title: pr?.title || `PR #${prNumber}`, description: "Could not generate description." };
    }
  }
}
