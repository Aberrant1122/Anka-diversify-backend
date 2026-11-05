import { BaselineValidationService } from "../workspace/baseline-validation-service";
import { Router, Request, Response } from "express";
import { prisma } from "../services/database";
import { PrismaClient } from "@prisma/client";
import { ExecutionPolicy } from "../workspace/document-executor";
import { WorkspaceService } from "../workspace/workspace-service";
import { DocumentExecutor } from "../workspace/document-executor";
import { WorkspaceError } from "../workspace/document-contract";
import {
  WorkspaceGenerationService,
  WorkspaceProvider,
} from "../workspace/generation-service";
import { WorkspaceRepositoryService } from "../workspace/repository-service";
import { documentRepositoryRoot } from "../workspace/repository-service";
import { WorkspaceExecutionService } from "../workspace/workspace-execution-service";
import { SandboxAdapter } from "../workspace/sandbox";
import { PublicationAdapter } from "../workspace/publication";
import os from "os";
import path from "path";
export function createWorkspaceRouter(
  database: PrismaClient,
  policy?: ExecutionPolicy,
  provider?: WorkspaceProvider,
  adapters?: { sandbox?: SandboxAdapter; publisher?: PublicationAdapter },
) {
  const router = Router({ mergeParams: true });
  router.use((_req, res, next) =>
    process.env.ANKA_DOCUMENT_WORKFLOW_ENABLED === "false"
      ? res.status(503).json({ error: "DOCUMENT_WORKFLOW_DISABLED" })
      : next(),
  );
  const service = new WorkspaceService(database),
    executor = new DocumentExecutor(service, policy);
  const execution = new WorkspaceExecutionService(
    database,
    service,
    policy || {
      repositoryRoot: documentRepositoryRoot(),
      runsRoot:
        process.env.ANKA_EXECUTION_ROOT ||
        path.join(os.tmpdir(), "anka-document-runs"),
    },
    adapters?.sandbox,
    adapters?.publisher,
  );
  const generation = new WorkspaceGenerationService(
    database,
    service,
    executor,
    provider,
  );
  const route =
    (work: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        res.json({ success: true, data: await work(req) });
      } catch (e) {
        if (e instanceof WorkspaceError)
          res.status(e.status).json({ error: e.code });
        else {
          console.error(
            "Workspace operation failed",
            e instanceof Error ? e.name : "unknown",
          );
          res.status(503).json({ error: "WORKSPACE_UNAVAILABLE" });
        }
      }
    };
  const project = (r: Request) => String(r.params.projectId);
  const actor = (r: Request) => r.user.userId as string;
  const baseline = new BaselineValidationService(database); // Default trusted evidence store unavailable.
  router.get(
    "/baseline-validation",
    route((r) => baseline.view(project(r), actor(r))),
  );
  router.post(
    "/baseline-validation/preview",
    route((r) => baseline.preview(project(r), actor(r), r.body)),
  );
  router.post(
    "/baseline-validation/approve",
    route((r) => baseline.approve(project(r), actor(r), r.body)),
  );
  router.post(
    "/baseline-validation/authorize",
    route((r) => baseline.authorize(project(r), actor(r), r.body)),
  );
  router.post(
    "/baseline-validation/claim",
    route((r) => baseline.claim(project(r), actor(r), r.body)),
  );
  router.post(
    "/baseline-validation/operations/:operationId/dispatch",
    route((r) =>
      baseline.dispatch(project(r), actor(r), String(r.params.operationId)),
    ),
  );
  router.post(
    "/baseline-validation/operations/:operationId/request-cleanup",
    route((r) =>
      baseline.requestCleanup(
        project(r),
        actor(r),
        String(r.params.operationId),
      ),
    ),
  );
  // No HTTP receipt ingestion, worker-start/result or cleanup-confirmation route.
  router.post(
    "/repositories/:repositoryId/materialize",
    route((r) =>
      new WorkspaceRepositoryService(
        database,
        policy?.repositoryRoot,
      ).materialize(project(r), actor(r), String(r.params.repositoryId)),
    ),
  );
  router.get(
    "/repositories/observed-baselines",
    route(async (r) =>
      executor.observedBaselines(
        await database.projectRepository.findMany({
          where: { projectId: project(r), project: { userId: actor(r) } },
          select: { id: true, localPath: true },
        }),
      ),
    ),
  );
  router.get(
    "/capabilities",
    route(async (r) => {
      const capabilities = await execution.capabilities(project(r), actor(r));
      return { ...generation.capabilities(), ...capabilities };
    }),
  );
  router.post(
    "/generate",
    route((r) => generation.generate(project(r), actor(r), r.body)),
  );
  router.post(
    "/runs/:runId/propose",
    route((r) =>
      generation.generate(project(r), actor(r), {
        ...r.body,
        kind: "CODE_PROPOSAL",
        runId: String(r.params.runId),
      }),
    ),
  );
  router.post(
    "/runs/:runId/retry",
    route((r) =>
      service.retry(project(r), actor(r), String(r.params.runId), r.body),
    ),
  );
  const runInput = (r: Request) => ({
    expectedVersion: r.body.expectedVersion,
    expectedChangeHash: r.body.expectedChangeHash,
    idempotencyKey: r.body.idempotencyKey,
  });
  router.post(
    "/runs/:runId/validate",
    route((r) =>
      execution.validate(
        project(r),
        actor(r),
        String(r.params.runId),
        runInput(r),
      ),
    ),
  );
  router.post(
    "/runs/:runId/publication/prepare",
    route((r) =>
      execution.preparePublication(
        project(r),
        actor(r),
        String(r.params.runId),
        runInput(r),
      ),
    ),
  );
  router.post(
    "/runs/:runId/publication/approve",
    route((r) =>
      service.approvePublication(project(r), actor(r), String(r.params.runId), {
        expectedVersion: r.body.expectedVersion,
        preparedEventId: r.body.preparedEventId,
        expectedBundleHash: r.body.expectedBundleHash,
      }),
    ),
  );
  router.post(
    "/runs/:runId/publication/publish",
    route((r) =>
      execution.publish(project(r), actor(r), String(r.params.runId), {
        ...runInput(r),
        publicationApprovalId: r.body.publicationApprovalId,
      }),
    ),
  );
  router.post(
    "/runs/:runId/publication/reconcile",
    route((r) =>
      execution.reconcilePublication(
        project(r),
        actor(r),
        String(r.params.runId),
        r.body.preparedEventId,
      ),
    ),
  );
  router.post(
    "/runs/:runId/operations/:operationId/recover",
    route((r) =>
      execution.recover(
        project(r),
        actor(r),
        String(r.params.runId),
        String(r.params.operationId),
      ),
    ),
  );
  router.get(
    "/",
    route((r) => service.view(project(r), actor(r))),
  );
  router.post(
    "/documents",
    route((r) => service.save(project(r), actor(r), r.body)),
  );
  router.post(
    "/import-legacy",
    route((r) =>
      service.importLegacy(project(r), actor(r), r.body.expectedVersion),
    ),
  );
  router.post(
    "/approve",
    route((r) => service.approve(project(r), actor(r), r.body)),
  );
  router.post(
    "/runs",
    route((r) => service.authorize(project(r), actor(r), r.body)),
  );
  router.get(
    "/runs/:runId/preview",
    route(async (r) => {
      const repositories = await database.projectRepository.findMany({
        where: { projectId: project(r), project: { userId: actor(r) } },
        select: { id: true, localPath: true },
      });
      return executor.preview(
        project(r),
        actor(r),
        String(r.params.runId),
        repositories,
      );
    }),
  );
  router.post(
    "/runs/:runId/execute",
    route(async (r) => {
      const repositories = await database.projectRepository.findMany({
        where: { projectId: project(r), project: { userId: actor(r) } },
        select: { id: true, localPath: true },
      });
      return executor.execute(
        project(r),
        actor(r),
        String(r.params.runId),
        r.body.changes,
        repositories,
      );
    }),
  );
  router.post(
    "/runs/:runId/review",
    route((r) =>
      service.review(
        project(r),
        actor(r),
        String(r.params.runId),
        r.body.expectedChangeHash,
      ),
    ),
  );
  return router;
}
export default createWorkspaceRouter(prisma);
