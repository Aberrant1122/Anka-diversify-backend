export const SELF_HEALING_REPAIR_PROMPT = `You are a Specialized Self-Healing Code Repair Agent.
A prior code generation attempt produced compiler, linter, or execution errors when running shell validation checks.

INPUT:
- Raw terminal error traces.
- Current file changes.
- Previous error logs.

TASK:
Analyze the exact line numbers and error messages, apply surgical patches to fix compiler/type/lint errors, and preserve existing functionality.

CRITICAL STANDALONE MANDATE:
- For standalone web applications (index.html, style.css, script.js), NEVER delete or omit index.html or style.css during repair retries. You MUST output ALL 3 files in your 'changes' array.

Respond ONLY with valid JSON:
{
  "repaired": boolean,
  "patchExplanation": "What was fixed in response to the terminal errors",
  "changes": [
    {
      "path": "relative/path/to/file.ts",
      "content": "corrected complete file content",
      "description": "surgical repair applied"
    }
  ]
}`;

export interface RepairPromptInput {
  errorLog: string;
  changes?: any[];
  originalMessage?: string;
  attempt?: number;
  maxRetries?: number;
}

/**
 * Builds the system prompt for the self-healing repair agent,
 * embedding the actual terminal/compiler error trace directly when provided.
 */
export function buildRepairSystemPrompt(errorLog?: string): string {
  if (!errorLog) {
    return SELF_HEALING_REPAIR_PROMPT;
  }

  return `You are a Specialized Self-Healing Code Repair Agent.
A prior code generation attempt produced compiler, linter, or execution errors when running shell validation checks.

ACTUAL TERMINAL / COMPILER ERROR TRACE TO FIX:
══════════════════════════════════════════════════════════
${errorLog}
══════════════════════════════════════════════════════════

TASK:
Analyze the exact line numbers and error messages in the error trace above, apply surgical patches to fix compiler/type/lint errors, and preserve existing functionality.

CRITICAL STANDALONE MANDATE:
- For standalone web applications (index.html, style.css, script.js), NEVER delete or omit index.html or style.css during repair retries. You MUST output ALL 3 files in your 'changes' array.

Respond ONLY with valid JSON:
{
  "repaired": boolean,
  "patchExplanation": "What was fixed in response to the terminal errors",
  "changes": [
    {
      "path": "relative/path/to/file.ts",
      "content": "corrected complete file content",
      "description": "surgical repair applied"
    }
  ]
}`;
}

/**
 * Builds the user prompt containing proposed file changes, original request,
 * and the actual terminal error trace.
 */
export function buildRepairUserPrompt(input: RepairPromptInput): string {
  const attemptText = input.attempt && input.maxRetries ? ` (REPAIR ATTEMPT ${input.attempt}/${input.maxRetries})` : "";
  const changesText = input.changes && input.changes.length > 0 ? JSON.stringify(input.changes, null, 2) : "None";
  const reqText = input.originalMessage ? `ORIGINAL REQUEST: ${input.originalMessage}\n\n` : "";

  return `${reqText}CURRENT PROPOSED CHANGES:\n${changesText}\n\nACTUAL TERMINAL ERROR TRACE${attemptText}:\n${input.errorLog}\n\nFix all build errors, type mismatches, missing imports, or runtime errors shown above. Return JSON with "changes" array containing corrected file contents.`;
}

/**
 * Builds both system and user prompts with the actual error log injected.
 */
export function buildSelfHealingRepairPrompt(input: RepairPromptInput): { system: string; user: string } {
  return {
    system: buildRepairSystemPrompt(input.errorLog),
    user: buildRepairUserPrompt(input),
  };
}

