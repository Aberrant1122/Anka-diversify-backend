import fs from "fs";
import path from "path";
import os from "os";
import { EventEmitter } from "events";
import { TerminalController } from "../terminal-controller";
import { TerminalSessionManager } from "../../services/terminal-session-manager";
import { ProjectRepositoryService } from "../../services/project-repository-service";

describe("Terminal SSE Completion Lifecycle Tests", () => {
  let tempRoot: string;
  let repoPath: string;
  let controller: TerminalController;
  let sessionManager: TerminalSessionManager;
  let listSpy: jest.SpyInstance;
  let testSessionId: string;

  beforeAll(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "anka-terminal-sse-test-"));
    repoPath = path.join(tempRoot, "repo-test");
    fs.mkdirSync(path.join(repoPath, "src"), { recursive: true });

    listSpy = jest.spyOn(ProjectRepositoryService.prototype, "list").mockImplementation(async (projectId: string) => {
      if (projectId === "proj-test") {
        return [
          {
            id: "repo-test-id",
            projectId: "proj-test",
            name: "repo-test",
            localPath: repoPath,
            isPrimary: true,
          } as any,
        ];
      }
      return [];
    });
  });

  afterAll(() => {
    TerminalSessionManager.getInstance().shutdownAll();
    listSpy.mockRestore();
    try {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    TerminalSessionManager.resetInstance();
    sessionManager = TerminalSessionManager.getInstance();
    controller = new TerminalController();
    const session = await sessionManager.createSession("proj-test", "repo-test-id");
    testSessionId = session.sessionId;
  });

  function createMockReqRes(command: string) {
    const req: any = new EventEmitter();
    req.params = { projectId: "proj-test", sessionId: testSessionId };
    req.body = { command };

    const writtenChunks: string[] = [];
    const res: any = new EventEmitter();
    res.writableEnded = false;
    res.setHeader = jest.fn();
    res.flushHeaders = jest.fn();
    res.flush = jest.fn();
    res.write = jest.fn((chunk: string) => {
      writtenChunks.push(chunk);
      return true;
    });
    res.end = jest.fn(() => {
      res.writableEnded = true;
    });

    return { req, res, writtenChunks };
  }

  function parseEvents(chunks: string[]) {
    const raw = chunks.join("");
    const events: { event: string; data: any }[] = [];
    const lines = raw.split("\n");
    let currentEvent = "";
    let currentData = "";
    for (const line of lines) {
      if (line.startsWith("event:")) {
        currentEvent = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        currentData = line.slice(5).trim();
      } else if (line.trim() === "" && currentEvent && currentData) {
        try {
          events.push({ event: currentEvent, data: JSON.parse(currentData) });
        } catch {
          events.push({ event: currentEvent, data: currentData });
        }
        currentEvent = "";
        currentData = "";
      }
    }
    return events;
  }

  it("1. POST pwd command emits started, stdout, and exit events", async () => {
    const { req, res, writtenChunks } = createMockReqRes("pwd");
    await controller.runCommand(req, res);

    const events = parseEvents(writtenChunks);
    expect(events.map((e) => e.event)).toEqual(["started", "stdout", "exit"]);
    expect(events[0].data.command).toBe("pwd");
    expect(events[1].data.text).toContain(path.resolve(fs.realpathSync(repoPath)));
    expect(events[2].data.exitCode).toBe(0);
    expect(events[2].data.signal).toBeNull();
  });

  it("2. pwd response ends cleanly with res.end()", async () => {
    const { req, res } = createMockReqRes("pwd");
    await controller.runCommand(req, res);

    expect(res.end).toHaveBeenCalledTimes(1);
    expect(res.writableEnded).toBe(true);
  });

  it("3. session after pwd remains status=idle and activeProcess=null", async () => {
    const { req, res } = createMockReqRes("pwd");
    await controller.runCommand(req, res);

    const session = sessionManager.getSession(testSessionId, "proj-test");
    expect(session).toBeDefined();
    expect(session?.status).toBe("idle");
    const internalSession = (sessionManager as any).sessions.get(testSessionId);
    expect(internalSession?.activeProcess).toBeNull();
  });

  it("4. cd src updates cwd, emits exit, and ends response", async () => {
    const { req, res, writtenChunks } = createMockReqRes("cd src");
    await controller.runCommand(req, res);

    const events = parseEvents(writtenChunks);
    expect(events.map((e) => e.event)).toEqual(["started", "exit"]);
    expect(events[1].data.exitCode).toBe(0);
    const expectedCwd = path.resolve(fs.realpathSync(path.join(repoPath, "src")));
    expect(events[1].data.cwd).toBe(expectedCwd);
    expect(res.end).toHaveBeenCalledTimes(1);

    const session = sessionManager.getSession(testSessionId, "proj-test");
    expect(session?.cwd).toBe(expectedCwd);
  });

  it("5. invalid cd emits stderr, exitCode=1, and ends response", async () => {
    const { req, res, writtenChunks } = createMockReqRes("cd nonexistent_dir_xyz");
    await controller.runCommand(req, res);

    const events = parseEvents(writtenChunks);
    expect(events.map((e) => e.event)).toEqual(["started", "stderr", "exit"]);
    expect(events[1].data.text).toContain("no such file or directory");
    expect(events[2].data.exitCode).toBe(1);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("6. clear/cls emits exit and ends response cleanly", async () => {
    const { req, res, writtenChunks } = createMockReqRes("clear");
    await controller.runCommand(req, res);

    const events = parseEvents(writtenChunks);
    expect(events.map((e) => e.event)).toEqual(["started", "stdout", "exit"]);
    expect(events[1].data.text).toBe("\x1bc");
    expect(events[2].data.exitCode).toBe(0);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("7. node --version is not prematurely interrupted by request close, streams stdout, and exits", async () => {
    const { req, res, writtenChunks } = createMockReqRes("node --version");

    // Simulate Node.js POST request consumption: req emits close immediately
    req.emit("close");

    await controller.runCommand(req, res);

    const events = parseEvents(writtenChunks);
    expect(events.map((e) => e.event)).toEqual(["started", "stdout", "exit"]);
    expect(events[1].data.text).toMatch(/v\d+\.\d+\.\d+/);
    expect(events[2].data.exitCode).toBe(0);
    expect(res.end).toHaveBeenCalledTimes(1);
  });

  it("8. simulated real response disconnect interrupts active process", async () => {
    const interruptSpy = jest.spyOn(sessionManager, "interruptSession");
    const { req, res } = createMockReqRes('node -e "setTimeout(() => {}, 10000)"');

    const cmdPromise = controller.runCommand(req, res);

    // Wait a brief moment for subprocess to spawn
    await new Promise((resolve) => setTimeout(resolve, 80));

    // Client drops connection prematurely (res closes before res.writableEnded is true)
    res.emit("close");

    await cmdPromise;

    expect(interruptSpy).toHaveBeenCalledWith(testSessionId, "proj-test");
    interruptSpy.mockRestore();
  });

  it("9. normal response close after writableEnded does NOT call interruptSession", async () => {
    const interruptSpy = jest.spyOn(sessionManager, "interruptSession");
    const { req, res } = createMockReqRes("pwd");

    await controller.runCommand(req, res);
    expect(res.writableEnded).toBe(true);

    // Connection closes after normal res.end()
    res.emit("close");

    expect(interruptSpy).not.toHaveBeenCalled();
    interruptSpy.mockRestore();
  });
});
