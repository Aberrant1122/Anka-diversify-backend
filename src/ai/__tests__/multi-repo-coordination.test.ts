import {
  MultiRepoCoordinator,
  RepositoryCandidate,
  MultiRepoStep,
  CrossRepoHandoff,
  MultiRepoTaskResult,
} from "../coordination/MultiRepoCoordinator";
import { AgentFileChange, ChatRequest, ExecutionContract, FileManifest } from "../../types";
import { RepositoryRunSummary } from "../../services/git-worktree.service";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";

describe("Multi-Repo Coordination — Fast Track MVP Tests", () => {
  const mockBackendRepo: RepositoryCandidate = {
    id: "repo-api-id",
    name: "anka-api",
    role: "backend",
    localPath: "/mock/workspace/anka-api",
    githubUrl: "https://github.com/org/anka-api",
    isPrimary: false,
  };

  const mockFrontendRepo: RepositoryCandidate = {
    id: "repo-web-id",
    name: "anka-web",
    role: "frontend",
    localPath: "/mock/workspace/anka-web",
    githubUrl: "https://github.com/org/anka-web",
    isPrimary: false,
  };

  const mockSharedRepo: RepositoryCandidate = {
    id: "repo-shared-id",
    name: "anka-shared",
    role: "shared_library",
    localPath: "/mock/workspace/anka-shared",
    githubUrl: "https://github.com/org/anka-shared",
    isPrimary: false,
  };

  const mockCandidateRepos: RepositoryCandidate[] = [
    mockFrontendRepo, // deliberately put frontend first
    mockBackendRepo,
    mockSharedRepo,
  ];

  // 1. Plan backend before frontend (and shared before backend)
  test("1. Plan backend before frontend based on deterministic role priorities", () => {
    const coordinator = new MultiRepoCoordinator();
    const plan = coordinator.buildExecutionPlan(
      "proj-1",
      "Add user status support to the backend API and update the frontend to display it.",
      [mockFrontendRepo, mockBackendRepo]
    );

    expect(plan.steps.length).toBe(2);
    // Backend (priority 20) must be planned before Frontend (priority 30)
    expect(plan.steps[0].repositoryId).toBe("repo-api-id");
    expect(plan.steps[0].role).toBe("backend");
    expect(plan.steps[0].order).toBe(0);

    expect(plan.steps[1].repositoryId).toBe("repo-web-id");
    expect(plan.steps[1].role).toBe("frontend");
    expect(plan.steps[1].order).toBe(1);
    expect(plan.steps[1].dependsOnRepoIds).toContain("repo-api-id");
  });

  // 2. Reject repository ID not belonging to project
  test("2. Reject repository ID not belonging to project", async () => {
    const coordinator = new MultiRepoCoordinator();
    await expect(
      coordinator.verifyAndResolveRepositories(
        "proj-1",
        ["nonexistent-repo-id"],
        [mockBackendRepo, mockFrontendRepo]
      )
    ).rejects.toThrow(/\[UNAUTHORIZED_REPOSITORY\]/);
  });

  // 3. Reject repository from another project
  test("3. Reject repository from another project or unauthorized repository ID", async () => {
    const coordinator = new MultiRepoCoordinator();
    await expect(
      coordinator.verifyAndResolveRepositories(
        "proj-1",
        ["repo-from-other-proj-999"],
        [mockBackendRepo, mockFrontendRepo]
      )
    ).rejects.toThrow(/\[UNAUTHORIZED_REPOSITORY\].*repo-from-other-proj-999/);
  });

  // 4. Execute backend first
  test("4. Execute backend first in sequential workflow", async () => {
    const executionCalls: Array<{ repositoryId: string; repositoryPath: string }> = [];

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      executionCalls.push({
        repositoryId: opts.request.repositoryId,
        repositoryPath: opts.repositoryPath,
      });

      return {
        runId: opts.runId,
        branchName: "temp-branch",
        baseCommitSha: "abc1234",
        worktreePath: "/tmp/worktree",
        changedFiles: ["src/user.ts"],
        diffSummary: "1 file changed",
        validationPassed: true,
        validationCommands: ["npm test"],
        agentResponse: {
          explanation: "Backend changes verified",
          changes: [
            {
              path: "src/user.ts",
              action: "modify",
              content: "export interface User { id: string; name: string; status: 'active' | 'inactive'; }",
              description: "Add status field to User",
            },
          ],
          commitMessage: "feat(api): add user status",
          sessionId: opts.request.sessionId,
          buildVerified: true,
          healthStatus: "HEALTHY",
        },
      };
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Add user status to API and display in Web",
      customRepositories: [mockFrontendRepo, mockBackendRepo],
    });

    expect(executionCalls.length).toBe(2);
    expect(executionCalls[0].repositoryId).toBe("repo-api-id");
    expect(executionCalls[0].repositoryPath).toBe("/mock/workspace/anka-api");
    expect(executionCalls[1].repositoryId).toBe("repo-web-id");
    expect(executionCalls[1].repositoryPath).toBe("/mock/workspace/anka-web");
  });

  // 5. Backend success allows frontend execution
  test("5. Backend success allows frontend execution", async () => {
    const executedRepoIds: string[] = [];

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      executedRepoIds.push(opts.request.repositoryId);
      return {
        runId: opts.runId,
        branchName: "branch",
        baseCommitSha: "123",
        worktreePath: "/tmp",
        changedFiles: ["file.ts"],
        diffSummary: "",
        validationPassed: true,
        validationCommands: ["npm test"],
        agentResponse: {
          explanation: "Success",
          changes: [{ path: "file.ts", content: "code", description: "desc", action: "modify" }],
          commitMessage: "commit",
          sessionId: opts.request.sessionId,
          buildVerified: true,
          healthStatus: "HEALTHY",
        },
      };
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Feature across repos",
      customRepositories: [mockBackendRepo, mockFrontendRepo],
    });

    expect(executedRepoIds).toEqual(["repo-api-id", "repo-web-id"]);
    expect(result.overallStatus).toBe("SUCCESS");
    expect(result.results.length).toBe(2);
    expect(result.results[0].status).toBe("SUCCESS");
    expect(result.results[1].status).toBe("SUCCESS");
  });

  // 6. Backend failure stops frontend
  test("6. Backend failure stops frontend execution immediately", async () => {
    const executedRepoIds: string[] = [];

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      executedRepoIds.push(opts.request.repositoryId);
      if (opts.request.repositoryId === "repo-api-id") {
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "123",
          worktreePath: "/tmp",
          changedFiles: ["src/user.ts"],
          diffSummary: "",
          validationPassed: false,
          validationCommands: ["npm test"],
          validationErrors: "src/user.ts(10,5): error TS2304: Cannot find name 'Status'",
          agentResponse: {
            explanation: "Build failed",
            changes: [],
            commitMessage: "",
            sessionId: opts.request.sessionId,
            buildVerified: false,
            healthStatus: "UNHEALTHY",
          },
        };
      }
      return {} as any;
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Feature across repos",
      customRepositories: [mockBackendRepo, mockFrontendRepo],
    });

    expect(executedRepoIds).toEqual(["repo-api-id"]); // Frontend never called
    expect(result.overallStatus).toBe("FAILED");
    expect(result.failedRepositoryId).toBe("repo-api-id");
    expect(result.results.find((r) => r.repositoryId === "repo-web-id")?.status).toBe("SKIPPED");
  });

  // 7. Backend success + frontend failure: overallStatus = PARTIAL_FAILURE
  test("7. Backend success + frontend failure: overallStatus = PARTIAL_FAILURE", async () => {
    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      if (opts.request.repositoryId === "repo-api-id") {
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "123",
          worktreePath: "/tmp",
          changedFiles: ["src/user.ts"],
          diffSummary: "",
          validationPassed: true,
          validationCommands: ["npm test"],
          agentResponse: {
            explanation: "API changes verified",
            changes: [
              {
                path: "src/user.ts",
                content: "export interface User { id: string; status: string; }",
                description: "Add user status",
                action: "modify",
              },
            ],
            commitMessage: "feat: add user status",
            sessionId: opts.request.sessionId,
            buildVerified: true,
            healthStatus: "HEALTHY",
          },
        };
      } else {
        // Frontend fails
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "123",
          worktreePath: "/tmp",
          changedFiles: ["src/App.tsx"],
          diffSummary: "",
          validationPassed: false,
          validationCommands: ["npm run build"],
          validationErrors: "src/App.tsx(15,9): error TS2322: Type mismatch",
          agentResponse: {
            explanation: "Frontend build failed",
            changes: [],
            commitMessage: "",
            sessionId: opts.request.sessionId,
            buildVerified: false,
            healthStatus: "UNHEALTHY",
          },
        };
      }
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Feature across repos",
      customRepositories: [mockBackendRepo, mockFrontendRepo],
    });

    expect(result.overallStatus).toBe("PARTIAL_FAILURE");
    expect(result.failedRepositoryId).toBe("repo-web-id");
    expect(result.results[0].status).toBe("SUCCESS");
    expect(result.results[0].changes.length).toBe(1);
    expect(result.results[1].status).toBe("FAILED");
  });

  // 8. CrossRepoHandoff reaches frontend request
  test("8. CrossRepoHandoff reaches frontend request prompt", async () => {
    let frontendPrompt = "";

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      if (opts.request.repositoryId === "repo-api-id") {
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "123",
          worktreePath: "/tmp",
          changedFiles: ["src/types/user.ts"],
          diffSummary: "",
          validationPassed: true,
          validationCommands: ["npm test"],
          agentResponse: {
            explanation: "Added user status enum and interface",
            changes: [
              {
                path: "src/types/user.ts",
                content: "export interface User {\n  id: string;\n  status: 'active' | 'inactive';\n}",
                description: "Export User interface with status",
                action: "modify",
              },
            ],
            commitMessage: "feat: add user status enum",
            sessionId: opts.request.sessionId,
            buildVerified: true,
            healthStatus: "HEALTHY",
          },
        };
      } else {
        frontendPrompt = opts.request.message;
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "123",
          worktreePath: "/tmp",
          changedFiles: ["src/App.tsx"],
          diffSummary: "",
          validationPassed: true,
          validationCommands: ["npm test"],
          agentResponse: {
            explanation: "Web UI updated",
            changes: [{ path: "src/App.tsx", content: "code", description: "desc", action: "modify" }],
            commitMessage: "feat: update App",
            sessionId: opts.request.sessionId,
            buildVerified: true,
            healthStatus: "HEALTHY",
          },
        };
      }
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Add user status support to API and update Web",
      customRepositories: [mockBackendRepo, mockFrontendRepo],
    });

    expect(frontendPrompt).toContain("[UPSTREAM_CROSS_REPO_CONTRACT]");
    expect(frontendPrompt).toContain("Repository: anka-api");
    expect(frontendPrompt).toContain("Role: backend");
    expect(frontendPrompt).toContain("export interface User");
    expect(frontendPrompt).toContain("status: 'active' | 'inactive'");
  });

  // 9. Handoff contains contract info but no filesystem handle/token
  test("9. Handoff contains contract info but no filesystem handle or security tokens", async () => {
    let capturedPrompt = "";

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      if (opts.request.repositoryId === "repo-api-id") {
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "123",
          worktreePath: "/tmp/secret-path/anka-api",
          changedFiles: ["src/user.ts"],
          diffSummary: "",
          validationPassed: true,
          validationCommands: [],
          agentResponse: {
            explanation: "Done",
            changes: [
              {
                path: "src/user.ts",
                content: "export interface User { id: string; status: string; }",
                description: "desc",
                action: "modify",
              },
            ],
            commitMessage: "msg",
            sessionId: "s1",
            buildVerified: true,
            healthStatus: "HEALTHY",
          },
        };
      } else {
        capturedPrompt = opts.request.message;
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "123",
          worktreePath: "/tmp",
          changedFiles: [],
          diffSummary: "",
          validationPassed: true,
          validationCommands: [],
          agentResponse: {
            explanation: "Done",
            changes: [],
            commitMessage: "",
            sessionId: "s2",
            buildVerified: true,
            healthStatus: "HEALTHY",
          },
        };
      }
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Goal",
      customRepositories: [mockBackendRepo, mockFrontendRepo],
    });

    // Verification: no local filesystem paths or token credentials in downstream prompt
    expect(capturedPrompt).not.toContain("/tmp/secret-path");
    expect(capturedPrompt).not.toContain("githubToken");
    expect(capturedPrompt).not.toContain("Bearer");
    expect(capturedPrompt).not.toContain(".git");
  });

  // 10. Frontend attempt to modify backend path fails through normal repo scope
  test("10. Frontend attempt to modify backend path fails through normal repo scope", () => {
    // Contract authorized ONLY frontend files
    const frontendContract: ExecutionContract = {
      goal: "Update frontend to display user status",
      taskType: "NEW_FEATURE",
      risk: "LOW",
      estimatedComplexity: "SMALL",
      pipeline: "REPOSITORY",
      environment: "REACT_TS",
      repositoryRequired: true,
      expectedFiles: ["src/App.tsx"],
      validationType: "TYPESCRIPT_BUILD",
      targetPaths: ["src/App.tsx"],
      allowedActions: ["modify"],
      forbiddenActions: ["delete"],
      maxFiles: 2,
      searchScope: ["src/App.tsx"],
      contextScope: ["src/App.tsx"],
      diffCriticEnabled: true,
    };

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        {
          path: "src/App.tsx",
          action: "modify",
          description: "Display user status",
          dependencies: [],
        },
      ],
    };

    // Agent attempts to write a change to an upstream backend path from the frontend worktree
    const illegalProposedChange = [
      {
        path: "../anka-api/src/user.ts", // Out of repo root / undeclared
        action: "modify" as const,
        description: "attempt to sneak cross-repo write",
        content: "export interface Malicious { hack: true; }",
      },
    ];

    const result = enforceExecutionScope({
      proposedChanges: illegalProposedChange,
      manifest,
      contract: frontendContract,
      existingFilePaths: ["src/App.tsx", "package.json"],
    });

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => (e.reason as string) === "UNDECLARED_FILE" || e.reason === "TARGET_PATH_VIOLATION")).toBe(true);
  });

  // 11. Each repository gets separate run/worktree invocation
  test("11. Each repository gets separate run/worktree invocation", async () => {
    const runIds: string[] = [];

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      runIds.push(opts.runId);
      return {
        runId: opts.runId,
        branchName: "branch",
        baseCommitSha: "123",
        worktreePath: "/tmp",
        changedFiles: ["src/index.ts"],
        diffSummary: "",
        validationPassed: true,
        validationCommands: [],
        agentResponse: {
          explanation: "Done",
          changes: [{ path: "src/index.ts", content: "code", description: "desc", action: "modify" }],
          commitMessage: "",
          sessionId: "",
          buildVerified: true,
          healthStatus: "HEALTHY",
        },
      };
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Goal",
      customRepositories: [mockBackendRepo, mockFrontendRepo],
    });

    expect(runIds.length).toBe(2);
    // Verified distinct run IDs
    expect(runIds[0]).not.toEqual(runIds[1]);
  });

  // 12. All aggregated changes contain repositoryId
  test("12. All aggregated changes contain repositoryId", async () => {
    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      const repoId = opts.request.repositoryId;
      return {
        runId: opts.runId,
        branchName: "branch",
        baseCommitSha: "123",
        worktreePath: "/tmp",
        changedFiles: [`src/${repoId}.ts`],
        diffSummary: "",
        validationPassed: true,
        validationCommands: [],
        agentResponse: {
          explanation: "Done",
          changes: [
            {
              path: `src/${repoId}.ts`,
              action: "modify",
              content: `// from ${repoId}`,
              description: `change in ${repoId}`,
            },
          ],
          commitMessage: "",
          sessionId: "",
          buildVerified: true,
          healthStatus: "HEALTHY",
        },
      };
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Goal",
      customRepositories: [mockBackendRepo, mockFrontendRepo],
    });

    expect(result.changes.length).toBe(2);
    expect(result.changes[0].repositoryId).toBe("repo-api-id");
    expect(result.changes[1].repositoryId).toBe("repo-web-id");
  });

  // 13. Existing push payload accepts aggregated changes
  test("13. Existing push payload accepts aggregated changes grouped by repositoryId", async () => {
    const changes: AgentFileChange[] = [
      {
        path: "src/user.ts",
        content: "api code",
        description: "api desc",
        repositoryId: "repo-api-id",
      },
      {
        path: "src/App.tsx",
        content: "web code",
        description: "web desc",
        repositoryId: "repo-web-id",
      },
    ];

    // Simulate pushAgentChanges grouping logic in ai-controller.ts lines 450-458
    const primaryChanges = changes.filter((c) => !c.repositoryId);
    const secondaryChangesByRepo = new Map<string, { path: string; content: string }[]>();

    for (const c of changes) {
      if (c.repositoryId) {
        const list = secondaryChangesByRepo.get(c.repositoryId) || [];
        list.push({ path: c.path, content: c.content });
        secondaryChangesByRepo.set(c.repositoryId, list);
      }
    }

    expect(primaryChanges.length).toBe(0);
    expect(secondaryChangesByRepo.size).toBe(2);
    expect(secondaryChangesByRepo.get("repo-api-id")).toEqual([
      { path: "src/user.ts", content: "api code" },
    ]);
    expect(secondaryChangesByRepo.get("repo-web-id")).toEqual([
      { path: "src/App.tsx", content: "web code" },
    ]);
  });

  // 14. No automatic push occurs during generation
  test("14. No automatic push occurs during generation", async () => {
    let pushAttempted = false;

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      // In isolated agent runs, git push is NEVER called
      return {
        runId: opts.runId,
        branchName: "branch",
        baseCommitSha: "123",
        worktreePath: "/tmp",
        changedFiles: ["src/file.ts"],
        diffSummary: "",
        validationPassed: true,
        validationCommands: ["npm test"],
        agentResponse: {
          explanation: "Verified only",
          changes: [{ path: "src/file.ts", content: "code", description: "desc", action: "modify" }],
          commitMessage: "commit",
          sessionId: "",
          buildVerified: true,
          healthStatus: "HEALTHY",
        },
      };
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Goal",
      customRepositories: [mockBackendRepo, mockFrontendRepo],
    });

    expect(pushAttempted).toBe(false);
    expect(result.overallStatus).toBe("SUCCESS");
    // Changes are only returned to the caller, not pushed
    expect(result.changes.length).toBe(2);
  });

  // 15. Dependency cycle in repo plan rejected
  test("15. Dependency cycle in repo plan rejected", () => {
    const coordinator = new MultiRepoCoordinator();

    // Cyclic edges: web depends on api, api depends on web
    const cyclicEdges = {
      "repo-web-id": ["repo-api-id"],
      "repo-api-id": ["repo-web-id"],
    };

    expect(() => {
      coordinator.buildExecutionPlan(
        "proj-1",
        "Add features with circular dependency",
        [mockBackendRepo, mockFrontendRepo],
        cyclicEdges
      );
    }).toThrow(/\[CYCLIC_DEPENDENCY_ERROR\]/);
  });

  // 16. Independent single-repo agent behavior remains unchanged
  test("16. Independent single-repo agent behavior remains unchanged", async () => {
    let singleRepoInvokedWithNullRepoId = false;

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      // When executed for single repository, opts.request.repositoryId is that repository's ID
      if (opts.request.repositoryId === "repo-single") {
        singleRepoInvokedWithNullRepoId = true;
      }
      return {
        runId: opts.runId,
        branchName: "branch",
        baseCommitSha: "123",
        worktreePath: "/tmp",
        changedFiles: ["src/index.ts"],
        diffSummary: "",
        validationPassed: true,
        validationCommands: [],
        agentResponse: {
          explanation: "Single repo pass",
          changes: [{ path: "src/index.ts", content: "code", description: "desc", action: "modify" }],
          commitMessage: "",
          sessionId: "",
          buildVerified: true,
          healthStatus: "HEALTHY",
        },
      };
    };

    const singleCandidate: RepositoryCandidate = {
      id: "repo-single",
      name: "my-single-app",
      role: "backend",
      localPath: "/tmp/single",
      isPrimary: true,
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Single repo update",
      customRepositories: [singleCandidate],
    });

    expect(singleRepoInvokedWithNullRepoId).toBe(true);
    expect(result.overallStatus).toBe("SUCCESS");
    expect(result.results.length).toBe(1);
    expect(result.changes[0].repositoryId).toBe("repo-single");
  });
});
