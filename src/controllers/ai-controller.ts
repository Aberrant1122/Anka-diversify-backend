import { Request, Response } from "express";
import { AiService } from "../services/ai-service";
import { ProjectGitHubService } from "../services/github.service";
import { ChatRequest } from "../types";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const aiService = AiService.getInstance();

export class AiController {
  // General Assistant Routes
  async generalChat(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      if (!userId) {
        return res.status(401).json({ error: "User ID required" });
      }

      const chatRequest: ChatRequest = req.body;

      if (!chatRequest.message) {
        return res.status(400).json({ error: "Message is required" });
      }

      const response = await aiService.processGeneralChat(userId, chatRequest);
      res.json(response);
    } catch (error) {
      console.error("General chat error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async getGeneralSessions(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      if (!userId) {
        return res.status(401).json({ error: "User ID required" });
      }

      const sessions = await aiService.getSessions(userId, "general");

      const formattedSessions = sessions.map((session: any) => ({
        id: session.id,
        title: session.title,
        type: session.type,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        lastMessage: session.messages[0]?.content || null,
      }));

      res.json({ sessions: formattedSessions });
    } catch (error) {
      console.error("Get general sessions error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async getGeneralSessionMessages(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      const { sessionId } = req.params;

      if (!userId) {
        return res.status(401).json({ error: "User ID required" });
      }

      if (Array.isArray(sessionId)) {
        return res.status(400).json({ error: "Invalid session ID" });
      }

      const session = await aiService.getSessionMessages(sessionId, userId);
      res.json({
        messages: session.messages,
        session: {
          id: session.id,
          title: session.title,
          type: session.type,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      });
    } catch (error) {
      console.error("Get general session messages error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // Project Assistant Routes
  async projectChat(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      const { projectId } = req.params;

      if (!userId) {
        return res.status(401).json({ error: "User ID required" });
      }

      if (Array.isArray(projectId)) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      const chatRequest: ChatRequest = req.body;

      if (!chatRequest.message) {
        return res.status(400).json({ error: "Message is required" });
      }

      const response = await aiService.processProjectChat(
        userId,
        projectId,
        chatRequest,
      );
      res.json(response);
    } catch (error) {
      console.error("Project chat error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async getProjectSessions(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      const { projectId } = req.params;

      if (!userId) {
        return res.status(401).json({ error: "User ID required" });
      }

      if (Array.isArray(projectId)) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      const sessions = await aiService.getSessions(
        userId,
        "project",
        projectId,
      );

      const formattedSessions = sessions.map((session: any) => ({
        id: session.id,
        title: session.title,
        type: session.type,
        projectId: session.projectId,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages.length,
        lastMessage: session.messages[0]?.content || null,
      }));

      res.json({ sessions: formattedSessions });
    } catch (error) {
      console.error("Get project sessions error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async getProjectSessionMessages(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      const { projectId, sessionId } = req.params;

      if (!userId) {
        return res.status(401).json({ error: "User ID required" });
      }

      if (Array.isArray(sessionId)) {
        return res.status(400).json({ error: "Invalid session ID" });
      }

      const session = await aiService.getSessionMessages(sessionId, userId);
      res.json({
        messages: session.messages,
        session: {
          id: session.id,
          title: session.title,
          type: session.type,
          projectId: session.projectId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
        },
      });
    } catch (error) {
      console.error("Get project session messages error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async getProjectContext(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      const { projectId } = req.params;

      if (!userId) {
        return res.status(401).json({ error: "User ID required" });
      }

      if (Array.isArray(projectId)) {
        return res.status(400).json({ error: "Invalid project ID" });
      }

      const context = await aiService.getProjectContext(projectId, userId);
      res.json(context);
    } catch (error) {
      console.error("Get project context error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  // ── Coding Agent ────────────────────────────────────────────────────────────

  async runAgent(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      const { projectId } = req.params;
      if (!userId) return res.status(401).json({ error: "User ID required" });
      if (Array.isArray(projectId)) return res.status(400).json({ error: "Invalid project ID" });

      const result = await aiService.runCodingAgent(userId, projectId, req.body);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Agent run error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async pushAgentChanges(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      const { projectId } = req.params;
      if (!userId) return res.status(401).json({ error: "User ID required" });
      if (Array.isArray(projectId)) return res.status(400).json({ error: "Invalid project ID" });

      const { changes, commitMessage } = req.body as {
        changes: { path: string; content: string }[];
        commitMessage: string;
      };

      if (!changes?.length) {
        return res.status(400).json({ error: "No changes provided" });
      }

      // Get the project's GitHub URL
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project?.githubUrl) {
        return res.status(400).json({ error: "No GitHub repository connected to this project" });
      }

      const result = await ProjectGitHubService.pushChanges(project.githubUrl, changes, commitMessage);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Agent push error:", error);
      res.status(500).json({
        error: "Push failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }
}
