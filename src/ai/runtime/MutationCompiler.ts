import { FileEditingPrimitive } from "../../types";
import { EditingConflictError, fingerprintBytes, materializeEditingPrimitive } from "../editing/EditingPrimitives";

export type MutationFailureCode =
  | "MUTATION_IR_INVALID" | "EDIT_ANCHOR_NOT_FOUND" | "EDIT_ANCHOR_AMBIGUOUS"
  | "FILE_HASH_MISMATCH" | "FILE_REVISION_CHANGED" | "MANIFEST_SCOPE_MISMATCH"
  | "REPAIR_SCHEMA_INVALID" | "REPAIR_SCOPE_EXPANSION_REQUIRED" | "REINVESTIGATION_REQUIRED"
  | "REPAIR_UNRESOLVED" | "TRANSACTION_REVISION_DIVERGED" | "WORKSPACE_BINDING_INVALID"
  | "CAPABILITY_MANIFEST_MISMATCH" | "TRANSACTION_INVALIDATED" | "TRANSACTION_CONFLICT";

export class MutationFailure extends Error {
  constructor(public readonly code: MutationFailureCode, message: string) {
    super(message);
    this.name = "MutationFailure";
  }
}

interface MutationBase { readonly path: string; readonly expectedFileHash: string | null }
export type MutationOperation = MutationBase & (
  | { readonly op: "replace_exact"; readonly oldText: string; readonly newText: string }
  | { readonly op: "insert_before" | "insert_after"; readonly anchor: string; readonly content: string }
  | { readonly op: "create_file"; readonly content: string }
  | { readonly op: "delete_file" }
);

export interface CompiledMutation {
  readonly operation: MutationOperation;
  readonly before: string | null;
  readonly after: string | null;
}

const protectedSegments = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".anka-cache", ".turbo"]);
export function mutationPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && !/[\\:\0]/.test(value) && value.split("/").every(s => !!s && s !== "." && s !== ".." && !protectedSegments.has(s.toLowerCase()));
}

/** Pure compiler. Its output is data, never an execution credential. Runtime recompiles it. */
export class MutationCompiler {
  static editingConflict(error: EditingConflictError): MutationFailure {
    return new MutationFailure(error.code === "STALE_SOURCE" ? "FILE_HASH_MISMATCH"
      : error.code === "TARGET_NOT_FOUND" ? "EDIT_ANCHOR_NOT_FOUND"
      : error.code === "AMBIGUOUS_TARGET" ? "EDIT_ANCHOR_AMBIGUOUS" : "MUTATION_IR_INVALID", error.message);
  }
  static parse(value: unknown): readonly MutationOperation[] {
    const invalid = (message: string): never => { throw new MutationFailure("MUTATION_IR_INVALID", message); };
    if (!Array.isArray(value) || !value.length || value.length > 100) return invalid("Expected 1–100 canonical mutation operations.");
    return Object.freeze(value.map((item: unknown) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return invalid("Mutation must be an object.");
      const v = item as Record<string, unknown>;
      const fields: Record<string, readonly string[]> = {
        replace_exact: ["oldText", "newText"], insert_before: ["anchor", "content"],
        insert_after: ["anchor", "content"], create_file: ["content"], delete_file: [],
      };
      if (typeof v.op !== "string" || !Object.prototype.hasOwnProperty.call(fields, v.op)) return invalid("Use an explicit canonical operation; generic modify is not supported.");
      const allowed = ["op", "path", "expectedFileHash", ...fields[v.op]];
      if (Object.keys(v).some(k => !allowed.includes(k)) || allowed.some(k => !Object.prototype.hasOwnProperty.call(v, k))) return invalid("Unexpected or missing mutation fields.");
      if (!mutationPath(v.path)) return invalid("Mutation path must be an unprotected canonical repository-relative path.");
      if (v.op === "create_file" ? v.expectedFileHash !== null : typeof v.expectedFileHash !== "string" || !/^[a-f0-9]{64}$/.test(v.expectedFileHash)) return invalid("Mutation requires the current file hash (null for CREATE).");
      if (fields[v.op].some(k => typeof v[k] !== "string")) return invalid("Operation text must be a string.");
      if (v.op === "replace_exact" && (!v.oldText || v.oldText === v.newText)) return invalid("replace_exact requires non-empty oldText and a real change.");
      if ((v.op === "insert_before" || v.op === "insert_after") && (!v.anchor || !v.content)) return invalid("Insertion requires a non-empty anchor and content.");
      return Object.freeze({ ...v }) as unknown as MutationOperation;
    }));
  }

  static compile(value: unknown, files: ReadonlyMap<string, string>): readonly CompiledMutation[] {
    const virtual = new Map(files);
    return Object.freeze(this.parse(value).map(operation => {
      const before = virtual.get(operation.path) ?? null;
      const bytes = before === null ? null : Buffer.from(before, "base64");
      if ((bytes === null ? null : fingerprintBytes(bytes)) !== operation.expectedFileHash) {
        throw new MutationFailure("FILE_HASH_MISMATCH", `Current hash differs for ${operation.path}.`);
      }
      const common = { path: operation.path, description: operation.op };
      let primitive: FileEditingPrimitive;
      switch (operation.op) {
        case "create_file": primitive = { ...common, type: "CREATE_FILE", content: operation.content }; break;
        case "delete_file": primitive = { ...common, type: "DELETE_FILE" }; break;
        case "replace_exact": primitive = { ...common, type: "EXACT_REPLACE", oldText: operation.oldText, newText: operation.newText }; break;
        default: primitive = { ...common, type: operation.op === "insert_before" ? "INSERT_BEFORE" : "INSERT_AFTER", anchor: operation.anchor, content: operation.content };
      }
      try {
        const after = materializeEditingPrimitive(primitive, bytes).after?.toString("base64") ?? null;
        if (after === null) virtual.delete(operation.path); else virtual.set(operation.path, after);
        return Object.freeze({ operation, before, after });
      } catch (error) {
        if (!(error instanceof EditingConflictError)) throw error;
        throw this.editingConflict(error);
      }
    }));
  }
}
