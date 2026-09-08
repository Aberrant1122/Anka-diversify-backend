import fs from "fs";
import path from "path";
import { spawn, ChildProcess, exec } from "child_process";
import { randomUUID } from "crypto";
import { ProjectRepositoryService } from "./project-repository-service";
import { ValidationEnvironmentPolicy } from "../ai/validation/ValidationEnvironmentPolicy";

export interface TerminalSession {
  sessionId: string;
  projectId: string;
  repositoryId: string;
  repositoryName: string;
  rootPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  activeProcess: ChildProcess | null;
  createdAt: number;
  lastActivityAt: number;
  status: "idle" | "running" | "closed";
}

export interface TerminalSessionInfo {
  sessionId: string;
  projectId: string;
  repositoryId: string;
  repositoryName: string;
  cwd: string;
  status: "idle" | "running" | "closed";
}

export interface CommandExitResult {
  exitCode: number | null;
  signal: string | null;
  cwd: string;
  durationMs: number;
}

export class TerminalSessionManager {
  private static instance: TerminalSessionManager | null = null;
  private sessions: Map<string, TerminalSession> = new Map();
  private sweeperTimer: NodeJS.Timeout | null = null;

  public static readonly MAX_SESSIONS_PER_PROJECT = 5;
  public static readonly MAX_GLOBAL_SESSIONS = 25;
  public static readonly IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
  public static readonly COMMAND_TIMEOUT_MS = 120 * 1000; // 120 seconds
  public static readonly SWEEPER_INTERVAL_MS = 60 * 1000; // 60 seconds

  private constructor() {
    this.startSweeper();
  }

  public static getInstance(): TerminalSessionManager {
    if (!TerminalSessionManager.instance) {
      TerminalSessionManager.instance = new TerminalSessionManager();
    }
    return TerminalSessionManager.instance;
  }

  /**
   * Resets singleton for isolated testing environments.
   */
  public static resetInstance(): void {
    if (TerminalSessionManager.instance) {
      TerminalSessionManager.instance.shutdownAll();
      TerminalSessionManager.instance = null;
    }
  }

  private startSweeper(): void {
    if (this.sweeperTimer) return;
    this.sweeperTimer = setInterval(() => {
      this.sweepIdleSessions();
    }, TerminalSessionManager.SWEEPER_INTERVAL_MS);
    this.sweeperTimer.unref();
  }

  public sweepIdleSessions(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivityAt >= TerminalSessionManager.IDLE_TIMEOUT_MS) {
        this.closeSession(sessionId, session.projectId);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Canonical path containment helper.
   * Ensures candidate path is strictly equal to rootPath or a subpath of rootPath.
   */
  public static isWithinRoot(candidate: string, root: string): boolean {
    const normalCandidate = path.resolve(candidate);
    const normalRoot = path.resolve(root);
    const relative = path.relative(normalRoot, normalCandidate);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  }

  /**
   * Symlink/junction-aware containment helper.
   * Compares realpaths on disk when both paths exist to prevent symlink traversal escapes.
   */
  public static isWithinRootSafe(candidate: string, root: string): boolean {
    const normalCandidate = path.resolve(candidate);
    const normalRoot = path.resolve(root);

    if (!TerminalSessionManager.isWithinRoot(normalCandidate, normalRoot)) {
      return false;
    }

    try {
      if (fs.existsSync(normalCandidate) && fs.existsSync(normalRoot)) {
        const realCandidate = fs.realpathSync(normalCandidate);
        const realRoot = fs.realpathSync(normalRoot);
        return TerminalSessionManager.isWithinRoot(realCandidate, realRoot);
      }
    } catch {
      return false;
    }

    return true;
  }

  /**
   * Narrow defense-in-depth policy to block high-risk host-management commands
   * and explicit path escapes outside the repository root.
   */
  public static validateCommandPolicy(
    command: string,
    rootPath: string,
    cwd: string
  ): { allowed: boolean; reason?: string } {
    const trimmed = command.trim();
    if (!trimmed) {
      return { allowed: true };
    }

    // 1. Block destructive system / OS commands
    const dangerousPatterns = [
      /^\s*(?:shutdown|reboot|poweroff|halt)\b/i,
      /^\s*(?:format|diskpart)\b/i,
      /^\s*(?:reg\s+delete|reg\s+add)\b/i,
      /ExecutionPolicy\s+Bypass/i,
      /\bmklink\b/i,
    ];

    for (const pattern of dangerousPatterns) {
      if (pattern.test(trimmed)) {
        return {
          allowed: false,
          reason: "Command rejected by security policy: dangerous host-management command.",
        };
      }
    }

    // 2. Reject explicit absolute path targets outside rootPath if detected as arguments
    // e.g. "rmdir /s /q C:\Windows" or "cat /etc/shadow"
    const words = trimmed.split(/\s+/);
    for (const word of words.slice(1)) {
      const cleanWord = word.replace(/^[\\"']+|[\\"']+$/g, "");
      if (path.isAbsolute(cleanWord)) {
        if (!TerminalSessionManager.isWithinRootSafe(cleanWord, rootPath)) {
          return {
            allowed: false,
            reason: `Access denied: target path "${cleanWord}" is outside repository boundary.`,
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Resolves platform shell.
   */
  public static detectPlatformShell(): string {
    if (process.platform === "win32") {
      return process.env.COMSPEC || "cmd.exe";
    }
    return process.env.SHELL || "/bin/sh";
  }

  /**
   * Safely terminates a child process and its process tree.
   */
  public static killProcessTree(child: ChildProcess, signal: "SIGINT" | "SIGTERM" | "SIGKILL" = "SIGTERM"): void {
    if (!child || !child.pid) return;
    try {
      if (process.platform === "win32") {
        exec(`taskkill /pid ${child.pid} /T /F`, () => {});
      } else {
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      }
    } catch {
      try {
        child.kill(signal);
      } catch {}
    }
  }

  /**
   * Constructs a sanitized, neutral environment for terminal sessions.
   * - Preserves essential system execution variables (PATH, SystemRoot, COMSPEC, HOME, TEMP, SHELL, etc.).
   * - Strips sensitive application secrets (tokens, keys, passwords, database URLs, etc.).
   * - Omits ANKA application runtime variables like NODE_ENV and PORT so repository scripts
   *   and test runners (e.g. Jest) establish their own expected defaults or user overrides.
   */
  public static buildTerminalEnv(customEnv?: Record<string, string>): NodeJS.ProcessEnv {
    const sanitizedEnv = ValidationEnvironmentPolicy.getSanitizedEnv("terminal", {
      customEnv: {
        TERM: "xterm-256color",
        FORCE_COLOR: "1",
        ...(customEnv || {}),
      },
    });

    for (const k of Object.keys(sanitizedEnv)) {
      const lower = k.toLowerCase();
      if (lower === "node_env" || lower === "port") {
        delete sanitizedEnv[k];
      }
    }

    return sanitizedEnv;
  }

  /**
   * Creates a new terminal session bound to a verified repository.
   */
  public async createSession(projectId: string, repositoryId?: string): Promise<TerminalSessionInfo> {
    if (!projectId) {
      throw new Error("projectId is required to create a terminal session");
    }

    // Enforce global cap
    if (this.sessions.size >= TerminalSessionManager.MAX_GLOBAL_SESSIONS) {
      throw new Error("Global terminal session limit reached (max 25). Close unused sessions.");
    }

    // Enforce per-project cap
    const projectSessions = Array.from(this.sessions.values()).filter((s) => s.projectId === projectId);
    if (projectSessions.length >= TerminalSessionManager.MAX_SESSIONS_PER_PROJECT) {
      throw new Error(`Project terminal session limit reached (max ${TerminalSessionManager.MAX_SESSIONS_PER_PROJECT}). Close an existing session.`);
    }

    const repoService = new ProjectRepositoryService();
    const repos = await repoService.list(projectId);

    if (!repos || repos.length === 0) {
      throw new Error("REPOSITORY_NOT_MATERIALIZED");
    }

    let targetRepo = repositoryId
      ? repos.find((r) => r.id === repositoryId)
      : repos.find((r) => r.isPrimary) || repos[0];

    if (!targetRepo) {
      throw new Error("Repository not found for this project");
    }

    if (!targetRepo.localPath || !fs.existsSync(targetRepo.localPath)) {
      throw new Error("REPOSITORY_NOT_MATERIALIZED");
    }

    const canonicalRoot = path.resolve(fs.realpathSync(targetRepo.localPath));
    const sessionId = randomUUID();

    // Environment sanitization: neutral repository environment without ANKA backend runtime contamination
    const sanitizedEnv = TerminalSessionManager.buildTerminalEnv();

    const session: TerminalSession = {
      sessionId,
      projectId,
      repositoryId: targetRepo.id,
      repositoryName: targetRepo.name,
      rootPath: canonicalRoot,
      cwd: canonicalRoot,
      env: sanitizedEnv,
      activeProcess: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      status: "idle",
    };

    this.sessions.set(sessionId, session);

    return {
      sessionId: session.sessionId,
      projectId: session.projectId,
      repositoryId: session.repositoryId,
      repositoryName: session.repositoryName,
      cwd: session.cwd,
      status: session.status,
    };
  }

  public getSession(sessionId: string, projectId: string): TerminalSessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.projectId !== projectId) {
      return null;
    }
    return {
      sessionId: session.sessionId,
      projectId: session.projectId,
      repositoryId: session.repositoryId,
      repositoryName: session.repositoryName,
      cwd: session.cwd,
      status: session.status,
    };
  }

  /**
   * Executes a command inside the terminal session.
   * Intercepts navigation (cd, pwd, clear) in Node.js without subprocesses.
   * Spawns non-navigation commands with live stdout/stderr chunk streaming.
   */
  public async runCommand(
    sessionId: string,
    projectId: string,
    command: string,
    onStdout: (chunk: string) => void,
    onStderr: (chunk: string) => void
  ): Promise<CommandExitResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error("Terminal session not found");
    }
    if (session.projectId !== projectId) {
      throw new Error("Access denied: session belongs to another project");
    }
    if (session.status === "running") {
      throw new Error("TERMINAL_SESSION_BUSY");
    }

    session.lastActivityAt = Date.now();
    const trimmed = command.trim();
    const startTime = Date.now();

    // ── 1. Intercept `pwd` ──
    if (trimmed === "pwd") {
      onStdout(`${session.cwd}\n`);
      return {
        exitCode: 0,
        signal: null,
        cwd: session.cwd,
        durationMs: Date.now() - startTime,
      };
    }

    // ── 2. Intercept `clear` / `cls` ──
    if (trimmed === "clear" || trimmed === "cls") {
      onStdout("\x1bc"); // ANSI clear screen
      return {
        exitCode: 0,
        signal: null,
        cwd: session.cwd,
        durationMs: Date.now() - startTime,
      };
    }

    // ── 3. Intercept `cd` ──
    if (trimmed === "cd" || trimmed.startsWith("cd ") || trimmed.startsWith("cd\t")) {
      const targetArg = trimmed.slice(2).trim();

      if (!targetArg || targetArg === "~") {
        session.cwd = session.rootPath;
        return {
          exitCode: 0,
          signal: null,
          cwd: session.cwd,
          durationMs: Date.now() - startTime,
        };
      }

      // Handle quoted paths e.g. cd "src/my folder"
      const cleanTarget = targetArg.replace(/^[\\"']+|[\\"']+$/g, "");
      const candidate = path.resolve(session.cwd, cleanTarget);

      if (!TerminalSessionManager.isWithinRootSafe(candidate, session.rootPath)) {
        onStderr("Access denied: directory is outside the selected repository.\n");
        return {
          exitCode: 1,
          signal: null,
          cwd: session.cwd,
          durationMs: Date.now() - startTime,
        };
      }

      if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
        onStderr(`cd: no such file or directory: ${cleanTarget}\n`);
        return {
          exitCode: 1,
          signal: null,
          cwd: session.cwd,
          durationMs: Date.now() - startTime,
        };
      }

      session.cwd = path.resolve(fs.realpathSync(candidate));
      return {
        exitCode: 0,
        signal: null,
        cwd: session.cwd,
        durationMs: Date.now() - startTime,
      };
    }

    // ── 4. Defense-in-depth security policy check ──
    const policy = TerminalSessionManager.validateCommandPolicy(trimmed, session.rootPath, session.cwd);
    if (!policy.allowed) {
      onStderr(`${policy.reason || "Command rejected by security policy."}\n`);
      return {
        exitCode: 1,
        signal: null,
        cwd: session.cwd,
        durationMs: Date.now() - startTime,
      };
    }

    // ── 5. Spawn external command ──
    session.status = "running";
    const shell = TerminalSessionManager.detectPlatformShell();

    return new Promise<CommandExitResult>((resolve) => {
      let timeoutTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const finish = (result: CommandExitResult) => {
        if (settled) return;
        settled = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        session.status = "idle";
        session.activeProcess = null;
        session.lastActivityAt = Date.now();
        resolve(result);
      };

      const child = spawn(trimmed, {
        cwd: session.cwd,
        env: session.env,
        shell,
        windowsHide: true,
      });

      session.activeProcess = child;

      child.stdout?.on("data", (data: Buffer | string) => {
        onStdout(data.toString());
      });

      child.stderr?.on("data", (data: Buffer | string) => {
        onStderr(data.toString());
      });

      child.on("error", (err: Error) => {
        onStderr(`Command execution failed: ${err.message}\n`);
        finish({
          exitCode: 1,
          signal: null,
          cwd: session.cwd,
          durationMs: Date.now() - startTime,
        });
      });

      child.on("close", (code: number | null, signal: string | null) => {
        finish({
          exitCode: code ?? (signal ? 1 : 0),
          signal: signal ?? null,
          cwd: session.cwd,
          durationMs: Date.now() - startTime,
        });
      });

      // 120s timeout enforcement
      timeoutTimer = setTimeout(() => {
        onStderr("\n[TERMINAL_TIMEOUT] Command exceeded maximum execution time of 120 seconds. Process terminated.\n");
        TerminalSessionManager.killProcessTree(child, "SIGKILL");
        finish({
          exitCode: 124,
          signal: "SIGKILL",
          cwd: session.cwd,
          durationMs: Date.now() - startTime,
        });
      }, TerminalSessionManager.COMMAND_TIMEOUT_MS);
      timeoutTimer.unref();
    });
  }

  /**
   * Interrupts currently running command in session.
   */
  public interruptSession(sessionId: string, projectId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.projectId !== projectId) {
      return false;
    }

    if (session.activeProcess) {
      TerminalSessionManager.killProcessTree(session.activeProcess, "SIGINT");
      session.status = "idle";
      session.activeProcess = null;
      session.lastActivityAt = Date.now();
      return true;
    }

    return false;
  }

  /**
   * Closes session and terminates any active child process.
   */
  public closeSession(sessionId: string, projectId?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    if (projectId && session.projectId !== projectId) {
      return false;
    }

    if (session.activeProcess) {
      TerminalSessionManager.killProcessTree(session.activeProcess, "SIGKILL");
      session.activeProcess = null;
    }

    session.status = "closed";
    this.sessions.delete(sessionId);
    return true;
  }

  /**
   * Shuts down all sessions on backend server stop.
   */
  public shutdownAll(): void {
    if (this.sweeperTimer) {
      clearInterval(this.sweeperTimer);
      this.sweeperTimer = null;
    }

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.activeProcess) {
        TerminalSessionManager.killProcessTree(session.activeProcess, "SIGKILL");
      }
    }
    this.sessions.clear();
  }
}
