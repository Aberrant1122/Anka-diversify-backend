import { Request, Response } from "express";
import { AiService } from "../services/ai-service";
import { ProjectGitHubService } from "../services/github.service";
import { ChatRequest } from "../types";
import { PrismaClient } from "@prisma/client";
import { decrypt } from "../utils/encryption";

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
      if (error instanceof Error && error.stack) {
        console.error("Stack:", error.stack.split('\n').slice(0, 6).join('\n'));
      }
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

  async getContextSnapshots(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      if (Array.isArray(projectId)) return res.status(400).json({ error: "Invalid project ID" });

      const snapshots = await prisma.contextSnapshot.findMany({
        where: { projectId },
        orderBy: { createdAt: "desc" },
        take: 50,
      });
      res.json({ success: true, data: snapshots });
    } catch (error) {
      console.error("Error fetching context snapshots:", error);
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

      if (req.headers.accept?.includes("text/event-stream") || req.query.stream === "true") {
        return this.streamAgent(req, res);
      }

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

  async streamAgent(req: Request, res: Response) {
    try {
      const userId = req.headers["x-user-id"] as string;
      const { projectId } = req.params;
      if (!userId) return res.status(401).json({ error: "User ID required" });
      if (Array.isArray(projectId)) return res.status(400).json({ error: "Invalid project ID" });

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const sendEvent = (event: string, data: any) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      const result = await aiService.runCodingAgent(
        userId,
        projectId,
        req.body,
        (progressEvent) => {
          sendEvent("progress", progressEvent);
        }
      );

      sendEvent("complete", result);
      res.end();
    } catch (error) {
      console.error("Agent stream error:", error);
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Agent run failed", message: error instanceof Error ? error.message : "Unknown error" })}\n\n`);
      res.end();
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

      // Get the project and decrypt the GitHub token
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project?.githubUrl) {
        return res.status(400).json({ error: "No GitHub repository connected to this project" });
      }

      const token = project.githubToken ? decrypt(project.githubToken) : undefined;
      if (!token) {
        return res.status(400).json({ error: "No GitHub token configured for this project. Please add your GitHub token in the project settings." });
      }

      const result = await ProjectGitHubService.pushChanges(project.githubUrl, changes, commitMessage, token);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Agent push error:", error);
      res.status(500).json({
        error: "Push failed",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async getProjectHealth(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      if (Array.isArray(projectId)) return res.status(400).json({ error: "Invalid project ID" });
      const health = await aiService.getProjectHealth(projectId);
      res.json(health);
    } catch (error) {
      console.error("Project health error:", error);
      res.status(500).json({
        error: "Internal server error",
        message: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  async listPullRequests(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      if (Array.isArray(projectId)) return res.status(400).json({ error: "Invalid project ID" });
      const project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project?.githubUrl) return res.status(400).json({ error: "No GitHub repository connected" });
      const token = project.githubToken ? decrypt(project.githubToken) : undefined;
      const prs = await ProjectGitHubService.listPullRequests(project.githubUrl, token);
      res.json({ pullRequests: prs });
    } catch (error) {
      console.error("List PRs error:", error);
      res.status(500).json({ error: "Failed to fetch pull requests", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  async suggestSprintTasks(req: Request, res: Response) {
    try {
      const { projectId, sprintId } = req.params;
      if (Array.isArray(projectId) || Array.isArray(sprintId))
        return res.status(400).json({ error: "Invalid params" });
      const capacity = Number(req.query.capacity) || 10;
      const suggestions = await aiService.suggestSprintTasks(projectId, sprintId, capacity);
      res.json({ suggestions });
    } catch (error) {
      console.error("Sprint suggest error:", error);
      res.status(500).json({ error: "Failed to suggest tasks", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  async generatePRDescription(req: Request, res: Response) {
    try {
      const { projectId, prNumber } = req.params;
      if (Array.isArray(projectId)) return res.status(400).json({ error: "Invalid project ID" });
      const num = Array.isArray(prNumber) ? prNumber[0] : prNumber;
      const result = await aiService.generatePRDescription(projectId, parseInt(num, 10));
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Generate PR description error:", error);
      res.status(500).json({ error: "Failed to generate PR description", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  async generateSprint(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      if (Array.isArray(projectId)) return res.status(400).json({ error: "Invalid project ID" });
      const { prompt } = req.body;
      if (!prompt) return res.status(400).json({ error: "prompt is required" });
      const result = await aiService.generateSprint(projectId, prompt);
      res.json({ success: true, data: result });
    } catch (error) {
      console.error("Generate sprint error:", error);
      res.status(500).json({ error: "Failed to generate sprint", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  async suggestTaskOrder(req: Request, res: Response) {
    try {
      const { tasks } = req.body;
      if (!Array.isArray(tasks) || tasks.length === 0) {
        return res.status(400).json({ error: "tasks array is required" });
      }
      const order = await aiService.suggestTaskOrder(tasks);
      res.json({ success: true, data: { order } });
    } catch (error) {
      console.error("Suggest task order error:", error);
      res.status(500).json({ error: "Failed to suggest task order", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  async reviewPullRequest(req: Request, res: Response) {
    try {
      const { projectId, prNumber } = req.params;
      if (Array.isArray(projectId)) return res.status(400).json({ error: "Invalid project ID" });
      const num = Array.isArray(prNumber) ? prNumber[0] : prNumber;
      const review = await aiService.reviewPullRequest(projectId, parseInt(num, 10));
      res.json(review);
    } catch (error) {
      console.error("PR review error:", error);
      res.status(500).json({ error: "Failed to review pull request", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  // ── Manifest and Decomposition API Endpoints (Task 17) ─────────────────────

  async generateManifest(req: Request, res: Response) {
    try {
      const { projectId } = req.params;
      const { userRequest, sessionId } = req.body;
      const manifest = await prisma.agentManifest.findFirst({
        where: { projectId: String(projectId), sessionId: sessionId ? String(sessionId) : undefined },
        orderBy: { generatedAt: "desc" },
      });
      res.json({ success: true, data: manifest });
    } catch (error) {
      console.error("Generate manifest API error:", error);
      res.status(500).json({ error: "Failed to fetch/generate manifest", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  async approveManifest(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const updated = await prisma.agentManifest.update({
        where: { id: String(id) },
        data: { validationStatus: "approved", approvedAt: new Date() },
      });
      res.json({ success: true, data: updated });
    } catch (error) {
      console.error("Approve manifest error:", error);
      res.status(500).json({ error: "Failed to approve manifest", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  async rejectManifest(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const updated = await prisma.agentManifest.update({
        where: { id: String(id) },
        data: { validationStatus: "rejected" },
      });
      res.json({ success: true, data: updated });
    } catch (error) {
      console.error("Reject manifest error:", error);
      res.status(500).json({ error: "Failed to reject manifest", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }

  async getDecomposition(req: Request, res: Response) {
    try {
      const { sessionId } = req.params;
      const decomposition = await prisma.taskDecomposition.findFirst({
        where: { sessionId: String(sessionId) },
        include: { subTasksExecs: true },
        orderBy: { createdAt: "desc" },
      });
      res.json({ success: true, data: decomposition });
    } catch (error) {
      console.error("Get decomposition error:", error);
      res.status(500).json({ error: "Failed to get decomposition graph", message: error instanceof Error ? error.message : "Unknown error" });
    }
  }
}
