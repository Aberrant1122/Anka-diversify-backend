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

// ─── Pure Patch Applicator ──────────────────────────────────────────────────

/**
 * Deterministic, pure function that applies exact search/replace edits to file content.
 *
 * Rules:
 * - Every `oldText` must match exactly once in `originalContent` (exact byte match).
 * - All edits are located against the SAME original content before any are applied.
 * - Edits must not overlap in their source ranges.
 * - Edits are applied from highest startIndex to lowest to preserve earlier offsets.
 * - The function never mutates its inputs.
 * - No fuzzy matching, no regex, no whitespace normalization.
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

    // No-op check
    if (edit.oldText === edit.newText) {
      return {
        success: false,
        error: {
          code: "NO_OP_PATCH_EDIT",
          message: `Edit ${i}: oldText and newText are identical. A modify edit must change something.`,
          editIndex: i,
        },
      };
    }

    // Exact match: find all occurrences
    const firstIndex = originalContent.indexOf(edit.oldText);
    if (firstIndex === -1) {
      return {
        success: false,
        error: {
          code: "PATCH_TARGET_NOT_FOUND",
          message: `Edit ${i}: oldText not found in the original file content.`,
          editIndex: i,
        },
      };
    }

    // Check for second occurrence (ambiguity)
    const secondIndex = originalContent.indexOf(edit.oldText, firstIndex + 1);
    if (secondIndex !== -1) {
      return {
        success: false,
        error: {
          code: "AMBIGUOUS_PATCH_TARGET",
          message: `Edit ${i}: oldText matches multiple locations in the file. Provide more surrounding context to make the target unique.`,
          editIndex: i,
        },
      };
    }

    resolved.push({
      editIndex: i,
      startIndex: firstIndex,
      endIndex: firstIndex + edit.oldText.length,
      newText: edit.newText,
    });
  }

  // ── Phase 2: Check for overlapping source ranges ──
  // Sort by startIndex ascending for overlap checking
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
  // Applying in reverse order ensures earlier character positions are not shifted.
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
