import { Router } from 'express';
import { AiController } from '../controllers/ai-controller';

const router = Router();
const aiController = new AiController();

// General Assistant Routes
router.post('/general/chat', aiController.generalChat.bind(aiController));
router.get('/general/sessions', aiController.getGeneralSessions.bind(aiController));
router.get('/general/sessions/:sessionId/messages', aiController.getGeneralSessionMessages.bind(aiController));

// Project Assistant Routes
router.post('/projects/:projectId/chat', aiController.projectChat.bind(aiController));
router.get('/projects/:projectId/sessions', aiController.getProjectSessions.bind(aiController));
router.get('/projects/:projectId/sessions/:sessionId/messages', aiController.getProjectSessionMessages.bind(aiController));
router.get('/projects/:projectId/context', aiController.getProjectContext.bind(aiController));

export default router;
