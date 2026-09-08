import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";
import { detectStartCommand, resolveTargetRoute } from "../../services/visual-verifier.service";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { CodingAgent } from "../application/CodingAgent";
import { VisualVerificationResult } from "../../types";

describe("Framework Precedence & Visual Verification Live Path Regressions", () => {
  // Test 1: Vite repo with src/pages/* and vite in package.json -> VITE_REACT
  test("1. Vite repo with src/pages/* is detected as VITE_REACT, not NEXT_JS", () => {
    const pkgJson = JSON.stringify({
      name: "opspulse-dashboard",
      scripts: {
        dev: "vite",
      },
      dependencies: {
        react: "^18.3.1",
        "react-dom": "^18.3.1",
      },
      devDependencies: {
        vite: "^6.0.1",
      },
    });

    const files = [
      "src/App.tsx",
      "src/pages/DashboardPage/DashboardPage.tsx",
      "src/components/layout/Header/Header.tsx",
      "src/components/layout/Header/Header.css",
      "vite.config.ts",
    ];

    const arch = detectRepositoryArchitecture(files, pkgJson);
    expect(arch.framework).toBe("VITE_REACT");
    expect(arch.router).toBe("NONE");
    expect(arch.hasAppRouter).toBe(false);
    expect(arch.hasPagesRouter).toBe(false);
  });

  // Test 2: Next repo with next dependency + pages/* -> NEXT_JS
  test("2. Next repo with next dependency and pages/* is detected as NEXT_JS", () => {
    const pkgJson = JSON.stringify({
      name: "next-app",
      scripts: {
        dev: "next dev",
      },
      dependencies: {
        next: "^14.2.0",
        react: "^18.3.1",
      },
    });

    const files = [
      "pages/index.tsx",
      "pages/DashboardPage/DashboardPage.tsx",
      "components/Header.tsx",
    ];

    const arch = detectRepositoryArchitecture(files, pkgJson);
    expect(arch.framework).toBe("NEXT_JS");
    expect(arch.router).toBe("PAGES_ROUTER");
    expect(arch.hasPagesRouter).toBe(true);
  });

  // Test 3: Vite repo with vite.config.ts and no Next dependency -> VITE_REACT
  test("3. Vite repo with vite.config.ts and no Next dependency is detected as VITE_REACT", () => {
    const files = [
      "src/App.tsx",
      "src/pages/Home.tsx",
      "vite.config.ts",
    ];

    const arch = detectRepositoryArchitecture(files, JSON.stringify({ name: "plain-vite" }));
    expect(arch.framework).toBe("VITE_REACT");
  });

  // Test 4: Next repo with next.config.js and no Vite dependency -> NEXT_JS
  test("4. Next repo with next.config.js is detected as NEXT_JS", () => {
    const files = [
      "app/page.tsx",
      "next.config.js",
    ];

    const arch = detectRepositoryArchitecture(files, JSON.stringify({ name: "plain-next" }));
    expect(arch.framework).toBe("NEXT_JS");
  });

  // Test 5: Vite start command verification
  test("5. Vite start command uses --host 127.0.0.1, --port, and --strictPort", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vite-cmd-test-"));
    try {
      fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
        scripts: { dev: "vite" }
      }));
      const cmd = detectStartCommand(tmp, "VITE_REACT", 4321);
      expect(cmd).not.toBeNull();
      expect(cmd?.command).toBe("npm run dev -- --host 127.0.0.1 --port 4321 --strictPort");
      expect(cmd?.isPreview).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Test 6: Next start command verification
  test("6. Next start command preserves --hostname 127.0.0.1 and --port", () => {
    const fs = require("fs");
    const os = require("os");
    const path = require("path");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "next-cmd-test-"));
    try {
      fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({
        scripts: { dev: "next dev" }
      }));
      const cmd = detectStartCommand(tmp, "NEXT_JS", 4321);
      expect(cmd).not.toBeNull();
      expect(cmd?.command).toBe("npm run dev -- --hostname 127.0.0.1 --port 4321");
      expect(cmd?.isPreview).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  // Test 7: Vite route defaults to /
  test("7. Route resolution for Vite repository defaults to /", () => {
    const changedFiles = [
      "src/pages/DashboardPage/DashboardPage.tsx",
      "src/components/layout/Header/Header.tsx",
    ];
    const route = resolveTargetRoute(changedFiles, "VITE_REACT", "Update dashboard");
    expect(route).toBe("/");
  });

  // Test 8: visualVerification survives GitWorktreeService -> AgentResponse -> CodingAgent
  test("8. visualVerification is preserved through CodingAgent return", async () => {
    const mockVisualResult: VisualVerificationResult = {
      status: "PASSED",
      framework: "VITE_REACT",
      route: "/",
      url: "http://127.0.0.1:54321/",
      httpStatus: 200,
      screenshotPath: "C:\\tmp\\screenshot.png",
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [],
      durationMs: 150,
    };

    const { RepositoryMaterializationService } = require("../../services/repository-materialization.service");
    const fs = require("fs");
    jest.spyOn(RepositoryMaterializationService, "ensureProjectRepositoryCurrent").mockResolvedValue({
      success: true,
      metadata: { canonicalRoot: "C:\\fake\\repo" } as any,
    });
    const origExists = fs.existsSync;
    jest.spyOn(fs, "existsSync").mockImplementation((p: any) => {
      if (typeof p === "string" && p.includes("fake")) return true;
      return origExists(p);
    });
    jest.spyOn(GitWorktreeService, "resolveRepositoryRoot").mockResolvedValue("C:\\fake\\repo");
    jest.spyOn(GitWorktreeService, "getHeadCommitSha").mockResolvedValue("abcdef123456");
    jest.spyOn(GitWorktreeService, "runIsolatedAgent").mockResolvedValue({
      runId: "test-run",
      branchName: "temp-branch",
      baseCommitSha: "abcdef",
      worktreePath: "C:\\fake\\worktree",
      changedFiles: ["src/App.tsx"],
      diffSummary: "1 file changed",
      validationPassed: true,
      validationCommands: ["npm test"],
      visualVerification: mockVisualResult,
      agentResponse: {
        explanation: "All good",
        changes: [{ path: "src/App.tsx", content: "export default () => null;", description: "test" }],
        commitMessage: "test commit",
        sessionId: "sess-1",
        buildVerified: true,
        visualVerification: mockVisualResult,
      },
    });

    const response = await CodingAgent.runCodingAgent("user-1", "cmtkf3pfn000xdmesn1s7haz2", {
      message: "Update dashboard",
      sessionId: "sess-1",
    });

    expect(response.visualVerification).toBeDefined();
    expect(response.visualVerification?.status).toBe("PASSED");
    expect(response.visualVerification?.framework).toBe("VITE_REACT");
    expect(response.visualVerification?.screenshotPath).toBe("C:\\tmp\\screenshot.png");
  });

  // Test 9: single-repo controller complete payload includes visualVerification
  test("9. single-repo controller complete payload includes visualVerification", async () => {
    const { AiController } = require("../../controllers/ai-controller");
    const { AiService } = require("../application/AiService");

    const mockVisualResult: VisualVerificationResult = {
      status: "PASSED",
      framework: "VITE_REACT",
      route: "/",
      url: "http://127.0.0.1:54321/",
      httpStatus: 200,
      screenshotPath: "C:\\tmp\\screenshot.png",
      pageErrors: [],
      consoleErrors: [],
      failedRequests: [],
      durationMs: 150,
    };

    const aiServiceInstance = AiService.getInstance();
    jest.spyOn(aiServiceInstance, "runCodingAgent").mockResolvedValue({
      explanation: "Controller test",
      changes: [],
      commitMessage: "test",
      sessionId: "sess-1",
      buildVerified: true,
      visualVerification: mockVisualResult,
    });

    const events: Array<{ event: string; data: any }> = [];
    const mockRes: any = {
      setHeader: jest.fn(),
      write: jest.fn((chunk: string) => {
        const match = chunk.match(/event: (.*?)\ndata: (.*?)\n\n/s);
        if (match) {
          events.push({ event: match[1], data: JSON.parse(match[2]) });
        }
      }),
      end: jest.fn(),
    };

    const mockReq: any = {
      user: { userId: "user-1" },
      params: { projectId: "cmtkf3pfn000xdmesn1s7haz2" },
      body: { message: "Update header" },
    };

    const controller = new AiController();
    await controller.streamAgent(mockReq, mockRes);

    const completeEvent = events.find((e) => e.event === "complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.data?.visualVerification).toBeDefined();
    expect(completeEvent?.data?.visualVerification?.status).toBe("PASSED");
    expect(completeEvent?.data?.visualVerification?.framework).toBe("VITE_REACT");
  });
});
