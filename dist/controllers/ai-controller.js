"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.AiController = void 0;
const ai_service_1 = require("../services/ai-service");
const aiService = ai_service_1.AiService.getInstance();
class AiController {
    // General Assistant Routes
    async generalChat(req, res) {
        try {
            const userId = req.headers["x-user-id"];
            if (!userId) {
                return res.status(401).json({ error: "User ID required" });
            }
            const chatRequest = req.body;
            if (!chatRequest.message) {
                return res.status(400).json({ error: "Message is required" });
            }
            const response = await aiService.processGeneralChat(userId, chatRequest);
            res.json(response);
        }
        catch (error) {
            console.error("General chat error:", error);
            res.status(500).json({
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
    async getGeneralSessions(req, res) {
        try {
            const userId = req.headers["x-user-id"];
            if (!userId) {
                return res.status(401).json({ error: "User ID required" });
            }
            const sessions = await aiService.getSessions(userId, "general");
            const formattedSessions = sessions.map((session) => ({
                id: session.id,
                title: session.title,
                type: session.type,
                createdAt: session.createdAt,
                updatedAt: session.updatedAt,
                messageCount: session.messages.length,
                lastMessage: session.messages[0]?.content || null,
            }));
            res.json({ sessions: formattedSessions });
        }
        catch (error) {
            console.error("Get general sessions error:", error);
            res.status(500).json({
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
    async getGeneralSessionMessages(req, res) {
        try {
            const userId = req.headers["x-user-id"];
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
        }
        catch (error) {
            console.error("Get general session messages error:", error);
            res.status(500).json({
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
    // Project Assistant Routes
    async projectChat(req, res) {
        try {
            const userId = req.headers["x-user-id"];
            const { projectId } = req.params;
            if (!userId) {
                return res.status(401).json({ error: "User ID required" });
            }
            if (Array.isArray(projectId)) {
                return res.status(400).json({ error: "Invalid project ID" });
            }
            const chatRequest = req.body;
            if (!chatRequest.message) {
                return res.status(400).json({ error: "Message is required" });
            }
            const response = await aiService.processProjectChat(userId, projectId, chatRequest);
            res.json(response);
        }
        catch (error) {
            console.error("Project chat error:", error);
            res.status(500).json({
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
    async getProjectSessions(req, res) {
        try {
            const userId = req.headers["x-user-id"];
            const { projectId } = req.params;
            if (!userId) {
                return res.status(401).json({ error: "User ID required" });
            }
            if (Array.isArray(projectId)) {
                return res.status(400).json({ error: "Invalid project ID" });
            }
            const sessions = await aiService.getSessions(userId, "project", projectId);
            const formattedSessions = sessions.map((session) => ({
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
        }
        catch (error) {
            console.error("Get project sessions error:", error);
            res.status(500).json({
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
    async getProjectSessionMessages(req, res) {
        try {
            const userId = req.headers["x-user-id"];
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
        }
        catch (error) {
            console.error("Get project session messages error:", error);
            res.status(500).json({
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
    async getProjectContext(req, res) {
        try {
            const userId = req.headers["x-user-id"];
            const { projectId } = req.params;
            if (!userId) {
                return res.status(401).json({ error: "User ID required" });
            }
            if (Array.isArray(projectId)) {
                return res.status(400).json({ error: "Invalid project ID" });
            }
            const context = await aiService.getProjectContext(projectId, userId);
            res.json(context);
        }
        catch (error) {
            console.error("Get project context error:", error);
            res.status(500).json({
                error: "Internal server error",
                message: error instanceof Error ? error.message : "Unknown error",
            });
        }
    }
}
exports.AiController = AiController;
//# sourceMappingURL=ai-controller.js.map