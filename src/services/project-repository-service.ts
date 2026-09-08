import fs from "fs";
import path from "path";
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

function deriveRepoName(githubUrl?: string | null, fallbackName?: string | null): string {
  if (githubUrl) {
    try {
      const parsed = new URL(githubUrl.trim());
      const parts = parsed.pathname.split("/").filter(Boolean);
      if (parts.length >= 2) {
        const repo = parts[1].replace(/\.git$/, "");
        if (repo) return repo;
      }
    } catch {
      const match = githubUrl.match(/[\/:]([^\/:]+?)(\.git)?$/);
      if (match && match[1]) return match[1];
    }
  }
  return fallbackName || "main";
}

function resolveLocalPath(githubUrl?: string | null, localPath?: string | null): string | null {
  if (localPath && fs.existsSync(localPath)) {
    return localPath;
  }
  if (githubUrl) {
    const candidateDirs = [
      path.resolve(process.cwd(), "..", "anka evaluation"),
      path.resolve(process.env.USERPROFILE || "C:\\Users\\PCC", "Desktop", "anka evaluation"),
    ];
    for (const parentDir of candidateDirs) {
      if (fs.existsSync(parentDir)) {
        try {
          const entries = fs.readdirSync(parentDir);
          for (const entry of entries) {
            const fullPath = path.join(parentDir, entry);
            try {
              const gitConfigPath = path.join(fullPath, ".git", "config");
              if (fs.existsSync(gitConfigPath)) {
                const configContent = fs.readFileSync(gitConfigPath, "utf8");
                const cleanUrl = githubUrl.trim().replace(/\.git$/, "").toLowerCase();
                if (configContent.toLowerCase().includes(cleanUrl)) {
                  return fullPath;
                }
              }
            } catch {}
          }
        } catch {}
      }
    }
  }
  return localPath || null;
}

export class ProjectRepositoryService {
  /**
   * Idempotently ensures the project's primary Git repository has a persisted
   * ProjectRepository row (isPrimary=true).
   *
   * 1. If an isPrimary row already exists, returns it unchanged.
   * 2. If the project has no githubUrl, returns null safely.
   * 3. If the project has a githubUrl, creates and returns the primary row.
   */
  async ensurePrimaryRepository(projectId: string) {
    const existing = await prisma.projectRepository.findFirst({
      where: { projectId, isPrimary: true },
    });
    if (existing) {
      if (!existing.localPath) {
        const resolved = resolveLocalPath(existing.githubUrl, existing.localPath);
        if (resolved) {
          return prisma.projectRepository.update({
            where: { id: existing.id },
            data: { localPath: resolved },
          });
        }
      }
      return existing;
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true,
        githubUrl: true,
        githubToken: true,
        localPath: true,
        userId: true,
      },
    });

    if (!project || !project.githubUrl) {
      return null;
    }

    const name = deriveRepoName(project.githubUrl, project.name);
    const localPath = resolveLocalPath(project.githubUrl, project.localPath);
    const role = "backend";

    const repo = await prisma.projectRepository.create({
      data: {
        projectId: project.id,
        name,
        role,
        githubUrl: project.githubUrl,
        githubToken: project.githubToken, // Already encrypted AES-256-CBC
        localPath,
        defaultBranch: "main",
        isPrimary: true,
        ownerUserId: project.userId,
      },
    });

    return repo;
  }

  async list(projectId: string) {
    await this.ensurePrimaryRepository(projectId);

    const repos = await prisma.projectRepository.findMany({
      where: { projectId },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    });

    // Backfill any missing localPath on secondary repos if detected on disk
    for (const r of repos) {
      if (!r.localPath) {
        const resolved = resolveLocalPath(r.githubUrl, r.localPath);
        if (resolved) {
          await prisma.projectRepository.update({
            where: { id: r.id },
            data: { localPath: resolved },
          }).catch(() => {});
          r.localPath = resolved;
        }
      }
    }

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

  /**
   * Resolves repository configuration for agent execution.
   * If repositoryId is supplied, queries the specific ProjectRepository.
   * If repositoryId is omitted, queries the primary project repository.
   */
  async resolveRepositoryForAgent(projectId: string, repositoryId?: string) {
    if (repositoryId) {
      const repo = await prisma.projectRepository.findFirst({
        where: { id: repositoryId, projectId },
      });
      if (!repo) {
        throw new Error(`[REPOSITORY_NOT_FOUND] Repository "${repositoryId}" does not belong to project "${projectId}".`);
      }
      return {
        id: repo.id,
        name: repo.name,
        role: repo.role,
        localPath: repo.localPath,
        githubUrl: repo.githubUrl,
        defaultBranch: repo.defaultBranch,
        isPrimary: repo.isPrimary,
      };
    }

    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, name: true, localPath: true, githubUrl: true },
    });
    if (!project) {
      throw new Error(`[PROJECT_NOT_FOUND] Project "${projectId}" not found.`);
    }

    const primaryRepo = await prisma.projectRepository.findFirst({
      where: { projectId, isPrimary: true },
    });

    return {
      id: primaryRepo?.id || project.id,
      name: primaryRepo?.name || project.name || "primary",
      role: primaryRepo?.role || "backend",
      localPath: primaryRepo?.localPath || project.localPath || null,
      githubUrl: primaryRepo?.githubUrl || project.githubUrl || undefined,
      defaultBranch: primaryRepo?.defaultBranch || "main",
      isPrimary: true,
    };
  }
}
