import { PrismaClient } from "@prisma/client";
import { GitHubService } from "./GitHubService";
import { decrypt } from "../../utils/encryption";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";

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

    const result = await LLMGateway.getInstance().callStructured<{ title: string; description: string }>({
      stage: PipelineStages.SUMMARIZATION,
      model: "gpt-4o",
      temperature: 0.4,
      maxTokens: 800,
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
      schema: {
        name: "PullRequestDescriptionSchema",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["title", "description"],
          properties: {
            title: { type: "string", minLength: 1, maxLength: 72 },
            description: { type: "string", minLength: 1 },
          },
        },
        validate: (value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Description must be an object"] };
          const description = value as Record<string, unknown>;
          if (Object.keys(description).some((key) => !["title", "description"].includes(key)) || typeof description.title !== "string" || !description.title.trim() || description.title.length > 72 || typeof description.description !== "string" || !description.description.trim()) return { valid: false, errors: ["Description fields are invalid"] };
          return { valid: true, data: description as unknown as { title: string; description: string } };
        },
      },
    });
    return result.content;
  }
}
