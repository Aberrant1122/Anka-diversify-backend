import { PrismaClient } from "@prisma/client";
import { buildInitialDocumentationMessages, DOCUMENTATION_PROVIDER_JSON_SCHEMA } from "../src/ai/prompts/documentation";
import { PlanningDocumentationContextBuilder } from "../src/planning/documentation-context";
import { estimateMessageTokens, estimateRequestPayloadTokens } from "../src/ai/context/ContextManager";
import { ModelRouter } from "../src/ai/gateway/ModelRouter";
import { PipelineStages } from "../src/ai/gateway/PipelineStage";

async function main() {
  const prisma = new PrismaClient();
  const router = new ModelRouter();
  const route = router.route(PipelineStages.DOCUMENTATION_GENERATION);

  const contextBuilder = new PlanningDocumentationContextBuilder();
  const builtContext = await prisma.$transaction(async (tx) => {
    return contextBuilder.buildInTransaction(tx, {
      projectId: "cmv4t9qjm0001hyliciu6ghqj",
      actorId: "cmpvksesy0000gfe7s6ic8n78",
      includeMemory: false,
    });
  });

  const messages = buildInitialDocumentationMessages(builtContext.payload);
  const msgTokens = messages.map(m => estimateMessageTokens(m));
  const totalMsgTokens = msgTokens.reduce((a, b) => a + b, 0);

  const schemaTokens = estimateRequestPayloadTokens(DOCUMENTATION_PROVIDER_JSON_SCHEMA);

  console.log("route policy:", {
    tier: route.tier,
    contextWindowTokens: route.contextWindowTokens,
    maxInputTokens: route.maxInputTokens,
    defaultMaxOutputTokens: route.defaultMaxOutputTokens,
    maxOutputTokens: route.maxOutputTokens,
  });
  console.log("messages tokens:", totalMsgTokens, msgTokens);
  console.log("schema tokens:", schemaTokens);
  console.log("Sum:", totalMsgTokens + schemaTokens + 16 + 512);

  await prisma.$disconnect();
}

main().catch(console.error);
