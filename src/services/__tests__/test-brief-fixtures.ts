import { Prisma, PrismaClient, WorkflowOperation } from "@prisma/client";
import { hashCanonical } from "../../planning/requirements-context";

export async function seedConfirmedLiveBrief(
  prisma: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  ownerId: string,
  options?: {
    title?: string;
    markdownContent?: string;
    revisionNumber?: number;
  },
): Promise<{ confirmationId: string; revisionId: string; contentHash: string }> {
  const revNumber = options?.revisionNumber ?? 1;
  const title = options?.title ?? "Confirmed Live Brief";
  const markdownContent = options?.markdownContent ?? "# Live Brief\n\nTest fixture scope.";
  const contentHash = hashCanonical({
    projectId,
    title,
    markdownContent,
    claims: [],
    evidenceManifest: [],
  });

  const revision = await prisma.liveBriefRevision.create({
    data: {
      projectId,
      revisionNumber: revNumber,
      title,
      markdownContent,
      structuredClaims: [],
      evidenceManifest: [],
      contentHash,
      changeSummary: `Test Brief Rev ${revNumber}`,
      createdById: ownerId,
      createdByType: "USER",
    },
  });

  const confirmation = await prisma.liveBriefConfirmation.create({
    data: {
      projectId,
      briefRevisionId: revision.id,
      briefRevisionNumber: revNumber,
      briefContentHash: contentHash,
      confirmedById: ownerId,
      status: "ACTIVE",
    },
  });

  await prisma.projectIntakeState.upsert({
    where: { projectId },
    update: {
      status: "CONFIRMED",
      currentBriefRevisionId: revision.id,
      currentConfirmationId: confirmation.id,
    },
    create: {
      projectId,
      status: "CONFIRMED",
      currentBriefRevisionId: revision.id,
      currentConfirmationId: confirmation.id,
    },
  });

  return { confirmationId: confirmation.id, revisionId: revision.id, contentHash };
}

export async function seedRequirementsWorkflowRun(
  prisma: PrismaClient | Prisma.TransactionClient,
  projectId: string,
  outputArtifactId: string,
  briefAuthority?: {
    confirmationId: string;
    revisionId: string;
    revisionNumber?: number;
    contentHash: string;
  },
): Promise<string> {
  let auth = briefAuthority;
  if (!auth) {
    const intake = await prisma.projectIntakeState.findUnique({
      where: { projectId },
      include: { currentConfirmation: true },
    });
    const conf = intake?.currentConfirmation;
    if (!conf) {
      throw new Error(`Cannot seed Requirements WorkflowRun: no active confirmation for project ${projectId}`);
    }
    auth = {
      confirmationId: conf.id,
      revisionId: conf.briefRevisionId,
      revisionNumber: conf.briefRevisionNumber,
      contentHash: conf.briefContentHash,
    };
  }

  const run = await prisma.workflowRun.create({
    data: {
      projectId,
      triggerType: "manual",
      currentPhase: "requirements",
      status: "completed",
      operation: WorkflowOperation.INITIAL_GENERATION,
      outputArtifactId,
      contextManifest: {
        briefAuthority: {
          confirmationId: auth.confirmationId,
          revisionId: auth.revisionId,
          revisionNumber: auth.revisionNumber ?? 1,
          contentHash: auth.contentHash,
        },
      },
    },
  });
  return run.id;
}
