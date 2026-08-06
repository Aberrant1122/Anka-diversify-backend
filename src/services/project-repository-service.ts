import { PrismaClient } from "@prisma/client";
import { encrypt, decrypt, validateGitHubToken } from "../utils/encryption";
import { ProjectGitHubService } from "./github.service";

const prisma = new PrismaClient();

const VALID_ROLES = [
  "frontend",
  "backend",
  "mobile",
  "infrastructure",
  "shared_library",
  "documentation",
  "data",
  "custom",
];

export interface CreateProjectRepositoryInput {
  name: string;
  role: string;
  githubUrl: string;
  githubToken?: string;
  localPath?: string;
  defaultBranch?: string;
  languages?: string[];
  frameworks?: string[];
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  ownerUserId?: string;
}

function redact<T extends { githubToken?: string | null }>(repo: T) {
  const { githubToken, ...rest } = repo;
  return { ...rest, hasToken: Boolean(githubToken) };
}

export class ProjectRepositoryService {
  async list(projectId: string) {
    const repos = await prisma.projectRepository.findMany({
      where: { projectId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });
    return repos.map(redact);
  }

  async create(projectId: string, input: CreateProjectRepositoryInput) {
    if (!input.name || !input.githubUrl) {
      throw new Error("name and githubUrl are required");
    }
    const role = VALID_ROLES.includes(input.role) ? input.role : "custom";

    let encryptedToken: string | undefined;
    if (input.githubToken) {
      const validation = await validateGitHubToken(input.githubToken);
      if (!validation.valid) {
        throw new Error(validation.error || "Invalid GitHub token");
      }
      encryptedToken = encrypt(input.githubToken);
    }

    const repo = await prisma.projectRepository.create({
      data: {
        projectId,
        name: input.name,
        role,
        githubUrl: input.githubUrl,
        githubToken: encryptedToken,
        localPath: input.localPath,
        defaultBranch: input.defaultBranch || "main",
        languages: input.languages as any,
        frameworks: input.frameworks as any,
        buildCommand: input.buildCommand,
        testCommand: input.testCommand,
        lintCommand: input.lintCommand,
        typecheckCommand: input.typecheckCommand,
        ownerUserId: input.ownerUserId,
        isPrimary: false,
      },
    });
    return redact(repo);
  }

  async update(projectId: string, repoId: string, input: Partial<CreateProjectRepositoryInput>) {
    const existing = await prisma.projectRepository.findFirst({ where: { id: repoId, projectId } });
    if (!existing) throw new Error("Repository not found");

    let encryptedToken: string | undefined | null = undefined;
    if (input.githubToken) {
      const validation = await validateGitHubToken(input.githubToken);
      if (!validation.valid) {
        throw new Error(validation.error || "Invalid GitHub token");
      }
      encryptedToken = encrypt(input.githubToken);
    }

    const repo = await prisma.projectRepository.update({
      where: { id: repoId },
      data: {
        name: input.name,
        role: input.role && VALID_ROLES.includes(input.role) ? input.role : undefined,
        githubUrl: input.githubUrl,
        githubToken: encryptedToken,
        localPath: input.localPath,
        defaultBranch: input.defaultBranch,
        languages: input.languages as any,
        frameworks: input.frameworks as any,
        buildCommand: input.buildCommand,
        testCommand: input.testCommand,
        lintCommand: input.lintCommand,
        typecheckCommand: input.typecheckCommand,
        ownerUserId: input.ownerUserId,
      },
    });
    return redact(repo);
  }

  async remove(projectId: string, repoId: string) {
    const existing = await prisma.projectRepository.findFirst({ where: { id: repoId, projectId } });
    if (!existing) throw new Error("Repository not found");
    if (existing.isPrimary) {
      throw new Error("Cannot delete the primary repository — update the project's main GitHub connection instead");
    }
    await prisma.projectRepository.delete({ where: { id: repoId } });
  }

  // Internal helper for future coordinator/repo-worker use — decrypted token, not exposed over HTTP.
  async getDecryptedToken(repoId: string): Promise<string | undefined> {
    const repo = await prisma.projectRepository.findUnique({ where: { id: repoId } });
    if (!repo?.githubToken) return undefined;
    return decrypt(repo.githubToken);
  }

  // Pulls a fresh repo snapshot into RepositorySnapshot so the AI agent can be
  // pointed at this repo (see ai-service.ts runCodingAgent's repositoryId param).
  async sync(projectId: string, repoId: string) {
    const repo = await prisma.projectRepository.findFirst({ where: { id: repoId, projectId } });
    if (!repo) throw new Error("Repository not found");

    const token = repo.githubToken ? decrypt(repo.githubToken) : undefined;
    await ProjectGitHubService.buildRepositoryContext(repo.id, repo.githubUrl, token);

    const snapshot = await prisma.repositorySnapshot.findUnique({ where: { repositoryId: repo.id } });
    return snapshot;
  }
}
