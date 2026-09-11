import fs from "fs";
import path from "path";
import crypto from "crypto";
import { ChatRequest, AgentResponse, AgentProgressEvent } from "../shared/types";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { GitWorktreeService, RepositoryRunSummary, RepositoryShippingPolicy } from "../../services/git-worktree.service";
import { RepositoryMaterializationService } from "../../services/repository-materialization.service";
import { prisma } from "../../services/database";
import { AgentWorkspaceState } from "../runtime/AgentWorkspaceState";
import { TaskRuntime } from "../runtime/TaskRuntime";
import { runWithTaskRuntimeScope } from "../runtime/TaskRuntimeScope";
import { AuthorizedCapabilityScope, CapabilityGrant } from "../runtime/CapabilityGuard";
import { NodeGitCommandExecutor } from "../../services/git-command";

const git = new NodeGitCommandExecutor();

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
  /**
   * Explicit task write authority supplied by trusted backend code. This is a
   * separate argument so ChatRequest/model data cannot create or widen it.
   */
  authorizedCapabilities?: readonly CapabilityGrant[];
  /** Trusted backend shipping policy; never read from ChatRequest/model output. */
  shipping?: RepositoryShippingPolicy;
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
      const directScope = internalOptions.effectiveLocalPath && internalOptions.authorizedCapabilities
        ? AuthorizedCapabilityScope.fromBackendConfiguration({
            workspaceRoot: internalOptions.effectiveLocalPath,
            authorityId: `trusted-direct-execution:${projectId}`,
            grants: internalOptions.authorizedCapabilities,
          }) ?? undefined
        : undefined;
      return AgentPipeline.runCodingAgent(userId, projectId, request, onProgress, {
        effectiveLocalPath: internalOptions.effectiveLocalPath,
        authorizedCapabilityScope: directScope,
      });
    }

    // 2. Query target repository localPath from database
    let targetLocalPath: string | null = null;
    let targetGithubUrl: string | null = null;

    if (request.repositoryId) {
      const repo = await prisma.projectRepository.findFirst({
        where: { id: request.repositoryId, projectId },
      });
      if (!repo) {
        throw new Error(
          `[REPOSITORY_NOT_FOUND] Repository "${request.repositoryId}" does not belong to project "${projectId}".`
        );
      }
      targetLocalPath = repo.localPath;
      targetGithubUrl = repo.githubUrl;
    } else {
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, localPath: true, githubUrl: true },
      });

      if (!project) {
        throw new Error(`[REPOSITORY_NOT_READY] Project "${projectId}" does not exist in database.`);
      }
      targetLocalPath = project.localPath;
      targetGithubUrl = project.githubUrl;
    }

    const isUserConfiguredLocalPath = Boolean(
      targetLocalPath && !RepositoryMaterializationService.isManagedRepositoryPath(targetLocalPath)
    );

    // 3. Materialize or refresh repository freshness if githubUrl is present or managed clone exists
    if (!request.repositoryId && (targetGithubUrl || (targetLocalPath && RepositoryMaterializationService.isManagedRepositoryPath(targetLocalPath)))) {
      const mat = await RepositoryMaterializationService.ensureProjectRepositoryCurrent(projectId);
      if (mat.success && mat.metadata) {
        targetLocalPath = mat.metadata.canonicalRoot;
      } else if (!targetLocalPath) {
        throw new Error(
          `[REPOSITORY_NOT_READY] Project "${projectId}" failed repository materialization: ${mat.error || "Unknown error"}. githubUrl=${targetGithubUrl}, localPathConfigured=${isUserConfiguredLocalPath}`
        );
      }
    }

    // 4. Fail-closed if no verified localPath exists
    if (!targetLocalPath) {
      console.log(`[ANKA_EXEC] gitRoot=none (no localPath configured)`);
      throw new Error(
        `[REPOSITORY_NOT_READY] Repository has no local repository configured and no valid repository source. localPathConfigured=${isUserConfiguredLocalPath}, githubUrl=${targetGithubUrl || "none"}`
      );
    }

    // 5. Validate existence of localPath on disk
    const resolvedPath = path.resolve(targetLocalPath);
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
      const { stdout } = await git.run(gitRoot, ["ls-files"]);
      trackedFilesCount = stdout.split("\n").filter((file) => file.trim().length > 0).length;
    } catch {}

    console.log(`[REPO_READY] project=${projectId}`);
    console.log(`[REPO_READY] trackedFiles=${trackedFilesCount}`);
    console.log(`[REPO_READY] head=${headSha.slice(0, 8)}`);
    console.log(`[REPO_READY] localPathConfigured=${isUserConfiguredLocalPath}`);

    // 8. Execute strictly through GitWorktreeService against the canonical Git repository root
    const runId = crypto.randomUUID().slice(0, 8);
    const initialWorkspace = AgentWorkspaceState.create({
      projectId,
      ...(request.repositoryId ? { repositoryId: request.repositoryId } : {}),
      root: gitRoot,
      revision: headSha,
      constraints: [
        { id: "isolated-execution", description: "Repository changes must execute in an isolated Git worktree." },
        { id: "deterministic-completion", description: "Only deterministic validation may complete the task runtime." },
      ],
    }).withEvidence({
      id: `git-head:${headSha}`,
      kind: "MATERIALIZED_REPOSITORY",
      description: "Git resolved the source repository HEAD before isolated execution.",
      revision: headSha,
    });
    const runtime = TaskRuntime.create({
      taskId: runId,
      originalGoal: request.message,
      workspace: initialWorkspace,
      runtimeScopeId: runId,
      metadata: { projectId, executionBoundary: "CodingAgent.runCodingAgent" },
    });
    runtime.start();

    let summary: RepositoryRunSummary;
    try {
      summary = await runWithTaskRuntimeScope(runtime.snapshot().runtimeScope, () =>
        GitWorktreeService.runIsolatedAgent({
          userId,
          projectId,
          repositoryPath: gitRoot,
          runId,
          request,
          authorizedCapabilities: internalOptions?.authorizedCapabilities,
          taskRuntime: runtime,
          shipping: internalOptions?.shipping,
          onProgress,
        })
      );
    } catch (error) {
      if (runtime.snapshot().status !== "FAILED" && runtime.snapshot().status !== "COMPLETED") {
        runtime.fail({
          failureType: "TECHNICAL_FAILURE",
          code: "ISOLATED_EXECUTION_FAILED",
          message: error instanceof Error ? error.message : "Unknown isolated execution failure",
        });
      }
      throw error;
    }

    let finalWorkspace = runtime.workspaceState().withRelevantPaths([
      ...runtime.workspaceState().snapshot().relevantPaths,
      ...summary.changedFiles,
    ]);
    if (summary.validationCommands.length > 0) {
      finalWorkspace = finalWorkspace.withValidationFact({
        id: "isolated-run-validation",
        command: summary.validationCommands.join(" && "),
        passed: summary.validationPassed,
        source: "DETERMINISTIC_TOOL",
      });
    }
    if (summary.diagnosticComparison) {
      finalWorkspace = finalWorkspace.withDiagnosticComparison(summary.diagnosticComparison);
    }
    if (runtime.snapshot().status === "RUNNING") runtime.updateWorkspace(finalWorkspace);

    if (summary.agentResponse.needsClarification && runtime.snapshot().status === "RUNNING") {
      runtime.requestClarification({
        question: summary.agentResponse.question || "Additional user input is required.",
        reason: summary.agentResponse.reason || "The task cannot proceed deterministically without clarification.",
      });
    } else if (!summary.validationPassed && runtime.snapshot().status === "RUNNING") {
      runtime.fail({
        failureType: "VALIDATION_FAILURE",
        code: summary.agentResponse.errorCode || "DETERMINISTIC_VALIDATION_FAILED",
        message: summary.agentResponse.reason || summary.validationErrors || "Deterministic validation did not pass.",
      });
    }

    return {
      ...summary.agentResponse,
      visualVerification: summary.visualVerification || summary.agentResponse?.visualVerification,
      taskRuntime: runtime.snapshot(),
      ...(summary.shipping ? { gitShipping: summary.shipping } : {}),
    };
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
