const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { PrismaClient } = require("@prisma/client");
const { validateSafeTestDatabase, assertSafeSchema } = require("../scripts/run-cp0-acceptance");

async function testSeed() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const schemaName = `planning_checkpoint_1b_cp41_seed_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  assertSafeSchema(schemaName);

  const isolatedUrl = new URL(baseUrl.href);
  isolatedUrl.searchParams.set("schema", schemaName);

  const migration = spawnSync("npx prisma migrate deploy", {
    shell: true,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: isolatedUrl.href },
  });
  if (migration.status !== 0) {
    throw new Error(migration.stderr || migration.stdout || "Migration failed");
  }

  process.env.DATABASE_URL = isolatedUrl.href;
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });
  const prisma = new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });

  try {
    const { DocumentationLifecycleFixture, requirements, documentationContent, hashOf } = require("../src/services/__tests__/planning-documentation-test-fixtures");
    const { architectureDraft } = require("../src/planning/__tests__/architecture-test-fixtures");
    const { PlanningArchitectureArtifactService } = require("../dist/services/planning-architecture-artifact.service");

    const fixture = new DocumentationLifecycleFixture();
    await fixture.start();

    const projectId = await fixture.createProject(true);
    const ownerId = fixture.ownerId;
    const memberId = fixture.memberId;

    const repo = await fixture.prisma.projectRepository.create({
      data: {
        id: "repo-core-backend",
        projectId,
        name: "anka-core-backend",
        role: "backend",
        githubUrl: "https://github.com/example/repo",
      },
    });

    const req = await fixture.approveRequirements(projectId, "cp41-journey");
    const doc = await fixture.documentationArtifacts.createInitialArtifact({
      projectId,
      actorId: ownerId,
      title: "Documentation",
      structuredContent: documentationContent(req.artifact, req.content),
    });
    await fixture.approvals.requestDocumentationApproval({
      projectId,
      artifactId: doc.id,
      expectedHash: hashOf(doc),
      actorId: ownerId,
    });
    await fixture.approvals.approveDocumentationArtifact({
      projectId,
      artifactId: doc.id,
      expectedHash: hashOf(doc),
      actorId: ownerId,
    });

    const draft = architectureDraft(req.content.nonFunctionalRequirements[0].id);
    draft.components = [
      {
        id: "ARCH-COMP-DATA",
        name: "Data Layer",
        responsibility: "Prisma schema & multi-tenant models",
        boundary: "Database",
        dependencyIds: [],
        documentationFeatureIds: ["DOC-FEATURE"],
        designNotes: "PostgreSQL schemas",
      },
      {
        id: "ARCH-COMP-SECURITY",
        name: "Security Guard",
        responsibility: "RBAC & token guards",
        boundary: "Auth",
        dependencyIds: ["ARCH-COMP-DATA"],
        documentationFeatureIds: ["DOC-FEATURE"],
        designNotes: "Owner verification",
      },
    ];
    draft.implementationSequence = ["ARCH-COMP-DATA", "ARCH-COMP-SECURITY"];

    const arch = await new PlanningArchitectureArtifactService(fixture.prisma).create({
      projectId,
      actorId: ownerId,
      title: "Architecture",
      structuredContent: draft,
    });
    await fixture.approvals.requestArchitectureApproval({
      projectId,
      artifactId: arch.id,
      expectedHash: hashOf(arch),
      actorId: ownerId,
    });
    await fixture.approvals.approveArchitectureArtifact({
      projectId,
      artifactId: arch.id,
      expectedHash: hashOf(arch),
      actorId: ownerId,
    });

    console.log(`[TEST SEED] Successfully created and approved Requirements, Documentation, and Architecture!`);

    const { currentImplementationAuthority } = require("../dist/planning/implementation-authority-preflight");
    const authority = await currentImplementationAuthority(fixture.prisma, projectId, ownerId);
    console.log(`[TEST SEED] currentImplementationAuthority verified. Fingerprint: ${authority.fingerprint.slice(0, 16)}...`);
    await fixture.stop();
  } finally {
    await prisma.$disconnect();
    await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
    await rootPrisma.$disconnect();
    console.log(`[TEST SEED] Cleaned up schema.`);
  }
}

testSeed().catch((err) => {
  console.error(err);
  process.exit(1);
});
