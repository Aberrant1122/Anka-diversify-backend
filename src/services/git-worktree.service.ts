import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { AgentPipeline } from "../ai/orchestration/AgentPipeline";
import { AgentFileChange, AgentProgressEvent, AgentResponse, ChatRequest, BaselineDiagnostic } from "../types";
import { WorktreeDependencyService, DependencyPreparationResult } from "./worktree-dependency.service";
import { DependencyRepairService, ALLOWED_DEPENDENCY_FILES } from "./dependency-repair.service";
import { ValidationPlanner } from "../ai/validation/ValidationPlanner";
import { ValidationRunner } from "../ai/validation/ValidationRunner";
import { ErrorClassifier } from "../ai/validation/ErrorClassifier";
import { BaselineRepairCoordinator } from "./baseline-repair.coordinator";
import { BaselineDeltaVerifier, BaselineDeltaResult } from "./baseline-delta.verifier";
import { RuntimePreflightService } from "./runtime-preflight.service";
import { RepositoryCacheManager } from "./repository-cache.manager";
import { VisualVerifierService } from "./visual-verifier.service";
import { detectRepositoryArchitecture } from "../ai/planning/RepositoryArchitectureDetector";
import { VisualVerificationResult } from "../types";
import {
  BaselineDiagnosticVerifier,
  DiagnosticBaselineComparison,
  DiagnosticValidationSnapshot,
} from "../ai/runtime/BaselineDiagnosticVerifier";
import { AuthorizedCapabilityScope, CapabilityGrant } from "../ai/runtime/CapabilityGuard";
import type { TaskRuntime } from "../ai/runtime/TaskRuntime";
import { CompletionEvaluationResult, CompletionEvaluator } from "../ai/runtime/CompletionEvaluator";
import { VerifiedCheckpointJournal } from "../ai/runtime/VerifiedCheckpointJournal";
import { RepositoryObserver } from "../ai/orchestration/RepositoryObserver";
import { NodeGitCommandExecutor } from "./git-command";
import { GitShippingMode, GitShippingResult, GitWorkflowService } from "./git-workflow.service";
import type { CodeReviewProvider } from "./code-review-provider";

const git = new NodeGitCommandExecutor();

interface RunOwnershipRecord {
  readonly runId: string;
  readonly repositoryRoot: string;
  readonly worktreePath: string;
  readonly branchName: string;
}

function publicCompletionResult(result: CompletionEvaluationResult): NonNullable<AgentResponse["completionEvaluation"]> {
  if (result.outcome === "COMPLETE") {
    return { outcome: result.outcome, code: result.code, satisfiedRequirementIds: result.satisfiedRequirementIds };
  }
  if (result.outcome === "CLARIFICATION_REQUIRED") {
    return { outcome: result.outcome, code: result.code, question: result.question, reason: result.reason };
  }
  if (result.outcome === "BLOCKED" || result.outcome === "INCOMPLETE") {
    return { outcome: result.outcome, code: result.code, category: result.category, message: result.message };
  }
  return { outcome: result.outcome, code: result.code, message: result.message };
}

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
  diagnosticComparison?: DiagnosticBaselineComparison;
  visualVerification?: VisualVerificationResult;
  agentResponse: AgentResponse;
  shipping?: GitShippingResult;
}

export interface RepositoryShippingPolicy {
  readonly shippingId: string;
  readonly mode: GitShippingMode;
  readonly targetBranch: string;
  readonly trustedTargetRevision: string;
  readonly remote?: string;
  readonly expectedRepositoryIdentity?: string;
  readonly reviewProvider?: CodeReviewProvider;
}

export interface RunIsolatedAgentOptions {
  userId: string;
  projectId: string;
  repositoryPath: string;
  runId: string;
  request: ChatRequest;
  authorizedCapabilities?: readonly CapabilityGrant[];
  taskRuntime?: TaskRuntime;
  shipping?: RepositoryShippingPolicy;
  onProgress?: (event: AgentProgressEvent) => void;
}

export class GitWorktreeService {
  private static activeRuns = new Set<string>();

  /**
   * Returns count of active runs currently in process.
   */
  public static getActiveRunCount(): number {
    return this.activeRuns.size;
  }

  /**
   * Returns whether a runId is currently active in process.
   */
  public static isRunActive(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  /**
   * Binds independently supplied task grants to the deterministic isolated
   * worktree boundary. Containment alone never creates write authority.
   */
  public static createIsolatedCapabilityScope(
    worktreePath: string,
    runId: string,
    authorizedCapabilities?: readonly CapabilityGrant[],
  ): AuthorizedCapabilityScope | null {
    if (!authorizedCapabilities || authorizedCapabilities.length === 0) return null;
    return AuthorizedCapabilityScope.fromIsolatedWorktree({
      workspaceRoot: worktreePath,
      authorityId: `isolated-worktree:${runId}`,
      grants: authorizedCapabilities,
    });
  }

  /**
   * Returns root directory for disposable run worktrees.
   * Default: os.tmpdir()/anka/runs, overrideable via ANKA_RUNS_DIR.
   */
  public static getRunsRoot(): string {
    return process.env.ANKA_RUNS_DIR
      ? path.resolve(process.env.ANKA_RUNS_DIR)
      : path.join(os.tmpdir(), "anka", "runs");
  }

  private static validateRunId(runId: string): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(runId)) {
      throw new Error("INVALID_RUN_ID: runId must be a backend-safe identifier.");
    }
  }

  private static ownershipPath(runId: string): string {
    return path.join(this.getRunsRoot(), ".owners", `${runId}.json`);
  }

  private static async writeOwnership(record: RunOwnershipRecord): Promise<void> {
    const marker = this.ownershipPath(record.runId);
    await fs.promises.mkdir(path.dirname(marker), { recursive: true });
    await fs.promises.writeFile(marker, JSON.stringify(record), { encoding: "utf8", flag: "wx" });
  }

  private static async readOwnership(runId: string): Promise<RunOwnershipRecord | null> {
    try {
      const value: unknown = JSON.parse(await fs.promises.readFile(this.ownershipPath(runId), "utf8"));
      if (!value || typeof value !== "object") return null;
      const record = value as Partial<RunOwnershipRecord>;
      if (record.runId !== runId || typeof record.repositoryRoot !== "string"
        || typeof record.worktreePath !== "string" || typeof record.branchName !== "string") return null;
      const expectedPath = path.resolve(this.getRunsRoot(), runId);
      if (path.resolve(record.worktreePath) !== expectedPath || !record.branchName.startsWith("anka/run-")) return null;
      return Object.freeze({
        runId,
        repositoryRoot: path.resolve(record.repositoryRoot),
        worktreePath: expectedPath,
        branchName: record.branchName,
      });
    } catch {
      return null;
    }
  }

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
      const { stdout } = await git.run(resolvedPath, ["rev-parse", "--show-toplevel"]);
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
      const { stdout } = await git.run(repositoryRoot, ["rev-parse", "HEAD"]);
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
      const { stdout } = await git.run(repositoryRoot, ["status", "--porcelain"]);
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
    if (!runId || typeof runId !== "string") throw new Error("INVALID_RUN_ID: runId must be a non-empty string.");
    this.validateRunId(runId);

    // Verify runtime tools before executing
    await RuntimePreflightService.verifyTools(["git", "node", "npm"]);

    const repositoryRoot = await this.resolveRepositoryRoot(repositoryPath);
    await this.assertCleanWorkingTree(repositoryRoot);
    const baseCommitSha = await this.getHeadCommitSha(repositoryRoot);

    const branchName = `anka/run-${runId}`;
    const worktreePath = path.resolve(this.getRunsRoot(), runId);

    // Ensure parent temp directory exists
    await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });

    // A collision is never treated as authority to delete an existing path or branch.
    if (fs.existsSync(worktreePath) || fs.existsSync(this.ownershipPath(runId))) {
      throw new Error(`WORKTREE_COLLISION: Refusing to replace existing run path or ownership record for "${runId}".`);
    }
    const branchExists = await git.run(repositoryRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`])
      .then(() => true, () => false);
    if (branchExists) throw new Error(`WORKTREE_COLLISION: Refusing to delete existing branch "${branchName}".`);

    // Create branch and worktree from base commit SHA
    try {
      await git.run(repositoryRoot, ["worktree", "add", "-b", branchName, worktreePath, baseCommitSha]);
      await this.writeOwnership({ runId, repositoryRoot, worktreePath, branchName });
      this.activeRuns.add(runId);
    } catch (err: any) {
      this.activeRuns.delete(runId);
      // This path/branch was created by the immediately preceding command, so
      // cleanup remains bounded even if ownership-record persistence failed.
      try { await git.run(repositoryRoot, ["worktree", "remove", "--force", worktreePath]); } catch {}
      try { await git.run(repositoryRoot, ["branch", "-D", branchName]); } catch {}
      try { await fs.promises.rm(this.ownershipPath(runId), { force: true }); } catch {}
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
      const { stdout: statusOut } = await git.run(worktreePath, ["status", "--porcelain"]);
      const changedFiles = statusOut
        .split("\n")
        .map((line) => {
          if (!line || line.trim().length === 0) return "";
          // Format is XY<space>path
          return line.slice(2).trim().replace(/\\/g, "/");
        })
        .filter(Boolean);

      const { stdout: diffOut } = await git.run(worktreePath, ["diff", baseCommitSha]);

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
    const runId = path.basename(path.resolve(worktreePath));
    const ownership = await this.readOwnership(runId);
    if (!ownership || ownership.worktreePath !== path.resolve(worktreePath)) {
      throw new Error("WORKTREE_OWNERSHIP_REQUIRED: Refusing rollback outside an ANKA-owned run worktree.");
    }
    try {
      await git.run(worktreePath, ["reset", "--hard", baseCommitSha]);
      await git.run(worktreePath, ["clean", "-fd"]);
    } catch (err) {
      console.error(`[GitWorktreeService] Failed to rollback worktree at "${worktreePath}":`, err);
    }
  }

  /**
   * Safely removes worktree, deletes temporary branch, prunes git metadata, and deletes directory.
   */
  static async cleanupWorktree(
    worktreePath: string,
    repositoryRoot?: string,
    branchName?: string,
    runId?: string
  ): Promise<void> {
    const effectiveRunId = runId ?? path.basename(path.resolve(worktreePath));
    const ownership = await this.readOwnership(effectiveRunId);
    if (!ownership || ownership.worktreePath !== path.resolve(worktreePath)) return;
    if (repositoryRoot && path.resolve(repositoryRoot) !== ownership.repositoryRoot) return;
    if (branchName && branchName !== ownership.branchName) return;
    this.activeRuns.delete(effectiveRunId);
    if (fs.existsSync(ownership.repositoryRoot)) {
      try { await git.run(ownership.repositoryRoot, ["worktree", "remove", "--force", ownership.worktreePath]); } catch {}
      try { await git.run(ownership.repositoryRoot, ["worktree", "prune"]); } catch {}
      try { await git.run(ownership.repositoryRoot, ["branch", "-D", ownership.branchName]); } catch {}
    }
    if (fs.existsSync(ownership.worktreePath)) {
      try { await fs.promises.rm(ownership.worktreePath, { recursive: true, force: true }); } catch {}
    }
    try { await fs.promises.rm(this.ownershipPath(effectiveRunId), { force: true }); } catch {}
  }

  /**
   * Sweeps abandoned/orphaned run worktree directories older than maxAgeMs (default 2 hours).
   * Active runs in the current process are preserved.
   */
  static async sweepOrphanedRuns(maxAgeMs = 2 * 60 * 60 * 1000): Promise<number> {
    const runsRoot = this.getRunsRoot();
    const candidateDirs = process.env.ANKA_RUNS_DIR
      ? [runsRoot]
      : [runsRoot, path.join(os.tmpdir(), "anka-worktrees")];
    let cleanedCount = 0;
    const now = Date.now();

    for (const rootDir of candidateDirs) {
      if (!fs.existsSync(rootDir)) continue;
      try {
        const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const runId = entry.name;
            if (runId === ".owners") continue;
            if (this.activeRuns.has(runId)) {
              continue;
            }

            const fullPath = path.join(rootDir, runId);
            try {
              const ownership = rootDir === runsRoot ? await this.readOwnership(runId) : null;
              if (ownership && fs.existsSync(fullPath)) {
                const stat = await fs.promises.stat(fullPath);
                const age = now - stat.mtimeMs;
                if (age >= maxAgeMs) {
                  await this.cleanupWorktree(fullPath, ownership.repositoryRoot, ownership.branchName, runId);
                  if (!fs.existsSync(fullPath)) cleanedCount++;
                }
              }
            } catch {}
          }
        }
      } catch {}
    }

    return cleanedCount;
  }

  /**
   * High-level coordinator: runs AgentPipeline strictly inside a strictly disposable Git worktree.
   * Guaranteed finally cleanup eliminates worktree, temporary branch, and node_modules for all outcomes.
   * The source repository is never modified at any point.
   */
  static async runIsolatedAgent(options: RunIsolatedAgentOptions): Promise<RepositoryRunSummary> {
    const { userId, projectId, repositoryPath, runId, request, onProgress } = options;

    return RepositoryCacheManager.withLease(projectId, async () => {
      const prepared = await this.prepareRepositoryRun({ repositoryPath, runId });
      console.log(`[ANKA_EXEC] worktree=${prepared.worktreePath}`);
      let preserveForShippingRetry = false;

      try {
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
                dependencyPreparationDurationMs: depPrep.durationMs,
                worktreePath: prepared.worktreePath,
                branchName: prepared.branchName,
                baseCommitSha: prepared.baseCommitSha,
                healthStatus: "HEALTHY",
                baselineFailure: false,
                buildVerificationBlocked: false,
                baselineDependencyInstall: "PASS",
                baselineBuild: "PASS",
                baselineReady: true,
                buildReady: true,
              },
            };
          } else {
            return {
              runId,
              branchName: prepared.branchName,
              baseCommitSha: prepared.baseCommitSha,
              worktreePath: prepared.worktreePath,
              changedFiles: [],
              diffSummary: "No file differences.",
              validationPassed: false,
              validationCommands: [depPrep.installCommand || "npm ci"],
              validationErrors: repairResult.explanation,
              agentResponse: {
                explanation: repairResult.explanation,
                changes: [],
                commitMessage: "",
                sessionId: request.sessionId || "",
                buildVerified: false,
                healthStatus: "BASELINE_REPOSITORY_UNHEALTHY",
                errorType,
                baselineDependencyInstall: "FAIL",
                baselineReady: false,
                buildReady: false,
                dependencyPreparationAttempted: true,
                dependencyPreparationSucceeded: false,
                packageManager: depPrep.packageManager,
                installCommand: depPrep.installCommand,
                dependencyPreparationDurationMs: depPrep.durationMs,
              },
            };
          }
        }

        console.warn(`[WorktreeDependency] Dependency preparation failed in worktree: ${depPrep.error}`);
        return {
          runId,
          branchName: prepared.branchName,
          baseCommitSha: prepared.baseCommitSha,
          worktreePath: prepared.worktreePath,
          changedFiles: [],
          diffSummary: "No file differences (dependency preparation failed).",
          validationPassed: false,
          validationCommands: [depPrep.installCommand || "npm ci"],
          validationErrors: `[BASELINE_REPOSITORY_UNHEALTHY] [${errorType}] ${depPrep.error || "Dependency installation failed in worktree."}`,
          agentResponse: {
            explanation: `[BASELINE_REPOSITORY_UNHEALTHY] [${errorType}] Repository baseline has invalid or unresolvable dependencies: ${depPrep.error || "Install failed"}`,
            changes: [],
            commitMessage: "",
            sessionId: request.sessionId || "",
            buildVerified: false,
            dependencyPreparationAttempted: depPrep.attempted,
            dependencyPreparationSucceeded: depPrep.success,
            packageManager: depPrep.packageManager,
            installCommand: depPrep.installCommand,
            dependencyPreparationDurationMs: depPrep.durationMs,
            worktreePath: prepared.worktreePath,
            branchName: prepared.branchName,
            baseCommitSha: prepared.baseCommitSha,
            healthStatus: "BASELINE_REPOSITORY_UNHEALTHY",
            errorType,
            packageName: depPrep.packageName,
            requestedVersion: depPrep.requestedVersion,
            baselineDependencyInstall: "FAIL",
            baselineReady: false,
            buildReady: false,
            origin: "BASELINE",
            baselineFailure: true,
            buildVerificationBlocked: true,
            agentIntroduced: false,
          },
        };
      }

      // Step 3: Verify untouched baseline build before Agent generation
      const baselineCommands = ValidationPlanner.detectValidationCommands(prepared.worktreePath);
      let baselineBuildPassed = true;
      let baselineBuildErrors: string | undefined;
      let baselineRepairedChanges: AgentFileChange[] = [];
      let baselineDiagnostics: BaselineDiagnostic[] = [];
      let baselineValidationSnapshot: DiagnosticValidationSnapshot | null = null;
      let targetedBaselineDiagnostics: BaselineDiagnostic[] = [];
      let isBaselineDeltaTask = false;

      if (baselineCommands.length > 0) {
        console.log(`[BASELINE_BUILD] Verifying untouched baseline build with: ${baselineCommands.join(" && ")}`);
        const baselineCheck = await ValidationRunner.validateWithShell([], prepared.worktreePath, baselineCommands);
        baselineBuildPassed = baselineCheck.success;
        baselineBuildErrors = baselineCheck.errors;

        if (!baselineBuildPassed) {
          const classified = ErrorClassifier.classify(baselineCheck.errors || "Baseline build failed");
          classified.origin = "BASELINE";

          console.warn(`[BASELINE_BUILD] Untouched baseline build failed (origin=BASELINE, type=${classified.type}). Attempting baseline repair coordinator...`);

          // Route to BaselineRepairCoordinator ONLY if explicit dependency repair intent
          const isExplicitDepRepair = DependencyRepairService.isDependencyRepairIntent(request.message || "");

          if (isExplicitDepRepair) {
            const coordResult = await BaselineRepairCoordinator.repairBaselineBuildFailure(
              prepared.worktreePath,
              baselineCommands,
              baselineCheck.errors || "",
              depPrep.packageManager
            );

            if (coordResult.success) {
              baselineBuildPassed = true;
              baselineBuildErrors = undefined;
              baselineRepairedChanges = coordResult.changes;
            }
          }

          if (!baselineBuildPassed) {
            baselineDiagnostics = BaselineDeltaVerifier.extractDiagnostics(baselineCheck.errors || "", "BASELINE");
            const isBroadBuildRepair = BaselineDeltaVerifier.isBroadBuildRepairTask(request.message || "");
            const matchResult = BaselineDeltaVerifier.matchUserTaskToBaseline(
              request.message || "",
              baselineDiagnostics
            );
            targetedBaselineDiagnostics = isBroadBuildRepair
              ? baselineDiagnostics
              : matchResult.targetedDiagnostics;

            if (targetedBaselineDiagnostics.length > 0) {
              if (isBroadBuildRepair) {
                console.log(`[BASELINE_DELTA] User request is a broad build repair task targeting all ${targetedBaselineDiagnostics.length} visible baseline diagnostic(s). Allowing constrained task repair.`);
              } else {
                console.log(`[BASELINE_DELTA] User request targets ${targetedBaselineDiagnostics.length} pre-existing baseline diagnostic(s). Allowing constrained task repair.`);
              }
              isBaselineDeltaTask = true;
            } else {
              console.log(`[REPO_HEALTH] baselineHealthy=false`);
              console.log(`[REPO_HEALTH] buildReady=false`);
              console.log(`[REPO_HEALTH] baselineReady=false`);
              console.log(`[REPO_HEALTH] origin=BASELINE`);
              console.log(`[REPO_HEALTH] errorType=${classified.type}`);
              console.log(`[REPO_HEALTH] baselineFailure=true`);
              console.log(`[REPO_HEALTH] agentIntroduced=false`);

              const failureExplanation = `[BASELINE_REPOSITORY_UNHEALTHY] Repository baseline build verification failed before agent execution (${classified.type}): ${baselineCheck.errors || "Build failed"}`;

              return {
                runId,
                branchName: prepared.branchName,
                baseCommitSha: prepared.baseCommitSha,
                worktreePath: prepared.worktreePath,
                changedFiles: [],
                diffSummary: "No file differences (baseline build failed).",
                validationPassed: false,
                validationCommands: baselineCommands,
                validationErrors: baselineCheck.errors,
                agentResponse: {
                  explanation: failureExplanation,
                  changes: [],
                  commitMessage: "",
                  sessionId: request.sessionId || "",
                  buildVerified: false,
                  healthStatus: "BASELINE_REPOSITORY_UNHEALTHY",
                  errorType: classified.type,
                  baselineDependencyInstall: "PASS",
                  baselineBuild: "FAIL",
                  baselineReady: false,
                  buildReady: false,
                  origin: "BASELINE",
                  baselineFailure: true,
                  agentIntroduced: false,
                  baselineDiagnosticCount: baselineDiagnostics.length,
                  targetedBaselineDiagnostics,
                  remainingBaselineDiagnostics: baselineDiagnostics,
                  newTaskDiagnostics: [],
                },
              };
            }
          }
        }

        baselineValidationSnapshot = BaselineDiagnosticVerifier.capture({
          phase: "BASELINE",
          passed: baselineBuildPassed,
          commands: baselineCommands,
          diagnostics: baselineBuildPassed ? [] : baselineDiagnostics,
          repositoryRoot: prepared.worktreePath,
          source: "DETERMINISTIC_TOOL",
        });
      }

      console.log(`[REPO_HEALTH] baselineHealthy=${baselineBuildPassed || isBaselineDeltaTask}`);
      console.log(`[REPO_HEALTH] dependenciesReady=true`);
      console.log(`[REPO_HEALTH] buildReady=${baselineBuildPassed}`);
      console.log(`[REPO_HEALTH] baselineReady=${baselineBuildPassed}`);
      console.log(`[REPO_HEALTH] baselineDependencyInstall=PASS`);
      console.log(`[REPO_HEALTH] baselineBuild=${baselineBuildPassed ? "PASS" : "FAIL"}`);

      // 4. Run AgentPipeline strictly targeting the isolated worktree
      let agentResponse: AgentResponse;
      let executionError: Error | null = null;
      const checkpointJournal = new VerifiedCheckpointJournal();

      try {
        agentResponse = await AgentPipeline.runCodingAgent(
          userId,
          projectId,
          request,
          onProgress,
          {
            effectiveLocalPath: prepared.worktreePath,
            authorizedCapabilityScope: this.createIsolatedCapabilityScope(
              prepared.worktreePath,
              runId,
              options.authorizedCapabilities,
            ) ?? undefined,
            baselineDiagnostics,
            targetedBaselineDiagnostics,
            isBaselineDeltaTask,
            baseCommitSha: prepared.baseCommitSha,
            baselineBuildPassed,
            baselineReady: baselineBuildPassed,
            dependenciesReady: depPrep.success,
            baselineCommands,
            baselineBuildErrors,
            taskRuntime: options.taskRuntime,
            checkpointJournal,
            deferCompletionToGitWorktree: Boolean(options.taskRuntime),
          }
        );
      } catch (err: any) {
        executionError = err;
        throw err;
      }

      let diffInfo = await this.getWorktreeDiff(prepared.worktreePath, prepared.baseCommitSha);
      const dependencyFiles = new Set(["package.json", "package-lock.json"]);
      const actualDependencyDelta = diffInfo.changedFiles.some((file) => dependencyFiles.has(file.replace(/\\/g, "/")));
      const trustedDependencyGrant = (options.authorizedCapabilities ?? []).some((grant) =>
        dependencyFiles.has(grant.path.replace(/\\/g, "/"))
          && (grant.action === "FILE_CREATE" || grant.action === "FILE_MODIFY"),
      );
      if (prepared.worktreePath && actualDependencyDelta && !trustedDependencyGrant) {
        try {
          await git.run(prepared.worktreePath, ["checkout", "HEAD", "--", "package.json", "package-lock.json"]);
          diffInfo = await this.getWorktreeDiff(prepared.worktreePath, prepared.baseCommitSha);
        } catch {}
      }

      let validationPassed = false;
      let deltaResult: BaselineDeltaResult | null = null;
      let diagnosticComparison: DiagnosticBaselineComparison | undefined;

      if (baselineCommands.length > 0 && baselineValidationSnapshot) {
        const postBuild = await ValidationRunner.validateWithShell([], prepared.worktreePath, baselineCommands);
        const postChangeDiagnostics = BaselineDeltaVerifier.extractDiagnostics(postBuild.errors, "CURRENT_TASK");
        const currentValidationSnapshot = BaselineDiagnosticVerifier.capture({
          phase: "CURRENT",
          passed: postBuild.success,
          commands: baselineCommands,
          diagnostics: postChangeDiagnostics,
          repositoryRoot: prepared.worktreePath,
          source: "DETERMINISTIC_TOOL",
        });
        diagnosticComparison = BaselineDiagnosticVerifier.compare(baselineValidationSnapshot, currentValidationSnapshot);

        if (isBaselineDeltaTask) {
          const currentIdentities = new Set(
            diagnosticComparison.currentOutcomes.map((outcome) => outcome.diagnostic.identity),
          );
          const introducedIdentities = new Set(
            diagnosticComparison.currentOutcomes
              .filter((outcome) => outcome.classification === "INTRODUCED")
              .map((outcome) => outcome.diagnostic.identity),
          );
          const resolvedTargetDiagnostics = targetedBaselineDiagnostics.filter((diagnostic) =>
            !currentIdentities.has(BaselineDiagnosticVerifier.identityOf(diagnostic, prepared.worktreePath)),
          );
          const remainingBaselineDiagnostics = baselineDiagnostics.filter((diagnostic) =>
            currentIdentities.has(BaselineDiagnosticVerifier.identityOf(diagnostic, prepared.worktreePath)),
          );
          const newTaskDiagnostics = postChangeDiagnostics.filter((diagnostic) =>
            introducedIdentities.has(BaselineDiagnosticVerifier.identityOf(diagnostic, prepared.worktreePath)),
          );
          const allTargetedResolved = targetedBaselineDiagnostics.length > 0
            && resolvedTargetDiagnostics.length === targetedBaselineDiagnostics.length;
          const broadRepair = BaselineDeltaVerifier.isBroadBuildRepairTask(request.message);
          const repositoryClean = postBuild.success && postChangeDiagnostics.length === 0;
          const taskVerified = diagnosticComparison.verifiedSuccess
            && (broadRepair ? repositoryClean : allTargetedResolved);

          deltaResult = {
            baselineDiagnosticCount: baselineDiagnostics.length,
            targetedBaselineDiagnostics,
            resolvedTargetDiagnostics,
            remainingBaselineDiagnostics,
            revealedBaselineDiagnostics: [],
            newTaskDiagnostics,
            taskVerified,
            repositoryClean,
          };
          validationPassed = taskVerified;
          agentResponse.buildVerified = repositoryClean;
          agentResponse.taskVerified = taskVerified;
          agentResponse.repositoryClean = repositoryClean;
          agentResponse.healthStatus = repositoryClean ? "HEALTHY" : taskVerified
            ? "TASK_VERIFIED_REPOSITORY_UNHEALTHY"
            : "BASELINE_REPOSITORY_UNHEALTHY";
          if (taskVerified && !repositoryClean) {
            agentResponse.explanation = BaselineDeltaVerifier.formatDeltaExplanation(deltaResult);
          }
        } else {
          validationPassed = Boolean(
            agentResponse.buildVerified === true
            && !executionError
            && postBuild.success
            && diagnosticComparison.verifiedSuccess,
          );
          agentResponse.buildVerified = validationPassed;
          agentResponse.taskVerified = validationPassed;
          agentResponse.repositoryClean = validationPassed;
          if (!validationPassed) agentResponse.healthStatus = "BASELINE_REPOSITORY_UNHEALTHY";
        }
      } else {
        validationPassed = Boolean(agentResponse.buildVerified === true && !executionError);
      }

      const totalChanges = [...baselineRepairedChanges, ...(agentResponse.changes || [])];
      const isSuccessfulNoOp = agentResponse.successfulNoOp === true;

      if (totalChanges.length === 0 && !isSuccessfulNoOp) {
        validationPassed = false;
        agentResponse.buildVerified = false;
        if (!agentResponse.buildErrors) {
          agentResponse.buildErrors = agentResponse.explanation || "Zero changes generated without explicit verified no-op.";
        }
      }

      if (
        options.taskRuntime
        && options.taskRuntime.snapshot().status === "RUNNING"
        && agentResponse.agentLoop?.outcome === "AWAITING_COMPLETION_EVALUATION"
      ) {
        const completionFacts = await RepositoryObserver.loadProjectFacts(projectId);
        const completionObservation = await RepositoryObserver.observe(projectId, request, completionFacts, {
          effectiveLocalPath: prepared.worktreePath,
        });
        const repositoryRevision = completionObservation.currentRevisionHash
          ?? `unversioned-git-worktree-completion-${runId}`;
        let completionWorkspace = options.taskRuntime.workspaceState().withRelevantPaths([
          ...options.taskRuntime.workspaceState().snapshot().relevantPaths,
          ...diffInfo.changedFiles,
        ]).withEvidence({
          id: `git-worktree-completion:${runId}:${repositoryRevision}`,
          kind: "MATERIALIZED_REPOSITORY",
          description: "Git worktree validation captured fresh materialized disk reality for CP8.",
          revision: repositoryRevision,
        });
        if (diagnosticComparison) completionWorkspace = completionWorkspace.withDiagnosticComparison(diagnosticComparison);
        options.taskRuntime.updateWorkspace(completionWorkspace);
        const deterministicNoOp = agentResponse.successfulNoOp === true
          && agentResponse.reason === "ALREADY_SATISFIED"
          && validationPassed;
        const completion = CompletionEvaluator.evaluate({
          runtime: options.taskRuntime,
          handoff: {
            outcome: agentResponse.agentLoop.outcome,
            workingPlanId: agentResponse.agentLoop.workingPlanId,
            workingPlanRevision: agentResponse.agentLoop.workingPlanRevision,
          },
          journal: checkpointJournal,
          repository: {
            root: prepared.worktreePath,
            revision: repositoryRevision,
            changedPaths: diffInfo.changedFiles,
            source: "MATERIALIZED_REPOSITORY",
            coverage: "FULL_REPOSITORY_DELTA",
            trustedChanges: baselineRepairedChanges.map((change) => ({
              path: change.path,
              fingerprint: change.action === "delete" || change.isDeleted
                ? "MISSING"
                : crypto.createHash("sha256").update(change.content).digest("hex"),
              source: "BASELINE_REPAIR_COORDINATOR" as const,
            })),
          },
          validation: {
            passed: validationPassed,
            repositoryRevision,
            source: "GIT_WORKTREE_VALIDATION",
          },
          requirements: CompletionEvaluator.requirementsFromPlan(
            agentResponse.taskExecutionPlan,
            repositoryRevision,
            checkpointJournal,
            deterministicNoOp,
          ),
          diagnosticComparison,
          diagnosticRepositoryRevision: diagnosticComparison ? repositoryRevision : undefined,
          diagnosticsRequired: baselineCommands.length > 0,
        });
        if (completion.outcome === "COMPLETE") {
          options.taskRuntime.complete(completion.receipt);
          agentResponse.lifecycleStage = "Done";
          agentResponse.compoundTaskStatus = "COMPLETED";
        } else {
          if (agentResponse.lifecycleStage === "Done") agentResponse.lifecycleStage = "Determine Completion";
          if (agentResponse.compoundTaskStatus === "COMPLETED") agentResponse.compoundTaskStatus = "VERIFIED";
        }
        agentResponse.completionEvaluation = publicCompletionResult(completion);
        agentResponse.taskRuntime = options.taskRuntime.snapshot();
      }

      // Step 4: Bounded Playwright Visual Verification for supported frontend apps
      let visualVerification: VisualVerificationResult | undefined;
      if (validationPassed && Boolean(agentResponse.buildVerified === true) && !executionError) {
        try {
          const pkgPath = path.join(prepared.worktreePath, "package.json");
          const pkgJsonContent = fs.existsSync(pkgPath) ? fs.readFileSync(pkgPath, "utf8") : undefined;
          const arch = detectRepositoryArchitecture(
            diffInfo.changedFiles,
            pkgJsonContent
          );

          visualVerification = await VisualVerifierService.verify({
            worktreePath: prepared.worktreePath,
            changedFiles: totalChanges,
            framework: arch.framework,
            runId,
            taskPrompt: request.message,
          });
        } catch (visErr: any) {
          visualVerification = {
            status: "RUNTIME_FAILED",
            framework: "UNKNOWN",
            route: "/",
            pageErrors: [`Visual verification encountered unhandled error: ${visErr?.message || visErr}`],
            consoleErrors: [],
            failedRequests: [],
            durationMs: 0,
          };
        }
      }

      let shipping: GitShippingResult | undefined;
      if (options.shipping) {
        if (!options.taskRuntime) {
          throw new Error("GIT_WORKFLOW_REQUIRED: Shipping requires the authoritative TaskRuntime.");
        }
        // From this point, a shipping failure must not erase already-verified task history.
        preserveForShippingRetry = true;
        const infrastructureChanges = baselineRepairedChanges.map((change) => {
          const relativePath = change.path.replace(/\\/g, "/");
          const absolutePath = path.resolve(prepared.worktreePath, relativePath);
          return Object.freeze({
            path: relativePath,
            fingerprint: change.action === "delete" || change.isDeleted || !fs.existsSync(absolutePath)
              ? "MISSING"
              : crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
            policyAuthorized: true as const,
          });
        });
        shipping = await new GitWorkflowService().ship({
          repositoryRoot: prepared.repositoryRoot,
          worktreePath: prepared.worktreePath,
          baseRevision: prepared.baseCommitSha,
          taskBranch: prepared.branchName,
          targetBranch: options.shipping.targetBranch,
          trustedTargetRevision: options.shipping.trustedTargetRevision,
          shippingId: options.shipping.shippingId,
          taskRuntime: options.taskRuntime,
          checkpointJournal,
          validationPassed,
          mode: options.shipping.mode,
          remote: options.shipping.remote,
          expectedRepositoryIdentity: options.shipping.expectedRepositoryIdentity,
          commitSummary: agentResponse.commitMessage,
          trustedInfrastructureChanges: infrastructureChanges,
          reviewProvider: options.shipping.reviewProvider,
          validationSummary: validationPassed ? "Deterministic validation passed" : "Deterministic validation failed",
        });
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
        validationErrors: !validationPassed ? (agentResponse.buildErrors || agentResponse.explanation) : undefined,
        diagnosticComparison,
        visualVerification,
        ...(shipping ? { shipping } : {}),
        agentResponse: {
          ...agentResponse,
          changes: totalChanges,
          dependencyPreparationAttempted: depPrep.attempted,
          dependencyPreparationSucceeded: depPrep.success,
          packageManager: depPrep.packageManager,
          installCommand: depPrep.installCommand,
          dependencyPreparationDurationMs: depPrep.durationMs,
          worktreePath: prepared.worktreePath,
          branchName: prepared.branchName,
          baseCommitSha: prepared.baseCommitSha,
          buildVerified: Boolean(agentResponse.buildVerified === true),
          healthStatus: agentResponse.healthStatus || (validationPassed ? "HEALTHY" : "BASELINE_REPOSITORY_UNHEALTHY"),
          baselineDependencyInstall: "PASS",
          baselineBuild: baselineBuildPassed ? "PASS" : "FAIL",
          baselineReady: baselineBuildPassed,
          buildReady: baselineBuildPassed,
          origin: deltaResult
            ? (deltaResult.newTaskDiagnostics.length > 0 ? "CURRENT_TASK" : (!deltaResult.repositoryClean ? "BASELINE" : undefined))
            : (validationPassed ? (agentResponse.repositoryClean === false ? "BASELINE" : undefined) : "CURRENT_TASK"),
          agentIntroduced: Boolean(!validationPassed && (deltaResult ? deltaResult.newTaskDiagnostics.length > 0 : !agentResponse.buildVerified)),
          taskVerified: deltaResult ? deltaResult.taskVerified : (agentResponse.taskVerified ?? validationPassed),
          repositoryClean: deltaResult ? deltaResult.repositoryClean : (agentResponse.repositoryClean ?? (agentResponse.buildVerified && validationPassed)),
          baselineDiagnosticCount: deltaResult?.baselineDiagnosticCount ?? agentResponse.baselineDiagnosticCount,
          targetedBaselineDiagnostics: deltaResult?.targetedBaselineDiagnostics ?? agentResponse.targetedBaselineDiagnostics,
          resolvedTargetDiagnostics: deltaResult?.resolvedTargetDiagnostics ?? agentResponse.resolvedTargetDiagnostics,
          remainingBaselineDiagnostics: deltaResult?.remainingBaselineDiagnostics ?? agentResponse.remainingBaselineDiagnostics,
          revealedBaselineDiagnostics: deltaResult?.revealedBaselineDiagnostics ?? agentResponse.revealedBaselineDiagnostics,
          newTaskDiagnostics: deltaResult?.newTaskDiagnostics ?? agentResponse.newTaskDiagnostics,
          visualVerification,
        },
      };
      } finally {
        if (!preserveForShippingRetry) {
          await this.cleanupWorktree(
            prepared.worktreePath,
            prepared.repositoryRoot,
            prepared.branchName,
            runId
          );
        } else {
          this.activeRuns.delete(runId);
        }
      }
    });
  }
}
