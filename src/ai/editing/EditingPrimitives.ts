import crypto from "crypto";
import fs from "fs";
import { FileEditingPrimitive } from "../../types";
import { applyPatchToFile } from "../patch/PatchApplicator";

export type EditingFailureCode =
  | "STALE_SOURCE"
  | "TARGET_NOT_FOUND"
  | "AMBIGUOUS_TARGET"
  | "CREATE_TARGET_EXISTS"
  | "MODIFY_TARGET_MISSING"
  | "DELETE_TARGET_MISSING"
  | "PATCH_CONTEXT_MISMATCH"
  | "EDIT_CONFLICT";

export class EditingConflictError extends Error {
  constructor(
    public readonly code: EditingFailureCode,
    message: string,
    public readonly path: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "EditingConflictError";
  }
}

export interface MaterializedPrimitive {
  readonly primitive: FileEditingPrimitive;
  readonly before: Buffer | null;
  readonly after: Buffer | null;
}

export function fingerprintBytes(bytes: Buffer | string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function assertFingerprint(primitive: FileEditingPrimitive, current: Buffer | null): void {
  if (!primitive.expectedSourceFingerprint) return;
  if (current === null || fingerprintBytes(current) !== primitive.expectedSourceFingerprint) {
    throw new EditingConflictError(
      "STALE_SOURCE",
      `Current bytes for "${primitive.path}" do not match the expected source fingerprint.`,
      primitive.path,
    );
  }
}

function requireCurrentFile(primitive: FileEditingPrimitive, current: Buffer | null): Buffer {
  if (current === null) {
    throw new EditingConflictError(
      primitive.type === "DELETE_FILE" ? "DELETE_TARGET_MISSING" : "MODIFY_TARGET_MISSING",
      `Target "${primitive.path}" does not exist in the current materialized repository.`,
      primitive.path,
    );
  }
  return current;
}

function exactOccurrences(source: string, target: string): number[] {
  if (!target) return [];
  const matches: number[] = [];
  let offset = 0;
  while (offset <= source.length - target.length) {
    const match = source.indexOf(target, offset);
    if (match < 0) break;
    matches.push(match);
    offset = match + target.length;
  }
  return matches;
}

function assertOccurrenceCount(
  primitive: FileEditingPrimitive,
  matches: readonly number[],
  expectedOccurrenceCount: number | undefined,
): number {
  const expected = expectedOccurrenceCount ?? 1;
  if (!Number.isInteger(expected) || expected < 1) {
    throw new EditingConflictError("EDIT_CONFLICT", "Expected occurrence count must be a positive integer.", primitive.path);
  }
  if (matches.length === 0 || matches.length < expected) {
    throw new EditingConflictError("TARGET_NOT_FOUND", `Expected ${expected} exact target occurrence(s), found ${matches.length}.`, primitive.path);
  }
  if (matches.length > expected) {
    throw new EditingConflictError("AMBIGUOUS_TARGET", `Expected ${expected} exact target occurrence(s), found ${matches.length}.`, primitive.path);
  }
  return expected;
}

function replaceAtMatches(source: string, matches: readonly number[], oldLength: number, replacement: string): string {
  let result = source;
  for (const index of [...matches].reverse()) {
    result = result.slice(0, index) + replacement + result.slice(index + oldLength);
  }
  return result;
}

/** Pure deterministic materialization against caller-supplied current bytes. */
export function materializeEditingPrimitive(
  primitive: FileEditingPrimitive,
  current: Buffer | null,
): MaterializedPrimitive {
  assertFingerprint(primitive, current);

  if (primitive.type === "CREATE_FILE") {
    if (current !== null) {
      throw new EditingConflictError("CREATE_TARGET_EXISTS", `Create target "${primitive.path}" already exists.`, primitive.path);
    }
    return { primitive, before: null, after: Buffer.from(primitive.content, "utf8") };
  }

  const currentBytes = requireCurrentFile(primitive, current);
  if (primitive.type === "DELETE_FILE") return { primitive, before: currentBytes, after: null };
  if (primitive.type === "REPLACE_FILE") {
    return { primitive, before: currentBytes, after: Buffer.from(primitive.content, "utf8") };
  }

  const source = currentBytes.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(currentBytes)) {
    throw new EditingConflictError(
      "EDIT_CONFLICT",
      `Target "${primitive.path}" is not lossless UTF-8; text editing would rewrite unrelated bytes.`,
      primitive.path,
    );
  }
  if (primitive.type === "PATCH_HUNK") {
    const result = applyPatchToFile(source, primitive.edits);
    if (!result.success) {
      const code = result.error.code === "AMBIGUOUS_PATCH_TARGET"
        ? "AMBIGUOUS_TARGET"
        : result.error.code === "PATCH_TARGET_NOT_FOUND"
          ? "PATCH_CONTEXT_MISMATCH"
          : "EDIT_CONFLICT";
      throw new EditingConflictError(code, result.error.message, primitive.path);
    }
    return { primitive, before: currentBytes, after: Buffer.from(result.content, "utf8") };
  }

  const target = primitive.type === "EXACT_REPLACE" ? primitive.oldText : primitive.anchor;
  const matches = exactOccurrences(source, target);
  assertOccurrenceCount(primitive, matches, primitive.expectedOccurrenceCount);
  const replacement = primitive.type === "EXACT_REPLACE"
    ? primitive.newText
    : primitive.type === "INSERT_BEFORE"
      ? primitive.content + primitive.anchor
      : primitive.anchor + primitive.content;
  const after = replaceAtMatches(source, matches, target.length, replacement);
  return { primitive, before: currentBytes, after: Buffer.from(after, "utf8") };
}

export function readCurrentBytes(filePath: string): Buffer | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error("Target is not a regular file");
    return fs.readFileSync(filePath);
  } catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
