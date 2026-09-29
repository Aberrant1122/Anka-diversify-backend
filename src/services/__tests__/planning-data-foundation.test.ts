import crypto from "crypto";
import { PrismaClient } from "@prisma/client";

const databaseUrl = process.env.DATABASE_URL;
const isolatedSchema = databaseUrl
  ? new URL(databaseUrl).searchParams.get("schema")
  : null;

if (!isolatedSchema?.startsWith("planning_checkpoint_1a_")) {
  throw new Error(
    "planning-data-foundation.test.ts requires an isolated planning_checkpoint_1a_* PostgreSQL schema",
  );
}

const prisma = new PrismaClient();

const userId = `checkpoint-1a-user-${crypto.randomUUID()}`;
const projectId = `checkpoint-1a-project-${crypto.randomUUID()}`;
const artifactV1Id = `checkpoint-1a-artifact-${crypto.randomUUID()}`;
const artifactV2Id = `checkpoint-1a-artifact-${crypto.randomUUID()}`;
const hashV1 = crypto.createHash("sha256").update("requirements-v1").digest("hex");
const hashV2 = crypto.createHash("sha256").update("requirements-v2").digest("hex");

async function insertArtifact(input: {
  id: string;
  version: number;
  title: string;
  content: string;
  contentHash: string;
  previousVersionId?: string;
  basedOnArtifactId?: string;
}): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "phase_artifacts" (
      "id", "projectId", "phase", "type", "title", "content",
      "structuredContent", "schemaVersion", "contentHash", "version",
      "previousVersionId", "basedOnArtifactId", "changeKind",
      "createdBy", "createdByType", "lifecycleStatus", "approved"
    ) VALUES (
      $1, $2, 'requirements', 'requirements_doc', $3, $4,
      $5::jsonb, 1, $6, $7, $8, $9,
      $10::"ArtifactChangeKind", $11, $12::"ArtifactActorType",
      'DRAFT'::"ArtifactLifecycleStatus", FALSE
    )`,
    input.id,
    projectId,
    input.title,
    input.content,
    JSON.stringify({ projectGoal: { text: input.content } }),
    input.contentHash,
    input.version,
    input.previousVersionId ?? null,
    input.basedOnArtifactId ?? null,
    input.version === 1 ? "INITIAL_GENERATION" : "AI_SECTION_REVISION",
    userId,
    input.version === 1 ? "AI" : "HUMAN",
  );
}

describe("Checkpoint 1A planning data foundation", () => {
  beforeAll(async () => {
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@anka.test`,
        name: "Checkpoint 1A",
        password: "not-used",
        role: "user",
      },
    });
    await prisma.project.create({
      data: {
        id: projectId,
        name: "Checkpoint 1A Requirements",
        userId,
      },
    });

    await insertArtifact({
      id: artifactV1Id,
      version: 1,
      title: "Requirements v1",
      content: "requirements-v1",
      contentHash: hashV1,
    });
    await insertArtifact({
      id: artifactV2Id,
      version: 2,
      title: "Requirements v2",
      content: "requirements-v2",
      contentHash: hashV2,
      previousVersionId: artifactV1Id,
      basedOnArtifactId: artifactV1Id,
    });
  });

  afterAll(async () => {
    await prisma.project.delete({ where: { id: projectId } });
    await prisma.user.delete({ where: { id: userId } });
    await prisma.$disconnect();
  });

  test("enforces one version number per project, phase, and artifact type", async () => {
    await expect(
      insertArtifact({
        id: `checkpoint-1a-artifact-${crypto.randomUUID()}`,
        version: 2,
        title: "Duplicate Requirements v2",
        content: "duplicate-v2",
        contentHash: crypto.createHash("sha256").update("duplicate-v2").digest("hex"),
      }),
    ).rejects.toThrow();

    const rows = await prisma.$queryRawUnsafe<Array<{ version: number }>>(
      `SELECT "version" FROM "phase_artifacts"
       WHERE "projectId" = $1 AND "phase" = 'requirements' AND "type" = 'requirements_doc'
       ORDER BY "version" ASC`,
      projectId,
    );
    expect(rows.map((row) => row.version)).toEqual([1, 2]);
  });

  test("prevents updates to immutable artifact content while preserving lineage", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE "phase_artifacts" SET "content" = 'silently-overwritten' WHERE "id" = $1`,
        artifactV1Id,
      ),
    ).rejects.toThrow(/immutable/i);

    const rows = await prisma.$queryRawUnsafe<Array<{
      content: string;
      previousVersionId: string | null;
      basedOnArtifactId: string | null;
    }>>(
      `SELECT "content", "previousVersionId", "basedOnArtifactId"
       FROM "phase_artifacts" WHERE "id" = $1`,
      artifactV2Id,
    );
    expect(rows[0]).toEqual({
      content: "requirements-v2",
      previousVersionId: artifactV1Id,
      basedOnArtifactId: artifactV1Id,
    });
  });

  test("records an approval against the exact artifact version and hash", async () => {
    const approvalId = `checkpoint-1a-approval-${crypto.randomUUID()}`;
    await prisma.$executeRawUnsafe(
      `INSERT INTO "phase_approvals" (
        "id", "projectId", "phase", "artifactId", "artifactVersion",
        "artifactContentHash", "legacyUnverified", "approvedById", "decision"
      ) VALUES ($1, $2, 'requirements', $3, 2, $4, FALSE, $5, 'approved')`,
      approvalId,
      projectId,
      artifactV2Id,
      hashV2,
      userId,
    );

    const rows = await prisma.$queryRawUnsafe<Array<{
      artifactId: string;
      artifactVersion: number;
      artifactContentHash: string;
      actualHash: string;
      legacyUnverified: boolean;
    }>>(
      `SELECT a."artifactId", a."artifactVersion", a."artifactContentHash",
              p."contentHash" AS "actualHash", a."legacyUnverified"
       FROM "phase_approvals" a
       JOIN "phase_artifacts" p ON p."id" = a."artifactId"
       WHERE a."id" = $1`,
      approvalId,
    );
    expect(rows[0]).toEqual({
      artifactId: artifactV2Id,
      artifactVersion: 2,
      artifactContentHash: hashV2,
      actualHash: hashV2,
      legacyUnverified: false,
    });

    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "phase_approvals" (
          "id", "projectId", "phase", "artifactId", "artifactVersion",
          "artifactContentHash", "legacyUnverified", "approvedById", "decision"
        ) VALUES ($1, $2, 'requirements', $3, 99, $4, FALSE, $5, 'approved')`,
        `checkpoint-1a-approval-${crypto.randomUUID()}`,
        projectId,
        "missing-artifact-version",
        crypto.createHash("sha256").update("missing").digest("hex"),
        userId,
      ),
    ).rejects.toThrow();
  });

  test("persists phase pointers and Requirements workflow-run context metadata", async () => {
    const runId = `checkpoint-1a-run-${crypto.randomUUID()}`;
    const contextHash = crypto.createHash("sha256").update("brief-context").digest("hex");
    await prisma.$executeRawUnsafe(
      `INSERT INTO "workflow_runs" (
        "id", "projectId", "triggerType", "currentPhase", "status", "operation",
        "baseArtifactId", "inputArtifactId", "outputArtifactId", "contextManifest",
        "contextHash", "targetSectionKey", "initiatedById", "initiatedByType", "idempotencyKey"
      ) VALUES (
        $1, $2, 'manual', 'requirements', 'completed', 'SECTION_REVISION',
        $3, $3, $4, $5::jsonb, $6, 'projectGoal', $7, 'HUMAN', $8
      )`,
      runId,
      projectId,
      artifactV1Id,
      artifactV2Id,
      JSON.stringify({ brief: "rough brief", artifactInputs: [{ id: artifactV1Id, version: 1, hash: hashV1 }] }),
      contextHash,
      userId,
      `checkpoint-1a-${crypto.randomUUID()}`,
    );

    await prisma.$executeRawUnsafe(
      `INSERT INTO "project_phase_states" (
        "id", "projectId", "phase", "status", "currentArtifactId",
        "approvalCandidateArtifactId", "currentApprovedArtifactId", "activeRunId", "stateVersion"
      ) VALUES ($1, $2, 'requirements', 'approved', $3, $3, $3, $4, 3)`,
      `checkpoint-1a-state-${crypto.randomUUID()}`,
      projectId,
      artifactV2Id,
      runId,
    );

    const rows = await prisma.$queryRawUnsafe<Array<{
      currentArtifactId: string;
      approvalCandidateArtifactId: string;
      currentApprovedArtifactId: string;
      activeRunId: string;
      stateVersion: number;
      contextHash: string;
      outputArtifactId: string;
    }>>(
      `SELECT s."currentArtifactId", s."approvalCandidateArtifactId",
              s."currentApprovedArtifactId", s."activeRunId", s."stateVersion",
              r."contextHash", r."outputArtifactId"
       FROM "project_phase_states" s
       JOIN "workflow_runs" r ON r."id" = s."activeRunId"
       WHERE s."projectId" = $1 AND s."phase" = 'requirements'`,
      projectId,
    );
    expect(rows[0]).toEqual({
      currentArtifactId: artifactV2Id,
      approvalCandidateArtifactId: artifactV2Id,
      currentApprovedArtifactId: artifactV2Id,
      activeRunId: runId,
      stateVersion: 3,
      contextHash,
      outputArtifactId: artifactV2Id,
    });
  });
});
