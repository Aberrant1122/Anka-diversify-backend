import crypto from "crypto";
import { AgentFileChange, ExecutionContract, RoadmapStep } from "../shared/types";
import { FileManifest } from "../../types";
import {
  GeneratedChangeProposal,
  resolveGenerationProposals,
  validateGenerationProposals,
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
import { ComponentContractGrounder } from "../contracts/ComponentContractGrounder";
import {
  detectRepositoryArchitecture,
  buildRepositoryUISystemPromptSection,
} from "../planning/RepositoryArchitectureDetector";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { sha256 } from "../validation/FileVersionGuard";

type ModelChangeAction = "create" | "modify" | "delete";

interface ModelPatchEdit {
  oldText: string;
  newText: string;
}

interface ModelGeneratedChange {
  path: string;
  action?: ModelChangeAction;
  content?: string;
  description: string;
  edits?: ModelPatchEdit[];
  isDeleted?: boolean;
  layer?: "Controller" | "Service" | "Repository" | "Schema" | "UI";
  repositoryId?: string;
}

interface CodeGenerationPayload {
  explanation: string;
  changes: ModelGeneratedChange[];
  commitMessage: string;
}

interface ClarificationPayload {
  needsClarification: true;
  question: string;
  options?: string[];
}

interface ExecuteGenerationPayload {
  explanation: string;
  changes: AgentFileChange[];
  commitMessage: string;
}

type ExecuteChangesPayload = ExecuteGenerationPayload | ClarificationPayload;

interface ContentRepairPayload {
  content: string;
}

function bindWholeFilePrimitive(change: AgentFileChange): void {
  if (change.action === "create") {
    change.editPrimitive = {
      type: "CREATE_FILE",
      path: change.path,
      content: change.content,
      description: change.description,
    };
    return;
  }
  if (change.action === "modify" || change.action === undefined) {
    change.action = "modify";
    change.editPrimitive = {
      type: "REPLACE_FILE",
      path: change.path,
      content: change.content,
      description: change.description,
      expectedSourceFingerprint: change.editPrimitive?.expectedSourceFingerprint,
    };
  }
}

const MODEL_CHANGE_PROPERTIES = {
  path: { type: "string", minLength: 1 },
  action: { type: "string", enum: ["create", "modify", "delete"] },
  content: { type: "string" },
  description: { type: "string", minLength: 1 },
  edits: {
    type: "array",
    minItems: 1,
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        oldText: { type: "string", minLength: 1 },
        newText: { type: "string" },
      },
      required: ["oldText", "newText"],
    },
  },
  isDeleted: { type: "boolean" },
  layer: { type: "string", enum: ["Controller", "Service", "Repository", "Schema", "UI"] },
  repositoryId: { type: "string", minLength: 1 },
} as const;

function isPlainObject(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unexpectedKeys(value: Record<string, any>, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return Object.keys(value).filter((key) => !allowedSet.has(key));
}

function isSafeRepositoryRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.includes("\0")) {
    return false;
  }
  const normalized = value.replace(/\\/g, "/");
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return false;
  return !normalized.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0);
}

function validateModelGeneratedChange(change: unknown, requireExplicitAction: boolean): string[] {
  if (!isPlainObject(change)) return ["change must be an object"];

  const errors: string[] = [];
  const extraKeys = unexpectedKeys(change, [
    "path", "action", "content", "description", "edits", "isDeleted", "layer", "repositoryId",
  ]);
  if (extraKeys.length > 0) errors.push(`unexpected fields: ${extraKeys.join(", ")}`);
  if (!isSafeRepositoryRelativePath(change.path)) errors.push("path must be a safe repository-relative path");
  if (typeof change.description !== "string" || change.description.length === 0) {
    errors.push("description must be a non-empty string");
  }
  if (change.repositoryId !== undefined && (typeof change.repositoryId !== "string" || change.repositoryId.length === 0)) {
    errors.push("repositoryId must be a non-empty string when supplied");
  }
  if (
    change.layer !== undefined &&
    !["Controller", "Service", "Repository", "Schema", "UI"].includes(change.layer)
  ) {
    errors.push("layer is invalid");
  }

  const action = change.action;
  if (requireExplicitAction && !["create", "modify", "delete"].includes(action)) {
    errors.push("action must be explicitly create, modify, or delete");
    return errors;
  }
  if (action !== undefined && !["create", "modify", "delete"].includes(action)) {
    errors.push("action is invalid");
    return errors;
  }

  if (action === "modify") {
    if (!Array.isArray(change.edits) || change.edits.length === 0) {
      errors.push("modify requires a non-empty edits array");
    } else {
      change.edits.forEach((edit: unknown, index: number) => {
        if (
          !isPlainObject(edit) ||
          unexpectedKeys(edit, ["oldText", "newText"]).length > 0 ||
          typeof edit.oldText !== "string" ||
          edit.oldText.length === 0 ||
          typeof edit.newText !== "string" ||
          edit.oldText === edit.newText
        ) {
          errors.push(`edit ${index} must contain distinct string oldText and newText values`);
        }
      });
    }
    if (change.content !== undefined || change.isDeleted !== undefined) {
      errors.push("modify cannot contain content or isDeleted");
    }
  } else if (action === "delete") {
    if (change.isDeleted !== true || change.content !== "" || change.edits !== undefined) {
      errors.push("delete requires isDeleted=true, empty content, and no edits");
    }
  } else {
    if (typeof change.content !== "string" || change.edits !== undefined || change.isDeleted === true) {
      errors.push(`${action === "create" ? "create" : "legacy full-content change"} requires string content and no edits/deletion marker`);
    }
  }

  return errors;
}

function validateCodeGenerationPayload(
  parsed: unknown,
  requireExplicitAction: boolean,
): { valid: boolean; errors?: string[]; data?: CodeGenerationPayload } {
  if (!isPlainObject(parsed)) return { valid: false, errors: ["response must be an object"] };

  const errors: string[] = [];
  const extraKeys = unexpectedKeys(parsed, ["explanation", "changes", "commitMessage"]);
  if (extraKeys.length > 0) errors.push(`unexpected top-level fields: ${extraKeys.join(", ")}`);
  if (typeof parsed.explanation !== "string" || parsed.explanation.length === 0) {
    errors.push("explanation must be a non-empty string");
  }
  if (typeof parsed.commitMessage !== "string" || parsed.commitMessage.length === 0) {
    errors.push("commitMessage must be a non-empty string");
  }
  if (!Array.isArray(parsed.changes) || parsed.changes.length === 0) {
    errors.push("changes must be a non-empty array");
  } else {
    parsed.changes.forEach((change: unknown, index: number) => {
      for (const error of validateModelGeneratedChange(change, requireExplicitAction)) {
        errors.push(`changes[${index}]: ${error}`);
      }
    });
  }

  return errors.length > 0
    ? { valid: false, errors }
    : { valid: true, data: parsed as unknown as CodeGenerationPayload };
}

function validateExecuteChangesPayload(
  parsed: unknown,
): { valid: boolean; errors?: string[]; data?: ExecuteChangesPayload } {
  if (isPlainObject(parsed) && parsed.needsClarification === true) {
    const validKeys = unexpectedKeys(parsed, ["needsClarification", "question", "options"]).length === 0;
    const validQuestion = typeof parsed.question === "string" && parsed.question.length > 0;
    const validOptions = parsed.options === undefined || (
      Array.isArray(parsed.options) && parsed.options.every((option: unknown) => typeof option === "string" && option.length > 0)
    );
    return validKeys && validQuestion && validOptions
      ? { valid: true, data: parsed as unknown as ClarificationPayload }
      : { valid: false, errors: ["clarification requires a non-empty question and optional non-empty string options"] };
  }
  const generationResult = validateCodeGenerationPayload(parsed, false);
  if (!generationResult.valid || !isPlainObject(parsed) || !Array.isArray(parsed.changes)) {
    return { valid: false, errors: generationResult.errors || ["invalid executeChanges generation payload"] };
  }
  if (!parsed.changes.every((change: unknown) => isPlainObject(change) && typeof change.content === "string")) {
    return { valid: false, errors: ["executeChanges requires complete string content for every change"] };
  }
  return { valid: true, data: parsed as unknown as ExecuteGenerationPayload };
}

function validateContentRepairPayload(
  parsed: unknown,
): { valid: boolean; errors?: string[]; data?: ContentRepairPayload } {
  if (
    !isPlainObject(parsed) ||
    unexpectedKeys(parsed, ["content"]).length > 0 ||
    typeof parsed.content !== "string" ||
    parsed.content.length === 0
  ) {
    return { valid: false, errors: ["repair response must contain non-empty string content"] };
  }
  return { valid: true, data: { content: parsed.content } };
}

function codeGenerationSchema(name: string, requireExplicitAction: boolean) {
  return {
    name,
    strict: false,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        explanation: { type: "string", minLength: 1 },
        changes: {
          type: "array",
          minItems: 1,
          items: {
            type: "object",
            additionalProperties: false,
            properties: MODEL_CHANGE_PROPERTIES,
            required: requireExplicitAction
              ? ["path", "action", "description"]
              : ["path", "description"],
          },
        },
        commitMessage: { type: "string", minLength: 1 },
      },
      required: ["explanation", "changes", "commitMessage"],
    },
    validate: (parsed: unknown) => validateCodeGenerationPayload(parsed, requireExplicitAction),
  };
}

const CONTENT_REPAIR_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: { content: { type: "string", minLength: 1 } },
  required: ["content"],
} as const;

/**
 * Builds advisory manifest planning context for proposal generation.
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
REQUESTED FILE PLAN — ADVISORY PLANNING CONTEXT
══════════════════════════════════════════════════════════
These are requested candidate changes. They grant no mutation authority.

${fileLines.join("\n")}

PROPOSAL GUIDANCE:
1. Prefer requested paths when they remain consistent with current repository facts.
2. Every generated change MUST explicitly set "action": "create" | "modify" | "delete".
3. For deletion operations, set "action": "delete", "isDeleted": true, "content": "", and a clear description.
4. If current repository facts require a different path/action, return that explicit proposal with a rationale.
5. CapabilityGuard and deterministic validation independently decide whether any proposal may execute.
6. Use exact repository-relative paths as written above.

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

    const completion = await LLMGateway.getInstance().callStructured<ExecuteChangesPayload>({
      stage: PipelineStages.CODE_GENERATION,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.2,
      maxTokens: 8000,
      schema: {
        name: "ExecuteChangesSchema",
        strict: false,
        schema: {
          oneOf: [
            codeGenerationSchema("ExecuteChangesGeneration", false).schema,
            {
              type: "object",
              additionalProperties: false,
              properties: {
                needsClarification: { const: true },
                question: { type: "string", minLength: 1 },
                options: { type: "array", items: { type: "string", minLength: 1 } },
              },
              required: ["needsClarification", "question"],
            },
          ],
        },
        validate: validateExecuteChangesPayload,
      },
    });
    return completion.content;
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
    const gateway = LLMGateway.getInstance();
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
        const roadmapRes = await gateway.callStructured<{ roadmap: RoadmapStep[] }>({
          stage: PipelineStages.ROADMAP_PLANNING,
          messages: [
            { role: "system", content: IMPLEMENTATION_PLANNER_PROMPT },
            { role: "user", content: `REQUEST: ${message}\nINTENT: ${intentResult.intent}` },
          ],
          temperature: 0.2,
          schema: {
            name: "ImplementationRoadmapSchema",
            strict: false,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                roadmap: {
                  type: "array",
                  minItems: 1,
                  maxItems: 5,
                  items: {
                    type: "object",
                    additionalProperties: false,
                    properties: {
                      phase: { type: "number" },
                      title: { type: "string" },
                      layer: { type: "string", enum: ["Controller", "Service", "Repository", "Schema", "UI"] },
                      targetFiles: { type: "array", items: { type: "string" } },
                      description: { type: "string" },
                    },
                    required: ["phase", "title", "targetFiles", "description"],
                  },
                },
              },
              required: ["roadmap"],
            },
            validate: (parsed) => {
              const allowedPaths = new Set(Array.from(manifestFileMap.keys()));
              const safePath = (value: unknown) => {
                if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.includes("\0")) return false;
                const normalized = normalizeRepoPath(value);
                return !normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized) && normalized.split("/").every((part) => part && part !== "." && part !== "..") && (allowedPaths.size === 0 || allowedPaths.has(normalized));
              };
              const valid = Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed)
                && Object.keys(parsed).length === 1 && Array.isArray(parsed.roadmap)
                && parsed.roadmap.length > 0 && parsed.roadmap.length <= 5
                && parsed.roadmap.every((step: any, index: number) => step && typeof step === "object" && !Array.isArray(step)
                  && Object.keys(step).every((key) => ["phase", "title", "layer", "targetFiles", "description"].includes(key))
                  && Number.isInteger(step.phase) && step.phase === index + 1
                  && typeof step.title === "string" && step.title.trim()
                  && (step.layer === undefined || ["Controller", "Service", "Repository", "Schema", "UI"].includes(step.layer))
                  && Array.isArray(step.targetFiles) && step.targetFiles.length > 0 && new Set(step.targetFiles).size === step.targetFiles.length && step.targetFiles.every(safePath)
                  && typeof step.description === "string" && step.description.trim()));
              return { valid, errors: valid ? undefined : ["Roadmap must contain ordered, bounded phases using requested planning paths"], data: parsed };
            },
          },
        });

        if (Array.isArray(roadmapRes.content?.roadmap) && roadmapRes.content.roadmap.length > 0) {
          roadmap = roadmapRes.content.roadmap;
        }
      } catch (err: any) {
        console.warn("[CodeGenerator] Roadmap planning LLM call failed, falling back to default roadmap:", err?.message || err);
      }
    }

    const requiredRepositoryEvidence = Object.entries(authoritativeModifySources || {}).map(([p, s]) => ({
      id: `authoritative-modify:${normalizeRepoPath(p)}:${s.sha256}`,
      content: `AUTHORIZED MODIFY SOURCE\nFILE: ${p}\nSHA256: ${s.sha256}\nFULL AUTHORITATIVE CONTENT:\n${s.content}`,
      required: true,
      priority: 0,
    }));

    const supportingRepositoryEvidence = Object.entries(optimizedContext?.fileContext || {})
      .filter(([p]) => !authoritativeModifySources || !authoritativeModifySources[p])
      .map(([p, c]) => {
        const fileSha = crypto.createHash("sha256").update(String(c)).digest("hex");
        return {
          id: `supporting-file:${normalizeRepoPath(p)}:${fileSha}`,
          content: `SUPPORTING REPOSITORY CONTEXT\nFILE: ${p}\nSHA256: ${fileSha}\nFULL CONTENT:\n${c}`,
          required: false,
          priority: 100,
        };
      });

    const skeletonRepositoryEvidence = Object.entries(optimizedContext?.skeletonContext || {}).map(([p, c]) => ({
      id: `skeleton-file:${normalizeRepoPath(p)}`,
      content: `SKELETON DEPENDENCY: ${p}\n${c}`,
      required: false,
      priority: 200,
    }));
    const repositoryEvidence = [
      ...requiredRepositoryEvidence,
      ...supportingRepositoryEvidence,
      ...skeletonRepositoryEvidence,
    ];

    const effectiveResolutionSourceMap: Record<string, string> =
      mergedSourceMap ||
      (authoritativeModifySources
        ? Object.fromEntries(Object.entries(authoritativeModifySources).map(([p, s]) => [p, s.content]))
        : null) ||
      optimizedContext?.fileContext ||
      {};

    const resolvedComponentContracts = ComponentContractGrounder.resolveComponentContractsForGeneration({
      authorizedModifySources: authoritativeModifySources,
      approvedManifest,
      contract,
      effectiveResolutionSourceMap,
      userMessage: message,
    });

    const componentContractBlocks = resolvedComponentContracts.map((c) => c.contractText);

    const contextContent = componentContractBlocks.join("\n\n");

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
      const isMultiFileRequest = (!isNarrowScope || manifestHasCreateOrModify) && (
        (approvedManifest && approvedManifest.files.length >= 2) ||
        contract?.estimatedComplexity === "LARGE" ||
        contract?.estimatedComplexity === "COMPLEX" ||
        (contract?.maxFiles !== undefined && contract.maxFiles >= 2)
      );
      if (isMultiFileRequest) {
        multiFileInstruction = "\n\nMULTI-FILE ARCHITECTURE MANDATE: Output a complete multi-file blueprint containing ALL necessary files.";
      }
    }

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

    const isUI = arch.existingUIComponents.length > 0 || (approvedManifest?.files && approvedManifest.files.some((f) => /\.(?:tsx|jsx|css|scss|html)$/i.test(f.path)));
    const uiSystemSection = isUI
      ? `\n\n${buildRepositoryUISystemPromptSection(arch, {
          isComprehensiveUI: (approvedManifest?.files?.length || 0) >= 3,
          isSmallComponent: (approvedManifest?.files?.length || 0) <= 1,
        })}`
      : "";

    const stylingSection = !hasTailwind && !isStandaloneWeb
      ? `\n\n══════════════════════════════════════════════════════════
CSS & STYLING ARCHITECTURE RULES
══════════════════════════════════════════════════════════
1. Tailwind CSS is NOT installed in this repository.
2. Do NOT write Tailwind utility classes as raw CSS selectors (e.g. NEVER write '.dark:bg-gray-900', '.text-sm', or '.flex' inside .css files).
3. In stylesheets (.css / .module.css / global.css), use standard, valid CSS class names matching existing repository conventions.
4. For dark mode, use valid CSS selectors like '@media (prefers-color-scheme: dark)' or theme class selectors.
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
    const componentContractInstruction = `\n\n══════════════════════════════════════════════════════════
EXISTING LOCAL COMPONENT PROP CONTRACT RULES
══════════════════════════════════════════════════════════
When using an existing local component, conform to its authoritative exported prop/interface contract. Do not invent props that are not present in that contract.
══════════════════════════════════════════════════════════`;

    const effectiveCodingPrompt = isStandaloneWeb
      ? `${STANDALONE_HTML_CSS_JS_PROMPT}${contractGuardrail}${manifestSection}`
      : `${systemPrompt}\n\n${CODING_AGENT_PROMPT}\n\n${LAYER_CONSTRAINT_PROMPT}${packagesSection}${stylingSection}${appRouterSection}${uiSystemSection}${contractGuardrail}${manifestSection}${componentContractInstruction}`;

    const hasManifest = approvedManifest && Array.isArray(approvedManifest.files) && approvedManifest.files.length > 0;
    const jsonFormatReminder = hasManifest
      ? `\n\nREMINDER: Respond ONLY with valid JSON. For CREATE actions, output complete file content. For MODIFY actions, output targeted edits[] with exact oldText/newText pairs. For DELETE actions, output deletion markers. See STRICT MODIFY RULES above.`
      : `\n\nREMINDER: Respond ONLY with valid JSON. Every file in your "changes" array MUST contain the COMPLETE 100% file content.`;

    const contextSummary = contextContent || (repositoryEvidence.length > 0
      ? "Repository evidence is supplied through the bounded ContextManager."
      : "(Standalone Application - No repository context required)");
    const userPrompt = `USER REQUEST: ${message}\nINTENT: ${intentResult.intent}\nROADMAP PLAN:\n${JSON.stringify(roadmap, null, 2)}\n\nCONTEXT:\n${contextSummary}${multiFileInstruction}${jsonFormatReminder}`;

    const completion = await gateway.callStructured<CodeGenerationPayload>({
      stage: PipelineStages.CODE_GENERATION,
      messages: [
        { role: "system", content: effectiveCodingPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: 16000,
      repositoryEvidence,
      schema: codeGenerationSchema("PrimaryCodeGenerationSchema", Boolean(hasManifest || isDeleteTask)),
    });

    let parsed = completion.content;
    let rawChanges: ModelGeneratedChange[] = parsed.changes;
    let explanation = parsed.explanation;
    let commitMessage = parsed.commitMessage;

    // The manifest guides generation, but generated proposals are not accepted or
    // rejected here because of manifest membership. CapabilityGuard and the
    // transaction/validation boundary decide whether they may be materialized.

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

      const proposals = [...normalizedProposals];

      // PART A: Structurally validate ALL proposals before application
      const malformedProposals = validateGenerationProposals(
        proposals,
        effectiveResolutionSourceMap,
      );

      const patchTelemetry: PatchCorrectionTelemetry = {
        patchCorrectionAttempted: false,
        patchCorrectionSucceeded: false,
        patchCorrectionAttempts: 0,
      };

      if (malformedProposals.length > 0) {
        // PART B: Bounded Multi-Proposal Correction (Cap check)
        const MAX_CORRECTABLE_PROPOSALS_PER_GENERATION = 3;
        if (malformedProposals.length > MAX_CORRECTABLE_PROPOSALS_PER_GENERATION) {
          throw new Error(
            `[PATCH_RESOLUTION_FAILED] Bounded correction cap exceeded: ${malformedProposals.length} malformed proposals detected (maximum allowed: ${MAX_CORRECTABLE_PROPOSALS_PER_GENERATION}). Failing closed.`
          );
        }

        patchTelemetry.patchCorrectionAttempted = true;
        let anyFailed = false;

        // PART C: Correct ONLY malformed proposals (each gets at most 1 attempt)
        for (const malformed of malformedProposals) {
          const proposalIdx = malformed.proposalIndex;
          const targetProposal = proposals[proposalIdx];
          if (!targetProposal || targetProposal.action !== "modify") {
            anyFailed = true;
            continue;
          }

          const normPath = targetProposal.path.replace(/\\/g, "/");
          let originalContent = effectiveResolutionSourceMap[normPath];
          if (originalContent === undefined) {
            for (const [k, v] of Object.entries(effectiveResolutionSourceMap)) {
              if (k.replace(/\\/g, "/").toLowerCase() === normPath.toLowerCase()) {
                originalContent = v;
                break;
              }
            }
          }

          if (originalContent === undefined) {
            anyFailed = true;
            continue;
          }

          patchTelemetry.patchCorrectionAttempts++;
          patchTelemetry.failedFilePath = targetProposal.path;
          patchTelemetry.errorCode = malformed.code;

          console.log(
            `[CodeGenerator] Proposal ${proposalIdx} ("${targetProposal.path}") failed structural validation with [${malformed.code}]. Triggering bounded exact patch correction (Attempt 1/1)...`
          );

          const correction = await PatchCorrectionEngine.correctPatch({
            filePath: targetProposal.path,
            currentContent: originalContent,
            userMessage: message,
            manifestAction: "modify",
            failedEdits: malformed.failedEdits || (targetProposal as any).edits || [],
            errorCode: malformed.code as any,
            errorMessage: malformed.message,
          });

          if (correction.succeeded && correction.correctedEdits && correction.correctedEdits.length > 0) {
            console.log(
              `[CodeGenerator] Bounded exact patch correction succeeded for "${targetProposal.path}" with ${correction.correctedEdits.length} edit(s).`
            );
            proposals[proposalIdx] = {
              ...targetProposal,
              edits: correction.correctedEdits,
            };
          } else {
            console.warn(
              `[CodeGenerator] Bounded exact patch correction failed for "${targetProposal.path}": ${correction.error || "Unknown error"}`
            );
            anyFailed = true;
          }
        }

        patchTelemetry.patchCorrectionSucceeded = !anyFailed;
      }

      // Re-run deterministic proposal resolution across the complete set
      let resolution: ResolutionResult = resolveGenerationProposals(
        proposals,
        effectiveResolutionSourceMap,
      );

      if (!resolution.success) {
        throw new Error(
          `[PATCH_RESOLUTION_FAILED] ${resolution.error.code}: ${resolution.error.message}${
            patchTelemetry.patchCorrectionAttempted
              ? ` (Bounded correction attempt failed)`
              : ""
          }`
        );
      }

      changes = resolution.changes;
      expectedSourceHashes = resolution.expectedSourceHashes;
    } else {
      // Legacy path: standalone/delete/no-manifest — full-content changes
      expectedSourceHashes = {};
      changes = rawChanges.map((raw): AgentFileChange => {
        const normalizedPath = normalizeRepoPath(raw.path);
        const currentSource = Object.entries(effectiveResolutionSourceMap)
          .find(([sourcePath]) => normalizeRepoPath(sourcePath) === normalizedPath)?.[1];
        const action = raw.action ?? (currentSource === undefined ? "create" : "modify");
        const description = raw.description || `${action} ${raw.path}`;
        if (action === "delete") {
          if (currentSource !== undefined) expectedSourceHashes![normalizedPath] = sha256(currentSource);
          return {
            path: raw.path,
            content: "",
            description,
            action,
            isDeleted: true,
            editPrimitive: {
              type: "DELETE_FILE",
              path: raw.path,
              description,
              expectedSourceFingerprint: currentSource === undefined ? undefined : sha256(currentSource),
            },
          };
        }
        if (action === "create") {
          return {
            path: raw.path,
            content: raw.content || "",
            description,
            action,
            editPrimitive: { type: "CREATE_FILE", path: raw.path, content: raw.content || "", description },
          };
        }
        if (currentSource !== undefined) expectedSourceHashes![normalizedPath] = sha256(currentSource);
        return {
          path: raw.path,
          content: raw.content || "",
          description,
          action: "modify",
          editPrimitive: {
            type: "REPLACE_FILE",
            path: raw.path,
            content: raw.content || "",
            description,
            expectedSourceFingerprint: currentSource === undefined ? undefined : sha256(currentSource),
          },
        };
      });
      if (Object.keys(expectedSourceHashes).length === 0) expectedSourceHashes = undefined;
    }

    if (approvedManifest && Array.isArray(approvedManifest.files)) {
      // Preserve planned action metadata for audit, but never synthesize a
      // mutation merely because the manifest requested one.
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
          const normalizedTarget = normalizeRepoPath(targetPath);
          const currentSource = Object.entries(effectiveResolutionSourceMap)
            .find(([sourcePath]) => normalizeRepoPath(sourcePath) === normalizedTarget)?.[1];
          changes.push({
            path: targetPath,
            content: "",
            description: `Delete ${targetPath}`,
            action: "delete",
            isDeleted: true,
            editPrimitive: {
              type: "DELETE_FILE",
              path: targetPath,
              description: `Delete ${targetPath}`,
              expectedSourceFingerprint: currentSource === undefined ? undefined : sha256(currentSource),
            },
          });
        }
      }
      for (const change of changes) {
        if (contract.targetPaths.some((tp) => change.path.replace(/\\/g, "/").startsWith(tp) || change.path.replace(/\\/g, "/") === tp)) {
          change.action = "delete";
          change.isDeleted = true;
          change.content = "";
          const normalizedTarget = normalizeRepoPath(change.path);
          const currentSource = Object.entries(effectiveResolutionSourceMap)
            .find(([sourcePath]) => normalizeRepoPath(sourcePath) === normalizedTarget)?.[1];
          change.editPrimitive = {
            type: "DELETE_FILE",
            path: change.path,
            description: change.description || `Delete ${change.path}`,
            expectedSourceFingerprint: currentSource === undefined ? undefined : sha256(currentSource),
          };
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

        const secCorrection = await gateway.callStructured<ContentRepairPayload>({
            stage: PipelineStages.CODE_CORRECTION,
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
            schema: {
              name: "SecurityCodeCorrectionSchema",
              strict: true,
              schema: CONTENT_REPAIR_SCHEMA,
              validate: validateContentRepairPayload,
            },
          });

          const parsedSec = secCorrection.content;
          if (typeof parsedSec.content === "string" && parsedSec.content.length > 0) {
            const recheck = SecurityPolicy.checkCode(parsedSec.content, change.path);
            if (recheck.safe) {
              change.content = parsedSec.content;
              bindWholeFilePrimitive(change);
            } else {
              throw new Error(`[UNSAFE_DYNAMIC_CODE_EXECUTION] Generated code in "${change.path}" violated security policy: ${recheck.violations.map((v) => v.message).join("; ")}`);
            }
          } else {
            throw new Error(`[UNSAFE_DYNAMIC_CODE_EXECUTION] Generated code in "${change.path}" violated security policy: ${violation.message}`);
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
          bindWholeFilePrimitive(change);
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

          const depCorrection = await gateway.callStructured<ContentRepairPayload>({
              stage: PipelineStages.CODE_CORRECTION,
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
              schema: {
                name: "DependencyCodeCorrectionSchema",
                strict: true,
                schema: CONTENT_REPAIR_SCHEMA,
                validate: validateContentRepairPayload,
              },
            });

            const parsedDep = depCorrection.content;
            if (typeof parsedDep.content === "string" && parsedDep.content.length > 0) {
              const recheck = ImportValidator.validateCodeImports(parsedDep.content, change.path, installedPackages);
              if (recheck.valid) {
                change.content = parsedDep.content;
                bindWholeFilePrimitive(change);
              } else {
                throw new Error(`[UNDECLARED_EXTERNAL_DEPENDENCY] Generated code in "${change.path}" imported uninstalled package: ${recheck.errors.map((e) => e.message).join("; ")}`);
              }
            } else {
              throw new Error(`[UNDECLARED_EXTERNAL_DEPENDENCY] Generated code in "${change.path}" imported uninstalled package: ${violation.message}`);
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
