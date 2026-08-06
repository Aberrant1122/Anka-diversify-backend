import { WorkflowContextService } from "../workflow-context.service";
import { ClarificationHandlerService } from "../clarification-handler.service";

describe("Kanban & Workflow Context System", () => {
  const workflowContextService = new WorkflowContextService();
  const clarificationHandlerService = new ClarificationHandlerService();

  test("builds system boundary prompt correctly", () => {
    const prompt = workflowContextService.buildSystemBoundaryPrompt({
      projectId: "test-proj-1",
      requirements: "Must support Google Auth",
      architecture: "PostgreSQL + Next.js App Router",
      implementation: "API endpoints in /api/auth",
    });

    expect(prompt).toContain("CRITICAL PROJECT WORKFLOW BOUNDARIES");
    expect(prompt).toContain("Must support Google Auth");
    expect(prompt).toContain("PostgreSQL + Next.js App Router");
    expect(prompt).toContain("STRICT OUT-OF-SCOPE & AMBIGUITY RULES");
  });

  test("formats resolved clarification context", async () => {
    const context = await clarificationHandlerService.getResolvedClarificationContext("non-existent-task");
    expect(context).toBe("");
  });
});
