import { WasmASTParserEngine } from "../../services/ast-parser.engine";
import { StaticValidationEngine } from "../../services/static-validator.engine";
import { ValidationDetector } from "../validation/ValidationDetector";
import {
  MultiRepoCoordinator,
  RepositoryCandidate,
} from "../coordination/MultiRepoCoordinator";
import { RepositoryRunSummary } from "../../services/git-worktree.service";

describe("Multi-Repo Frontend Validation & Handoff Regressions", () => {
  beforeAll(async () => {
    await WasmASTParserEngine.initialize();
  });

  // 1. AST export parser: export async function
  test("1. AST export parser extracts 'fetchUsers' from 'export async function fetchUsers() {}'", () => {
    const code = "export async function fetchUsers() { return []; }";
    const symbols = WasmASTParserEngine.extractSymbols("src/api/users.ts", code);
    const fetchExport = symbols.exports.find((e) => e.name === "fetchUsers");
    expect(fetchExport).toBeDefined();
    expect(fetchExport?.isDefault).toBe(false);
    expect(fetchExport?.type).toBe("function");
  });

  // 2. AST export parser: export default async function
  test("2. AST export parser extracts 'loadUsers' from 'export default async function loadUsers() {}'", () => {
    const code = "export default async function loadUsers() { return []; }";
    const symbols = WasmASTParserEngine.extractSymbols("src/api/users.ts", code);
    const loadExport = symbols.exports.find((e) => e.name === "loadUsers");
    expect(loadExport).toBeDefined();
    expect(loadExport?.isDefault).toBe(true);
    expect(loadExport?.type).toBe("function");
  });

  // 3. Existing sync export function
  test("3. Existing sync 'export function foo() {}' still extracts correctly", () => {
    const code = "export function foo() { return 42; }";
    const symbols = WasmASTParserEngine.extractSymbols("src/utils.ts", code);
    const fooExport = symbols.exports.find((e) => e.name === "foo");
    expect(fooExport).toBeDefined();
    expect(fooExport?.isDefault).toBe(false);
    expect(fooExport?.type).toBe("function");
  });

  // 4. Existing interface / type / class / const exports remain green
  test("4. Existing interface, type, class, and const exports extract correctly", () => {
    const code = `
export interface User { id: string; }
export type UserStatus = 'active' | 'inactive';
export class UserService {}
export const DEFAULT_STATUS = 'active';
export enum Role { ADMIN, USER }
`;
    const symbols = WasmASTParserEngine.extractSymbols("src/types.ts", code);
    expect(symbols.exports.some((e) => e.name === "User" && e.type === "interface")).toBe(true);
    expect(symbols.exports.some((e) => e.name === "UserStatus" && e.type === "type")).toBe(true);
    expect(symbols.exports.some((e) => e.name === "UserService" && e.type === "class")).toBe(true);
    expect(symbols.exports.some((e) => e.name === "DEFAULT_STATUS")).toBe(true);
    expect(symbols.exports.some((e) => e.name === "Role")).toBe(true);
  });

  // 5. Static validation: no missing_export failure on async function export
  test("5. StaticValidationEngine resolves import of async exported function without missing_export", () => {
    const snapshotFiles = [
      {
        path: "src/api/users.ts",
        content: "export async function fetchUsers(): Promise<any[]> { return []; }",
      },
      {
        path: "src/App.tsx",
        content: `import { fetchUsers } from './api/users';\nexport function App() { fetchUsers(); return null; }`,
      },
      {
        path: "src/api/users.test.ts",
        content: `import { fetchUsers } from './users';\ntest('fetchUsers', () => { fetchUsers(); });`,
      },
    ];

    const result = StaticValidationEngine.validate(snapshotFiles);
    const missingExportIssues = result.issues.filter((i) => i.checkId === "missing_export");
    expect(missingExportIssues).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  // 6. ValidationDetector: global result contains unrelated FAIL, but relevantIssues has no FAIL -> passed = true
  test("6. ValidationDetector recomputes pass state: unrelated snapshot FAIL does not fail modified files gate", async () => {
    const snapshotFiles = [
      {
        path: "src/unrelated/broken.ts",
        content: "import { NonExistent } from './nowhere';",
      },
      {
        path: "src/components/UserCard.tsx",
        content: "export function UserCard() { return <div>User</div>; }",
      },
    ];

    const changes = [
      {
        path: "src/components/UserCard.tsx",
        action: "modify" as const,
        description: "Update UserCard component",
        content: "export function UserCard() { return <div>Updated User</div>; }",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      { keyFiles: snapshotFiles },
      "Update UserCard component styling"
    );

    expect(result.overallPassed).toBe(true);
    expect(result.failedChecks).toHaveLength(0);
  });

  // 7. ValidationDetector: relevant FAIL remains passed = false
  test("7. ValidationDetector preserves FAIL if modified file introduces a broken import", async () => {
    const snapshotFiles = [
      {
        path: "src/components/UserCard.tsx",
        content: "export function UserCard() { return <div>User</div>; }",
      },
    ];

    const changes = [
      {
        path: "src/components/UserCard.tsx",
        action: "modify" as const,
        description: "Update UserCard component with broken import",
        content: "import { MissingSymbol } from './non-existent';\nexport function UserCard() { return <div>Bad</div>; }",
      },
    ];

    const result = await ValidationDetector.runFeatureValidation(
      changes,
      { keyFiles: snapshotFiles },
      "Update UserCard component"
    );

    expect(result.overallPassed).toBe(false);
    expect(result.failedChecks.some((c) => c.includes("broken_import"))).toBe(true);
  });

  // 8 & 9. CrossRepoHandoff clean summary
  test("8 & 9. CrossRepoHandoff cleans execution reporting and retains only factual contract summary", async () => {
    const mockBackendRepo: RepositoryCandidate = {
      id: "repo-api-id",
      name: "MONOREPO_API_test",
      role: "backend",
      localPath: "/mock/api",
      githubUrl: "https://github.com/org/api",
      isPrimary: true,
    };

    const mockFrontendRepo: RepositoryCandidate = {
      id: "repo-web-id",
      name: "MONOREPO_WEB_test",
      role: "frontend",
      localPath: "/mock/web",
      githubUrl: "https://github.com/org/web",
      isPrimary: false,
    };

    let receivedFrontendPrompt = "";

    const verboseBackendExplanation = `User status was added to the backend User contract and users API response.

Reflection Pass Score: 90%. Deterministic Policy: PASS. LLM Review: PASS (LOW risk).

### ⏱️ Pipeline Stage Performance & Metrics
\`\`\`text
Pipeline Start
Stage 1: Intent Analysis
Stage 8: Build Repair
Total LLM API Cost: $0.0333
\`\`\`

### 📋 Repository Intelligence Verification Checklist
**Repository Search Confidence:** 90%
**Build Status:** ✅ Build Verified / Passed

✅ Analyze current code base
✅ Build passes
✅ Feature functional & working`;

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      if (opts.request.repositoryId === "repo-api-id") {
        return {
          runId: opts.runId,
          branchName: "branch",
          baseCommitSha: "123",
          worktreePath: "/tmp",
          changedFiles: ["src/types/user.ts", "src/services/users.service.ts"],
          diffSummary: "",
          validationPassed: true,
          validationCommands: ["npm test"],
          agentResponse: {
            explanation: verboseBackendExplanation,
            changes: [
              {
                path: "src/types/user.ts",
                content: "export type UserStatus = 'active' | 'inactive';\nexport interface User { id: string; status: UserStatus; }",
                description: "Export User and UserStatus",
                action: "modify",
              },
            ],
            commitMessage: "feat: user status",
            sessionId: opts.request.sessionId,
            buildVerified: true,
            healthStatus: "HEALTHY",
          },
        };
      } else {
        receivedFrontendPrompt = opts.request.message;
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
            explanation: "Frontend updated",
            changes: [],
            commitMessage: "feat: update frontend",
            sessionId: opts.request.sessionId,
            buildVerified: true,
            healthStatus: "HEALTHY",
          },
        };
      }
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Add user status support",
      customRepositories: [mockBackendRepo, mockFrontendRepo],
    });

    expect(result.overallStatus).toBe("SUCCESS");

    // Test 8: Must NOT contain telemetry/reporting noise
    expect(receivedFrontendPrompt).not.toContain("Reflection Pass Score");
    expect(receivedFrontendPrompt).not.toContain("Pipeline Start");
    expect(receivedFrontendPrompt).not.toContain("Total LLM API Cost");
    expect(receivedFrontendPrompt).not.toContain("Repository Intelligence Verification Checklist");
    expect(receivedFrontendPrompt).not.toContain("Stage 1: Intent Analysis");

    // Test 9: Must contain factual changed files, contract, and clean summary
    expect(receivedFrontendPrompt).toContain("[UPSTREAM_CROSS_REPO_CONTRACT]");
    expect(receivedFrontendPrompt).toContain("Repository: MONOREPO_API_test");
    expect(receivedFrontendPrompt).toContain("Role: backend");
    expect(receivedFrontendPrompt).toContain("- src/types/user.ts");
    expect(receivedFrontendPrompt).toContain("export type UserStatus = 'active' | 'inactive';");
    expect(receivedFrontendPrompt).toContain("Summary:\nUser status was added to the backend User contract and users API response.");
  });

  // 10. MultiRepoCoordinator failure logging executes without exposing secrets/tokens
  test("10. MultiRepoCoordinator failure logging executes concisely without exposing tokens", async () => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    const mockBackendRepo: RepositoryCandidate = {
      id: "repo-api-id",
      name: "MONOREPO_API_test",
      role: "backend",
      localPath: "/mock/api",
      githubUrl: "https://github.com/org/api",
      isPrimary: true,
    };

    const mockRunner = async (opts: any): Promise<RepositoryRunSummary> => {
      return {
        runId: opts.runId,
        branchName: "branch",
        baseCommitSha: "123",
        worktreePath: "/tmp",
        changedFiles: [],
        diffSummary: "",
        validationPassed: false,
        validationCommands: ["npm test"],
        validationErrors: "Type error: missing export fetchUsers",
        agentResponse: {
          explanation: "Build failed",
          changes: [],
          commitMessage: "",
          sessionId: opts.request.sessionId,
          buildVerified: false,
          healthStatus: "UNHEALTHY",
          buildErrors: "Feature / static validation failed required checks.",
        },
      };
    };

    const coordinator = new MultiRepoCoordinator(mockRunner);
    const result = await coordinator.coordinateTask({
      userId: "user-1",
      projectId: "proj-1",
      userPrompt: "Secret token: ghp_12345ABCDE should not be logged",
      customRepositories: [mockBackendRepo],
    });

    expect(result.overallStatus).toBe("FAILED");
    expect(errorSpy).toHaveBeenCalled();
    const loggedCalls = errorSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(loggedCalls).toContain("[MULTI_REPO_STEP_FAILED]");
    expect(loggedCalls).toContain("repo=MONOREPO_API_test");
    expect(loggedCalls).toContain("code=STATIC_VALIDATION_FAILED");
    expect(loggedCalls).not.toContain("ghp_12345ABCDE");

    errorSpy.mockRestore();
  });
});
