import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface ProjectWorkflowContext {
  projectId: string;
  requirements?: string;
  documentation?: string;
  architecture?: string;
  implementation?: string;
  testing?: string;
  review?: string;
}

export class WorkflowContextService {
  /**
   * Fetches all approved (or latest fallback) phase artifacts for a given project ID.
   */
  async getProjectWorkflowContext(projectId: string): Promise<ProjectWorkflowContext> {
    const artifacts = await prisma.phaseArtifact.findMany({
      where: { projectId },
      orderBy: { version: "desc" },
    });

    // Group by phase, preferring approved artifacts over draft versions
    const phaseMap: Record<string, string> = {};

    for (const art of artifacts) {
      if (!phaseMap[art.phase] || art.approved) {
        phaseMap[art.phase] = art.content;
      }
    }

    return {
      projectId,
      requirements: phaseMap["requirements"],
      documentation: phaseMap["documentation"],
      architecture: phaseMap["architecture"],
      implementation: phaseMap["implementation"],
      testing: phaseMap["testing"],
      review: phaseMap["review"],
    };
  }

  /**
   * Constructs a strict, zero-hallucination System Boundary prompt from the project workflow context.
   */
  buildSystemBoundaryPrompt(ctx: ProjectWorkflowContext): string {
    return `
================================================================================
CRITICAL PROJECT WORKFLOW BOUNDARIES (SOURCE OF TRUTH)
================================================================================
You MUST strictly follow the specifications defined in the project workflow subtabs below.
Do NOT invent, assume, or hallucinate features, endpoints, data models, or design choices that contradict or expand beyond these document boundaries.

--------------------------------------------------------------------------------
1. REQUIREMENTS
--------------------------------------------------------------------------------
${ctx.requirements ? ctx.requirements.trim() : "No requirements artifact specified yet."}

--------------------------------------------------------------------------------
2. ARCHITECTURE
--------------------------------------------------------------------------------
${ctx.architecture ? ctx.architecture.trim() : "No architecture artifact specified yet."}

--------------------------------------------------------------------------------
3. IMPLEMENTATION SPECS
--------------------------------------------------------------------------------
${ctx.implementation ? ctx.implementation.trim() : "No implementation specs artifact specified yet."}

--------------------------------------------------------------------------------
4. DOCUMENTATION & RULES
--------------------------------------------------------------------------------
${ctx.documentation ? ctx.documentation.trim() : "No additional documentation specified yet."}

================================================================================
STRICT OUT-OF-SCOPE & AMBIGUITY RULES
================================================================================
1. If the current task requires technical information (such as API contracts, database fields, or UI components) that is NOT included or IS ambiguous in these workflow documents:
   - DO NOT ASSUME OR GUESS.
   - You MUST call the 'trigger_scope_clarification' tool.
   - Clearly state that the information is missing from or out-of-scope of the project workflow documents.
   - Provide 2 to 4 concrete solution options (with pros and cons) for the user to choose.
2. If the task is fully covered by the workflow documents above, proceed with step-by-step code generation adhering strictly to these specifications.
================================================================================
`;
  }
}
