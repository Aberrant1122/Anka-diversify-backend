const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  const projects = await prisma.project.findMany();
  console.log("PROJECTS COUNT:", projects.length);
  for (const p of projects) {
    console.log(`PROJECT: ${p.id} | name: "${p.name}" | phase: ${p.currentPhase} | createdAt: ${p.createdAt.toISOString()}`);
  }

  const allRuns = await prisma.workflowRun.findMany({
    orderBy: { startedAt: "asc" },
  });
  console.log("\nALL WORKFLOW RUNS (" + allRuns.length + " total):");
  for (const r of allRuns) {
    const dur = r.completedAt ? (r.completedAt.getTime() - r.startedAt.getTime()) / 1000 : null;
    const u = r.modelUsage || {};
    console.log(`RUN: ${r.id} | proj: ${r.projectId} | phase: ${r.currentPhase} | op: ${r.operation} | status: ${r.status} | dur: ${dur}s | err: ${r.errorCode || "none"} | model: ${u.model || "n/a"} | effort: ${u.reasoningEffort || "n/a"} | inTok: ${u.promptTokens || "n/a"} | outTok: ${u.completionTokens || "n/a"} | cost: $${r.costUSD || 0}`);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
