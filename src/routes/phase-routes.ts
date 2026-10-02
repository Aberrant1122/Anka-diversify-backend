import { Router } from "express";
import { PhaseController } from "../controllers/phase-controller";

const router = Router({ mergeParams: true });
const phaseController = new PhaseController();

// GET    /api/projects/:projectId/phases
router.get("/", phaseController.getPhaseStates.bind(phaseController));

// GET    /api/projects/:projectId/phases/requirements-policy
router.get("/requirements-policy", phaseController.getRequirementsPolicy.bind(phaseController));

// GET    /api/projects/:projectId/phases/approvals?phase=architecture
router.get("/approvals", phaseController.getApprovalHistory.bind(phaseController));

// GET    /api/projects/:projectId/phases/artifacts?phase=architecture
router.get("/artifacts", phaseController.listArtifacts.bind(phaseController));

// GET    /api/projects/:projectId/phases/artifacts/:artifactId
router.get("/artifacts/:artifactId", phaseController.getArtifact.bind(phaseController));

// GET    /api/projects/:projectId/phases/requirements/artifacts/:artifactId/readiness
router.get("/requirements/artifacts/:artifactId/readiness", phaseController.getRequirementsReadiness.bind(phaseController));

router.get("/architecture/artifacts/:artifactId/readiness", phaseController.getArchitectureReadiness.bind(phaseController));
router.post("/architecture/artifacts/generate", phaseController.generateInitialArchitecture.bind(phaseController));
router.get("/architecture/runs/:runId", phaseController.getArchitectureRun.bind(phaseController));
router.post("/architecture/artifacts", phaseController.createArchitectureArtifact.bind(phaseController));
router.post("/architecture/artifacts/:artifactId/revisions", phaseController.createArchitectureSuccessor.bind(phaseController));
router.post("/architecture/artifacts/:artifactId/revisions/ai", phaseController.reviseArchitectureAI.bind(phaseController));

// POST   /api/projects/:projectId/phases/artifacts
router.post("/artifacts", phaseController.createArtifact.bind(phaseController));

// POST   /api/projects/:projectId/phases/requirements/artifacts/generate
router.post(
  "/requirements/artifacts/generate",
  phaseController.generateInitialRequirements.bind(phaseController),
);

// POST   /api/projects/:projectId/phases/documentation/artifacts/generate
router.post(
  "/documentation/artifacts/generate",
  phaseController.generateInitialDocumentation.bind(phaseController),
);

// POST   /api/projects/:projectId/phases/documentation/artifacts/:artifactId/revisions
router.post(
  "/documentation/artifacts/:artifactId/revisions",
  phaseController.reviseDocumentation.bind(phaseController),
);

// POST   /api/projects/:projectId/phases/documentation/artifacts/:artifactId/revise
router.post(
  "/documentation/artifacts/:artifactId/revise",
  phaseController.reviseDocumentationDocument.bind(phaseController),
);

// POST   /api/projects/:projectId/phases/documentation/artifacts/:artifactId/feedback
router.post(
  "/documentation/artifacts/:artifactId/feedback",
  phaseController.applyDocumentationFeedback.bind(phaseController),
);

// POST   /api/projects/:projectId/phases/documentation/artifacts/:artifactId/sections/:sectionKey/revise
router.post(
  "/documentation/artifacts/:artifactId/sections/:sectionKey/revise",
  phaseController.reviseDocumentationSection.bind(phaseController),
);

// POST   /api/projects/:projectId/phases/documentation/artifacts/:artifactId/sections/:sectionKey/regenerate
router.post(
  "/documentation/artifacts/:artifactId/sections/:sectionKey/regenerate",
  phaseController.regenerateDocumentationSection.bind(phaseController),
);

// POST   /api/projects/:projectId/phases/requirements/artifacts/:artifactId/revisions
router.post(
  "/requirements/artifacts/:artifactId/revisions",
  phaseController.reviseRequirements.bind(phaseController),
);

// GET    /api/projects/:projectId/phases/runs
router.get("/runs", phaseController.getWorkflowRuns.bind(phaseController));

// GET    /api/projects/:projectId/phases/runs/:runId
router.get("/runs/:runId", phaseController.getRequirementsRun.bind(phaseController));

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

// POST   /api/projects/:projectId/phases/:phase/reject
router.post("/:phase/reject", phaseController.rejectPhase.bind(phaseController));

export default router;
