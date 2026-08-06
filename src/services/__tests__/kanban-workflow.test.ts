import { WorkflowContextService } from "../workflow-context.service";
import { ClarificationHandlerService } from "../clarification-handler.service";

export async function runKanbanWorkflowTests() {
  console.log("[Test] Running Kanban & Workflow Context tests...");
  const workflowContextService = new WorkflowContextService();
  const clarificationHandlerService = new ClarificationHandlerService();

  const prompt = workflowContextService.buildSystemBoundaryPrompt({
    projectId: "test-proj-1",
    requirements: "Must support Google Auth",
    architecture: "PostgreSQL + Next.js App Router",
    implementation: "API endpoints in /api/auth",
  });

  if (!prompt.includes("CRITICAL PROJECT WORKFLOW BOUNDARIES")) {
    throw new Error("Expected prompt to contain CRITICAL PROJECT WORKFLOW BOUNDARIES");
  }
  if (!prompt.includes("Must support Google Auth")) {
    throw new Error("Expected prompt to contain requirements");
  }

  const context = await clarificationHandlerService.getResolvedClarificationContext("non-existent-task");
  if (context !== "") {
    throw new Error("Expected empty string for unresolved task context");
  }

  console.log("  ✓ Kanban & Workflow Context tests passed.");
}

if (require.main === module) {
  runKanbanWorkflowTests().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
  });
}

