import fs from "fs";
import os from "os";
import path from "path";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { WorktreeDependencyService } from "../../services/worktree-dependency.service";
import { AgentPipeline } from "../orchestration/AgentPipeline";
import { DiagnosticNormalizer } from "../validation/DiagnosticNormalizer";
import { ErrorClassifier } from "../validation/ErrorClassifier";
import { ValidationRunner } from "../validation/ValidationRunner";

const googleFontFailure = `
next/font: error:
Failed to fetch Geist from Google Fonts.
Failed to fetch Geist Mono from Google Fonts.
Turbopack build failed with 2 errors.
`;

describe("external network failure classification precedence", () => {
  test("classifies a Next Google Font fetch failure as ENVIRONMENT", () => {
    const result = ErrorClassifier.classify(googleFontFailure);

    expect(result.type).toBe("ENVIRONMENT");
    expect(result.isInfrastructure).toBe(true);
    expect(result.isCompile).toBe(false);
    expect(result.canSurgicalPatch).toBe(false);
  });

  test("prefers the concrete Geist fetch cause over generic Turbopack text", () => {
    const result = ErrorClassifier.classify(
      "Turbopack build failed\nnext/font: error\nFailed to fetch Geist from Google Fonts",
    );

    expect(result.type).toBe("ENVIRONMENT");
  });

  test("classifies ECONNRESET during dependency access as ENVIRONMENT", () => {
    const result = ErrorClassifier.classify(
      "npm ERR! network request to https://registry.npmjs.org/react failed, reason: read ECONNRESET",
    );

    expect(result.type).toBe("ENVIRONMENT");
  });

  test("classifies EAI_AGAIN DNS failures as ENVIRONMENT", () => {
    const result = ErrorClassifier.classify(
      "getaddrinfo EAI_AGAIN fonts.googleapis.com\nTurbopack build failed",
    );

    expect(result.type).toBe("ENVIRONMENT");
  });

  test("classifies ENETUNREACH and explicit network request failures as ENVIRONMENT", () => {
    expect(ErrorClassifier.classify("connect ENETUNREACH 142.250.0.0:443").type).toBe("ENVIRONMENT");
    expect(ErrorClassifier.classify("network request failed while downloading a build dependency").type).toBe("ENVIRONMENT");
  });

  test("does not treat an ungrounded connection token or bare next/font error as environment evidence", () => {
    expect(ErrorClassifier.classify("ECONNRESET while parsing a local fixture").type).toBe("UNKNOWN");
    expect(ErrorClassifier.classify("next/font: error\nTurbopack build failed").type).toBe("COMPILE_NEXT");
  });

  test("keeps a genuine Next missing export failure as COMPILE_NEXT", () => {
    const result = ErrorClassifier.classify(`
./app/page.tsx
Export getFoo doesn't exist in target module
Turbopack build failed with 1 error
`);

    expect(result.type).toBe("COMPILE_NEXT");
    expect(result.isCompile).toBe(true);
  });

  test("keeps a genuine TypeScript failure as COMPILE_TS", () => {
    const result = ErrorClassifier.classify(`
app/page.tsx(12,7): error TS2322: Type 'number' is not assignable to type 'string'.
Failed to type check.
Turbopack build failed
`);

    expect(result.type).toBe("COMPILE_TS");
    expect(result.isCompile).toBe(true);
  });

  test("normalizes the specific font/network cause before source parsing", () => {
    const diagnostics = DiagnosticNormalizer.normalize(
      `app/layout.tsx\n${googleFontFailure}`,
    );

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].category).toBe("ENVIRONMENT_FAILURE");
    expect(diagnostics[0].filePath).toBeUndefined();
  });
});

describe("baseline external network failure", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-baseline-network-"));
    fs.writeFileSync(
      path.join(tempDir, "package.json"),
      JSON.stringify({ name: "next-app", scripts: { build: "next build" }, dependencies: { next: "15.0.0" } }),
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test("keeps a failed baseline blocked and never enters repository mutation", async () => {
    jest.spyOn(GitWorktreeService, "prepareRepositoryRun").mockResolvedValue({
      originalRepositoryPath: tempDir,
      repositoryRoot: tempDir,
      worktreePath: tempDir,
      branchName: "anka/network-baseline",
      targetBranch: "main",
      baseCommitSha: "baseline-sha",
    });
    jest.spyOn(GitWorktreeService, "rollbackWorktree").mockResolvedValue(undefined as any);
    jest.spyOn(WorktreeDependencyService, "prepareDependencies").mockResolvedValue({
      attempted: true,
      success: true,
      packageManager: "npm",
      installCommand: "npm ci --no-audit --no-fund",
      durationMs: 1,
      errorType: null,
    });
    jest.spyOn(ValidationRunner, "validateWithShell").mockResolvedValue({
      success: false,
      errors: googleFontFailure,
    });
    const pipelineSpy = jest.spyOn(AgentPipeline, "runCodingAgent");

    const summary = await GitWorktreeService.runIsolatedAgent({
      userId: "user-network-baseline",
      projectId: "project-network-baseline",
      repositoryPath: tempDir,
      runId: "run-network-baseline",
      request: { message: "Add a calculator button" },
    });

    expect(pipelineSpy).not.toHaveBeenCalled();
    expect(summary.validationPassed).toBe(false);
    expect(summary.changedFiles).toEqual([]);
    expect(summary.agentResponse.errorType).toBe("ENVIRONMENT");
    expect(summary.agentResponse.baselineReady).toBe(false);
    expect(summary.agentResponse.buildReady).toBe(false);
    expect(summary.agentResponse.baselineBuild).toBe("FAIL");
    expect(summary.agentResponse.baselineFailure).toBe(true);
    expect(summary.agentResponse.agentIntroduced).toBe(false);
  });
});
