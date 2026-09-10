import crypto from "crypto";
import { FilePatchEdit, applyPatchToFile } from "../patch/PatchApplicator";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { isLLMError } from "../gateway/LLMError";

interface PatchCorrectionPayload {
  edits: FilePatchEdit[];
}

export interface PatchCorrectionInput {
  filePath: string;
  currentContent: string;
  userMessage: string;
  manifestAction?: string;
  failedEdits: readonly FilePatchEdit[];
  errorCode:
    | "PATCH_TARGET_NOT_FOUND"
    | "AMBIGUOUS_PATCH_TARGET"
    | "NO_OP_PATCH_EDIT"
    | "MODIFY_PATCH_REQUIRED"
    | "EMPTY_PATCH_TARGET"
    | "OVERLAPPING_PATCH_EDITS"
    | "NO_PATCH_EDITS";
  errorMessage: string;
}

export interface PatchCorrectionResult {
  attempted: boolean;
  succeeded: boolean;
  correctedEdits?: FilePatchEdit[];
  error?: string;
}

export interface PatchCorrectionTelemetry {
  patchCorrectionAttempted: boolean;
  patchCorrectionSucceeded: boolean;
  patchCorrectionAttempts: number;
  failedFilePath?: string;
  errorCode?: string;
}

export class PatchCorrectionEngine {
  /**
   * Attempts ONE bounded model-assisted correction for a failed MODIFY patch proposal
   * whose oldText was not found, was ambiguous, or was a no-op in current authoritative file content.
   */
  static async correctPatch(input: PatchCorrectionInput): Promise<PatchCorrectionResult> {
    const { filePath, currentContent, userMessage, manifestAction, failedEdits, errorCode, errorMessage } = input;

    // Strict guard: only attempt for target-not-found, ambiguous-target, no-op edit, or malformed patch
    const eligibleCodes = [
      "PATCH_TARGET_NOT_FOUND",
      "AMBIGUOUS_PATCH_TARGET",
      "NO_OP_PATCH_EDIT",
      "MODIFY_PATCH_REQUIRED",
      "EMPTY_PATCH_TARGET",
      "OVERLAPPING_PATCH_EDITS",
      "NO_PATCH_EDITS",
    ];
    if (!eligibleCodes.includes(errorCode)) {
      return {
        attempted: false,
        succeeded: false,
        error: `Error code "${errorCode}" is not eligible for patch correction.`,
      };
    }

    const fileSha = crypto.createHash("sha256").update(currentContent).digest("hex");

    const systemPrompt = `You are an Exact Patch Correction Assistant.
A previously generated search/replace patch failed (Reason: ${errorCode}). A modify edit must produce a real effective change and match exact source text.

CRITICAL CORRECTION RULES:
1. The previous oldText was not found exactly in the current source.
2. Return corrected structured edits only.
3. Every "oldText" MUST be copied EXACTLY character-for-character from the supplied CURRENT EXACT FULL SOURCE CONTENT.
4. "oldText" must contain sufficient surrounding context to match uniquely in the file (no ambiguous duplicates).
5. Do NOT rewrite the entire file.
6. Do NOT change undeclared files.
7. Do NOT invent source or guess formatting.
8. Do NOT use line-number-only patches or unified diff format.
9. Multiple independent changes to one file must be separate edits[] entries.

Respond ONLY with valid JSON:
{
  "edits": [
    {
      "oldText": "exact substring copied from CURRENT EXACT FULL SOURCE CONTENT",
      "newText": "replacement source text"
    }
  ]
}`;

    const userPrompt = `TARGET FILE: ${filePath}
SHA-256: ${fileSha}
REQUESTED TASK: ${userMessage}
APPROVED ACTION: ${manifestAction || "modify"}

PATCH APPLICATOR FAILURE:
[${errorCode}] ${errorMessage}

PREVIOUS FAILED EDITS:
${JSON.stringify(failedEdits, null, 2)}

═══════════════════════════════════════════════════
CURRENT EXACT FULL SOURCE CONTENT:
═══════════════════════════════════════════════════
${currentContent}`;

    try {
      const result = await LLMGateway.getInstance().callStructured<PatchCorrectionPayload>({
        stage: PipelineStages.CODE_CORRECTION,
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.0,
        maxTokens: 4000,
        schema: {
          name: "ExactPatchCorrectionSchema",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["edits"],
            properties: {
              edits: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["oldText", "newText"],
                  properties: {
                    oldText: { type: "string", minLength: 1 },
                    newText: { type: "string" },
                  },
                },
              },
            },
          },
          validate: (value: unknown) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Patch correction must be an object"] };
            const payload = value as Record<string, unknown>;
            if (Object.keys(payload).some((key) => key !== "edits") || !Array.isArray(payload.edits) || payload.edits.length === 0) {
              return { valid: false, errors: ["Patch correction must contain only a non-empty edits array"] };
            }
            for (const item of payload.edits) {
              if (!item || typeof item !== "object" || Array.isArray(item)) return { valid: false, errors: ["Patch edit must be an object"] };
              const edit = item as Record<string, unknown>;
              if (Object.keys(edit).some((key) => key !== "oldText" && key !== "newText") || typeof edit.oldText !== "string" || edit.oldText.length === 0 || typeof edit.newText !== "string" || edit.oldText === edit.newText) {
                return { valid: false, errors: ["Patch edit fields are invalid"] };
              }
            }
            return { valid: true, data: payload as unknown as PatchCorrectionPayload };
          },
        },
      });

      const correctedEdits = result.content.edits;

      // Verify the corrected edits against exact PatchApplicator
      const verifyResult = applyPatchToFile(currentContent, correctedEdits);

      if (!verifyResult.success) {
        return {
          attempted: true,
          succeeded: false,
          error: `Corrected edits failed exact PatchApplicator verification: [${verifyResult.error.code}] ${verifyResult.error.message}`,
        };
      }

      return {
        attempted: true,
        succeeded: true,
        correctedEdits,
      };
    } catch (err: any) {
      if (isLLMError(err)) throw err;
      return {
        attempted: true,
        succeeded: false,
        error: `Patch correction model invocation failed: ${err?.message || err}`,
      };
    }
  }
}
