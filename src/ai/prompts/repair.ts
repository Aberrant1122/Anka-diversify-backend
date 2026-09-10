import ts from "typescript";
import { DiagnosticError } from "../../services/surgical-repair.engine";
import { FileManifest, ExecutionContract } from "../../types";
import { ComponentContractGrounder } from "../contracts/ComponentContractGrounder";

export const SELF_HEALING_REPAIR_PROMPT = `You are a Specialized Self-Healing Code Repair Agent.
A prior code generation attempt produced compiler, linter, or execution errors when running shell validation checks.

TASK:
Analyze the terminal error trace and diagnostics, then output surgical repairs strictly matching the approved manifest plan.

CRITICAL INSTRUCTIONS:
1. Repair ONLY files declared in the APPROVED FILE PLAN.
2. Every action must match the approved manifest declaration ("modify", "create", or "delete").
3. Use the output contract supplied for this repair operation. Do not invent alternate fields or representations.
4. Follow the selected output contract exactly.
5. Keep every generated change bounded to the approved repair scope.
6. Do not generate no-op changes.
7. Do not use placeholder comments.
8. Preserve existing behavior outside the targeted error fix. Do not perform unrelated refactors.
9. Follow the selected output contract for CREATE actions.
10. Follow the selected output contract for DELETE actions.
11. SECURITY MANDATE: Never use eval(), new Function(), or unrestricted dynamic code execution on user input. For calculations, use explicit mathematical operators or safe deterministic parsers.
12. PUBLIC CONTRACT PRESERVATION: Never remove or rename exported interface properties, component Props, or exported types unless the user explicitly requested an API change. When fixing unused parameter errors (TS6133), remove the symbol from the function parameter destructuring ONLY, not from the exported interface. Retain all type imports required by public interfaces.
13. EXISTING COMPONENT REPAIR: When repairing usage of an existing local component, repair against the authoritative existing component interface. Do not rename one invented prop to another without evidence.

`;

const EDIT_REPAIR_OUTPUT_CONTRACT = `
REPAIR OUTPUT CONTRACT (JSON ONLY):
Return {"repaired":boolean,"patchExplanation":"...","changes":[...]}.
For MODIFY actions, each change requires an "edits" array whose oldText exactly matches current content and whose newText is a real change. CREATE requires full content. DELETE requires action "delete", isDeleted true, and empty content.
Do not use line numbers, unified diffs, ellipses, or placeholder comments.`;

const FULL_CONTENT_REPAIR_OUTPUT_CONTRACT = `
BUILD ERROR REPAIR OUTPUT CONTRACT (JSON ONLY):
Return only {"changes":[...]} with no repaired or patchExplanation fields.
CREATE requires path, action "create", description, and non-empty full content; do not include edits or isDeleted.
MODIFY requires path, action "modify", description, and non-empty full replacement content; do not include edits or isDeleted.
DELETE requires path, action "delete", description, content "", and isDeleted true; do not include edits.
Do not return success, buildPassed, validationPassed, verified, complete, or other undeclared fields.`;

export interface StructuredRepairPromptInput {
  errorLog: string;
  diagnostics?: DiagnosticError[];
  currentFiles?: Record<string, string>;
  approvedManifest?: FileManifest | null;
  contract?: ExecutionContract | null;
  originalMessage?: string;
  attempt?: number;
  maxRetries?: number;
  changes?: any[];
  alternativeAttemptFeedback?: string;
  appliedDiff?: string;
  localPath?: string | null;
  outputContract?: "edits" | "fullContent";
}

/**
 * Deterministically detect whether a missing-name diagnostic in a .ts file is structurally caused by JSX syntax.
 * Verifies that:
 * 1. File extension is strictly .ts (and not .tsx or .d.ts).
 * 2. Diagnostic is TS2304 / TS2552 or BUILD_ERR with 'cannot find name'.
 * 3. symbolName is non-empty.
 * 4. File content structurally contains a JSX element with tagName matching the missing symbol within ±2 lines.
 */
export function isJsxInTsDiagnostic(diag: DiagnosticError, fileContent?: string): boolean {
  if (!diag.file || !diag.file.endsWith(".ts") || diag.file.endsWith(".d.ts") || diag.file.endsWith(".tsx")) {
    return false;
  }
  if (!fileContent) {
    return false;
  }
  if (!diag.symbolName || !diag.symbolName.trim()) {
    return false;
  }
  const isMissingNameDiagnostic =
    diag.code === "TS2304" ||
    diag.code === "TS2552" ||
    (diag.code === "BUILD_ERR" && /cannot find name/i.test(diag.message || ""));
  if (!isMissingNameDiagnostic) {
    return false;
  }

  try {
    const sourceFile = ts.createSourceFile("temp.tsx", fileContent, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let foundJsx = false;

    function visit(node: ts.Node) {
      if (foundJsx) return;
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const tagName = node.tagName.getText(sourceFile);
        if (tagName === diag.symbolName) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          if (Math.abs(line - diag.line) <= 2) {
            foundJsx = true;
            return;
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
    return foundJsx;
  } catch {
    return false;
  }
}

export function buildRepairSystemPrompt(input?: StructuredRepairPromptInput): string {
  let prompt = SELF_HEALING_REPAIR_PROMPT + (input?.outputContract === "fullContent" ? FULL_CONTENT_REPAIR_OUTPUT_CONTRACT : EDIT_REPAIR_OUTPUT_CONTRACT);

  if (input?.approvedManifest && Array.isArray(input.approvedManifest.files)) {
    const fileList = input.approvedManifest.files
      .map((f) => `• ${f.path} (${f.action.toUpperCase()}): ${f.description || "No description"}`)
      .join("\n");
    prompt += `\n\nAPPROVED FILE PLAN (CANNOT BE EXCEEDED):\n${fileList}`;
  }

  return prompt;
}

export function buildRepairUserPrompt(input: StructuredRepairPromptInput): string {
  const attemptText = input.attempt && input.maxRetries ? ` (REPAIR ATTEMPT ${input.attempt}/${input.maxRetries})` : "";
  const reqText = input.originalMessage ? `ORIGINAL USER REQUEST:\n${input.originalMessage}\n\n` : "";

  let diagsText = "";
  if (input.diagnostics && input.diagnostics.length > 0) {
    const approvedPaths = new Set(
      input.approvedManifest?.files?.map((f) => f.path.replace(/\\/g, "/").replace(/^\.\//, "")) ||
        Object.keys(input.currentFiles || {}).map((k) => k.replace(/\\/g, "/").replace(/^\.\//, ""))
    );

    const isAuthorized = (d: DiagnosticError) => {
      if (!d.file) return false;
      const clean = d.file.replace(/\\/g, "/").replace(/^\.\//, "");
      return (
        approvedPaths.size === 0 ||
        approvedPaths.has(clean) ||
        Array.from(approvedPaths).some((ap) => clean.endsWith(ap) || ap.endsWith(clean))
      );
    };

    const authDiags = input.diagnostics.filter(isAuthorized);
    const unauthDiags = input.diagnostics.filter((d) => !isAuthorized(d));

    const formatDiag = (d: DiagnosticError) =>
      `• [${d.code || "ERROR"}] ${d.file}:${d.line}${d.column ? `:${d.column}` : ""} - ${d.message}${d.symbolName ? ` (Symbol: ${d.symbolName})` : ""}`;

    if (unauthDiags.length > 0) {
      if (authDiags.length > 0) {
        diagsText += `AUTHORIZED STRUCTURED DIAGNOSTICS TO REPAIR:\n${authDiags.map(formatDiag).join("\n")}\n\n`;
      }
      diagsText += `EXTERNAL CALLER / CONSUMER COMPILER EVIDENCE (READ-ONLY — DO NOT MODIFY THESE FILES):\n` +
        `The following diagnostic(s) occurred in caller or consumer file(s) outside your approved manifest:\n` +
        `${unauthDiags.map(formatDiag).join("\n")}\n` +
        `DO NOT modify these caller files. Treat these diagnostics as causal evidence that an export, type signature, or interface in the authorized file(s) was broken or removed. Repair or restore the expected contract within your AUTHORIZED file(s) so external callers compile.\n\n`;
    } else {
      const lines = input.diagnostics.map(formatDiag);
      diagsText = `STRUCTURED DIAGNOSTICS DETECTED:\n${lines.join("\n")}\n\n`;
    }
  }

  let causalDiagnosticGuidance = "";
  if (input.diagnostics && input.diagnostics.length > 0 && input.currentFiles) {
    const causalItems: string[] = [];
    for (const d of input.diagnostics) {
      const fileContent =
        input.currentFiles?.[d.file] ||
        Object.entries(input.currentFiles || {}).find(
          ([k]) =>
            k.replace(/\\/g, "/").endsWith(d.file.replace(/\\/g, "/")) ||
            d.file.replace(/\\/g, "/").endsWith(k.replace(/\\/g, "/")),
        )?.[1];

      if (
        (d.code === "TS6133" || /is declared but (?:its value is never read|never used)/i.test(d.message || "")) &&
        d.symbolName
      ) {
        let snippet = "";
        if (fileContent) {
          const lines = fileContent.split("\n");
          const start = Math.max(0, d.line - 3);
          const end = Math.min(lines.length, d.line + 2);
          snippet = lines
            .slice(start, end)
            .map((l, idx) => `      ${start + idx + 1}: ${l}`)
            .join("\n");
        }
        causalItems.push(
          `• [AGENT_CAUSED_TS6133] File "${d.file}" line ${d.line}: '${d.symbolName}' is declared but its value is never read.\n` +
            `  - Causality: The declaration became unused because prior changes removed its usage/references.\n` +
            (snippet ? `  - Declaration Context (around line ${d.line}):\n${snippet}\n` : "") +
            `  - DESTRUCTURING VS PUBLIC INTERFACE MANDATE: If '${d.symbolName}' is a destructured component parameter (e.g., '({ ..., ${d.symbolName}, ... }) =>') whose Props interface declares '${d.symbolName}', DO NOT delete '${d.symbolName}' from the exported Props interface! Public component contracts must remain stable so external callers do not break.\n` +
            `  - Minimal Fix: Remove '${d.symbolName}' ONLY from the function parameter destructuring list (e.g., change '({ foo, ${d.symbolName}, bar }) =>' to '({ foo, bar }) =>'), while keeping '${d.symbolName}' in the exported Props interface. Also preserve any type imports (e.g. ActivityItem) required by the retained interface.`,
        );
      }
    }

    if (causalItems.length > 0) {
      causalDiagnosticGuidance = `CAUSAL COMPILER DIAGNOSTIC CONTEXT:\n${causalItems.join("\n\n")}\n\n`;
    }
  }

  let jsxInTsGuidance = "";
  if (input.diagnostics && input.diagnostics.length > 0 && input.currentFiles) {
    const jsxInTsDiags = input.diagnostics.filter((d) => {
      const content =
        input.currentFiles?.[d.file] ||
        Object.entries(input.currentFiles || {}).find(
          ([k]) => k.replace(/\\/g, "/").endsWith(d.file.replace(/\\/g, "/")) || d.file.replace(/\\/g, "/").endsWith(k.replace(/\\/g, "/")),
        )?.[1];
      return content ? isJsxInTsDiagnostic(d, content) : false;
    });

    if (jsxInTsDiags.length > 0) {
      const guidanceItems = jsxInTsDiags.map(
        (d) => `• [JSX_IN_TS_FILE] File "${d.file}" line ${d.line}: Compiler evidence indicates that this .ts file contains JSX syntax. The reported intrinsic element name "${d.symbolName}" is not a missing import.
  - Do not add imports for JSX intrinsic element names such as div, h1, section, etc.
  - Resolve the .ts/JSX grammar mismatch while preserving component behavior.
  - If the current repair contract only permits MODIFY on the existing file, rewrite the JSX expression into equivalent React.createElement calls.
  - Do not propose a rename unless the execution contract explicitly permits the required CREATE/DELETE/file-rename operations.`,
      );
      jsxInTsGuidance = `SPECIALIZED COMPILER REPAIR GUIDANCE:\n${guidanceItems.join("\n\n")}\n\n`;
    }
  }

  let componentContractGuidance = "";
  if (input.diagnostics && input.diagnostics.length > 0 && input.currentFiles) {
    const compContracts = ComponentContractGrounder.resolveComponentContractsForDiagnostics(
      input.diagnostics,
      input.currentFiles,
      input.localPath,
      input.approvedManifest
    );
    if (compContracts.length > 0) {
      const contractItems = compContracts.map(
        (c) => `• [EXISTING_COMPONENT_CONTRACT] Component File: "${c.componentPath}"\n` +
          `  - Authoritative Component Source / Props Contract (READ-ONLY — DO NOT MODIFY THIS COMPONENT FILE):\n` +
          `${c.contractText.split("\n").map((l) => `    ${l}`).join("\n")}\n` +
          `  - MANDATE: Repair against the authoritative existing component interface. Do not rename one invented prop to another without evidence.`
      );
      componentContractGuidance = `AUTHORITATIVE EXISTING COMPONENT CONTRACT CONTEXT:\n${contractItems.join("\n\n")}\n\n`;
    }
  }

  let alternativeFeedbackText = "";
  if (input.alternativeAttemptFeedback) {
    alternativeFeedbackText = `PREVIOUS INEFFECTIVE REPAIR FEEDBACK:\n${input.alternativeAttemptFeedback}\n\n`;
  }

  let diffText = "";
  if (input.appliedDiff) {
    diffText = `CURRENT APPLIED CHANGES / DIFF CONTEXT:\n${input.appliedDiff}\n\n`;
  }

  let filesText = "";
  if (input.currentFiles && Object.keys(input.currentFiles).length > 0) {
    const fileBlocks = Object.entries(input.currentFiles).map(
      ([p, content]) => `══════════════════════════════════════════════════════════\nCURRENT FILE CONTENT: ${p}\n══════════════════════════════════════════════════════════\n${content}`,
    );
    filesText = `CURRENT TARGET FILE CONTENTS (COPY EXACT oldText FROM HERE):\n${fileBlocks.join("\n\n")}\n\n`;
  } else if (input.changes && input.changes.length > 0) {
    filesText = `CURRENT CHANGES:\n${JSON.stringify(input.changes, null, 2)}\n\n`;
  }

  const outputInstruction = input.outputContract === "fullContent"
    ? "Return JSON using the BUILD ERROR REPAIR OUTPUT CONTRACT above."
    : "Return JSON using the REPAIR OUTPUT CONTRACT above, including edits[] for MODIFY actions.";
  return `${reqText}${diagsText}${causalDiagnosticGuidance}${jsxInTsGuidance}${componentContractGuidance}${alternativeFeedbackText}${diffText}${filesText}ACTUAL TERMINAL ERROR TRACE${attemptText}:\n${input.errorLog}\n\nFix all build/type/lint errors shown above. ${outputInstruction}`;
}

export function buildSelfHealingRepairPrompt(input: StructuredRepairPromptInput): { system: string; user: string } {
  return {
    system: buildRepairSystemPrompt(input),
    user: buildRepairUserPrompt(input),
  };
}
