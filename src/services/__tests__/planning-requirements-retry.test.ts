import { Prisma, PrismaClient } from "@prisma/client";
import { PlanningRequirementsContextBuilder } from "../../planning/requirements-context";
import { PlanningAuthorizationService } from "../planning-authorization.service";
import { PlanningRequirementsRunService, RequirementsGenerationAudit } from "../planning-requirements-run.service";

function retryableConflict(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError("sensitive database conflict details", {
    code: "P2034",
    clientVersion: "5.22.0",
  });
}

function rejectingPrisma(): { prisma: PrismaClient; transaction: jest.Mock } {
  const transaction = jest.fn().mockImplementation(async () => {
    throw retryableConflict();
  });
  return {
    prisma: { $transaction: transaction } as unknown as PrismaClient,
    transaction,
  };
}

const audit: RequirementsGenerationAudit = { modelUsage: {}, costUSD: null };

describe("Requirements transaction retry exhaustion", () => {
  test("Transaction A exhausts the configured retries with a sanitized concurrency error", async () => {
    const { prisma, transaction } = rejectingPrisma();
    const authorization = {
      assertCanEdit: jest.fn().mockResolvedValue({ id: "project-1" }),
    } as unknown as PlanningAuthorizationService;
    const contexts = {
      buildInitial: jest.fn().mockResolvedValue({
        payload: {
          target: "requirements",
          operation: "INITIAL_GENERATION",
          project: { id: "project-1", name: "Project", description: null, currentPhase: "requirements" },
          brief: "Brief",
          initiator: { id: "actor-1", type: "HUMAN" },
          versions: { builder: "builder-v1", schema: 1, prompt: "prompt-v2", providerSchema: "schema-v1" },
        },
        manifest: {
          target: "requirements",
          operation: "INITIAL_GENERATION",
          project: { id: "project-1", name: "Project", description: null, currentPhase: "requirements" },
          initiator: { id: "actor-1", type: "HUMAN" },
          brief: { normalizedText: "Brief", byteLength: 5, hash: "brief-hash", source: "submitted_brief" },
          builderVersion: "builder-v1",
          schemaVersion: 1,
          promptVersion: "prompt-v2",
          providerSchemaVersion: "schema-v1",
          contextHash: "context-hash",
        },
        contextHash: "context-hash",
      }),
    } as unknown as PlanningRequirementsContextBuilder;
    const runs = new PlanningRequirementsRunService(prisma, authorization, contexts);

    await expect(runs.startRequirementsRun({
      projectId: "project-1",
      actorId: "actor-1",
      operation: "INITIAL_GENERATION",
      idempotencyKey: "retry-a",
      brief: "Brief",
    })).rejects.toMatchObject({
      code: "PLANNING_CONCURRENT_UPDATE",
      httpStatus: 409,
      message: "Could not acquire the Requirements run lease.",
    });
    expect(transaction).toHaveBeenCalledTimes(3);
  });

  test.each([
    ["initial", (runs: PlanningRequirementsRunService) => runs.finalizeInitialGeneration({
      projectId: "project-1", runId: "run-1", actorId: "actor-1", structuredContent: {}, audit,
    })],
    ["revision", (runs: PlanningRequirementsRunService) => runs.finalizeRequirementsRevision({
      projectId: "project-1", runId: "run-1", actorId: "actor-1", structuredContent: {}, audit,
    })],
  ] as const)("Transaction B %s exhaustion is sanitized and preserves the attempt bound", async (_name, finalize) => {
    const { prisma, transaction } = rejectingPrisma();
    const runs = new PlanningRequirementsRunService(prisma);

    const thrown: unknown = await finalize(runs).then(() => null, (error: unknown) => error);
    expect(thrown).toMatchObject({
      code: "PLANNING_CONCURRENT_UPDATE",
      httpStatus: 409,
    });
    expect(thrown).not.toMatchObject({ message: expect.stringContaining("sensitive") });
    expect(transaction).toHaveBeenCalledTimes(3);
  });
});
