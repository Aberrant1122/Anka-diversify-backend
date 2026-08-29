import ts from "typescript";
import { DiagnosticError } from "../../services/surgical-repair.engine";
import { FileManifest, ExecutionContract } from "../../types";

export const SELF_HEALING_REPAIR_PROMPT = `You are a Specialized Self-Healing Code Repair Agent.
A prior code generation attempt produced compiler, linter, or execution errors when running shell validation checks.

TASK:
Analyze the terminal error trace and diagnostics, then output surgical repairs strictly matching the approved manifest plan.

CRITICAL INSTRUCTIONS:
1. Repair ONLY files declared in the APPROVED FILE PLAN.
2. Every action must match the approved manifest declaration ("modify", "create", or "delete").
3. For MODIFY actions, output structured "edits" array ONLY. Do NOT output full file content for modify operations.
4. "oldText" must match the EXACT text from the CURRENT file content provided in this prompt (exact byte match).
5. Ensure "oldText" contains enough surrounding context so it is unique within the file.
6. Every edit MUST make a real modification (oldText and newText must NOT be identical). No-op edits are rejected.
7. Do NOT use line numbers, unified diffs, ellipses, or placeholder comments.
8. Preserve existing behavior outside the targeted error fix. Do not perform unrelated refactors.
9. For CREATE actions, output the full "content" of the new file.
10. For DELETE actions, set "action": "delete", "isDeleted": true, and "content": "".
11. SECURITY MANDATE: Never use eval(), new Function(), or unrestricted dynamic code execution on user input. For calculations, use explicit mathematical operators or safe deterministic parsers.

RESPONSE FORMAT (JSON ONLY):
{
  "repaired": boolean,
  "patchExplanation": "What was fixed in response to the terminal errors",
  "changes": [
    {
      "path": "relative/path/to/file.ts",
      "action": "modify",
      "description": "Short explanation of surgical fix",
      "edits": [
        {
          "oldText": "exact current source text to replace",
          "newText": "replacement text"
        }
      ]
    }
  ]
}`;

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
  let prompt = SELF_HEALING_REPAIR_PROMPT;

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
    const lines = input.diagnostics.map(
      (d) => `• [${d.code || "ERROR"}] ${d.file}:${d.line}${d.column ? `:${d.column}` : ""} - ${d.message}${d.symbolName ? ` (Symbol: ${d.symbolName})` : ""}`,
    );
    diagsText = `STRUCTURED DIAGNOSTICS DETECTED:\n${lines.join("\n")}\n\n`;
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

  let filesText = "";
  if (input.currentFiles && Object.keys(input.currentFiles).length > 0) {
    const fileBlocks = Object.entries(input.currentFiles).map(
      ([p, content]) => `══════════════════════════════════════════════════════════\nCURRENT FILE CONTENT: ${p}\n══════════════════════════════════════════════════════════\n${content}`,
    );
    filesText = `CURRENT TARGET FILE CONTENTS (COPY EXACT oldText FROM HERE):\n${fileBlocks.join("\n\n")}\n\n`;
  } else if (input.changes && input.changes.length > 0) {
    filesText = `CURRENT CHANGES:\n${JSON.stringify(input.changes, null, 2)}\n\n`;
  }

  return `${reqText}${diagsText}${jsxInTsGuidance}${filesText}ACTUAL TERMINAL ERROR TRACE${attemptText}:\n${input.errorLog}\n\nFix all build/type/lint errors shown above. Return JSON with structured "changes" using edits[] for MODIFY actions.`;
}

export function buildSelfHealingRepairPrompt(input: StructuredRepairPromptInput): { system: string; user: string } {
  return {
    system: buildRepairSystemPrompt(input),
    user: buildRepairUserPrompt(input),
  };
}
