const crypto = require("crypto");
const { PrismaClient } = require("@prisma/client");
const { validateSafeTestDatabase, assertSafeSchema } = require("./run-cp0-acceptance");
const { spawnSync } = require("child_process");

async function main() {
  const baseUrl = validateSafeTestDatabase(process.env.CP0_TEST_DATABASE_URL);
  const schemaName = `planning_checkpoint_cp2_real_provider_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
  assertSafeSchema(schemaName);
  const isolatedUrl = new URL(baseUrl.href);
  isolatedUrl.searchParams.set("schema", schemaName);

  console.log(`[Real Provider Test] Isolated schema: ${schemaName}`);
  const rootPrisma = new PrismaClient({ datasources: { db: { url: baseUrl.href } } });

  try {
    const migration = spawnSync("npx prisma migrate deploy", {
      shell: true,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: isolatedUrl.href },
    });
    if (migration.status !== 0) {
      throw new Error(migration.stderr || migration.stdout || "Migration failed");
    }

    process.env.DATABASE_URL = isolatedUrl.href;
    const { LiveBriefService } = require("../dist/services/live-brief.service");
    const prisma = new PrismaClient({ datasources: { db: { url: isolatedUrl.href } } });

    try {
      const userId = `user-real-${crypto.randomUUID()}`;
      const projectId = `proj-real-${crypto.randomUUID()}`;

      await prisma.user.create({
        data: { id: userId, email: `${userId}@test.local`, name: "Real Provider User", password: "pwd" },
      });
      await prisma.project.create({
        data: { id: projectId, name: "Edge Deployment Manager", description: "Edge cluster rollout tool", userId },
      });

      // Instantiate LiveBriefService with real LLMGateway
      const service = new LiveBriefService(prisma);
      await service.initialize(projectId, userId);

      console.log("[Real Provider Test] Calling LiveBriefService.converse with real LLMGateway (OpenAI)...");
      const startTime = Date.now();
      const intakeResult = await service.converse({
        projectId,
        actorId: userId,
        message: "We need an edge deployment manager for distributed Kubernetes clusters. Core goal: achieve sub-5s rollback on faulty canary deployments.",
        requestKey: "real-test-req-1",
      });
      const latencyMs = Date.now() - startTime;
      console.log(`[Real Provider Test] OpenAI call succeeded in ${latencyMs}ms!`);

      // Verify response structure
      if (!intakeResult.message || typeof intakeResult.message !== "string") {
        throw new Error("Missing or invalid intake response message");
      }
      console.log(`[Real Provider Test] Assistant message: "${intakeResult.message.slice(0, 100)}..."`);
      console.log(`[Real Provider Test] Proposed claims returned: ${intakeResult.proposedClaims.length}`);
      console.log(`[Real Provider Test] Questions returned: ${intakeResult.questions.length}`);

      // Verify claims in database
      const dbClaims = await prisma.projectClaim.findMany({ where: { projectId } });
      console.log(`[Real Provider Test] Persisted DB claims: ${dbClaims.length}`);
      for (const claim of dbClaims) {
        if (claim.status !== "PROPOSED") {
          throw new Error(`Claim ${claim.id} expected PROPOSED, got ${claim.status}`);
        }
      }
      console.log("[Real Provider Test] VERIFIED: All claims saved as PROPOSED (model output cannot self-accept).");

      // Verify idempotency
      console.log("[Real Provider Test] Verifying idempotency with same requestKey...");
      const cachedResult = await service.converse({
        projectId,
        actorId: userId,
        message: "Different message but same request key",
        requestKey: "real-test-req-1",
      });
      if (cachedResult.message !== intakeResult.message) {
        throw new Error("Idempotency replay did not match original cached response");
      }
      console.log("[Real Provider Test] VERIFIED: Idempotency replay returned cached response without re-invoking model.");

      console.log("\n=== REAL PROVIDER INTEGRATION TEST: VERIFIED PASS ===");
    } finally {
      await prisma.$disconnect();
    }
  } finally {
    try {
      await rootPrisma.$executeRawUnsafe(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
      console.log(`[Real Provider Test] Dropped schema: ${schemaName}`);
    } finally {
      await rootPrisma.$disconnect();
    }
  }
}

main().catch((err) => {
  console.error("[Real Provider Test] FAILED:", err);
  process.exitCode = 1;
});
