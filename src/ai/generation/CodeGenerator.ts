import crypto from "crypto";
import { getOpenAI } from "../shared/utils";
import { AgentFileChange, ExecutionContract, RoadmapStep } from "../shared/types";
import { FileManifest } from "../../types";
import {
  GeneratedChangeProposal,
  resolveGenerationProposals,
  ResolutionResult,
} from "./GenerationProposalResolver";
import { PatchCorrectionEngine, PatchCorrectionTelemetry } from "./PatchCorrectionEngine";
import { RoadmapGenerator } from "./RoadmapGenerator";
import { ValidationPlanner } from "../validation/ValidationPlanner";
import {
  IMPLEMENTATION_PLANNER_PROMPT,
  CODING_AGENT_PROMPT,
  LAYER_CONSTRAINT_PROMPT,
} from "../prompts/coding";
import { STANDALONE_HTML_CSS_JS_PROMPT } from "../prompts/standalone";
import { buildContractGuardrailSection } from "../prompts/validation";
import { SecurityPolicy } from "../security/SecurityPolicy";
import { ImportValidator } from "../validation/ImportValidator";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";
import {
  detectRepositoryArchitecture,
  isUITask,
  isFullPageDashboardRequest,
  buildRepositoryUISystemPromptSection,
} from "../planning/RepositoryArchitectureDetector";

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
7. Use exact repository-relative paths as written above.

═══════════════════════════════════════════
ACTION-SPECIFIC OUTPUT FORMAT
═══════════════════════════════════════════

For CREATE actions — output COMPLETE new file content:
{ "path": "...", "action": "create", "content": "100% complete new file", "description": "..." }

For DELETE actions — output deletion marker:
{ "path": "...", "action": "delete", "isDeleted": true, "content": "", "description": "..." }

For MODIFY actions — output ONLY targeted search/replace edits:
{ "path": "...", "action": "modify", "description": "...", "edits": [ { "oldText": "exact existing source text copied verbatim", "newText": "replacement source text" } ] }

STRICT MODIFY RULES:
1. Do NOT output complete file content for modify. Use edits[] only.
2. Each oldText must be copied EXACTLY from the provided full file context / FULL AUTHORITATIVE CONTENT block. Exact byte match required.
3. Do NOT paraphrase, reformat, change quotes, or alter whitespace when selecting oldText.
4. Select the smallest unique, structurally meaningful block (e.g. specific JSX element, function, or import statement) needed for the edit.
5. oldText must contain enough surrounding source context to identify exactly one location in the file (no ambiguous duplicates).
6. Do NOT use line numbers.
7. Do NOT use unified diff syntax.
8. Do NOT use ellipses, placeholders, or comments like "...", "// existing code", or "unchanged code here" inside oldText or newText.
9. Multiple independent changes to one file must be separate edits[] entries.
10. Do NOT include unrelated formatting or refactoring changes.
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
    authoritativeModifySources?: Record<string, { path: string; content: string; sha256: string }>,
    mergedSourceMap?: Record<string, string>,
  ): Promise<{
    roadmap: RoadmapStep[];
    changes: AgentFileChange[];
    explanation: string;
    commitMessage: string;
    validationCommands: string[];
    expectedSourceHashes?: Record<string, string>;
  }> {
    const isStandaloneWeb = contract?.pipeline === "STANDALONE" || contract?.environment === "HTML_CSS_JS";
    const isDeleteTask = contract?.taskType === "DELETE_FILE" || contract?.taskType === "DELETE_FOLDER";

    const manifestFileMap = new Map<
      string,
      { path: string; action: "create" | "modify" | "delete"; description?: string }
    >();
    if (approvedManifest && Array.isArray(approvedManifest.files)) {
      for (const f of approvedManifest.files) {
        if (f && f.path) {
          manifestFileMap.set(normalizeRepoPath(f.path), {
            path: f.path,
            action: f.action || "modify",
            description: f.description,
          });
        }
      }
    }

    const manifestDeleteFiles = approvedManifest && Array.isArray(approvedManifest.files)
      ? approvedManifest.files.filter((f) => f.action === "delete").map((f) => f.path)
      : [];
    const manifestHasCreateOrModify = approvedManifest && Array.isArray(approvedManifest.files)
      ? approvedManifest.files.some((f) => f.action === "create" || f.action === "modify")
      : false;

    let roadmap: RoadmapStep[] = RoadmapGenerator.createDefaultRoadmap(contract, message);

    if ((!isDeleteTask || manifestHasCreateOrModify) && !isStandaloneWeb) {
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

    const modifySourceBlocks = Object.entries(authoritativeModifySources || {}).map(([p, s]) => {
      return `═══════════════════════════════════════════════════\nAUTHORIZED MODIFY SOURCE\nFILE: ${p}\nSHA256: ${s.sha256}\nFULL AUTHORITATIVE CONTENT:\n═══════════════════════════════════════════════════\n${s.content}`;
    });

    const supportingBlocks = Object.entries(optimizedContext?.fileContext || {})
      .filter(([p]) => !authoritativeModifySources || !authoritativeModifySources[p])
      .map(([p, c]) => {
        const fileSha = crypto.createHash("sha256").update(String(c)).digest("hex");
        return `═══════════════════════════════════════════════════\nSUPPORTING REPOSITORY CONTEXT\nFILE: ${p}\nSHA256: ${fileSha}\nFULL CONTENT:\n═══════════════════════════════════════════════════\n${c}`;
      });

    const skeletonBlocks = Object.entries(optimizedContext?.skeletonContext || {}).map(
      ([p, c]) => `=== SKELETON DEPENDENCY: ${p} ===\n${c}`
    );

    const contextContent = [...modifySourceBlocks, ...supportingBlocks, ...skeletonBlocks].join("\n\n");

    let multiFileInstruction = "";
    if (approvedManifest && Array.isArray(approvedManifest.files) && manifestDeleteFiles.length > 0) {
      multiFileInstruction = `\n\nDELETION MANDATE: This request asks to delete specific approved file(s): ${manifestDeleteFiles.join(", ")}. Output a 'changes' array containing an entry for each path to delete with "action": "delete", "isDeleted": true, "content": "", and "description": "Delete path".`;
    } else if (!approvedManifest && isDeleteTask) {
      multiFileInstruction = `\n\nDELETION MANDATE: This request asks to delete target path(s): ${contract?.targetPaths?.join(", ") || "(target files)"}. Output a 'changes' array containing an entry for each path to delete with "action": "delete", "isDeleted": true, "content": "", and "description": "Delete path".`;
    } else if (isStandaloneWeb) {
      multiFileInstruction = "\n\nSTANDALONE MULTI-FILE MANDATE: You MUST output all 3 files in your 'changes' array: 'index.html', 'style.css', and 'script.js'. Output ALL 3 files so the application works standalone.";
    } else {
      const narrowScopeTypes = new Set(["DELETE_FOLDER", "DELETE_FILE", "CONFIG_CHANGE", "DOCS"]);
      const isNarrowScope = contract && narrowScopeTypes.has(contract.taskType);
      const isAppOrDashboardRequest = (!isNarrowScope || manifestHasCreateOrModify) && /dashboard|game|app|landing|page|feature|component|system/i.test(message);
      if (isAppOrDashboardRequest) {
        multiFileInstruction = "\n\nMULTI-FILE ARCHITECTURE MANDATE: Output a complete multi-file blueprint containing ALL necessary files.";
      }
    }

    const effectiveResolutionSourceMap: Record<string, string> =
      mergedSourceMap ||
      (authoritativeModifySources
        ? Object.fromEntries(Object.entries(authoritativeModifySources).map(([p, s]) => [p, s.content]))
        : null) ||
      optimizedContext?.fileContext ||
      {};

    const isAppRouter =
      Object.keys(effectiveResolutionSourceMap).some((p) => p.startsWith("app/") || p.includes("/app/")) ||
      Boolean(approvedManifest?.files && approvedManifest.files.some((f) => f.path.startsWith("app/") || f.path.includes("/app/")));

    let installedPackages: string[] = [];
    let hasTailwind = false;
    const pkgJsonRaw =
      effectiveResolutionSourceMap["package.json"] ||
      Object.entries(effectiveResolutionSourceMap).find(([p]) => p.endsWith("package.json"))?.[1];

    const arch = detectRepositoryArchitecture(Object.keys(effectiveResolutionSourceMap), pkgJsonRaw);
    installedPackages = arch.installedPackages;
    hasTailwind = arch.hasTailwind;

    const isUI = isUITask(message);
    const isFullDashboard = isFullPageDashboardRequest(message);
    const isSmallComp = !isFullDashboard && /(small|badge|button|tag|pill|icon|fix|minor|single)/i.test(message);

    const uiSystemSection = isUI
      ? `\n\n${buildRepositoryUISystemPromptSection(arch, {
          isDashboard: isFullDashboard,
          isSmallComponent: isSmallComp,
        })}`
      : "";

    const stylingSection = !hasTailwind && !isStandaloneWeb
      ? `\n\n══════════════════════════════════════════════════════════
CSS & STYLING ARCHITECTURE RULES
══════════════════════════════════════════════════════════
1. Tailwind CSS is NOT installed in this repository.
2. Do NOT write Tailwind utility classes as raw CSS selectors (e.g. NEVER write '.dark:bg-gray-900', '.text-sm', or '.flex' inside .css files).
3. In stylesheets (.css / .module.css / global.css), use standard, valid CSS class names (e.g. .calculator-container, .display-screen, .action-btn).
4. For dark mode, use valid CSS selectors like '.dark .calculator-container' or '@media (prefers-color-scheme: dark)'.
══════════════════════════════════════════════════════════`
      : "";

    const packagesSection = installedPackages.length > 0
      ? `\n\n══════════════════════════════════════════════════════════
AVAILABLE EXTERNAL PACKAGES (from repository package.json)
══════════════════════════════════════════════════════════
${installedPackages.map((p) => `• ${p}`).join("\n")}

CRITICAL IMPORT MANDATE:
You MUST NOT import external npm packages outside this verified list.
Standard Node.js built-in modules (path, fs, crypto, etc.) are allowed.
Prefer native JS/framework functionality rather than inventing a dependency.
══════════════════════════════════════════════════════════`
      : "";

    const appRouterSection = isAppRouter
      ? `\n\n══════════════════════════════════════════════════════════
NEXT.JS APP ROUTER & CLIENT COMPONENT RULES
══════════════════════════════════════════════════════════
1. This project uses Next.js App Router (app/*).
2. CLIENT COMPONENTS: Any component file (.tsx/.jsx) that uses React interactive hooks (useState, useEffect, useReducer, useRef interactively), browser event handlers (onClick, onChange, onSubmit), or browser APIs (window, document, localStorage) MUST start with:
"use client";
at line 1 before any imports.
3. SERVER COMPONENTS: Components that do not use client hooks or events should remain Server Components (do NOT add "use client" unnecessarily).
4. SECURITY: Never evaluate raw user input with eval(), new Function(), or dynamic execution APIs.
══════════════════════════════════════════════════════════`
      : "";

    const manifestSection = buildApprovedFilePlanSection(approvedManifest);
    const contractGuardrail = contract ? buildContractGuardrailSection(contract) : "";
    const effectiveCodingPrompt = isStandaloneWeb
      ? `${STANDALONE_HTML_CSS_JS_PROMPT}${contractGuardrail}${manifestSection}`
      : `${systemPrompt}\n\n${CODING_AGENT_PROMPT}\n\n${LAYER_CONSTRAINT_PROMPT}${packagesSection}${stylingSection}${appRouterSection}${uiSystemSection}${contractGuardrail}${manifestSection}`;

    const hasManifest = approvedManifest && Array.isArray(approvedManifest.files) && approvedManifest.files.length > 0;
    const jsonFormatReminder = hasManifest
      ? `\n\nREMINDER: Respond ONLY with valid JSON. For CREATE actions, output complete file content. For MODIFY actions, output targeted edits[] with exact oldText/newText pairs. For DELETE actions, output deletion markers. See STRICT MODIFY RULES above.`
      : `\n\nREMINDER: Respond ONLY with valid JSON. Every file in your "changes" array MUST contain the COMPLETE 100% file content.`;

    const userPrompt = `USER REQUEST: ${message}\nINTENT: ${intentResult.intent}\nROADMAP PLAN:\n${JSON.stringify(roadmap, null, 2)}\n\nCONTEXT:\n${contextContent || "(Standalone Application - No repository context required)"}${multiFileInstruction}${jsonFormatReminder}`;

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
    const rawChanges: any[] = Array.isArray(parsed.changes) ? parsed.changes : [];
    const explanation = parsed.explanation || "Agent generated code diffs.";
    const commitMessage =
      parsed.commitMessage ||
      `feat(${(intentResult?.intent || "build").toLowerCase()}): implementation updates`;

    // ── Resolve raw LLM proposals into AgentFileChange[] ──
    const hasManifestContext = approvedManifest && Array.isArray(approvedManifest.files) && approvedManifest.files.length > 0;
    const shouldUseStructuredResolution = hasManifestContext && !isStandaloneWeb && (manifestHasCreateOrModify || !isDeleteTask);

    let changes: AgentFileChange[];
    let expectedSourceHashes: Record<string, string> | undefined;

    if (shouldUseStructuredResolution) {
      // Structured patch path: parse as GeneratedChangeProposal[]
      const initialProposals: GeneratedChangeProposal[] = rawChanges.map((raw: any) => {
        const action = (raw.action || "modify").toLowerCase();
        if (action === "create") {
          return {
            path: raw.path,
            action: "create" as const,
            content: raw.content || "",
            description: raw.description || "",
          };
        } else if (action === "delete") {
          return {
            path: raw.path,
            action: "delete" as const,
            content: "" as const,
            description: raw.description || "",
            isDeleted: true as const,
          };
        } else {
          // modify
          return {
            path: raw.path,
            action: "modify" as const,
            edits: Array.isArray(raw.edits) ? raw.edits : [],
            description: raw.description || "",
          };
        }
      });

      // ─── Deterministic No-Op Patch Edit Normalization ───────────────────
      const primaryTargetPaths = new Set(
        (contract?.expectedFiles && contract.expectedFiles.length > 0
          ? contract.expectedFiles
          : contract?.targetPaths || []
        )
          .filter((p) => p && !p.includes("project-wide") && !p.includes("*"))
          .map((p) => p.replace(/\\/g, "/").replace(/^\.\//, ""))
      );

      const primaryAuthoritativeFile = intentResult?.targetPath
        ? intentResult.targetPath.replace(/\\/g, "/").replace(/^\.\//, "")
        : Array.from(primaryTargetPaths)[0];

      const normalizedProposals: GeneratedChangeProposal[] = [];

      for (const proposal of initialProposals) {
        if (proposal.action !== "modify") {
          normalizedProposals.push(proposal);
          continue;
        }

        const rawEdits = Array.isArray(proposal.edits) ? proposal.edits : [];
        const effectiveEdits = rawEdits.filter((edit: any) => {
          if (!edit || typeof edit !== "object") return false;
          const isIdentical =
            typeof edit.oldText === "string" &&
            typeof edit.newText === "string" &&
            edit.oldText === edit.newText;
          return !isIdentical;
        });

        const normProposalPath = proposal.path.replace(/\\/g, "/").replace(/^\.\//, "");
        const isAuthoritativeTarget =
          normProposalPath === primaryAuthoritativeFile ||
          (primaryTargetPaths.size === 1 && primaryTargetPaths.has(normProposalPath));

        if (rawEdits.length > 0 && effectiveEdits.length === 0) {
          if (!isAuthoritativeTarget && initialProposals.length > 1) {
            console.log(
              `[CodeGenerator] Supporting target "${proposal.path}" contained only no-op edit(s) and required no modification. Pruned from effective changes.`
            );
            continue;
          } else {
            console.warn(
              `[CodeGenerator] Authoritative target "${proposal.path}" generated only no-op edit(s). Retaining proposal for bounded patch correction.`
            );
            normalizedProposals.push(proposal);
          }
        } else {
          if (rawEdits.length > effectiveEdits.length) {
            console.log(
              `[CodeGenerator] Pruned ${rawEdits.length - effectiveEdits.length} no-op edit(s) from "${proposal.path}". Retained ${effectiveEdits.length} effective edit(s).`
            );
          }
          normalizedProposals.push({
            ...proposal,
            edits: effectiveEdits,
          });
        }
      }

      if (normalizedProposals.length === 0) {
        throw new Error(
          `[PATCH_RESOLUTION_FAILED] NO_EFFECTIVE_CHANGE: All generated file modifications were no-op edits. A modify task must produce at least one effective change.`
        );
      }

      const proposals = normalizedProposals;

      let resolution: ResolutionResult = resolveGenerationProposals(
        proposals,
        effectiveResolutionSourceMap,
      );

      const patchTelemetry: PatchCorrectionTelemetry = {
        patchCorrectionAttempted: false,
        patchCorrectionSucceeded: false,
        patchCorrectionAttempts: 0,
      };

      if (!resolution.success) {
        const err = resolution.error;
        const isEligibleForCorrection =
          (err.code === "PATCH_TARGET_NOT_FOUND" ||
            err.code === "AMBIGUOUS_PATCH_TARGET" ||
            err.code === "NO_OP_PATCH_EDIT" ||
            err.code === "MODIFY_PATCH_REQUIRED") &&
          typeof err.proposalIndex === "number" &&
          proposals[err.proposalIndex]?.action === "modify";

        if (isEligibleForCorrection) {
          const failedProposal = proposals[err.proposalIndex] as {
            path: string;
            action: "modify";
            edits: any[];
            description: string;
          };

          const originalContent = effectiveResolutionSourceMap[failedProposal.path.replace(/\\/g, "/")];

          if (originalContent !== undefined) {
            patchTelemetry.patchCorrectionAttempted = true;
            patchTelemetry.patchCorrectionAttempts = 1;
            patchTelemetry.failedFilePath = failedProposal.path;
            patchTelemetry.errorCode = err.code;

            console.log(
              `[CodeGenerator] Patch resolution failed with [${err.code}] on "${failedProposal.path}". Triggering bounded exact patch correction (Attempt 1/1)...`
            );

            const correction = await PatchCorrectionEngine.correctPatch({
              filePath: failedProposal.path,
              currentContent: originalContent,
              userMessage: message,
              manifestAction: "modify",
              failedEdits: failedProposal.edits,
              errorCode: err.code as "PATCH_TARGET_NOT_FOUND" | "AMBIGUOUS_PATCH_TARGET" | "NO_OP_PATCH_EDIT" | "MODIFY_PATCH_REQUIRED",
              errorMessage: err.message,
            });

            if (correction.succeeded && correction.correctedEdits && correction.correctedEdits.length > 0) {
              patchTelemetry.patchCorrectionSucceeded = true;
              console.log(
                `[CodeGenerator] Bounded exact patch correction succeeded for "${failedProposal.path}" with ${correction.correctedEdits.length} edit(s). Re-verifying exact resolution...`
              );

              const correctedProposals = proposals.map((p, idx) => {
                if (idx === err.proposalIndex) {
                  return {
                    ...p,
                    edits: correction.correctedEdits!,
                  };
                }
                return p;
              });

              resolution = resolveGenerationProposals(
                correctedProposals,
                effectiveResolutionSourceMap,
              );
            } else {
              console.warn(
                `[CodeGenerator] Bounded exact patch correction failed for "${failedProposal.path}": ${correction.error || "Unknown error"}`
              );
            }
          }
        }

        if (!resolution.success) {
          throw new Error(
            `[PATCH_RESOLUTION_FAILED] ${resolution.error.code}: ${resolution.error.message}${
              patchTelemetry.patchCorrectionAttempted
                ? ` (Bounded correction attempt 1/1 failed)`
                : ""
            }`,
          );
        }
      }

      changes = resolution.changes;
      expectedSourceHashes = resolution.expectedSourceHashes;
    } else {
      // Legacy path: standalone/delete/no-manifest — full-content changes
      changes = rawChanges as AgentFileChange[];
    }

    if (approvedManifest && Array.isArray(approvedManifest.files)) {
      const existingPathsInChanges = new Set(changes.map((c) => normalizeRepoPath(c.path)));
      for (const mf of approvedManifest.files) {
        const norm = normalizeRepoPath(mf.path);
        if (mf.action === "delete" && !existingPathsInChanges.has(norm)) {
          changes.push({
            path: mf.path,
            content: "",
            description: mf.description || `Delete ${mf.path}`,
            action: "delete",
            isDeleted: true,
          });
        }
      }
      for (const change of changes) {
        const decl = manifestFileMap.get(normalizeRepoPath(change.path));
        if (decl && decl.action === "delete" && change.action === "delete") {
          change.isDeleted = true;
          change.content = "";
          if (!change.description || change.description.includes("edits")) {
            change.description = `Delete ${change.path}`;
          }
        }
      }
    } else if (isDeleteTask && contract?.targetPaths) {
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

    // ── Deterministic Precheck 1: Dynamic Execution Security Precheck (SecurityPolicy) ──
    const baselineMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(optimizedContext.fileContext)) {
      if (typeof v === "string") baselineMap[k] = v;
    }

    const secCheck = SecurityPolicy.checkChanges(changes, baselineMap);
    if (!secCheck.safe) {
      for (const violation of secCheck.violations) {
        const change = changes.find((c) => c.path === violation.path);
        if (!change) continue;

        console.warn(`[CodeGenerator] Detected unsafe dynamic execution in "${change.path}". Triggering bounded secure correction...`);

        try {
          const secCorrection = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [
              {
                role: "system",
                content: `You are a Secure Code Repair Assistant. The proposed code introduces unsafe dynamic code execution (${violation.message}) which is strictly forbidden. Rewrite the code using explicit allowlisted operators (+, -, *, /, %, sqrt, power, sin, cos, tan, log, ln, pi, e) or a safe deterministic parser without eval, new Function, or mathjs.evaluate. Respond ONLY with valid JSON: { "content": "..." }`,
              },
              {
                role: "user",
                content: `FILE: ${change.path}\nPROPOSED CODE:\n${change.content}\nORIGINAL REQUEST: ${message}`,
              },
            ],
            temperature: 0.0,
            response_format: { type: "json_object" },
          });

          const parsedSec = JSON.parse(secCorrection.choices[0]?.message?.content || "{}");
          if (typeof parsedSec.content === "string" && parsedSec.content.length > 0) {
            const recheck = SecurityPolicy.checkCode(parsedSec.content, change.path);
            if (recheck.safe) {
              change.content = parsedSec.content;
            } else {
              throw new Error(`[UNSAFE_DYNAMIC_CODE_EXECUTION] Generated code in "${change.path}" violated security policy: ${recheck.violations.map((v) => v.message).join("; ")}`);
            }
          } else {
            throw new Error(`[UNSAFE_DYNAMIC_CODE_EXECUTION] Generated code in "${change.path}" violated security policy: ${violation.message}`);
          }
        } catch (secErr: any) {
          throw new Error(secErr.message || `[UNSAFE_DYNAMIC_CODE_EXECUTION] Generated code in "${change.path}" violated security policy.`);
        }
      }
    }

    // ── Deterministic Precheck 2: Next.js Client Component Directive Precheck ──
    if (isAppRouter) {
      for (const change of changes) {
        if (change.action === "delete" || change.isDeleted) continue;
        if (!/\.(tsx|jsx|ts|js)$/.test(change.path)) continue;

        const usesClientHooks =
          /\buse(State|Effect|Reducer|LayoutEffect|ImperativeHandle|SyncExternalStore)\s*(<|\()/.test(change.content) ||
          /\bfrom\s*["']react["']\b.*useState/.test(change.content);

        const hasClientDirective = /^(?:\s*\/\/[^\n]*\n|\s*\/\*[\s\S]*?\*\/\s*)*['"]use client['"]/m.test(change.content);

        if (usesClientHooks && !hasClientDirective) {
          console.log(`[CodeGenerator] Auto-adding "use client" directive to "${change.path}" (uses client React hooks in App Router).`);
          change.content = `"use client";\n\n` + change.content;
        }
      }
    }

    // ── Deterministic Precheck 3: Undeclared External Dependency Precheck (ImportValidator) ──
    if (installedPackages.length > 0) {
      const importCheck = ImportValidator.validateChangesImports(changes, installedPackages);
      if (!importCheck.valid) {
        for (const violation of importCheck.errors) {
          const change = changes.find((c) => c.path === violation.path);
          if (!change) continue;

          console.warn(`[CodeGenerator] Detected undeclared external dependency in "${change.path}". Triggering bounded dependency correction...`);

          try {
            const depCorrection = await openai.chat.completions.create({
              model: "gpt-4o",
              messages: [
                {
                  role: "system",
                  content: `You are a Dependency-Safe Code Repair Assistant. The proposed code imported uninstalled external package "${violation.packageRoot}". You are STRICTLY FORBIDDEN from importing packages outside the verified installed packages: [${installedPackages.join(", ")}]. Standard Node.js built-in modules are allowed. Rewrite the code using ONLY available packages or native JavaScript/TypeScript standard APIs. Respond ONLY with valid JSON: { "content": "..." }`,
                },
                {
                  role: "user",
                  content: `FILE: ${change.path}\nPROPOSED CODE:\n${change.content}\nORIGINAL REQUEST: ${message}`,
                },
              ],
              temperature: 0.0,
              response_format: { type: "json_object" },
            });

            const parsedDep = JSON.parse(depCorrection.choices[0]?.message?.content || "{}");
            if (typeof parsedDep.content === "string" && parsedDep.content.length > 0) {
              const recheck = ImportValidator.validateCodeImports(parsedDep.content, change.path, installedPackages);
              if (recheck.valid) {
                change.content = parsedDep.content;
              } else {
                throw new Error(`[UNDECLARED_EXTERNAL_DEPENDENCY] Generated code in "${change.path}" imported uninstalled package: ${recheck.errors.map((e) => e.message).join("; ")}`);
              }
            } else {
              throw new Error(`[UNDECLARED_EXTERNAL_DEPENDENCY] Generated code in "${change.path}" imported uninstalled package: ${violation.message}`);
            }
          } catch (depErr: any) {
            throw new Error(depErr.message || `[UNDECLARED_EXTERNAL_DEPENDENCY] Generated code in "${change.path}" imported uninstalled package "${violation.packageRoot}".`);
          }
        }
      }
    }

    const validationCommands = ValidationPlanner.detectValidationCommands(null, optimizedContext, contract);

    return {
      roadmap,
      changes,
      explanation,
      commitMessage,
      validationCommands,
      expectedSourceHashes,
    };
  }
}
