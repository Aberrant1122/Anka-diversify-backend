import crypto from "crypto";
import {
  AgentFileChange,
  AgentResponse,
  AgentProgressEvent,
  ChatRequest,
  VisualVerificationResult,
} from "../../types";
import { GitWorktreeService, RepositoryRunSummary } from "../../services/git-worktree.service";
import { ErrorDiagnosticsParser } from "../../services/surgical-repair.engine";
import { prisma } from "../../services/database";

export type RepositoryRole =
  | "shared_library"
  | "backend"
  | "frontend"
  | "mobile"
  | "infrastructure"
  | "documentation"
  | "custom";

export interface MultiRepoStep {
  repositoryId: string;
  name: string;
  role: RepositoryRole;
  repositoryPath: string;
  objective: string;
  order: number;
  dependsOnRepoIds: string[];
}

export interface MultiRepoExecutionPlan {
  planId: string;
  projectId: string;
  userPrompt: string;
  steps: MultiRepoStep[];
}

export interface CrossRepoHandoff {
  sourceRepoId: string;
  sourceRepoName: string;
  sourceRole: string;
  changedFiles: string[];
  summary: string;
  exportedContractDiff: string;
}

export interface MultiRepoRepoResult {
  repositoryId: string;
  repositoryName: string;
  role: string;
  status: "SUCCESS" | "FAILED" | "SKIPPED";
  changes: AgentFileChange[];
  buildVerified: boolean;
  validationPassed: boolean;
  validationCommands: string[];
  validationErrors?: string;
  visualVerification?: VisualVerificationResult;
  handoff?: CrossRepoHandoff;
}

export interface MultiRepoTaskResult {
  planId: string;
  overallStatus: "SUCCESS" | "FAILED" | "PARTIAL_FAILURE";
  results: MultiRepoRepoResult[];
  failedRepositoryId?: string;
  changes: AgentFileChange[];
}

export interface MultiRepoProgressEvent {
  type:
    | "MULTI_REPO_PLAN_CREATED"
    | "REPOSITORY_STEP_STARTED"
    | "REPOSITORY_STEP_VALIDATING"
    | "REPOSITORY_STEP_COMPLETED"
    | "REPOSITORY_STEP_FAILED"
    | "MULTI_REPO_COMPLETE";
  planId: string;
  repositoryId?: string;
  repositoryName?: string;
  message: string;
  timestamp: string;
  details?: any;
}

export interface RepositoryCandidate {
  id: string;
  name: string;
  role: string;
  localPath: string;
  githubUrl?: string;
  isPrimary?: boolean;
}

export type MultiRepoAgentRunner = (options: {
  userId: string;
  projectId: string;
  repositoryPath: string;
  runId: string;
  request: ChatRequest;
  onProgress?: (event: AgentProgressEvent) => void;
}) => Promise<RepositoryRunSummary>;

export interface CoordinateTaskOptions {
  userId: string;
  projectId: string;
  userPrompt: string;
  repositoryIds?: string[];
  onProgress?: (event: MultiRepoProgressEvent) => void;
  customRepositories?: RepositoryCandidate[];
  agentRunner?: MultiRepoAgentRunner;
  customPlanEdges?: Record<string, string[]>;
}

const ROLE_PRIORITY_MAP: Record<string, number> = {
  shared_library: 10,
  backend: 20,
  data: 25,
  frontend: 30,
  mobile: 35,
  infrastructure: 40,
  documentation: 50,
  custom: 60,
};

export class MultiRepoCoordinator {
  private agentRunner: MultiRepoAgentRunner;

  constructor(agentRunner?: MultiRepoAgentRunner) {
    this.agentRunner = agentRunner || GitWorktreeService.runIsolatedAgent.bind(GitWorktreeService);
  }

  /**
   * Phase 2: Verifies that every requested repository belongs to the target project.
   * Fails closed on unauthorized, duplicate, or nonexistent repositories.
   */
  public async verifyAndResolveRepositories(
    projectId: string,
    requestedRepoIds?: string[],
    customRepositories?: RepositoryCandidate[]
  ): Promise<RepositoryCandidate[]> {
    let available: RepositoryCandidate[] = [];

    if (customRepositories && customRepositories.length > 0) {
      available = [...customRepositories];
    } else {
      // 1. Fetch all ProjectRepository rows for the project
      const projectRepos = await prisma.projectRepository.findMany({
        where: { projectId },
        orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      });

      for (const pr of projectRepos) {
        if (pr.localPath) {
          available.push({
            id: pr.id,
            name: pr.name,
            role: pr.role,
            localPath: pr.localPath,
            githubUrl: pr.githubUrl,
            isPrimary: pr.isPrimary,
          });
        }
      }

      // 2. Also check primary legacy Project pointer if localPath exists
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { id: true, name: true, localPath: true, githubUrl: true },
      });

      if (project?.localPath && !available.some((r) => r.isPrimary || r.localPath === project.localPath)) {
        available.unshift({
          id: project.id,
          name: project.name || "primary",
          role: "backend", // fallback default
          localPath: project.localPath,
          githubUrl: project.githubUrl || undefined,
          isPrimary: true,
        });
      }
    }

    if (available.length === 0) {
      throw new Error(`[NO_REPOSITORIES_AVAILABLE] No verified repositories available for project "${projectId}".`);
    }

    // 3. If explicit repository IDs were requested, enforce strict verification
    if (requestedRepoIds && requestedRepoIds.length > 0) {
      // Check for duplicates
      const seen = new Set<string>();
      for (const id of requestedRepoIds) {
        if (seen.has(id)) {
          throw new Error(`[DUPLICATE_REPOSITORY] Duplicate repository ID "${id}" specified in multi-repo request.`);
        }
        seen.add(id);
      }

      const verifiedList: RepositoryCandidate[] = [];
      const availableMap = new Map<string, RepositoryCandidate>(available.map((r) => [r.id, r]));

      for (const reqId of requestedRepoIds) {
        const repo = availableMap.get(reqId);
        if (!repo) {
          throw new Error(
            `[UNAUTHORIZED_REPOSITORY] Repository "${reqId}" does not belong to project "${projectId}" or is not registered.`
          );
        }
        verifiedList.push(repo);
      }

      return verifiedList;
    }

    return available;
  }

  /**
   * Phase 3 & 4: Plans repository execution sequence using topological sorting.
   * Deterministically orders dependencies (e.g. backend before frontend).
   * Rejects cyclic dependencies.
   */
  public buildExecutionPlan(
    projectId: string,
    userPrompt: string,
    repositories: RepositoryCandidate[],
    customPlanEdges?: Record<string, string[]>
  ): MultiRepoExecutionPlan {
    const planId = `plan-${crypto.randomUUID().slice(0, 8)}`;
    const repoMap = new Map<string, RepositoryCandidate>(repositories.map((r) => [r.id, r]));

    // 1. Build dependency graph
    // A -> B means B depends on A (A must run before B)
    // dependsOnRepoIds contains upstream repos that must run before this repo
    const dependsOnMap = new Map<string, Set<string>>();
    for (const repo of repositories) {
      dependsOnMap.set(repo.id, new Set<string>());
    }

    // Apply explicit edges if provided
    if (customPlanEdges) {
      for (const [targetRepoId, upstreamRepoIds] of Object.entries(customPlanEdges)) {
        if (!dependsOnMap.has(targetRepoId)) {
          throw new Error(`[INVALID_PLAN_EDGE] Target repository "${targetRepoId}" not in participating repositories.`);
        }
        for (const upId of upstreamRepoIds) {
          if (!dependsOnMap.has(upId)) {
            throw new Error(`[INVALID_PLAN_EDGE] Upstream repository "${upId}" not in participating repositories.`);
          }
          if (upId === targetRepoId) {
            throw new Error(`[CYCLIC_DEPENDENCY_ERROR] Self-dependency detected on repository "${targetRepoId}".`);
          }
          dependsOnMap.get(targetRepoId)!.add(upId);
        }
      }
    } else {
      // Automatic role-based dependency heuristic
      // For each pair of repositories, if one has higher priority (e.g. backend priority 20 < frontend priority 30),
      // frontend automatically depends on backend.
      for (const repoA of repositories) {
        for (const repoB of repositories) {
          if (repoA.id === repoB.id) continue;

          const pA = ROLE_PRIORITY_MAP[repoA.role] ?? 60;
          const pB = ROLE_PRIORITY_MAP[repoB.role] ?? 60;

          if (pA < pB) {
            // repoA should execute before repoB
            dependsOnMap.get(repoB.id)!.add(repoA.id);
          }
        }
      }
    }

    // 2. Deterministic Topological Sorting (Kahn's algorithm)
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    for (const repo of repositories) {
      inDegree.set(repo.id, 0);
      adjacency.set(repo.id, []);
    }

    for (const [nodeId, upstreams] of dependsOnMap.entries()) {
      inDegree.set(nodeId, upstreams.size);
      for (const upstreamId of upstreams) {
        adjacency.get(upstreamId)!.push(nodeId);
      }
    }

    // Initial queue: nodes with inDegree === 0, sorted by role priority then name
    const queue: string[] = [];
    for (const repo of repositories) {
      if (inDegree.get(repo.id) === 0) {
        queue.push(repo.id);
      }
    }

    queue.sort((a, b) => {
      const repoA = repoMap.get(a)!;
      const repoB = repoMap.get(b)!;
      const pA = ROLE_PRIORITY_MAP[repoA.role] ?? 60;
      const pB = ROLE_PRIORITY_MAP[repoB.role] ?? 60;
      if (pA !== pB) return pA - pB;
      return repoA.name.localeCompare(repoB.name);
    });

    const executionOrder: string[] = [];

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      executionOrder.push(currentId);

      const neighbors = adjacency.get(currentId) || [];
      for (const neighborId of neighbors) {
        const remaining = (inDegree.get(neighborId) || 1) - 1;
        inDegree.set(neighborId, remaining);
        if (remaining === 0) {
          queue.push(neighborId);
          queue.sort((a, b) => {
            const repoA = repoMap.get(a)!;
            const repoB = repoMap.get(b)!;
            const pA = ROLE_PRIORITY_MAP[repoA.role] ?? 60;
            const pB = ROLE_PRIORITY_MAP[repoB.role] ?? 60;
            if (pA !== pB) return pA - pB;
            return repoA.name.localeCompare(repoB.name);
          });
        }
      }
    }

    // Cycle detection
    if (executionOrder.length !== repositories.length) {
      const unvisited = repositories.filter((r) => !executionOrder.includes(r.id)).map((r) => r.name);
      throw new Error(
        `[CYCLIC_DEPENDENCY_ERROR] Cyclic repository dependency detected in multi-repo plan: ${unvisited.join(", ")}`
      );
    }

    // 3. Build step objects
    const steps: MultiRepoStep[] = executionOrder.map((repoId, index) => {
      const candidate = repoMap.get(repoId)!;
      const upstreams = Array.from(dependsOnMap.get(repoId) || []);

      const objective = this.generateStepObjective(userPrompt, candidate.role, candidate.name);

      return {
        repositoryId: candidate.id,
        name: candidate.name,
        role: (candidate.role as RepositoryRole) || "custom",
        repositoryPath: candidate.localPath,
        objective,
        order: index,
        dependsOnRepoIds: upstreams,
      };
    });

    return {
      planId,
      projectId,
      userPrompt,
      steps,
    };
  }

  /**
   * Phase 7: Extracts bounded exported interfaces, types, endpoints, and summary from changed files.
   * Never leaks filesystem handles, tokens, or paths outside changed files.
   */
  public extractExportedContractDiff(changes: AgentFileChange[]): string {
    const lines: string[] = [];

    for (const change of changes) {
      if (change.action === "delete" || change.isDeleted || !change.content) {
        continue;
      }

      const content = change.content;

      // Extract TypeScript / JavaScript exported interfaces, types, enums
      const interfaceMatches = content.matchAll(/export\s+(?:interface|type|enum)\s+([A-Za-z0-9_]+)[\s\S]*?(?:}|\n(?=[^\s]))/g);
      for (const m of interfaceMatches) {
        const snippet = m[0].trim();
        if (snippet.length > 0 && snippet.length < 500) {
          lines.push(snippet);
        }
      }

      // Extract Express / Next API route handlers
      const routeMatches = content.matchAll(/(?:app|router)\.(?:get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/g);
      for (const rm of routeMatches) {
        lines.push(`${rm[0].split("(")[0].trim().toUpperCase()} ${rm[1]}`);
      }
    }

    if (lines.length > 0) {
      return lines.join("\n\n");
    }

    // Fallback: concise changed files and actions
    return changes
      .map((c) => `- ${c.path} (${c.action || "modify"}): ${c.description || "Updated contract"}`)
      .join("\n");
  }

  /**
   * Sanitizes upstream agent explanation into a compact, factual summary
   * containing only high-level implementation context, excluding execution
   * telemetry, reflection scores, and checklist tables.
   */
  public cleanHandoffSummary(rawExplanation?: string): string {
    if (!rawExplanation || typeof rawExplanation !== "string") {
      return "Changes verified successfully.";
    }

    // 1. Cut off at standard markdown reporting / telemetry sections
    const cutOffPatterns = [
      /\n\s*Reflection Pass Score:/i,
      /\n\s*###\s+⏱️/i,
      /\n\s*###\s+Pipeline Stage/i,
      /\n\s*###\s+📋/i,
      /\n\s*###\s+Repository Intelligence/i,
      /\n\s*###\s+Verification Checklist/i,
      /\n\s*Pipeline Start/i,
      /\n\s*\*\*Repository Search Confidence:/i,
      /\n\s*\*\*Build Status:/i,
      /\n\s*Files Modified \/ Deleted:/i,
    ];

    let cleaned = rawExplanation;
    for (const pattern of cutOffPatterns) {
      const match = cleaned.search(pattern);
      if (match !== -1) {
        cleaned = cleaned.slice(0, match);
      }
    }

    // 2. Remove task classification prefixes (e.g. [TaskType: NEW_FEATURE | Risk: HIGH | Complexity: LARGE])
    cleaned = cleaned.replace(/^\[TaskType:[^\]]+\]\s*/i, "");

    // 3. Remove code fences / raw output blocks
    cleaned = cleaned.replace(/```[\s\S]*?```/g, "");

    // 4. Remove checklist items (e.g. ✅, ❌, ⚠️)
    cleaned = cleaned
      .split("\n")
      .filter((line) => !/^\s*[-*]?\s*[✅❌⚠️]/.test(line))
      .join("\n")
      .trim();

    return cleaned || "Changes verified successfully.";
  }

  /**
   * Formats clean, bounded markdown for downstream repository injection.
   */
  public formatHandoffPrompt(handoff: CrossRepoHandoff): string {
    return [
      `\n[UPSTREAM_CROSS_REPO_CONTRACT]`,
      `Repository: ${handoff.sourceRepoName}`,
      `Role: ${handoff.sourceRole}`,
      `Changed files:`,
      handoff.changedFiles.map((f) => `- ${f}`).join("\n"),
      `\nValidated contract:`,
      handoff.exportedContractDiff || "(No public contract export modifications detected)",
      `\nSummary:`,
      handoff.summary,
      `Use this exact upstream contract when implementing this repository.\n`,
    ].join("\n");
  }

  /**
   * Phase 1 & 5: Coordinates sequential execution of multi-repository tasks.
   */
  public async coordinateTask(options: CoordinateTaskOptions): Promise<MultiRepoTaskResult> {
    const {
      userId,
      projectId,
      userPrompt,
      repositoryIds,
      onProgress,
      customRepositories,
      agentRunner = this.agentRunner,
      customPlanEdges,
    } = options;

    // 1. Verify repository access & membership
    const candidateRepos = await this.verifyAndResolveRepositories(
      projectId,
      repositoryIds,
      customRepositories
    );

    // 2. Formulate ordered multi-repository execution plan
    const plan = this.buildExecutionPlan(projectId, userPrompt, candidateRepos, customPlanEdges);

    onProgress?.({
      type: "MULTI_REPO_PLAN_CREATED",
      planId: plan.planId,
      message: `Formulated multi-repo execution plan with ${plan.steps.length} repositories.`,
      timestamp: new Date().toISOString(),
      details: { steps: plan.steps },
    });

    const results: MultiRepoRepoResult[] = [];
    const accumulatedHandoffs: CrossRepoHandoff[] = [];
    let failedRepositoryId: string | undefined = undefined;
    let abortRemaining = false;

    // 3. Sequentially execute each step
    for (const step of plan.steps) {
      if (abortRemaining) {
        results.push({
          repositoryId: step.repositoryId,
          repositoryName: step.name,
          role: step.role,
          status: "SKIPPED",
          changes: [],
          buildVerified: false,
          validationPassed: false,
          validationCommands: [],
          validationErrors: `Skipped due to upstream failure in repository "${failedRepositoryId}".`,
        });
        continue;
      }

      onProgress?.({
        type: "REPOSITORY_STEP_STARTED",
        planId: plan.planId,
        repositoryId: step.repositoryId,
        repositoryName: step.name,
        message: `Executing repository ${step.name} (Step ${step.order + 1}/${plan.steps.length})...`,
        timestamp: new Date().toISOString(),
      });

      // Build repository prompt combining user goal + objective + bounded upstream handoffs
      let stepMessage = `Goal: ${userPrompt}\n\nRepository Objective (${step.name} [${step.role}]):\n${step.objective}`;

      for (const handoff of accumulatedHandoffs) {
        stepMessage += this.formatHandoffPrompt(handoff);
      }

      const stepRequest: ChatRequest = {
        message: stepMessage,
        sessionId: `${plan.planId}-${step.repositoryId}`,
        repositoryId: step.repositoryId,
      };

      const runId = `${plan.planId.slice(-6)}-${step.order + 1}`;

      try {
        const summary = await agentRunner({
          userId,
          projectId,
          repositoryPath: step.repositoryPath,
          runId,
          request: stepRequest,
          onProgress: (event) => {
            if (event.stageName === "VALIDATING" || (typeof event.stageName === "string" && event.stageName.toUpperCase().includes("VALIDAT"))) {
              onProgress?.({
                type: "REPOSITORY_STEP_VALIDATING",
                planId: plan.planId,
                repositoryId: step.repositoryId,
                repositoryName: step.name,
                message: `Validating build & tests in ${step.name}...`,
                timestamp: new Date().toISOString(),
              });
            }
          },
        });

        const validationPassed = summary.validationPassed;
        const rawChanges = summary.agentResponse?.changes || [];

        // Tag every change with repositoryId
        let taggedChanges: AgentFileChange[] = rawChanges.map((c) => ({
          ...c,
          repositoryId: step.repositoryId,
        }));

        if (taggedChanges.length === 0 && summary.changedFiles && summary.changedFiles.length > 0) {
          taggedChanges = summary.changedFiles.map((p) => ({
            path: p,
            action: "modify" as const,
            content: "",
            description: "Modified in repository run",
            repositoryId: step.repositoryId,
          }));
        }

        const isSuccessfulNoOp = summary.agentResponse?.successfulNoOp === true;
        const hasVerifiedChanges = taggedChanges.length > 0 || isSuccessfulNoOp;
        const lifecycleStage = summary.agentResponse?.lifecycleStage;
        const isTerminalFailureStage =
          lifecycleStage === "ManifestValidationFailed" ||
          lifecycleStage === "BuildFailed" ||
          (typeof summary.agentResponse?.explanation === "string" &&
            summary.agentResponse.explanation.startsWith("[Manifest Validation Failed]"));

        const isStepSuccess =
          validationPassed === true &&
          hasVerifiedChanges &&
          !isTerminalFailureStage &&
          summary.agentResponse?.buildVerified === true;

        if (isStepSuccess) {
          const contractDiff = this.extractExportedContractDiff(taggedChanges);
          const cleanSummary = this.cleanHandoffSummary(summary.agentResponse?.explanation);
          const handoff: CrossRepoHandoff = {
            sourceRepoId: step.repositoryId,
            sourceRepoName: step.name,
            sourceRole: step.role,
            changedFiles: summary.changedFiles.length > 0 ? summary.changedFiles : taggedChanges.map((c) => c.path),
            summary: cleanSummary,
            exportedContractDiff: contractDiff,
          };

          accumulatedHandoffs.push(handoff);

          results.push({
            repositoryId: step.repositoryId,
            repositoryName: step.name,
            role: step.role,
            status: "SUCCESS",
            changes: taggedChanges,
            buildVerified: true,
            validationPassed: true,
            validationCommands: summary.validationCommands || [],
            visualVerification: summary.visualVerification,
            handoff,
          });

          onProgress?.({
            type: "REPOSITORY_STEP_COMPLETED",
            planId: plan.planId,
            repositoryId: step.repositoryId,
            repositoryName: step.name,
            message: `Repository ${step.name} completed and verified successfully.`,
            timestamp: new Date().toISOString(),
          });
        } else {
          // Failure
          abortRemaining = true;
          failedRepositoryId = step.repositoryId;

          // Order: 1. agentResponse.buildErrors, 2. summary.validationErrors, 3. agentResponse.explanation, 4. generic fallback
          const errorMsg =
            (summary.agentResponse?.buildErrors && summary.agentResponse.buildErrors.trim()) ||
            (summary.validationErrors && summary.validationErrors.trim()) ||
            (summary.agentResponse?.explanation && summary.agentResponse.explanation.trim()) ||
            (taggedChanges.length === 0 && !isSuccessfulNoOp ? "Zero changes generated without explicit verified no-op." : "Build or validation verification failed.");

          let errorCode: string;
          if (lifecycleStage === "ManifestValidationFailed" || summary.agentResponse?.explanation?.startsWith("[Manifest Validation Failed]")) {
            errorCode = "MANIFEST_VALIDATION_FAILED";
          } else if (summary.agentResponse?.buildErrors?.includes("Feature / static validation")) {
            errorCode = "STATIC_VALIDATION_FAILED";
          } else if (lifecycleStage === "BuildFailed") {
            errorCode = "BUILD_VERIFICATION_FAILED";
          } else if (summary.validationErrors && summary.validationErrors !== "Zero changes generated without explicit verified no-op." && !summary.validationErrors.includes("Zero changes generated")) {
            errorCode = summary.validationErrors.includes("TS") || summary.validationErrors.includes("error") ? "BUILD_VERIFICATION_FAILED" : "VALIDATION_FAILED";
          } else if (taggedChanges.length === 0 && !isSuccessfulNoOp) {
            errorCode = "ZERO_CHANGES_UNVERIFIED";
          } else if (summary.validationErrors) {
            errorCode = "VALIDATION_FAILED";
          } else {
            errorCode = "STEP_EXECUTION_FAILED";
          }

          const parsedDiags = ErrorDiagnosticsParser.parse(errorMsg);
          let rawErrorLine = "";
          if (parsedDiags.length > 0 && parsedDiags[0].file) {
            const d = parsedDiags[0];
            const loc = d.line ? `(${d.line}${d.column ? `,${d.column}` : ""})` : "";
            rawErrorLine = `${d.file}${loc}: error ${d.code || "ERR"}: ${d.message}`;
          } else {
            const lines = errorMsg.split("\n").map((l) => l.trim()).filter(Boolean);
            rawErrorLine = lines.find((l) => !l.startsWith("ROOT BUILD FAILURE") && !l.startsWith("FINAL REPAIR STATE")) || lines[0] || "Step validation failed";
          }

          const sanitizedError = rawErrorLine
            .replace(/(?:ghp_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9_\-\.]+|sk-[A-Za-z0-9_\-\.]+)/g, "[REDACTED]")
            .slice(0, 300);
          console.error(`[MULTI_REPO_STEP_FAILED] repo=${step.name} repoId=${step.repositoryId} code=${errorCode} message="${sanitizedError}"`);

          results.push({
            repositoryId: step.repositoryId,
            repositoryName: step.name,
            role: step.role,
            status: "FAILED",
            changes: taggedChanges,
            buildVerified: false,
            validationPassed: false,
            validationCommands: summary.validationCommands || [],
            validationErrors: errorMsg,
            visualVerification: summary?.visualVerification,
          });

          onProgress?.({
            type: "REPOSITORY_STEP_FAILED",
            planId: plan.planId,
            repositoryId: step.repositoryId,
            repositoryName: step.name,
            message: `Repository ${step.name} failed validation: ${errorMsg}`,
            timestamp: new Date().toISOString(),
          });
        }
      } catch (err: any) {
        abortRemaining = true;
        failedRepositoryId = step.repositoryId;

        const errorMsg = err?.message || "Execution exception occurred";
        const sanitizedError = (typeof errorMsg === "string" ? errorMsg.split("\n")[0] : "Execution exception")
          .replace(/(?:ghp_[A-Za-z0-9_]+|Bearer\s+[A-Za-z0-9_\-\.]+|sk-[A-Za-z0-9_\-\.]+)/g, "[REDACTED]")
          .slice(0, 300);
        console.error(`[MULTI_REPO_STEP_FAILED] repo=${step.name} repoId=${step.repositoryId} code=EXECUTION_EXCEPTION message="${sanitizedError}"`);

        results.push({
          repositoryId: step.repositoryId,
          repositoryName: step.name,
          role: step.role,
          status: "FAILED",
          changes: [],
          buildVerified: false,
          validationPassed: false,
          validationCommands: [],
          validationErrors: errorMsg,
        });

        onProgress?.({
          type: "REPOSITORY_STEP_FAILED",
          planId: plan.planId,
          repositoryId: step.repositoryId,
          repositoryName: step.name,
          message: `Repository ${step.name} encountered error: ${errorMsg}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // 4. Compute overall status
    const hasSuccess = results.some((r) => r.status === "SUCCESS");
    const hasFailed = results.some((r) => r.status === "FAILED");

    let overallStatus: "SUCCESS" | "FAILED" | "PARTIAL_FAILURE" = "SUCCESS";
    if (hasFailed) {
      overallStatus = hasSuccess ? "PARTIAL_FAILURE" : "FAILED";
    }

    // 5. Aggregate all changes
    const allChanges: AgentFileChange[] = [];
    for (const r of results) {
      for (const c of r.changes) {
        allChanges.push(c);
      }
    }

    onProgress?.({
      type: "MULTI_REPO_COMPLETE",
      planId: plan.planId,
      message: `Multi-repo task finished with status ${overallStatus}. Total changes: ${allChanges.length}`,
      timestamp: new Date().toISOString(),
      details: { overallStatus, totalChanges: allChanges.length },
    });

    return {
      planId: plan.planId,
      overallStatus,
      results,
      failedRepositoryId,
      changes: allChanges,
    };
  }

  private generateStepObjective(userPrompt: string, role: string, repoName: string): string {
    switch (role) {
      case "shared_library":
        return `Implement common types, shared models, and utility contracts required for: "${userPrompt}"`;
      case "backend":
        return `Implement server-side logic, API endpoints, and data contracts required for: "${userPrompt}" in ${repoName}`;
      case "frontend":
        return `Implement user interface components, views, and client-side integration consuming upstream APIs for: "${userPrompt}" in ${repoName}`;
      case "mobile":
        return `Implement mobile client screens and API integration for: "${userPrompt}" in ${repoName}`;
      default:
        return `Implement required changes for: "${userPrompt}" in ${repoName}`;
    }
  }
}
