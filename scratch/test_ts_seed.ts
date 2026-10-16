import crypto from "crypto";
import { spawnSync } from "child_process";
import { PrismaClient } from "@prisma/client";
import { validateSafeTestDatabase, assertSafeSchema } from "../scripts/run-cp0-acceptance";
import { DocumentationLifecycleFixture, requirements, documentationContent, hashOf } from "../src/services/__tests__/planning-documentation-test-fixtures";
import { architectureDraft } from "../src/planning/__tests__/architecture-test-fixtures";
import { PlanningArchitectureArtifactService } from "../src/services/planning-architecture-artifact.service";
import { currentImplementationAuthority } from "../src/planning/implementation-authority-preflight";

async function main() {
  const fixture = new DocumentationLifecycleFixture();
  try {
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

    const req = await fixture.approveRequirements(projectId, "cp41-ts");
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
    draft.dataDesign.items[0].componentId = "ARCH-COMP-DATA";
    draft.interfaceDesign.items[0].componentId = "ARCH-COMP-SECURITY";
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

    // Advance project to implementation phase
    await fixture.prisma.project.update({
      where: { id: projectId },
      data: { currentPhase: "implementation", phase: "implementation" },
    });
    await fixture.prisma.projectPhaseState.upsert({
      where: { projectId_phase: { projectId, phase: "implementation" } },
      create: { projectId, phase: "implementation", status: "not_started", stateVersion: 0 },
      update: { status: "not_started" },
    });

    const authority = await currentImplementationAuthority(fixture.prisma, projectId, ownerId);
    console.log(`[TEST TS SEED] SUCCESS! Authority fingerprint: ${authority.fingerprint.slice(0, 16)}...`);
  } finally {
    await fixture.stop();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
