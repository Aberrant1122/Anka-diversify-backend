import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ChatRequest, AgentResponse, AgentProgressEvent } from "../shared/types";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { RepositoryMaterializationService } from "../../services/repository-materialization.service";
import { prisma } from "../../services/database";

export interface CodingAgentInternalOptions {
  /**
   * Internal-only flag for trusted test runners (e.g. EvalRunner, unit tests)
   * to execute directly against an in-memory/isolated fixture workspace without
   * creating a Git worktree.
   * This CANNOT be passed or enabled via user-facing ChatRequest payload.
   */
  allowDirectExecution?: boolean;
  /**
   * Internal-only override path for trusted execution harnesses.
   */
  effectiveLocalPath?: string;
}

export class CodingAgent {
  /**
   * Primary entry point for coding agent runs.
   *
   * SECURITY INVARIANT:
   * - User-facing requests (from API/controller/ChatRequest) MUST NEVER bypass Git worktree isolation.
   * - Any request payload context fields (e.g. `request.context.directExecution`, `request.context.isEvalFixture`,
   *   or `request.context.effectiveLocalPath`) are STRICTLY IGNORED.
   * - Only trusted internal backend code supplying `internalOptions` as a distinct method argument can request direct execution.
   */
  static async runCodingAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
    onProgress?: (event: AgentProgressEvent) => void,
    internalOptions?: CodingAgentInternalOptions,
  ): Promise<AgentResponse> {
    console.log(`[ANKA_EXEC] CodingAgent entered`);

    // 1. Trusted internal-only direct execution path (used by EvalRunner and explicit test fixtures)
    if (internalOptions?.allowDirectExecution || internalOptions?.effectiveLocalPath) {
      return AgentPipeline.runCodingAgent(userId, projectId, request, onProgress, {
        effectiveLocalPath: internalOptions.effectiveLocalPath,
      });
    }

    // 2. Query project localPath from database
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, localPath: true, githubUrl: true },
    });

    if (!project) {
      throw new Error(`[REPOSITORY_NOT_READY] Project "${projectId}" does not exist in database.`);
    }

    const isUserConfiguredLocalPath = Boolean(
      project.localPath && !RepositoryMaterializationService.isManagedRepositoryPath(project.localPath)
    );

    // 3. Materialize or refresh repository freshness if githubUrl is present or managed clone exists
    if (project.githubUrl || (project.localPath && RepositoryMaterializationService.isManagedRepositoryPath(project.localPath))) {
      const mat = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
      if (mat.success && mat.metadata) {
        project.localPath = mat.metadata.canonicalRoot;
      } else if (!project.localPath) {
        throw new Error(
          `[REPOSITORY_NOT_READY] Project "${projectId}" failed repository materialization: ${mat.error || "Unknown error"}. githubUrl=${project.githubUrl}, localPathConfigured=${isUserConfiguredLocalPath}`
        );
      }
    }

    // 4. Fail-closed if no verified localPath exists
    if (!project.localPath) {
      console.log(`[ANKA_EXEC] gitRoot=none (no localPath configured)`);
      throw new Error(
        `[REPOSITORY_NOT_READY] Project "${projectId}" has no local repository configured and no valid repository source. localPathConfigured=${isUserConfiguredLocalPath}, githubUrl=${project.githubUrl || "none"}`
      );
    }

    // 5. Validate existence of localPath on disk
    const resolvedPath = path.resolve(project.localPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`[REPOSITORY_NOT_FOUND] Configured localPath "${resolvedPath}" does not exist.`);
    }

    // 6. Fail-closed Git membership check using Git itself
    let gitRoot: string;
    try {
      gitRoot = await GitWorktreeService.resolveRepositoryRoot(resolvedPath);
      console.log(`[ANKA_EXEC] gitRoot=${gitRoot}`);
    } catch (err: any) {
      throw new Error(
        `[GIT_REPOSITORY_REQUIRED] Configured path "${resolvedPath}" is not inside a valid Git repository. User-facing coding execution requires a Git repository to guarantee worktree isolation and prevent direct modifications.`
      );
    }

    // 7. Telemetry: Verify tracked files and HEAD SHA
    const headSha = await GitWorktreeService.getHeadCommitSha(gitRoot);
    let trackedFilesCount = 0;
    try {
      const ls = fs.readFileSync(path.join(gitRoot, ".git", "index"), "utf8"); // or exec git ls-files
      const { execSync } = require("child_process");
      const out = execSync("git ls-files", { cwd: gitRoot, encoding: "utf8" });
      trackedFilesCount = out.split("\n").filter((f: string) => f.trim().length > 0).length;
    } catch {}

    console.log(`[REPO_READY] project=${projectId}`);
    console.log(`[REPO_READY] trackedFiles=${trackedFilesCount}`);
    console.log(`[REPO_READY] head=${headSha.slice(0, 8)}`);
    console.log(`[REPO_READY] localPathConfigured=${isUserConfiguredLocalPath}`);

    // 8. Execute strictly through GitWorktreeService against the canonical Git repository root
    const runId = crypto.randomUUID().slice(0, 8);
    const summary = await GitWorktreeService.runIsolatedAgent({
      userId,
      projectId,
      repositoryPath: gitRoot,
      runId,
      request,
      onProgress,
    });

    return summary.agentResponse;
  }

  /**
   * Internal-only direct execution method for trusted backend harnesses (e.g. EvalRunner, unit tests).
   */
  static async runDirectAgent(
    userId: string,
    projectId: string,
    request: ChatRequest,
    options?: { effectiveLocalPath?: string },
    onProgress?: (event: AgentProgressEvent) => void,
  ): Promise<AgentResponse> {
    return AgentPipeline.runCodingAgent(userId, projectId, request, onProgress, options);
  }
}
