import fs from "fs";
import path from "path";
import crypto from "crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { GitCommandExecutor, NodeGitCommandExecutor } from "./git-command";
import { GitWorktreeService } from "./git-worktree.service";
import { PlanningAuthorizationService } from "./planning-authorization.service";
import { currentImplementationAuthority, resolveImplementationAuthority } from "../planning/implementation-authority-preflight";
import { PlanningDomainError } from "../planning/planning-errors";
import {
  BootstrapTemplateRegistry,
  BootstrapTemplate,
  UnsupportedBootstrapTemplateError,
} from "./bootstrap-template-registry";
import {
  WorkspaceBoundaryValidator,
  WorkspaceBoundaryError,
} from "./workspace-boundary-validator";
import { encrypt } from "../utils/encryption";

export interface BindExistingRepositoryInput {
  localPath: string;
  name?: string;
  role?: string;
  defaultBranch?: string;
  githubUrl?: string;
  githubToken?: string;
  isPrimary?: boolean;
  languages?: string[];
  frameworks?: string[];
  buildCommand?: string;
  testCommand?: string;
}

export interface PrepareBootstrapPlanInput {
  templateId?: string;
  repositoryRoot?: string;
  idempotencyKey?: string;
  baseBranch?: string;
}

export interface ExecuteBootstrapInput {
  idempotencyKey: string;
  confirmation: boolean;
  repositoryRoot?: string;
  templateId?: string;
  name?: string;
  baseBranch?: string;
  githubUrl?: string;
}

export class RepositoryBootstrapError extends Error {
  constructor(public readonly code: string, message: string, public readonly status: number = 400) {
    super(`${code}: ${message}`);
    this.name = "RepositoryBootstrapError";
  }
}

export class RepositoryBootstrapService {
  private readonly authorization: PlanningAuthorizationService;
  private readonly git: GitCommandExecutor;

  constructor(
    private readonly prisma: PrismaClient,
    gitExecutor?: GitCommandExecutor
  ) {
    this.authorization = new PlanningAuthorizationService(prisma);
    this.git = gitExecutor || new NodeGitCommandExecutor();
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Path A: Bind Existing Repository
  // ───────────────────────────────────────────────────────────────────────────

  async bindExistingRepository(
    projectId: string,
    actorId: string,
    input: BindExistingRepositoryInput
  ) {
    // 1. Verify owner authorization
    await this.authorization.assertOwner(projectId, actorId);

    if (!input.localPath || typeof input.localPath !== "string") {
      throw new RepositoryBootstrapError("INVALID_PATH", "Repository localPath is required.", 400);
    }

    // 2. Canonicalize and validate path against approved workspace boundaries
    const canonicalPath = WorkspaceBoundaryValidator.canonicalizeAndValidate(input.localPath);

    // 3. Verify directory exists and is a directory
    if (!fs.existsSync(canonicalPath)) {
      throw new RepositoryBootstrapError("REPOSITORY_NOT_FOUND", `Directory "${canonicalPath}" does not exist.`, 404);
    }
    const stat = fs.statSync(canonicalPath);
    if (!stat.isDirectory()) {
      throw new RepositoryBootstrapError("INVALID_PATH", `Path "${canonicalPath}" is not a directory.`, 400);
    }

    // 4. Verify valid Git repository
    const repoRoot = await GitWorktreeService.resolveRepositoryRoot(canonicalPath);

    // 5. Verify valid initial commit and HEAD exist
    const headCommitSha = await GitWorktreeService.getHeadCommitSha(repoRoot);

    // 6. Verify configured base branch exists and resolves to a valid commit
    let baseBranch = input.defaultBranch?.trim();
    if (!baseBranch) {
      try {
        const { stdout: currentBranch } = await this.git.run(repoRoot, ["branch", "--show-current"]);
        baseBranch = currentBranch.trim();
      } catch {
        baseBranch = "main";
      }
    }
    if (!baseBranch) baseBranch = "main";

    // Verify branch exists or resolves
    try {
      const { stdout: branchRev } = await this.git.run(repoRoot, ["rev-parse", "--verify", baseBranch]);
      if (!branchRev.trim()) {
        throw new Error("Empty rev-parse");
      }
    } catch {
      // If base branch ref not found, verify if HEAD matches
      try {
        const { stdout: headRev } = await this.git.run(repoRoot, ["rev-parse", "--verify", "HEAD"]);
        if (!headRev.trim()) {
          throw new RepositoryBootstrapError("GIT_BRANCH_NOT_FOUND", `Branch "${baseBranch}" does not resolve to a commit.`, 400);
        }
      } catch {
        throw new RepositoryBootstrapError("GIT_BRANCH_NOT_FOUND", `Branch "${baseBranch}" does not resolve to a commit.`, 400);
      }
    }

    // 7. Cross-project binding check: ensure repository is not already bound to a different project
    const existingBinding = await this.prisma.projectRepository.findFirst({
      where: {
        localPath: repoRoot,
        projectId: { not: projectId },
      },
    });
    if (existingBinding) {
      throw new RepositoryBootstrapError(
        "CROSS_PROJECT_REPOSITORY_CONFLICT",
        `Repository at "${repoRoot}" is already bound to another project ("${existingBinding.projectId}").`,
        409
      );
    }

    // Check if already bound to this project
    const existingInProject = await this.prisma.projectRepository.findFirst({
      where: {
        projectId,
        localPath: repoRoot,
      },
    });
    if (existingInProject) {
      return existingInProject;
    }

    // 8. Remote URL format validation if provided (without automatically pushing)
    let encryptedToken: string | undefined;
    if (input.githubToken) {
      encryptedToken = encrypt(input.githubToken);
    }

    // 9. Persist ProjectRepository binding
    const isPrimary = input.isPrimary !== undefined ? input.isPrimary : true;
    const name = input.name?.trim() || path.basename(repoRoot);
    const role = input.role?.trim() || "backend";

    const repo = await this.prisma.$transaction(async (tx) => {
      const created = await tx.projectRepository.create({
        data: {
          projectId,
          name,
          role,
          githubUrl: input.githubUrl || "",
          githubToken: encryptedToken,
          localPath: repoRoot,
          defaultBranch: baseBranch,
          currentIndexedCommit: headCommitSha,
          isPrimary,
          ownerUserId: actorId,
          languages: input.languages as any,
          frameworks: input.frameworks as any,
          buildCommand: input.buildCommand,
          testCommand: input.testCommand,
        },
      });

      if (isPrimary) {
        await tx.project.update({
          where: { id: projectId },
          data: { localPath: repoRoot },
        });
      }

      return created;
    });

    return repo;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Path B: New Repository Bootstrap Plan
  // ───────────────────────────────────────────────────────────────────────────

  async prepareBootstrapPlan(
    projectId: string,
    actorId: string,
    input: PrepareBootstrapPlanInput = {}
  ) {
    // 1. Verify owner authorization
    await this.authorization.assertOwner(projectId, actorId);

    // 2. Detect if an active primary repository is already bound
    const existingPrimary = await this.prisma.projectRepository.findFirst({
      where: { projectId, isPrimary: true },
    });
    if (existingPrimary && existingPrimary.localPath && fs.existsSync(existingPrimary.localPath)) {
      throw new RepositoryBootstrapError(
        "REPOSITORY_ALREADY_BOUND",
        `Project already has an active bound repository at "${existingPrimary.localPath}".`,
        409
      );
    }

    // 3. Require current approved Architecture authority
    const accepted = await currentImplementationAuthority(this.prisma, projectId, actorId);

    // 4. Resolve technology stack from approved Architecture metadata
    let template: BootstrapTemplate;
    if (input.templateId) {
      template = BootstrapTemplateRegistry.getTemplate(input.templateId);
    } else {
      const resolved = BootstrapTemplateRegistry.resolveStackFromArchitecture(accepted.architecture.content);
      template = BootstrapTemplateRegistry.getTemplate(resolved.templateId);
    }

    // 5. Resolve and validate requested repository root against workspace boundaries
    const targetRoot = input.repositoryRoot?.trim() || path.resolve(process.cwd(), "scratch", `repo-${projectId}`);
    const canonicalPath = WorkspaceBoundaryValidator.canonicalizeAndValidate(targetRoot, {
      forNewRepository: true,
    });

    const idempotencyKey = input.idempotencyKey || crypto.randomUUID();
    const baseBranch = input.baseBranch?.trim() || "main";

    // 6. Record or update attempt in PREPARED state
    await this.prisma.repositoryBootstrapAttempt.upsert({
      where: {
        projectId_idempotencyKey: {
          projectId,
          idempotencyKey,
        },
      },
      create: {
        projectId,
        idempotencyKey,
        status: "PREPARED",
        repositoryRoot: canonicalPath,
        templateId: template.id,
        selectedStack: {
          language: template.language,
          framework: template.framework,
          buildCommand: template.buildCommand,
          testCommand: template.testCommand,
        },
        architectureFingerprint: accepted.fingerprint,
        baseBranch,
      },
      update: {
        status: "PREPARED",
        repositoryRoot: canonicalPath,
        templateId: template.id,
        selectedStack: {
          language: template.language,
          framework: template.framework,
          buildCommand: template.buildCommand,
          testCommand: template.testCommand,
        },
        architectureFingerprint: accepted.fingerprint,
        baseBranch,
      },
    });

    return {
      idempotencyKey,
      templateId: template.id,
      templateName: template.name,
      description: template.description,
      selectedStack: {
        language: template.language,
        framework: template.framework,
        buildCommand: template.buildCommand,
        testCommand: template.testCommand,
        lintCommand: template.lintCommand,
        typecheckCommand: template.typecheckCommand,
      },
      repositoryRoot: canonicalPath,
      baseBranch,
      architectureFingerprint: accepted.fingerprint,
      plannedFiles: template.files.map((f) => ({
        path: f.path,
        description: f.description,
        preview: f.content.slice(0, 300),
      })),
      status: "PREPARED",
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Path B: Execute Repository Bootstrap
  // ───────────────────────────────────────────────────────────────────────────

  async executeBootstrap(
    projectId: string,
    actorId: string,
    input: ExecuteBootstrapInput
  ) {
    // 1. Verify owner authorization
    await this.authorization.assertOwner(projectId, actorId);

    // 2. Explicit confirmation check
    if (input.confirmation !== true) {
      throw new RepositoryBootstrapError(
        "OWNER_CONFIRMATION_REQUIRED",
        "Repository creation requires explicit owner confirmation.",
        400
      );
    }

    if (!input.idempotencyKey || typeof input.idempotencyKey !== "string") {
      throw new RepositoryBootstrapError("INVALID_INPUT", "idempotencyKey is required.", 400);
    }

    // 3. Check existing attempt for idempotency and concurrency
    const existingAttempt = await this.prisma.repositoryBootstrapAttempt.findUnique({
      where: {
        projectId_idempotencyKey: {
          projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
    });

    if (existingAttempt?.status === "BOUND" && existingAttempt.repositoryId) {
      const boundRepo = await this.prisma.projectRepository.findUnique({
        where: { id: existingAttempt.repositoryId },
      });
      if (boundRepo) {
        return { repository: boundRepo, attempt: existingAttempt, replayed: true };
      }
    }

    if (existingAttempt?.status === "INITIALIZING") {
      const elapsedMs = Date.now() - existingAttempt.updatedAt.getTime();
      if (elapsedMs < 30_000) {
        throw new RepositoryBootstrapError(
          "BOOTSTRAP_CONCURRENT_REQUEST",
          "A repository bootstrap operation is already in progress for this project.",
          409
        );
      }
    }

    // 4. Check if project is already bound to a primary repository
    const existingPrimary = await this.prisma.projectRepository.findFirst({
      where: { projectId, isPrimary: true },
    });
    if (existingPrimary && existingPrimary.localPath && fs.existsSync(existingPrimary.localPath)) {
      throw new RepositoryBootstrapError(
        "REPOSITORY_ALREADY_BOUND",
        `Project already has an active bound repository at "${existingPrimary.localPath}".`,
        409
      );
    }

    // 5. Require current approved Architecture authority
    const accepted = await currentImplementationAuthority(this.prisma, projectId, actorId);

    // 6. Resolve template
    let template: BootstrapTemplate;
    if (input.templateId) {
      template = BootstrapTemplateRegistry.getTemplate(input.templateId);
    } else if (existingAttempt?.templateId) {
      template = BootstrapTemplateRegistry.getTemplate(existingAttempt.templateId);
    } else {
      const resolved = BootstrapTemplateRegistry.resolveStackFromArchitecture(accepted.architecture.content);
      template = BootstrapTemplateRegistry.getTemplate(resolved.templateId);
    }

    // 7. Resolve and validate target root
    const targetRoot = input.repositoryRoot?.trim() || existingAttempt?.repositoryRoot || path.resolve(process.cwd(), "scratch", `repo-${projectId}`);
    
    // Check restart/retry reconciliation:
    // If target directory already exists with a valid Git repo and commit from a previous attempt:
    let isReconcilingExistingCommit = false;
    let existingHeadSha: string | null = null;
    if (fs.existsSync(targetRoot) && (await GitWorktreeService.isGitRepository(targetRoot))) {
      try {
        existingHeadSha = await GitWorktreeService.getHeadCommitSha(targetRoot);
        if (existingHeadSha && existingHeadSha.length >= 7) {
          isReconcilingExistingCommit = true;
        }
      } catch {}
    }

    const canonicalPath = WorkspaceBoundaryValidator.canonicalizeAndValidate(targetRoot, {
      forNewRepository: !isReconcilingExistingCommit,
    });

    const baseBranch = input.baseBranch?.trim() || existingAttempt?.baseBranch || "main";

    // 8. Update attempt to INITIALIZING
    const attempt = await this.prisma.repositoryBootstrapAttempt.upsert({
      where: {
        projectId_idempotencyKey: {
          projectId,
          idempotencyKey: input.idempotencyKey,
        },
      },
      create: {
        projectId,
        idempotencyKey: input.idempotencyKey,
        status: "INITIALIZING",
        repositoryRoot: canonicalPath,
        templateId: template.id,
        selectedStack: {
          language: template.language,
          framework: template.framework,
        },
        architectureFingerprint: accepted.fingerprint,
        baseBranch,
      },
      update: {
        status: "INITIALIZING",
        repositoryRoot: canonicalPath,
        templateId: template.id,
        architectureFingerprint: accepted.fingerprint,
        baseBranch,
        errorMessage: null,
        errorCode: null,
      },
    });

    let headCommitSha = existingHeadSha;

    if (!isReconcilingExistingCommit) {
      const createdPaths: string[] = [];
      try {
        // Ensure root directory exists
        await fs.promises.mkdir(canonicalPath, { recursive: true });

        // Write template foundational files
        for (const file of template.files) {
          const filePath = path.join(canonicalPath, file.path);
          await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
          await fs.promises.writeFile(filePath, file.content, "utf8");
          createdPaths.push(filePath);
        }

        // Initialize Git repository using safe argument arrays
        try {
          await this.git.run(canonicalPath, ["init", "-b", baseBranch]);
        } catch {
          // Older git fallback
          await this.git.run(canonicalPath, ["init"]);
          await this.git.run(canonicalPath, ["checkout", "-b", baseBranch]).catch(async () => {
            await this.git.run(canonicalPath, ["branch", "-M", baseBranch]);
          });
        }

        // Local git config for author
        await this.git.run(canonicalPath, ["config", "user.name", "ANKA OS"]);
        await this.git.run(canonicalPath, ["config", "user.email", "anka@anka.local"]);

        // Initial commit
        await this.git.run(canonicalPath, ["add", "--", "."]);
        await this.git.run(canonicalPath, ["commit", "-m", "chore: initial commit by ANKA OS repository bootstrap"]);

        // Verify HEAD commit SHA
        headCommitSha = await GitWorktreeService.getHeadCommitSha(canonicalPath);

        // Verify GitWorktreeService readiness
        await GitWorktreeService.assertCleanWorkingTree(canonicalPath);
        await GitWorktreeService.resolveRepositoryRoot(canonicalPath);
      } catch (gitErr: any) {
        // Safe rollback on initialization failure
        try {
          await this.prisma.repositoryBootstrapAttempt.update({
            where: { id: attempt.id },
            data: {
              status: "FAILED",
              errorCode: "GIT_INIT_FAILED",
              errorMessage: gitErr?.message || "Failed initializing Git repository",
            },
          });
        } catch {}

        throw new RepositoryBootstrapError(
          "GIT_INIT_FAILED",
          `Git initialization failed: ${gitErr?.message || gitErr}`,
          500
        );
      }
    }

    if (!headCommitSha) {
      throw new RepositoryBootstrapError("GIT_HEAD_RESOLUTION_FAILED", "Failed resolving initial commit SHA.", 500);
    }

    // 9. Database persistence & binding
    try {
      const repo = await this.prisma.$transaction(async (tx) => {
        const createdRepo = await tx.projectRepository.create({
          data: {
            projectId,
            name: input.name?.trim() || path.basename(canonicalPath),
            role: "backend",
            githubUrl: input.githubUrl || "",
            localPath: canonicalPath,
            defaultBranch: baseBranch,
            currentIndexedCommit: headCommitSha,
            isPrimary: true,
            ownerUserId: actorId,
            languages: [template.language] as any,
            frameworks: template.framework ? ([template.framework] as any) : ([] as any),
            buildCommand: template.buildCommand,
            testCommand: template.testCommand,
            lintCommand: template.lintCommand,
            typecheckCommand: template.typecheckCommand,
            executionPolicy: {
              bootstrap: {
                templateId: template.id,
                architectureFingerprint: accepted.fingerprint,
                baselineCommitSha: headCommitSha,
                status: "BOUND",
              },
            },
          },
        });

        await tx.project.update({
          where: { id: projectId },
          data: { localPath: canonicalPath },
        });

        await tx.repositoryBootstrapAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "BOUND",
            baselineCommitSha: headCommitSha,
            repositoryId: createdRepo.id,
          },
        });

        return createdRepo;
      });

      return {
        repository: repo,
        baselineCommitSha: headCommitSha,
        baseBranch,
        selectedStack: {
          language: template.language,
          framework: template.framework,
        },
        attemptId: attempt.id,
      };
    } catch (dbErr: any) {
      // On DB persistence failure: do NOT delete the repository files
      // Mark attempt as BASELINE_READY so subsequent retry can reconcile without re-scaffolding
      try {
        await this.prisma.repositoryBootstrapAttempt.update({
          where: { id: attempt.id },
          data: {
            status: "BASELINE_READY",
            baselineCommitSha: headCommitSha,
            errorCode: "DB_PERSISTENCE_FAILED",
            errorMessage: dbErr?.message || "Database persistence failed during binding",
          },
        });
      } catch {}

      throw new RepositoryBootstrapError(
        "DB_PERSISTENCE_FAILED",
        `Repository was initialized at "${canonicalPath}" with commit ${headCommitSha}, but database binding failed: ${dbErr?.message || dbErr}. Safe retry is available.`,
        500
      );
    }
  }
}
