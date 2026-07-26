import { Router } from "express";
import { PhaseController } from "../controllers/phase-controller";

const router = Router({ mergeParams: true });
const phaseController = new PhaseController();

// GET    /api/projects/:projectId/phases
router.get("/", phaseController.getPhaseStates.bind(phaseController));

// GET    /api/projects/:projectId/phases/approvals?phase=architecture
router.get("/approvals", phaseController.getApprovalHistory.bind(phaseController));

// GET    /api/projects/:projectId/phases/artifacts?phase=architecture
router.get("/artifacts", phaseController.listArtifacts.bind(phaseController));

// POST   /api/projects/:projectId/phases/artifacts
router.post("/artifacts", phaseController.createArtifact.bind(phaseController));

// GET    /api/projects/:projectId/phases/runs
router.get("/runs", phaseController.getWorkflowRuns.bind(phaseController));

// POST   /api/projects/:projectId/phases/:phase/run — AI drafts a proposal + logs a WorkflowRun
router.post("/:phase/run", phaseController.runAutomatedPhase.bind(phaseController));

// POST   /api/projects/:projectId/phases/:phase/start
router.post("/:phase/start", phaseController.startPhase.bind(phaseController));

// POST   /api/projects/:projectId/phases/:phase/request-approval
router.post("/:phase/request-approval", phaseController.requestApproval.bind(phaseController));

// POST   /api/projects/:projectId/phases/:phase/approve
router.post("/:phase/approve", phaseController.approvePhase.bind(phaseController));

// POST   /api/projects/:projectId/phases/:phase/request-changes
router.post("/:phase/request-changes", phaseController.requestChanges.bind(phaseController));

export default router;
