import { getOpenAI } from "../shared/utils";
import { AgentFileChange, ExecutionContract, RoadmapStep } from "../shared/types";
import { FileManifest } from "../../types";
import { RoadmapGenerator } from "./RoadmapGenerator";
import { ValidationPlanner } from "../validation/ValidationPlanner";
import {
  IMPLEMENTATION_PLANNER_PROMPT,
  CODING_AGENT_PROMPT,
  LAYER_CONSTRAINT_PROMPT,
} from "../prompts/coding";
import { STANDALONE_HTML_CSS_JS_PROMPT } from "../prompts/standalone";
import { buildContractGuardrailSection } from "../prompts/validation";

/**
 * Builds a deterministic, concise prompt section instructing the LLM to stay strictly within the approved FileManifest.
 */
export function buildApprovedFilePlanSection(manifest?: FileManifest | null): string {
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) {
    return "";
  }

  const fileLines = manifest.files.map((f) => {
    const actionUpper = (f.action || "modify").toUpperCase();
    return `- ${actionUpper}: ${f.path}${f.description ? ` (${f.description})` : ""}`;
  });

  return `
══════════════════════════════════════════════════════════
APPROVED FILE PLAN — MANDATORY EXECUTION SCOPE
══════════════════════════════════════════════════════════
You may produce changes ONLY for the files declared below.

${fileLines.join("\n")}

STRICT EXECUTION REQUIREMENTS:
1. Every generated change path must exactly correspond to an approved manifest file listed above.
2. Every generated change MUST explicitly set "action": "create" | "modify" | "delete" matching the approved action.
3. For deletion operations, set "action": "delete", "isDeleted": true, "content": "", and a clear description.
4. Do NOT create additional helper files, utilities, tests, or configurations unless explicitly declared in the plan above.
5. Do NOT modify package.json, config files, routes, or other files unless explicitly declared above.
6. If the implementation appears to require another file not listed in the plan: DO NOT invent or modify it. Stay strictly within the approved plan.
7. Output every required manifest file that needs changes with 100% complete content.
8. Use exact repository-relative paths as written above.
══════════════════════════════════════════════════════════
`;
}

export class CodeGenerator {
  static buildAgentSystemPrompt(
    projectContext: any,
    snapshot: any,
    architectureDoc?: string | null,
    memorySummary?: string | null,
  ): string {
    const repoInfo = snapshot
      ? `REPOSITORY: ${snapshot.repoName} (branch: ${snapshot.defaultBranch})\nFILE TREE:\n${snapshot.fileTree.slice(0, 200).join("\n")}`
      : "No repository connected yet. You MUST generate complete new application files required for the user's request.";

    const architectureInfo = architectureDoc
      ? `\nAPPROVED ARCHITECTURE:\n${architectureDoc}\n`
      : "";

    const memoryInfo = memorySummary
      ? `\nPROJECT MEMORY:\n${memorySummary}\n`
      : "";

    const languages: Record<string, number> = snapshot?.languages || {};
    const dominantLanguage = Object.entries(languages).sort(([, a], [, b]) => (b as number) - (a as number))[0]?.[0];

    return `You are a coding agent for "${projectContext.project.name}". Produce exact file changes for the user's request.

${repoInfo}
${architectureInfo}${memoryInfo}
ACTIVE TASKS:
${projectContext.activeTasks.map((t: any) => `- ${t.title} (${t.status}, priority: ${t.priority})`).join("\n") || "None"}

CRITICAL CODE QUALITY RULES:
1. Every file you output MUST be COMPLETE and SELF-CONTAINED.
2. Write the ENTIRE file content from line 1 to the end.
3. All code MUST compile without errors.
${dominantLanguage ? `- This project's established language/stack is ${dominantLanguage} — ALL new files MUST use it.` : ""}

Respond ONLY with valid JSON:
{
  "explanation": "what you changed and why",
  "changes": [{ "path": "relative/path", "content": "COMPLETE file content", "description": "one-line summary" }],
  "commitMessage": "feat: description"
}`;
  }

  static async executeChanges(
    message: string,
    approach: string,
    fileContext: Record<string, string>,
    systemPrompt: string,
    previousErrors: string | null,
  ): Promise<
    | { explanation: string; changes: AgentFileChange[]; commitMessage: string }
    | { needsClarification: true; question: string; options?: string[] }
  > {
    const fileContents = Object.entries(fileContext)
      .map(([p, c]) => `=== ${p} ===\n${c}`)
      .join("\n\n");

    const userMessage = previousErrors
      ? `${message}\n\nAPPROACH: ${approach}\n\nRELEVANT FILES:\n${fileContents}\n\nPREVIOUS ATTEMPT ERRORS:\n${previousErrors}`
      : `${message}\n\nAPPROACH: ${approach}\n\nRELEVANT FILES:\n${fileContents}`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.2,
      max_tokens: 8000,
      response_format: { type: "json_object" },
    });

    try {
      return JSON.parse(completion.choices[0]?.message?.content || "{}");
    } catch {
      return { explanation: "Failed to parse response", changes: [], commitMessage: "chore: agent changes" };
    }
  }

  static async generateRoadmapAndDiffs(
    message: string,
    intentResult: any,
    optimizedContext: any,
    systemPrompt: string,
    contract?: ExecutionContract,
    approvedManifest?: FileManifest | null,
  ): Promise<{
    roadmap: RoadmapStep[];
    changes: AgentFileChange[];
    explanation: string;
    commitMessage: string;
    validationCommands: string[];
  }> {
    const isStandaloneWeb = contract?.pipeline === "STANDALONE" || contract?.environment === "HTML_CSS_JS";
    const isDeleteTask = contract?.taskType === "DELETE_FILE" || contract?.taskType === "DELETE_FOLDER";

    let roadmap: RoadmapStep[] = RoadmapGenerator.createDefaultRoadmap(contract, message);

    if (!isDeleteTask && !isStandaloneWeb) {
      try {
        const openai = getOpenAI();
        const roadmapCompletion = await openai.chat.completions.create({
          model: "gpt-4o",
          messages: [
            { role: "system", content: IMPLEMENTATION_PLANNER_PROMPT },
            { role: "user", content: `REQUEST: ${message}\nINTENT: ${intentResult.intent}` },
          ],
          temperature: 0.2,
          response_format: { type: "json_object" },
        });
        const parsedRoadmap = JSON.parse(roadmapCompletion.choices[0]?.message?.content || "{}");
        if (Array.isArray(parsedRoadmap.roadmap) && parsedRoadmap.roadmap.length > 0) {
          roadmap = parsedRoadmap.roadmap;
        }
      } catch {}
    }

    const contextContent = Object.entries(optimizedContext.fileContext)
      .map(([p, c]) => `=== FULL FILE: ${p} ===\n${c}`)
      .concat(
        Object.entries(optimizedContext.skeletonContext).map(
          ([p, c]) => `=== SKELETON DEPENDENCY: ${p} ===\n${c}`,
        ),
      )
      .join("\n\n");

    let multiFileInstruction = "";
    if (isDeleteTask) {
      multiFileInstruction = `\n\nDELETION MANDATE: This request asks to delete target path(s): ${contract?.targetPaths?.join(", ") || "(target files)"}. Output a 'changes' array containing an entry for each path to delete with "action": "delete", "isDeleted": true, "content": "", and "description": "Delete path".`;
    } else if (isStandaloneWeb) {
      multiFileInstruction = "\n\nSTANDALONE MULTI-FILE MANDATE: You MUST output all 3 files in your 'changes' array: 'index.html', 'style.css', and 'script.js'. Output ALL 3 files so the application works standalone.";
    } else {
      const narrowScopeTypes = new Set(["DELETE_FOLDER", "DELETE_FILE", "CONFIG_CHANGE", "DOCS"]);
      const isNarrowScope = contract && narrowScopeTypes.has(contract.taskType);
      const isAppOrDashboardRequest = !isNarrowScope && /dashboard|game|app|landing|page|feature|component|system/i.test(message);
      if (isAppOrDashboardRequest) {
        multiFileInstruction = "\n\nMULTI-FILE ARCHITECTURE MANDATE: Output a complete multi-file blueprint containing ALL necessary files.";
      }
    }

    const manifestSection = buildApprovedFilePlanSection(approvedManifest);
    const contractGuardrail = contract ? buildContractGuardrailSection(contract) : "";
    const effectiveCodingPrompt = isStandaloneWeb
      ? `${STANDALONE_HTML_CSS_JS_PROMPT}${contractGuardrail}${manifestSection}`
      : `${systemPrompt}\n\n${CODING_AGENT_PROMPT}\n\n${LAYER_CONSTRAINT_PROMPT}${contractGuardrail}${manifestSection}`;

    const userPrompt = `USER REQUEST: ${message}\nINTENT: ${intentResult.intent}\nROADMAP PLAN:\n${JSON.stringify(roadmap, null, 2)}\n\nCONTEXT:\n${contextContent || "(Standalone Application - No repository context required)"}${multiFileInstruction}\n\nREMINDER: Respond ONLY with valid JSON. Every file in your "changes" array MUST contain the COMPLETE 100% file content.`;

    const openai = getOpenAI();
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system", content: effectiveCodingPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 16000,
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
    let changes: AgentFileChange[] = Array.isArray(parsed.changes) ? parsed.changes : [];
    const explanation = parsed.explanation || "Agent generated code diffs.";
    const commitMessage = parsed.commitMessage || `feat(${intentResult.intent.toLowerCase()}): implementation updates`;

    if (isDeleteTask && contract?.targetPaths) {
      const existingPathsInChanges = new Set(changes.map((c) => c.path.replace(/\\/g, "/").replace(/\/$/, "")));
      for (const targetPath of contract.targetPaths) {
        if (!existingPathsInChanges.has(targetPath)) {
          changes.push({
            path: targetPath,
            content: "",
            description: `Delete ${targetPath}`,
            action: "delete",
            isDeleted: true,
          });
        }
      }
      for (const change of changes) {
        if (contract.targetPaths.some((tp) => change.path.replace(/\\/g, "/").startsWith(tp) || change.path.replace(/\\/g, "/") === tp)) {
          change.action = "delete";
          change.isDeleted = true;
          change.content = "";
          if (!change.description || change.description.includes("edits")) {
            change.description = `Delete ${change.path}`;
          }
        }
      }
    }

    // If standalone web mode is active, ensure we do not inject hardcoded templates.
    // We strictly rely on AI-generated file changes based on repo analysis and user instructions.

    const validationCommands = ValidationPlanner.detectValidationCommands(null, optimizedContext, contract);

    return {
      roadmap,
      changes,
      explanation,
      commitMessage,
      validationCommands,
    };
  }
}
