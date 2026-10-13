const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const projectId = "cmv4t9qjm0001hyliciu6ghqj";
  const project = await prisma.project.findUnique({ where: { id: projectId } });
  console.log("PROJECT:", { id: project.id, name: project.name, currentPhase: project.currentPhase, userId: project.userId });

  const states = await prisma.projectPhaseState.findMany({ where: { projectId } });
  console.log("PHASE STATES:");
  for (const s of states) {
    console.log(`- phase: ${s.phase} | status: ${s.status} | currentArtifactId: ${s.currentArtifactId} | approvedArtifactId: ${s.currentApprovedArtifactId} | candidateId: ${s.approvalCandidateArtifactId} | isStale: ${s.isStale} | activeRunId: ${s.activeRunId}`);
  }

  const approvals = await prisma.phaseApproval.findMany({ where: { projectId } });
  console.log("APPROVALS:");
  for (const a of approvals) {
    console.log(`- phase: ${a.phase} | decision: ${a.decision} | artifactId: ${a.artifactId} | version: ${a.artifactVersion} | approvedBy: ${a.approvedById} | approvedAt: ${a.approvedAt?.toISOString()}`);
  }

  const artifacts = await prisma.phaseArtifact.findMany({
    where: { projectId },
    select: { id: true, phase: true, version: true, title: true, lifecycleStatus: true, approved: true, approvedAt: true, contentHash: true },
    orderBy: [{ phase: "asc" }, { version: "asc" }],
  });
  console.log("ARTIFACTS:");
  for (const art of artifacts) {
    console.log(`- phase: ${art.phase} | v${art.version} | id: ${art.id} | status: ${art.lifecycleStatus} | approved: ${art.approved} | hash: ${art.contentHash?.slice(0, 16)}...`);
  }

  const tasks = await prisma.implementationTask.findMany({ where: { projectId } });
  console.log("IMPLEMENTATION TASKS COUNT:", tasks.length);

  const kanban = await prisma.kanbanBoard.findMany({ where: { projectId } });
  console.log("KANBAN BOARDS COUNT:", kanban.length);
}

main().catch(console.error).finally(() => prisma.$disconnect());
