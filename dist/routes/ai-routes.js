"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const ai_controller_1 = require("../controllers/ai-controller");
const router = (0, express_1.Router)();
const aiController = new ai_controller_1.AiController();
// General Assistant Routes
router.post('/general/chat', aiController.generalChat.bind(aiController));
router.get('/general/sessions', aiController.getGeneralSessions.bind(aiController));
router.get('/general/sessions/:sessionId/messages', aiController.getGeneralSessionMessages.bind(aiController));
// Project Assistant Routes
router.post('/projects/:projectId/chat', aiController.projectChat.bind(aiController));
router.get('/projects/:projectId/sessions', aiController.getProjectSessions.bind(aiController));
router.get('/projects/:projectId/sessions/:sessionId/messages', aiController.getProjectSessionMessages.bind(aiController));
router.get('/projects/:projectId/context', aiController.getProjectContext.bind(aiController));
exports.default = router;
//# sourceMappingURL=ai-routes.js.map