import { Request, Response } from "express";
import { TerminalSessionManager } from "../services/terminal-session-manager";

export class TerminalController {
  private sessionManager = TerminalSessionManager.getInstance();

  public createSession = async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
      const { repositoryId } = req.body || {};

      if (!projectId) {
        res.status(400).json({ success: false, error: "projectId is required" });
        return;
      }

      const session = await this.sessionManager.createSession(projectId, repositoryId);
      res.status(201).json({
        success: true,
        data: session,
      });
    } catch (err: any) {
      const message = err?.message || "Failed to create terminal session";
      if (message === "REPOSITORY_NOT_MATERIALIZED") {
        res.status(400).json({
          success: false,
          code: "REPOSITORY_NOT_MATERIALIZED",
          error: "Repository local path is not materialized or does not exist on disk.",
        });
        return;
      }
      res.status(400).json({
        success: false,
        error: message,
      });
    }
  };

  public getSession = async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
      const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;

      if (!projectId || !sessionId) {
        res.status(400).json({ success: false, error: "projectId and sessionId are required" });
        return;
      }

      const session = this.sessionManager.getSession(sessionId, projectId);

      if (!session) {
        res.status(404).json({ success: false, error: "Terminal session not found or belongs to another project" });
        return;
      }

      res.json({ success: true, data: session });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || "Failed to retrieve terminal session" });
    }
  };

  public runCommand = async (req: Request, res: Response): Promise<void> => {
    const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
    const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;
    const { command } = req.body || {};

    if (!projectId || !sessionId) {
      res.status(400).json({ success: false, error: "projectId and sessionId are required" });
      return;
    }

    if (typeof command !== "string") {
      res.status(400).json({ success: false, error: "command must be a string" });
      return;
    }

    const session = this.sessionManager.getSession(sessionId, projectId);
    if (!session) {
      res.status(404).json({ success: false, error: "Terminal session not found or belongs to another project" });
      return;
    }

    if (session.status === "running") {
      res.status(409).json({
        success: false,
        code: "TERMINAL_SESSION_BUSY",
        error: "A command is already executing in this terminal session.",
      });
      return;
    }

    // Initialize Server-Sent Events stream
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    (res as any).flushHeaders?.();

    let clientDisconnected = false;
    res.on("close", () => {
      if (!res.writableEnded) {
        clientDisconnected = true;
        // Terminate running command if client disconnected mid-execution
        this.sessionManager.interruptSession(sessionId, projectId);
      }
    });

    const sendEvent = (event: string, data: any) => {
      if (!clientDisconnected && !res.writableEnded) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        (res as any).flush?.();
      }
    };

    try {
      sendEvent("started", { command, cwd: session.cwd });

      const result = await this.sessionManager.runCommand(
        sessionId,
        projectId,
        command,
        (stdoutChunk: string) => {
          sendEvent("stdout", { text: stdoutChunk });
        },
        (stderrChunk: string) => {
          sendEvent("stderr", { text: stderrChunk });
        }
      );

      sendEvent("exit", result);
    } catch (err: any) {
      sendEvent("error", { message: err?.message || "Execution error" });
    } finally {
      if (!res.writableEnded) {
        res.end();
      }
    }
  };

  public interruptSession = async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
      const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;

      if (!projectId || !sessionId) {
        res.status(400).json({ success: false, error: "projectId and sessionId are required" });
        return;
      }

      const interrupted = this.sessionManager.interruptSession(sessionId, projectId);

      res.json({
        success: true,
        data: { interrupted },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || "Failed to interrupt terminal session" });
    }
  };

  public closeSession = async (req: Request, res: Response): Promise<void> => {
    try {
      const projectId = Array.isArray(req.params.projectId) ? req.params.projectId[0] : req.params.projectId;
      const sessionId = Array.isArray(req.params.sessionId) ? req.params.sessionId[0] : req.params.sessionId;

      if (!projectId || !sessionId) {
        res.status(400).json({ success: false, error: "projectId and sessionId are required" });
        return;
      }

      const closed = this.sessionManager.closeSession(sessionId, projectId);

      res.json({
        success: true,
        data: { closed },
      });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err?.message || "Failed to close terminal session" });
    }
  };
}
