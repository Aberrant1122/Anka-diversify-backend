import crypto from "crypto";
import { getOpenAI } from "../shared/utils";
import { FilePatchEdit, applyPatchToFile } from "../patch/PatchApplicator";

export interface PatchCorrectionInput {
  filePath: string;
  currentContent: string;
  userMessage: string;
  manifestAction?: string;
  failedEdits: readonly FilePatchEdit[];
  errorCode: "PATCH_TARGET_NOT_FOUND" | "AMBIGUOUS_PATCH_TARGET";
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
   * whose oldText was not found or was ambiguous in current authoritative file content.
   */
  static async correctPatch(input: PatchCorrectionInput): Promise<PatchCorrectionResult> {
    const { filePath, currentContent, userMessage, manifestAction, failedEdits, errorCode, errorMessage } = input;

    // Strict guard: only attempt for target-not-found or ambiguous-target
    if (errorCode !== "PATCH_TARGET_NOT_FOUND" && errorCode !== "AMBIGUOUS_PATCH_TARGET") {
      return {
        attempted: false,
        succeeded: false,
        error: `Error code "${errorCode}" is not eligible for patch correction.`,
      };
    }

    const fileSha = crypto.createHash("sha256").update(currentContent).digest("hex");

    const systemPrompt = `You are an Exact Patch Correction Assistant.
A previously generated search/replace patch failed because the proposed "oldText" was not found exactly in the current source file content or matched multiple locations ambiguously.

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
      const openai = getOpenAI();
      const completion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0.0,
        max_tokens: 4000,
        response_format: { type: "json_object" },
      });

      const parsed = JSON.parse(completion.choices[0]?.message?.content || "{}");
      const rawEdits = Array.isArray(parsed.edits) ? parsed.edits : [];

      if (rawEdits.length === 0) {
        return {
          attempted: true,
          succeeded: false,
          error: "Correction model returned empty edits[] array.",
        };
      }

      const correctedEdits: FilePatchEdit[] = rawEdits.map((e: any) => ({
        oldText: typeof e.oldText === "string" ? e.oldText : "",
        newText: typeof e.newText === "string" ? e.newText : "",
      }));

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
      return {
        attempted: true,
        succeeded: false,
        error: `Patch correction model invocation failed: ${err?.message || err}`,
      };
    }
  }
}
