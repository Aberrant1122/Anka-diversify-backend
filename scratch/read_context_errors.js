const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const failedRuns = await prisma.workflowRun.findMany({
    where: { errorCode: "PLANNING_AI_CONTEXT_TOO_LARGE" },
    select: { id: true, currentPhase: true, operation: true, startedAt: true, errorCode: true, errorMessage: true },
  });
  console.log("PLANNING_AI_CONTEXT_TOO_LARGE runs count:", failedRuns.length);
  for (const r of failedRuns) {
    console.log(`RUN ${r.id} (${r.currentPhase} - ${r.operation} at ${r.startedAt.toISOString()}):`);
    console.log(r.errorMessage);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
