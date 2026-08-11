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
router.get('/projects/:projectId/context-snapshots', aiController.getContextSnapshots.bind(aiController));
router.get('/projects/:projectId/file-reservations', aiController.getFileReservations.bind(aiController));
router.get('/projects/:projectId/drift-records', aiController.getDriftRecords.bind(aiController));
router.post('/projects/:projectId/drift-records', aiController.createDriftRecord.bind(aiController));
router.patch('/projects/:projectId/drift-records/:recordId', aiController.resolveDriftRecord.bind(aiController));

// Project Health
router.get('/projects/:projectId/health', aiController.getProjectHealth.bind(aiController));

// Pull Request Review
router.get('/projects/:projectId/prs', aiController.listPullRequests.bind(aiController));
router.post('/projects/:projectId/prs/:prNumber/review', aiController.reviewPullRequest.bind(aiController));
router.post('/projects/:projectId/prs/:prNumber/describe', aiController.generatePRDescription.bind(aiController));

// Sprint Planner
router.get('/projects/:projectId/sprints/:sprintId/suggest', aiController.suggestSprintTasks.bind(aiController));
router.post('/projects/:projectId/sprints/generate', aiController.generateSprint.bind(aiController));

// Coding Agent Routes
router.post('/projects/:projectId/agent/run', aiController.runAgent.bind(aiController));
router.post('/projects/:projectId/agent/stream', aiController.streamAgent.bind(aiController));
router.post('/projects/:projectId/agent/push', aiController.pushAgentChanges.bind(aiController));
router.post('/projects/:projectId/tasks/suggest-order', aiController.suggestTaskOrder.bind(aiController));

// Manifest & Task Decomposition Endpoints
router.post('/projects/:projectId/agent/manifest', aiController.generateManifest.bind(aiController));
router.post('/agent/manifest/:id/approve', aiController.approveManifest.bind(aiController));
router.post('/agent/manifest/:id/reject', aiController.rejectManifest.bind(aiController));
router.get('/agent/decomposition/:sessionId', aiController.getDecomposition.bind(aiController));

export default router;
