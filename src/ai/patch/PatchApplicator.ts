// ─── Patch Types ────────────────────────────────────────────────────────────

/**
 * A single exact search/replace edit within a file.
 * `oldText` must match exactly one occurrence in the original file content.
 * `newText` may be empty (targeted deletion within a file).
 */
export interface FilePatchEdit {
  readonly oldText: string;
  readonly newText: string;
}

/**
 * Stable error codes for deterministic patch failure.
 */
export type PatchErrorCode =
  | "EMPTY_PATCH_TARGET"
  | "PATCH_TARGET_NOT_FOUND"
  | "AMBIGUOUS_PATCH_TARGET"
  | "OVERLAPPING_PATCH_EDITS"
  | "NO_PATCH_EDITS"
  | "NO_OP_PATCH_EDIT";

export interface PatchSuccess {
  success: true;
  content: string;
  appliedEdits: number;
}

export interface PatchError {
  code: PatchErrorCode;
  message: string;
  editIndex?: number;
  diagnostics?: {
    sourceLength: number;
    oldTextLength: number;
    sourceEol: "LF" | "CRLF" | "MIXED";
    oldTextEol: "LF" | "CRLF" | "MIXED";
    exactMatch: boolean;
    eolNormalizedExactMatch: boolean;
  };
}

export interface PatchFailure {
  success: false;
  error: PatchError;
}

export type PatchResult = PatchSuccess | PatchFailure;

// ─── Internal: resolved edit location ───────────────────────────────────────

interface ResolvedEdit {
  editIndex: number;
  startIndex: number;
  endIndex: number;
  newText: string;
}

// ─── Helper: EOL Detection & Canonical Mapping ──────────────────────────────

export function detectEolStyle(text: string): "LF" | "CRLF" | "MIXED" {
  const hasCrlf = text.includes("\r\n");
  const hasBareLf = text.replace(/\r\n/g, "").includes("\n");
  if (hasCrlf && hasBareLf) return "MIXED";
  if (hasCrlf) return "CRLF";
  return "LF";
}

/**
 * Builds an index map from LF-normalized text to original text.
 * Allows mapping exact matches in normalized space directly to character ranges in originalContent.
 */
export function buildNormToOrigMap(originalContent: string): { normSource: string; mapNormToOrig: number[] } {
  const mapNormToOrig: number[] = [];
  let normSource = "";
  let origIdx = 0;

  while (origIdx < originalContent.length) {
    if (originalContent[origIdx] === "\r" && originalContent[origIdx + 1] === "\n") {
      mapNormToOrig.push(origIdx);
      normSource += "\n";
      origIdx += 2;
    } else {
      mapNormToOrig.push(origIdx);
      normSource += originalContent[origIdx];
      origIdx += 1;
    }
  }
  mapNormToOrig.push(originalContent.length);
  return { normSource, mapNormToOrig };
}

// ─── Pure Patch Applicator ──────────────────────────────────────────────────

/**
 * Deterministic, pure function that applies exact search/replace edits to file content.
 *
 * Rules:
 * - Every `oldText` must match exactly once in `originalContent`.
 * - Handles canonical line-ending (CRLF vs LF) exact matching transparently without fuzzy matching.
 * - Spaces, indentation, quotes, syntax, and identifiers MUST match exactly.
 * - All edits are located against the SAME original content before any are applied.
 * - Edits must not overlap in their source ranges.
 * - Edits are applied from highest startIndex to lowest to preserve earlier offsets.
 * - Preserves the target file's original EOL style when writing newText.
 * - The function never mutates its inputs.
 */
export function applyPatchToFile(
  originalContent: string,
  edits: readonly FilePatchEdit[],
): PatchResult {
  // ── Guard: empty edit list ──
  if (!edits || edits.length === 0) {
    return {
      success: false,
      error: {
        code: "NO_PATCH_EDITS",
        message: "No patch edits provided. A modify action requires at least one edit.",
      },
    };
  }

  const sourceEol = detectEolStyle(originalContent);
  const usesCrlf = sourceEol === "CRLF" || (sourceEol === "MIXED" && originalContent.includes("\r\n"));

  // Pre-compute normalized map for line-ending-canonical exact matching
  const { normSource, mapNormToOrig } = buildNormToOrigMap(originalContent);

  // ── Phase 1: Validate each edit individually and locate it ──
  const resolved: ResolvedEdit[] = [];

  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];

    // Empty oldText
    if (edit.oldText === "") {
      return {
        success: false,
        error: {
          code: "EMPTY_PATCH_TARGET",
          message: `Edit ${i}: oldText is empty. Every patch edit must target a non-empty source string.`,
          editIndex: i,
        },
      };
    }

    // No-op check (considering EOL normalization)
    const normOld = edit.oldText.replace(/\r\n/g, "\n");
    const normNew = edit.newText.replace(/\r\n/g, "\n");
    if (edit.oldText === edit.newText || normOld === normNew) {
      return {
        success: false,
        error: {
          code: "NO_OP_PATCH_EDIT",
          message: `Edit ${i}: oldText and newText are identical. A modify edit must change something.`,
          editIndex: i,
        },
      };
    }

    let startIndex = -1;
    let endIndex = -1;
    let finalNewText = edit.newText;

    // Step 1A: Direct exact character match
    const directFirst = originalContent.indexOf(edit.oldText);
    if (directFirst !== -1) {
      const directSecond = originalContent.indexOf(edit.oldText, directFirst + 1);
      if (directSecond !== -1) {
        return {
          success: false,
          error: {
            code: "AMBIGUOUS_PATCH_TARGET",
            message: `Edit ${i}: oldText matches multiple locations in the file. Provide more surrounding context to make the target unique.`,
            editIndex: i,
          },
        };
      }
      startIndex = directFirst;
      endIndex = directFirst + edit.oldText.length;
      finalNewText = usesCrlf ? edit.newText.replace(/\r?\n/g, "\r\n") : edit.newText.replace(/\r\n/g, "\n");
    } else {
      // Step 1B: Line-ending canonical exact match (LF <-> CRLF conversion only, no whitespace or token fuzzing)
      const normFirst = normSource.indexOf(normOld);
      if (normFirst === -1) {
        return {
          success: false,
          error: {
            code: "PATCH_TARGET_NOT_FOUND",
            message: `Edit ${i}: oldText not found in the original file content.`,
            editIndex: i,
            diagnostics: {
              sourceLength: originalContent.length,
              oldTextLength: edit.oldText.length,
              sourceEol,
              oldTextEol: detectEolStyle(edit.oldText),
              exactMatch: false,
              eolNormalizedExactMatch: false,
            },
          },
        };
      }

      const normSecond = normSource.indexOf(normOld, normFirst + 1);
      if (normSecond !== -1) {
        return {
          success: false,
          error: {
            code: "AMBIGUOUS_PATCH_TARGET",
            message: `Edit ${i}: oldText matches multiple locations in the file. Provide more surrounding context to make the target unique.`,
            editIndex: i,
          },
        };
      }

      // Map back from normalized space to original indices
      startIndex = mapNormToOrig[normFirst];
      endIndex = mapNormToOrig[normFirst + normOld.length];
      finalNewText = usesCrlf ? edit.newText.replace(/\r?\n/g, "\r\n") : edit.newText.replace(/\r\n/g, "\n");
    }

    resolved.push({
      editIndex: i,
      startIndex,
      endIndex,
      newText: finalNewText,
    });
  }

  // ── Phase 2: Check for overlapping source ranges ──
  const sorted = [...resolved].sort((a, b) => a.startIndex - b.startIndex);

  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const curr = sorted[i];

    if (prev.endIndex > curr.startIndex) {
      return {
        success: false,
        error: {
          code: "OVERLAPPING_PATCH_EDITS",
          message: `Edits ${prev.editIndex} and ${curr.editIndex} have overlapping source ranges [${prev.startIndex}..${prev.endIndex}) and [${curr.startIndex}..${curr.endIndex}).`,
          editIndex: curr.editIndex,
        },
      };
    }
  }

  // ── Phase 3: Apply edits from highest startIndex to lowest ──
  const reverseOrder = [...sorted].reverse();

  let result = originalContent;

  for (const edit of reverseOrder) {
    result =
      result.substring(0, edit.startIndex) +
      edit.newText +
      result.substring(edit.endIndex);
  }

  return {
    success: true,
    content: result,
    appliedEdits: edits.length,
  };
}
