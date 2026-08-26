import fs from "fs";
import path from "path";
import os from "os";
import { exec } from "child_process";
import { promisify } from "util";
import { AgentPipeline } from "../ai/orchestration/AgentPipeline";
import { AgentFileChange, AgentProgressEvent, AgentResponse, ChatRequest, BaselineDiagnostic } from "../types";
import { WorktreeDependencyService, DependencyPreparationResult } from "./worktree-dependency.service";
import { DependencyRepairService, ALLOWED_DEPENDENCY_FILES } from "./dependency-repair.service";
import { ValidationPlanner } from "../ai/validation/ValidationPlanner";
import { ValidationRunner } from "../ai/validation/ValidationRunner";
import { ErrorClassifier } from "../ai/validation/ErrorClassifier";
import { BaselineRepairCoordinator } from "./baseline-repair.coordinator";
import { BaselineDeltaVerifier, BaselineDeltaResult } from "./baseline-delta.verifier";

const execAsync = promisify(exec);

export interface PrepareRepositoryRunOptions {
  repositoryPath: string;
  runId: string;
}

export interface PreparedRepositoryRun {
  originalRepositoryPath: string;
  repositoryRoot: string;
  worktreePath: string;
  branchName: string;
  baseCommitSha: string;
}

export interface WorktreeDiffResult {
  changedFiles: string[];
  diffSummary: string;
  rawDiff: string;
}

export interface RepositoryRunSummary {
  runId: string;
  branchName: string;
  baseCommitSha: string;
  worktreePath: string;
  changedFiles: string[];
  diffSummary: string;
  validationPassed: boolean;
  validationCommands: string[];
  validationErrors?: string;
  agentResponse: AgentResponse;
}

export interface RunIsolatedAgentOptions {
  userId: string;
  projectId: string;
  repositoryPath: string;
  runId: string;
  request: ChatRequest;
  onProgress?: (event: AgentProgressEvent) => void;
}

export class GitWorktreeService {
  /**
   * Validates and resolves the canonical root directory of a local Git repository.
   */
  static async resolveRepositoryRoot(repositoryPath: string): Promise<string> {
    if (!repositoryPath || typeof repositoryPath !== "string") {
      throw new Error("REPOSITORY_NOT_FOUND: Repository path must be a non-empty string.");
    }

    const resolvedPath = path.resolve(repositoryPath);
    if (!fs.existsSync(resolvedPath)) {
      throw new Error(`REPOSITORY_NOT_FOUND: Path "${resolvedPath}" does not exist.`);
    }

    const stat = await fs.promises.stat(resolvedPath);
    if (!stat.isDirectory()) {
      throw new Error(`INVALID_REPOSITORY_PATH: Path "${resolvedPath}" is not a directory.`);
    }

    try {
      const { stdout } = await execAsync("git rev-parse --show-toplevel", { cwd: resolvedPath });
      const root = stdout.trim();
      return path.resolve(root);
    } catch (err: any) {
      throw new Error(`NOT_A_GIT_REPOSITORY: Path "${resolvedPath}" is not a valid Git repository: ${err?.message || err}`);
    }
  }

  /**
   * Tests whether a local directory belongs to a Git repository using Git itself.
   */
  static async isGitRepository(directoryPath: string): Promise<boolean> {
    try {
      await this.resolveRepositoryRoot(directoryPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Retrieves current HEAD 40-character commit SHA.
   */
  static async getHeadCommitSha(repositoryRoot: string): Promise<string> {
    try {
      const { stdout } = await execAsync("git rev-parse HEAD", { cwd: repositoryRoot });
      const sha = stdout.trim();
      if (!sha || sha.length < 7) {
        throw new Error("Unable to resolve valid Git HEAD commit SHA.");
      }
      return sha;
    } catch (err: any) {
      throw new Error(`GIT_HEAD_RESOLUTION_FAILED: Failed to resolve HEAD commit: ${err?.message || err}`);
    }
  }

  /**
   * Asserts that the source repository working tree is clean.
   * Fails safely without modifying user files if uncommitted changes exist.
   */
  static async assertCleanWorkingTree(repositoryRoot: string): Promise<void> {
    try {
      const { stdout } = await execAsync("git status --porcelain", { cwd: repositoryRoot });
      if (stdout.trim().length > 0) {
        throw new Error(
          `SOURCE_REPOSITORY_DIRTY: Source repository at "${repositoryRoot}" contains uncommitted changes. ANKA requires a clean repository state before creating an isolated execution worktree.`
        );
      }
    } catch (err: any) {
      if (err.message && err.message.includes("SOURCE_REPOSITORY_DIRTY")) {
        throw err;
      }
      throw new Error(`GIT_STATUS_FAILED: Failed checking repository status: ${err?.message || err}`);
    }
  }

  /**
   * Prepares an isolated Git worktree on a unique branch `anka/run-<runId>`
   * branched from the source HEAD commit.
   */
  static async prepareRepositoryRun(options: PrepareRepositoryRunOptions): Promise<PreparedRepositoryRun> {
    const { repositoryPath, runId } = options;
    if (!runId || typeof runId !== "string") {
      throw new Error("INVALID_RUN_ID: runId must be a non-empty string.");
    }

    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    await this.assertCleanWorkingTree(repositoryRoot);
    const baseCommitSha = await this.getHeadCommitSha(repositoryRoot);

    const branchName = `anka/run-${runId}`;
    const worktreePath = path.resolve(os.tmpdir(), "anka-worktrees", runId);

    // Ensure parent temp directory exists
    await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });

    // Clean prior stale worktree path if present
    if (fs.existsSync(worktreePath)) {
      try {
        await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: repositoryRoot });
      } catch {}
      try {
        await fs.promises.rm(worktreePath, { recursive: true, force: true });
      } catch {}
    }

    // Prune stale worktree registrations
    try {
      await execAsync("git worktree prune", { cwd: repositoryRoot });
    } catch {}

    // Delete existing branch with identical name if leftover
    try {
      await execAsync(`git branch -D "${branchName}"`, { cwd: repositoryRoot });
    } catch {}

    // Create branch and worktree from base commit SHA
    try {
      await execAsync(`git worktree add -b "${branchName}" "${worktreePath}" ${baseCommitSha}`, {
        cwd: repositoryRoot,
      });
    } catch (err: any) {
      throw new Error(
        `WORKTREE_CREATION_FAILED: Failed creating isolated worktree at "${worktreePath}": ${err?.message || err}`
      );
    }

    return {
      originalRepositoryPath: repositoryPath,
      repositoryRoot,
      worktreePath,
      branchName,
      baseCommitSha,
    };
  }

  /**
   * Computes changed files and diff summary inside the worktree relative to baseCommitSha.
   */
  static async getWorktreeDiff(worktreePath: string, baseCommitSha: string): Promise<WorktreeDiffResult> {
    try {
      const { stdout: statusOut } = await execAsync("git status --porcelain", { cwd: worktreePath });
      const changedFiles = statusOut
        .split("\n")
        .map((line) => {
          if (!line || line.trim().length === 0) return "";
          // Format is XY<space>path
          return line.slice(2).trim().replace(/\\/g, "/");
        })
        .filter(Boolean);

      const { stdout: diffOut } = await execAsync(`git diff ${baseCommitSha}`, { cwd: worktreePath });

      const diffLines = diffOut.split("\n");
      const summaryLines = diffLines.filter((l) => l.startsWith("diff --git") || l.startsWith("+++") || l.startsWith("---"));
      const diffSummary = summaryLines.slice(0, 50).join("\n") || (changedFiles.length > 0 ? `Changed files: ${changedFiles.join(", ")}` : "No file differences.");

      return {
        changedFiles,
        diffSummary,
        rawDiff: diffOut,
      };
    } catch {
      return {
        changedFiles: [],
        diffSummary: "Unable to retrieve git diff.",
        rawDiff: "",
      };
    }
  }

  /**
   * Resets and cleans the worktree back to baseCommitSha upon failure.
   */
  static async rollbackWorktree(worktreePath: string, baseCommitSha: string): Promise<void> {
    if (!worktreePath || !fs.existsSync(worktreePath)) return;
    try {
      await execAsync(`git reset --hard ${baseCommitSha}`, { cwd: worktreePath });
      await execAsync("git clean -fd", { cwd: worktreePath });
    } catch (err) {
      console.error(`[GitWorktreeService] Failed to rollback worktree at "${worktreePath}":`, err);
    }
  }

  /**
   * Safely removes worktree and prunes git metadata.
   */
  static async cleanupWorktree(worktreePath: string, repositoryRoot?: string): Promise<void> {
    if (repositoryRoot && fs.existsSync(repositoryRoot)) {
      try {
        await execAsync(`git worktree remove --force "${worktreePath}"`, { cwd: repositoryRoot });
        await execAsync("git worktree prune", { cwd: repositoryRoot });
      } catch {}
    }

    if (fs.existsSync(worktreePath)) {
      try {
        await fs.promises.rm(worktreePath, { recursive: true, force: true });
      } catch {}
    }
  }

  /**
   * High-level coordinator: runs AgentPipeline strictly inside an isolated Git worktree.
   * On success: preserves ANKA branch and worktree with a reviewable diff (NO auto-merge/push).
   * On failure: rolls worktree changes back cleanly.
   * The source repository is never modified at any point.
   */
  static async runIsolatedAgent(options: RunIsolatedAgentOptions): Promise<RepositoryRunSummary> {
    const { userId, projectId, repositoryPath, runId, request, onProgress } = options;

    const prepared = await this.prepareRepositoryRun({ repositoryPath, runId });
    console.log(`[ANKA_EXEC] worktree=${prepared.worktreePath}`);

    // 2. Prepare dependencies inside isolated worktree
    const depPrep = await WorktreeDependencyService.prepareDependencies(prepared.worktreePath);
    if (!depPrep.success) {
      const errorType = depPrep.errorType || "INFRASTRUCTURE";
      const isRepairableDep =
        errorType === "INVALID_PACKAGE_DEPENDENCY" ||
        errorType === "PEER_DEPENDENCY_CONFLICT" ||
        errorType === "LOCKFILE_OUT_OF_SYNC";

      const isDepRepairIntent = DependencyRepairService.isDependencyRepairIntent(request.message || "");

      if (isRepairableDep && isDepRepairIntent) {
        console.log(`[DEP_REPAIR] Entering constrained dependency repair mode. errorType=${errorType}`);
        const repairResult = await DependencyRepairService.runConstrainedDependencyRepair({
          worktreePath: prepared.worktreePath,
          depPrep,
          userMessage: request.message || "",
        });

        if (repairResult.success) {
          const diffInfo = await this.getWorktreeDiff(prepared.worktreePath, prepared.baseCommitSha);

          // Verify allowed files constraint strictly: ONLY allowed dependency files
          const illegalFiles = diffInfo.changedFiles.filter((f) => !ALLOWED_DEPENDENCY_FILES.has(path.basename(f)));
          if (illegalFiles.length > 0) {
            await this.rollbackWorktree(prepared.worktreePath, prepared.baseCommitSha);
            const failureExplanation = `[DEPENDENCY_REPAIR_VIOLATION] Dependency repair mode modified forbidden non-dependency files: ${illegalFiles.join(", ")}`;
            return {
              runId,
              branchName: prepared.branchName,
              baseCommitSha: prepared.baseCommitSha,
              worktreePath: prepared.worktreePath,
              changedFiles: [],
              diffSummary: "No file differences (dependency repair violated allowed scope).",
              validationPassed: false,
              validationCommands: [depPrep.installCommand || "npm ci"],
              validationErrors: failureExplanation,
              agentResponse: {
                explanation: failureExplanation,
                changes: [],
                commitMessage: "",
                sessionId: request.sessionId || "",
                buildVerified: false,
                healthStatus: "BASELINE_REPOSITORY_UNHEALTHY",
                errorType: "SCOPE_VIOLATION",
              },
            };
          }

          console.log(`[DEP_REPAIR] Dependency repair succeeded. baselineHealthy=true`);
          return {
            runId,
            branchName: prepared.branchName,
            baseCommitSha: prepared.baseCommitSha,
            worktreePath: prepared.worktreePath,
            changedFiles: diffInfo.changedFiles,
            diffSummary: diffInfo.diffSummary,
            validationPassed: true,
            validationCommands: [depPrep.installCommand || "npm ci --no-audit --no-fund"],
            agentResponse: {
              explanation: repairResult.explanation,
              changes: repairResult.changes,
              commitMessage: repairResult.commitMessage || "fix(deps): repair invalid baseline dependencies",
              sessionId: request.sessionId || "",
              buildVerified: true,
              dependencyPreparationAttempted: true,
              dependencyPreparationSucceeded: true,
              packageManager: depPrep.packageManager,
              installCommand: depPrep.installCommand,
              dependencyPreparationDurationMs: repairResult.durationMs,
              worktreePath: prepared.worktreePath,
              branchName: prepared.branchName,
              baseCommitSha: prepared.baseCommitSha,
              baselineFailure: false,
              buildVerificationBlocked: false,
              healthStatus: "HEALTHY",
            },
          };
        }
      }

      // Default: Rollback and return BASELINE_REPOSITORY_UNHEALTHY for unrelated source tasks or failed repair
      await this.rollbackWorktree(prepared.worktreePath, prepared.baseCommitSha);

      const isInvalidPkg = errorType === "INVALID_PACKAGE_DEPENDENCY";
      let failureExplanation = "";
      if (isInvalidPkg) {
        failureExplanation = `[BASELINE_REPOSITORY_UNHEALTHY] [INVALID_PACKAGE_DEPENDENCY] Baseline dependency preparation failed in repository: ${depPrep.error}${depPrep.packageName ? ` (Package: ${depPrep.packageName}, Version: ${depPrep.requestedVersion || "unknown"})` : ""}`;
      } else {
        failureExplanation = `[BASELINE_REPOSITORY_UNHEALTHY] [${errorType}] Baseline dependency preparation failed in repository: ${depPrep.error}`;
      }

      console.log(`[REPO_HEALTH] baselineHealthy=false`);
      console.log(`[REPO_HEALTH] errorType=${errorType}`);
      if (depPrep.packageName) console.log(`[REPO_HEALTH] packageName=${depPrep.packageName}`);
      if (depPrep.requestedVersion) console.log(`[REPO_HEALTH] requestedVersion=${depPrep.requestedVersion}`);
      console.log(`[REPO_HEALTH] baselineFailure=true`);
      console.log(`[REPO_HEALTH] buildVerificationBlocked=true`);

      return {
        runId,
        branchName: prepared.branchName,
        baseCommitSha: prepared.baseCommitSha,
        worktreePath: prepared.worktreePath,
        changedFiles: [],
        diffSummary: `No file differences (baseline repository dependency preparation failed: ${errorType}).`,
        validationPassed: false,
        validationCommands: depPrep.installCommand ? [depPrep.installCommand] : [],
        validationErrors: failureExplanation,
        agentResponse: {
          explanation: failureExplanation,
          changes: [],
          commitMessage: "",
          sessionId: request.sessionId || "",
          buildVerified: false,
          dependencyPreparationAttempted: depPrep.attempted,
          dependencyPreparationSucceeded: false,
          packageManager: depPrep.packageManager,
          installCommand: depPrep.installCommand,
          dependencyPreparationDurationMs: depPrep.durationMs,
          worktreePath: prepared.worktreePath,
          branchName: prepared.branchName,
          baseCommitSha: prepared.baseCommitSha,
          errorType,
          baselineFailure: true,
          buildVerificationBlocked: true,
          packageName: depPrep.packageName,
          requestedVersion: depPrep.requestedVersion,
          healthStatus: "BASELINE_REPOSITORY_UNHEALTHY",
        },
      };
    }

    // 3. Verify untouched repository baseline build before running AgentPipeline
    const baselineCommands = ValidationPlanner.detectValidationCommands(prepared.worktreePath);
    let baselineBuildPassed = true;
    let baselineBuildError = "";
    let baselineRepairedChanges: AgentFileChange[] = [];
    let baselineDiagnostics: BaselineDiagnostic[] = [];
    let targetedBaselineDiagnostics: BaselineDiagnostic[] = [];
    let isBaselineDeltaTask = false;

    if (baselineCommands.length > 0) {
      console.log(`[BASELINE_BUILD] Verifying untouched baseline build with: ${baselineCommands.join(", ")}`);
      const initialBuild = await ValidationRunner.validateWithShell([], prepared.worktreePath, baselineCommands);
      if (!initialBuild.success) {
        baselineBuildPassed = false;
        baselineBuildError = initialBuild.errors;

        const classified = ErrorClassifier.classify(initialBuild.errors);
        classified.origin = "BASELINE";

        console.warn(`[BASELINE_BUILD] Untouched baseline build failed (origin=BASELINE, type=${classified.type}). Attempting baseline repair coordinator...`);

        // Route to BaselineRepairCoordinator ONLY if explicit dependency repair intent
        const isExplicitDepRepair = DependencyRepairService.isDependencyRepairIntent(request.message || "");
        if (classified.type === "MISSING_DEP" && isExplicitDepRepair) {
          const repairRes = await BaselineRepairCoordinator.repairBaselineBuildFailure(
            prepared.worktreePath,
            baselineCommands,
            initialBuild.errors,
            depPrep.packageManager
          );

          if (repairRes.success && repairRes.baselineReady) {
            baselineBuildPassed = true;
            baselineBuildError = "";
            baselineRepairedChanges = repairRes.changes;
            console.log(`[BASELINE_BUILD] Baseline repair succeeded. baselineReady=true`);
          }
        }

        if (!baselineBuildPassed) {
          baselineDiagnostics = BaselineDeltaVerifier.extractDiagnostics(baselineBuildError, "BASELINE");
          const taskMatch = BaselineDeltaVerifier.matchUserTaskToBaseline(request.message || "", baselineDiagnostics);

          if (taskMatch.isMatch) {
            isBaselineDeltaTask = true;
            targetedBaselineDiagnostics = taskMatch.targetedDiagnostics;
            console.log(`[BASELINE_DELTA] User request targets ${taskMatch.targetedDiagnostics.length} pre-existing baseline diagnostic(s). Allowing constrained task repair.`);
          } else {
            await this.rollbackWorktree(prepared.worktreePath, prepared.baseCommitSha);
            const failureExplanation = `[BASELINE_REPOSITORY_UNHEALTHY] [${classified.type}] Untouched baseline repository build failed before code generation: ${baselineBuildError}`;

            console.log(`[REPO_HEALTH] baselineHealthy=false`);
            console.log(`[REPO_HEALTH] buildReady=false`);
            console.log(`[REPO_HEALTH] baselineReady=false`);
            console.log(`[REPO_HEALTH] origin=BASELINE`);
            console.log(`[REPO_HEALTH] errorType=${classified.type}`);
            console.log(`[REPO_HEALTH] baselineFailure=true`);
            console.log(`[REPO_HEALTH] agentIntroduced=false`);

            return {
              runId,
              branchName: prepared.branchName,
              baseCommitSha: prepared.baseCommitSha,
              worktreePath: prepared.worktreePath,
              changedFiles: [],
              diffSummary: `No file differences (baseline repository build failed: ${classified.type}).`,
              validationPassed: false,
              validationCommands: baselineCommands,
              validationErrors: failureExplanation,
              agentResponse: {
                explanation: failureExplanation,
                changes: [],
                commitMessage: "",
                sessionId: request.sessionId || "",
                buildVerified: false,
                healthStatus: "BASELINE_REPOSITORY_UNHEALTHY",
                errorType: classified.type,
                origin: "BASELINE",
                baselineFailure: true,
                agentIntroduced: false,
                buildReady: false,
                baselineDependencyInstall: "PASS",
                baselineBuild: "FAIL",
                baselineReady: false,
                baselineFailures: [
                  {
                    type: classified.type,
                    origin: "BASELINE",
                    rawErrors: baselineBuildError,
                  },
                ],
              },
            };
          }
        }
      }
    }

    console.log(`[REPO_HEALTH] baselineHealthy=${baselineBuildPassed}`);
    console.log(`[REPO_HEALTH] dependenciesReady=true`);
    console.log(`[REPO_HEALTH] buildReady=${baselineBuildPassed}`);
    console.log(`[REPO_HEALTH] baselineReady=${baselineBuildPassed}`);
    console.log(`[REPO_HEALTH] baselineDependencyInstall=PASS`);
    console.log(`[REPO_HEALTH] baselineBuild=${baselineBuildPassed ? "PASS" : "FAIL"}`);

    let agentResponse: AgentResponse;
    let executionError: any = null;

    try {
      agentResponse = await AgentPipeline.runCodingAgent(
        userId,
        projectId,
        request,
        onProgress,
        {
          effectiveLocalPath: prepared.worktreePath,
          baselineDiagnostics,
          targetedBaselineDiagnostics,
          isBaselineDeltaTask,
        }
      );
    } catch (err: any) {
      executionError = err;
      await this.rollbackWorktree(prepared.worktreePath, prepared.baseCommitSha);
      throw err;
    }

    if (prepared.worktreePath && agentResponse.changes && agentResponse.changes.length > 0) {
      const allowedPaths = new Set(agentResponse.changes.map((c) => c.path.replace(/\\/g, "/")));
      if (!allowedPaths.has("package.json")) {
        try {
          await execAsync("git checkout HEAD -- package.json package-lock.json", { cwd: prepared.worktreePath });
        } catch {}
      }
    }

    const diffInfo = await this.getWorktreeDiff(prepared.worktreePath, prepared.baseCommitSha);

    let validationPassed = false;
    let deltaResult: BaselineDeltaResult | null = null;

    if (baselineCommands.length > 0 && isBaselineDeltaTask) {
      if (agentResponse.taskVerified) {
        validationPassed = true;
        agentResponse.buildVerified = true;
        agentResponse.healthStatus = agentResponse.repositoryClean ? "HEALTHY" : "TASK_VERIFIED_REPOSITORY_UNHEALTHY";
      } else {
        const postBuild = await ValidationRunner.validateWithShell([], prepared.worktreePath, baselineCommands);
        const postChangeDiagnostics = BaselineDeltaVerifier.extractDiagnostics(postBuild.errors, "CURRENT_TASK");
        deltaResult = BaselineDeltaVerifier.compareBaselineVsPostChange(
          baselineDiagnostics,
          postChangeDiagnostics,
          targetedBaselineDiagnostics
        );

        if (deltaResult.taskVerified) {
          validationPassed = true;
          agentResponse.buildVerified = true;
          agentResponse.taskVerified = true;
          agentResponse.repositoryClean = deltaResult.repositoryClean;
          agentResponse.healthStatus = deltaResult.repositoryClean ? "HEALTHY" : "TASK_VERIFIED_REPOSITORY_UNHEALTHY";
          if (!deltaResult.repositoryClean) {
            agentResponse.explanation = BaselineDeltaVerifier.formatDeltaExplanation(deltaResult);
          }
        } else {
          validationPassed = false;
          agentResponse.buildVerified = false;
        }
      }
    } else {
      validationPassed = Boolean(agentResponse.buildVerified !== false && !executionError);
    }

    if (!validationPassed) {
      await this.rollbackWorktree(prepared.worktreePath, prepared.baseCommitSha);
    }

    return {
      runId,
      branchName: prepared.branchName,
      baseCommitSha: prepared.baseCommitSha,
      worktreePath: prepared.worktreePath,
      changedFiles: diffInfo.changedFiles,
      diffSummary: diffInfo.diffSummary,
      validationPassed,
      validationCommands: agentResponse.validationCommands || baselineCommands,
      validationErrors: !validationPassed ? agentResponse.explanation : undefined,
      agentResponse: {
        ...agentResponse,
        changes: [...baselineRepairedChanges, ...(agentResponse.changes || [])],
        dependencyPreparationAttempted: depPrep.attempted,
        dependencyPreparationSucceeded: depPrep.success,
        packageManager: depPrep.packageManager,
        installCommand: depPrep.installCommand,
        dependencyPreparationDurationMs: depPrep.durationMs,
        worktreePath: prepared.worktreePath,
        branchName: prepared.branchName,
        baseCommitSha: prepared.baseCommitSha,
        healthStatus: agentResponse.healthStatus || (validationPassed ? "HEALTHY" : "BASELINE_REPOSITORY_UNHEALTHY"),
        baselineDependencyInstall: "PASS",
        baselineBuild: baselineBuildPassed ? "PASS" : "FAIL",
        baselineReady: baselineBuildPassed,
        buildReady: baselineBuildPassed,
        origin: validationPassed ? (deltaResult && !deltaResult.repositoryClean ? "BASELINE" : undefined) : "CURRENT_TASK",
        agentIntroduced: Boolean(!validationPassed && (deltaResult ? deltaResult.newTaskDiagnostics.length > 0 : !agentResponse.buildVerified)),
        taskVerified: deltaResult ? deltaResult.taskVerified : (agentResponse.taskVerified ?? validationPassed),
        repositoryClean: deltaResult ? deltaResult.repositoryClean : (agentResponse.repositoryClean ?? validationPassed),
        baselineDiagnosticCount: deltaResult?.baselineDiagnosticCount ?? agentResponse.baselineDiagnosticCount,
        targetedBaselineDiagnostics: deltaResult?.targetedBaselineDiagnostics ?? agentResponse.targetedBaselineDiagnostics,
        resolvedTargetDiagnostics: deltaResult?.resolvedTargetDiagnostics ?? agentResponse.resolvedTargetDiagnostics,
        remainingBaselineDiagnostics: deltaResult?.remainingBaselineDiagnostics ?? agentResponse.remainingBaselineDiagnostics,
        newTaskDiagnostics: deltaResult?.newTaskDiagnostics ?? agentResponse.newTaskDiagnostics,
      },
    };
  }
}
