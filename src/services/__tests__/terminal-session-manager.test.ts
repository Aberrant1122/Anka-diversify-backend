import fs from "fs";
import path from "path";
import os from "os";
import { TerminalSessionManager } from "../terminal-session-manager";
import { ProjectRepositoryService } from "../project-repository-service";

describe("TerminalSessionManager — Day-1 Interactive Terminal Tests", () => {
  let tempRoot: string;
  let repoAPath: string;
  let repoBPath: string;
  let outsidePath: string;
  let listSpy: jest.SpyInstance;

  beforeAll(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anka-terminal-test-"));
    repoAPath = path.join(tempRoot, "repo-a");
    repoBPath = path.join(tempRoot, "repo-b");
    outsidePath = path.join(tempRoot, "outside");

    fs.mkdirSync(repoAPath, { recursive: true });
    fs.mkdirSync(path.join(repoAPath, "src"), { recursive: true });
    fs.mkdirSync(repoBPath, { recursive: true });
    fs.mkdirSync(outsidePath, { recursive: true });
  });

  afterAll(() => {
    TerminalSessionManager.getInstance().shutdownAll();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(() => {
    TerminalSessionManager.resetInstance();
    listSpy = jest.spyOn(ProjectRepositoryService.prototype, "list").mockImplementation(async (projectId: string) => {
      if (projectId === "proj-valid") {
        return [
          {
            id: "repo-a-id",
            projectId: "proj-valid",
            name: "repo-a",
            role: "backend",
            githubUrl: "https://github.com/org/repo-a.git",
            localPath: repoAPath,
            isPrimary: true,
            hasToken: false,
          } as any,
          {
            id: "repo-b-id",
            projectId: "proj-valid",
            name: "repo-b",
            role: "frontend",
            githubUrl: "https://github.com/org/repo-b.git",
            localPath: repoBPath,
            isPrimary: false,
            hasToken: false,
          } as any,
        ];
      }
      if (projectId === "proj-missing-local") {
        return [
          {
            id: "repo-missing-id",
            projectId: "proj-missing-local",
            name: "repo-missing",
            role: "backend",
            githubUrl: "https://github.com/org/repo-missing.git",
            localPath: path.join(tempRoot, "non-existent-folder"),
            isPrimary: true,
            hasToken: false,
          } as any,
        ];
      }
      return [];
    });
  });

  afterEach(() => {
    listSpy.mockRestore();
    TerminalSessionManager.resetInstance();
  });

  it("1. create session with valid repository succeeds", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    expect(session.sessionId).toBeDefined();
    expect(session.projectId).toBe("proj-valid");
    expect(session.repositoryId).toBe("repo-a-id");
    expect(session.repositoryName).toBe("repo-a");
    expect(session.cwd).toBe(path.resolve(fs.realpathSync(repoAPath)));
  });

  it("2. wrong repositoryId/projectId pair rejected", async () => {
    const mgr = TerminalSessionManager.getInstance();
    await expect(mgr.createSession("proj-valid", "repo-wrong-id")).rejects.toThrow(
      "Repository not found for this project"
    );
  });

  it("3. missing localPath rejected with REPOSITORY_NOT_MATERIALIZED", async () => {
    const mgr = TerminalSessionManager.getInstance();
    await expect(mgr.createSession("proj-missing-local")).rejects.toThrow(
      "REPOSITORY_NOT_MATERIALIZED"
    );
  });

  it("4. cwd starts at repository root", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");
    expect(session.cwd).toBe(path.resolve(fs.realpathSync(repoAPath)));
  });

  it("5. pwd returns cwd", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    let stdout = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      "pwd",
      (c) => { stdout += c; },
      () => {}
    );

    expect(result.exitCode).toBe(0);
    expect(stdout.trim()).toBe(session.cwd);
  });

  it("6. cd src updates cwd", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    let stdout = "";
    let stderr = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      "cd src",
      (c) => { stdout += c; },
      (c) => { stderr += c; }
    );

    expect(result.exitCode).toBe(0);
    expect(stderr).toBe("");
    const expectedCwd = path.resolve(fs.realpathSync(path.join(repoAPath, "src")));
    expect(result.cwd).toBe(expectedCwd);

    const updated = mgr.getSession(session.sessionId, "proj-valid");
    expect(updated?.cwd).toBe(expectedCwd);
  });

  it("7. cd .. from root rejected", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    let stderr = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      "cd ..",
      () => {},
      (c) => { stderr += c; }
    );

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Access denied: directory is outside the selected repository");
    expect(result.cwd).toBe(session.cwd);
  });

  it("8. cd ../../../ rejected", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    let stderr = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      "cd ../../../",
      () => {},
      (c) => { stderr += c; }
    );

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Access denied");
    expect(result.cwd).toBe(session.cwd);
  });

  it("9. absolute outside-root cd rejected", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    let stderr = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      `cd "${outsidePath}"`,
      () => {},
      (c) => { stderr += c; }
    );

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Access denied");
    expect(result.cwd).toBe(session.cwd);
  });

  it("10. symlink/junction cwd escape rejected where platform supports it", async () => {
    const symlinkPath = path.join(repoAPath, "outside-link");
    try {
      if (!fs.existsSync(symlinkPath)) {
        fs.symlinkSync(outsidePath, symlinkPath, "junction");
      }
    } catch {
      // If OS permissions do not allow symlinks in non-elevated mode, pass gracefully
      return;
    }

    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    let stderr = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      "cd outside-link",
      () => {},
      (c) => { stderr += c; }
    );

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Access denied");
    expect(result.cwd).toBe(session.cwd);
  });

  it("11. normal command stdout streams", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    let streamedOutput = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      'node -e "process.stdout.write(\'Hello Streaming Stdout\')"',
      (c) => { streamedOutput += c; },
      () => {}
    );

    expect(result.exitCode).toBe(0);
    expect(streamedOutput).toContain("Hello Streaming Stdout");
  });

  it("12. stderr streams independently", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    let streamedError = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      'node -e "process.stderr.write(\'Hello Streaming Stderr\')"',
      () => {},
      (c) => { streamedError += c; }
    );

    expect(result.exitCode).toBe(0);
    expect(streamedError).toContain("Hello Streaming Stderr");
  });

  it("13. exit code returned correctly", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      'node -e "process.exit(42)"',
      () => {},
      () => {}
    );

    expect(result.exitCode).toBe(42);
  });

  it("14. sanitized env removes fake secret", async () => {
    process.env.ANKA_TEST_SECRET = "super_secret_token_123";
    process.env.DATABASE_URL = "postgres://user:pass@localhost:5432/db";
    process.env.MY_API_KEY = "sk-123456789";

    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    // Check internal session.env object
    const internalSession = (mgr as any).sessions.get(session.sessionId);
    expect(internalSession.env.ANKA_TEST_SECRET).toBeUndefined();
    expect(internalSession.env.DATABASE_URL).toBeUndefined();
    expect(internalSession.env.MY_API_KEY).toBeUndefined();

    // Verify inside subprocess
    let stdout = "";
    await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      'node -e "process.stdout.write(String(process.env.ANKA_TEST_SECRET || \'ABSENT\'))"',
      (c) => { stdout += c; },
      () => {}
    );

    expect(stdout.trim()).toBe("ABSENT");

    delete process.env.ANKA_TEST_SECRET;
    delete process.env.DATABASE_URL;
    delete process.env.MY_API_KEY;
  });

  it("15. session cannot run two simultaneous commands", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    // Start a 1.5s command
    const cmdPromise = mgr.runCommand(
      session.sessionId,
      "proj-valid",
      'node -e "setTimeout(()=>{}, 1500)"',
      () => {},
      () => {}
    );

    // Attempt second command while running
    await expect(
      mgr.runCommand(session.sessionId, "proj-valid", "pwd", () => {}, () => {})
    ).rejects.toThrow("TERMINAL_SESSION_BUSY");

    // Interrupt to unblock
    mgr.interruptSession(session.sessionId, "proj-valid");
    await cmdPromise;
  });

  it("16. command timeout kills command", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    // Temporarily reduce timeout to 200ms
    const originalTimeout = TerminalSessionManager.COMMAND_TIMEOUT_MS;
    (TerminalSessionManager as any).COMMAND_TIMEOUT_MS = 200;

    let stderr = "";
    try {
      const result = await mgr.runCommand(
        session.sessionId,
        "proj-valid",
        'node -e "setTimeout(()=>{}, 2000)"',
        () => {},
        (c) => { stderr += c; }
      );

      expect(stderr).toContain("[TERMINAL_TIMEOUT]");
      expect(result.exitCode).toBe(124);
    } finally {
      (TerminalSessionManager as any).COMMAND_TIMEOUT_MS = originalTimeout;
    }
  });

  it("17. interrupt affects only active session process", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    const cmdPromise = mgr.runCommand(
      session.sessionId,
      "proj-valid",
      'node -e "setTimeout(()=>{}, 3000)"',
      () => {},
      () => {}
    );

    // Allow process to spawn
    await new Promise((r) => setTimeout(r, 100));

    const interrupted = mgr.interruptSession(session.sessionId, "proj-valid");
    expect(interrupted).toBe(true);

    const result = await cmdPromise;
    expect(mgr.getSession(session.sessionId, "proj-valid")?.status).toBe("idle");
  });

  it("18. close removes session", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    expect(mgr.getSession(session.sessionId, "proj-valid")).not.toBeNull();
    const closed = mgr.closeSession(session.sessionId, "proj-valid");
    expect(closed).toBe(true);

    expect(mgr.getSession(session.sessionId, "proj-valid")).toBeNull();
  });

  it("19. wrong project cannot access another project's session", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    expect(mgr.getSession(session.sessionId, "other-project")).toBeNull();

    await expect(
      mgr.runCommand(session.sessionId, "other-project", "pwd", () => {}, () => {})
    ).rejects.toThrow("Access denied: session belongs to another project");

    expect(mgr.interruptSession(session.sessionId, "other-project")).toBe(false);
    expect(mgr.closeSession(session.sessionId, "other-project")).toBe(false);
  });

  it("20. multi-repo repo-A session cannot cd to repo-B", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    let stderr = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      `cd "${repoBPath}"`,
      () => {},
      (c) => { stderr += c; }
    );

    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Access denied: directory is outside the selected repository");
    expect(result.cwd).toBe(session.cwd);
  });

  it("21. session cap enforced", async () => {
    const mgr = TerminalSessionManager.getInstance();

    const sessions = [];
    for (let i = 0; i < TerminalSessionManager.MAX_SESSIONS_PER_PROJECT; i++) {
      sessions.push(await mgr.createSession("proj-valid", "repo-a-id"));
    }

    await expect(mgr.createSession("proj-valid", "repo-a-id")).rejects.toThrow(
      "Project terminal session limit reached"
    );

    // Clean up
    for (const s of sessions) {
      mgr.closeSession(s.sessionId, "proj-valid");
    }
  });

  it("22. idle cleanup works", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    const internalSession = (mgr as any).sessions.get(session.sessionId);
    // Artificially age session by 31 minutes
    internalSession.lastActivityAt = Date.now() - (TerminalSessionManager.IDLE_TIMEOUT_MS + 1000);

    const swept = mgr.sweepIdleSessions();
    expect(swept).toBe(1);
    expect(mgr.getSession(session.sessionId, "proj-valid")).toBeNull();
  });

  it("23. parent process NODE_ENV is not leaked into child terminal environment", async () => {
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const mgr = TerminalSessionManager.getInstance();
      const session = await mgr.createSession("proj-valid", "repo-a-id");

      const internalSession = (mgr as any).sessions.get(session.sessionId);
      expect(internalSession.env.NODE_ENV).toBeUndefined();

      let stdout = "";
      const result = await mgr.runCommand(
        session.sessionId,
        "proj-valid",
        'node -e "process.stdout.write(String(process.env.NODE_ENV || \'undefined\'))"',
        (c) => { stdout += c; },
        () => {}
      );

      expect(result.exitCode).toBe(0);
      expect(stdout.trim()).toBe("undefined");
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });

  it("24. parent process PORT is not leaked into child terminal environment", async () => {
    const origPort = process.env.PORT;
    process.env.PORT = "3001";

    try {
      const mgr = TerminalSessionManager.getInstance();
      const session = await mgr.createSession("proj-valid", "repo-a-id");

      const internalSession = (mgr as any).sessions.get(session.sessionId);
      expect(internalSession.env.PORT).toBeUndefined();

      let stdout = "";
      const result = await mgr.runCommand(
        session.sessionId,
        "proj-valid",
        'node -e "process.stdout.write(String(process.env.PORT || \'undefined\'))"',
        (c) => { stdout += c; },
        () => {}
      );

      expect(result.exitCode).toBe(0);
      expect(stdout.trim()).toBe("undefined");
    } finally {
      if (origPort !== undefined) {
        process.env.PORT = origPort;
      } else {
        delete process.env.PORT;
      }
    }
  });

  it("25. explicit user command NODE_ENV override works on current platform", async () => {
    const mgr = TerminalSessionManager.getInstance();
    const session = await mgr.createSession("proj-valid", "repo-a-id");

    const cmd = process.platform === "win32"
      ? 'set NODE_ENV=test&& node -e "process.stdout.write(String(process.env.NODE_ENV))"'
      : 'NODE_ENV=test node -e "process.stdout.write(String(process.env.NODE_ENV))"';

    let stdout = "";
    const result = await mgr.runCommand(
      session.sessionId,
      "proj-valid",
      cmd,
      (c) => { stdout += c; },
      () => {}
    );

    expect(result.exitCode).toBe(0);
    expect(stdout.trim()).toBe("test");
  });

  it("26. simulated test runner defaulting NODE_ENV succeeds without collision", async () => {
    const origNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    try {
      const mgr = TerminalSessionManager.getInstance();
      const session = await mgr.createSession("proj-valid", "repo-a-id");

      // Simulates repository test runner (like Jest) which defaults NODE_ENV to 'test' when undefined
      // and verifies it does NOT attempt to bind port because NODE_ENV === 'test'
      const testScript = 'node -e "const env = process.env.NODE_ENV || \'test\'; if (env !== \'test\') { console.error(\'Port conflict: started on 3001\'); process.exit(1); } else { process.stdout.write(\'PASS: Jest env defaulted to test cleanly\'); }"';

      let stdout = "";
      let stderr = "";
      const result = await mgr.runCommand(
        session.sessionId,
        "proj-valid",
        testScript,
        (c) => { stdout += c; },
        (c) => { stderr += c; }
      );

      expect(result.exitCode).toBe(0);
      expect(stdout).toContain("PASS: Jest env defaulted to test cleanly");
      expect(stderr).toBe("");
    } finally {
      process.env.NODE_ENV = origNodeEnv;
    }
  });
});
