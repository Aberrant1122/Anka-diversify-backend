import { Router } from 'express';
import { AiController } from '../controllers/ai-controller';
import { authenticateToken } from '../middleware/auth';
import { requireProjectAccess } from '../middleware/project-access';
import { bodyResource, requireProjectResources, routeResource } from '../middleware/project-resource-binding';

const router = Router();
const aiController = new AiController();
const bind = (...resources: Parameters<typeof requireProjectResources>[1][]) =>
  requireProjectResources('projectId', ...resources);

// Require a valid JWT for every AI endpoint.
router.use(authenticateToken);

// General Assistant Routes
router.post('/general/chat', aiController.generalChat.bind(aiController));
router.get('/general/sessions', aiController.getGeneralSessions.bind(aiController));
router.get('/general/sessions/:sessionId/messages', aiController.getGeneralSessionMessages.bind(aiController));

// Project Assistant Routes
router.post('/projects/:projectId/chat', requireProjectAccess('projectId'), bind(bodyResource('sessionId', 'session', true)), aiController.projectChat.bind(aiController));
router.get('/projects/:projectId/sessions', requireProjectAccess('projectId'), aiController.getProjectSessions.bind(aiController));
router.get('/projects/:projectId/sessions/:sessionId/messages', requireProjectAccess('projectId'), bind(routeResource('sessionId', 'session')), aiController.getProjectSessionMessages.bind(aiController));
router.get('/projects/:projectId/context', requireProjectAccess('projectId'), aiController.getProjectContext.bind(aiController));
router.get('/projects/:projectId/context-snapshots', requireProjectAccess('projectId'), aiController.getContextSnapshots.bind(aiController));
router.get('/projects/:projectId/file-reservations', requireProjectAccess('projectId'), aiController.getFileReservations.bind(aiController));
router.get('/projects/:projectId/drift-records', requireProjectAccess('projectId'), aiController.getDriftRecords.bind(aiController));
router.post('/projects/:projectId/drift-records', requireProjectAccess('projectId'), aiController.createDriftRecord.bind(aiController));
router.patch('/projects/:projectId/drift-records/:recordId', requireProjectAccess('projectId'), aiController.resolveDriftRecord.bind(aiController));

// Project Health
router.get('/projects/:projectId/health', requireProjectAccess('projectId'), aiController.getProjectHealth.bind(aiController));

// Pull Request Review
router.get('/projects/:projectId/pull-requests', requireProjectAccess('projectId'), aiController.listPullRequests.bind(aiController));
router.post('/projects/:projectId/pull-requests/:prNumber/review', requireProjectAccess('projectId'), aiController.reviewPullRequest.bind(aiController));
router.post('/projects/:projectId/pull-requests/:prNumber/describe', requireProjectAccess('projectId'), aiController.generatePRDescription.bind(aiController));

// Sprint Planner
router.get('/projects/:projectId/sprints/:sprintId/suggest', requireProjectAccess('projectId'), bind(routeResource('sprintId', 'sprint')), aiController.suggestSprintTasks.bind(aiController));
router.post('/projects/:projectId/sprints/generate', requireProjectAccess('projectId'), aiController.generateSprint.bind(aiController));

// Coding Agent Routes
router.post('/projects/:projectId/agent/run', requireProjectAccess('projectId'), bind(bodyResource('sessionId', 'session', true), bodyResource('repositoryId', 'repository', true)), aiController.runAgent.bind(aiController));
router.post('/projects/:projectId/agent/stream', requireProjectAccess('projectId'), bind(bodyResource('sessionId', 'session', true), bodyResource('repositoryId', 'repository', true)), aiController.streamAgent.bind(aiController));
router.post('/projects/:projectId/agent/multi-repo/run', requireProjectAccess('projectId'), aiController.runMultiRepoAgent.bind(aiController));
router.post('/projects/:projectId/agent/push', requireProjectAccess('projectId'), aiController.pushAgentChanges.bind(aiController));
router.post('/projects/:projectId/tasks/suggest-order', requireProjectAccess('projectId'), aiController.suggestTaskOrder.bind(aiController));

// Manifest & Task Decomposition Endpoints
router.post('/projects/:projectId/agent/manifest', requireProjectAccess('projectId'), bind(bodyResource('sessionId', 'session', true)), aiController.generateManifest.bind(aiController));
router.post('/agent/manifest/:id/approve', aiController.approveManifest.bind(aiController));
router.post('/agent/manifest/:id/reject', aiController.rejectManifest.bind(aiController));
router.get('/agent/decomposition/:sessionId', aiController.getDecomposition.bind(aiController));

export default router;
