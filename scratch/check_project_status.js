const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const projectId = "cmv4t9qjm0001hyliciu6ghqj";
  const project = await prisma.project.findUnique({
    where: { id: projectId },
  });
  console.log("=== PROJECT ===");
  console.log(project);

  console.log("=== PHASE STATES ===");
  const states = await prisma.projectPhaseState.findMany({
    where: { projectId },
  });
  console.log(JSON.stringify(states, null, 2));

  console.log("=== APPROVALS ===");
  const approvals = await prisma.phaseApproval.findMany({
    where: { projectId },
  });
  console.log(JSON.stringify(approvals, null, 2));

  console.log("=== ARTIFACTS ===");
  const artifacts = await prisma.phaseArtifact.findMany({
    where: { projectId },
    select: {
      id: true,
      phase: true,
      version: true,
      title: true,
      lifecycleStatus: true,
      approved: true,
      approvedAt: true,
      contentHash: true,
      createdAt: true,
    },
    orderBy: [{ phase: "asc" }, { version: "asc" }],
  });
  console.log(JSON.stringify(artifacts, null, 2));

  console.log("=== REPOSITORIES BOUND TO THIS PROJECT ===");
  const repos = await prisma.projectRepository.findMany({
    where: { projectId },
  });
  console.log(JSON.stringify(repos, null, 2));

  console.log("=== ALL PROJECT REPOSITORIES ACROSS DB ===");
  const allRepos = await prisma.projectRepository.findMany();
  console.log(JSON.stringify(allRepos, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
