const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const run17 = await prisma.workflowRun.findUnique({
    where: { id: "cmv5pdyjb0009o4ng21k6pqy6" },
  });
  console.log("=== RUN 17 FULL RECORD ===");
  console.log("ID:", run17.id);
  console.log("Status:", run17.status);
  console.log("Error code:", run17.errorCode);
  console.log("Error message:", run17.errorMessage);
  console.log("Context Manifest:", JSON.stringify(run17.contextManifest, null, 2));
  console.log("Model usage:", JSON.stringify(run17.modelUsage, null, 2));

  console.log("\n=== PROJECT BRIEF WORKSPACE FOR PROJECT cmv4t9qjm0001hyliciu6ghqj ===");
  const state = await prisma.projectIntakeState.findUnique({
    where: { projectId: "cmv4t9qjm0001hyliciu6ghqj" },
    include: { currentBriefRevision: true, currentConfirmation: true },
  });
  console.log("Intake state:", state?.status);
  console.log("Brief title:", state?.currentBriefRevision?.title);
  console.log("Brief markdown snippet:", state?.currentBriefRevision?.markdownContent?.slice(0, 500));
}

main().catch(console.error).finally(() => prisma.$disconnect());
