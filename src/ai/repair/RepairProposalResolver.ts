import { AgentFileChange } from "../shared/types";
import { FileManifest } from "../../types";
import { applyPatchToFile, FilePatchEdit, PatchErrorCode } from "../patch/PatchApplicator";
import { sha256 } from "../validation/FileVersionGuard";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";

// ─── Repair Proposal Types ──────────────────────────────────────────────────

export type RepairChangeProposal =
  | {
      path: string;
      action: "create";
      content: string;
      description: string;
    }
  | {
      path: string;
      action: "modify";
      edits: FilePatchEdit[];
      description: string;
    }
  | {
      path: string;
      action: "delete";
      content?: string;
      description: string;
      isDeleted?: boolean;
    };

// ─── Repair Resolution Errors ───────────────────────────────────────────────

export type RepairResolutionErrorCode =
  | "REPAIR_UNDECLARED_FILE"
  | "SCOPE_EXPANSION_REQUIRED"
  | "REPAIR_ACTION_MISMATCH"
  | "MODIFY_PATCH_REQUIRED"
  | "PATCH_SOURCE_FILE_NOT_FOUND"
  | PatchErrorCode;

export interface RepairResolutionError {
  code: RepairResolutionErrorCode;
  message: string;
  path: string;
  proposalIndex?: number;
}

export interface RepairResolutionSuccess {
  success: true;
  changes: AgentFileChange[];
  expectedSourceHashes: Record<string, string>;
}

export interface RepairResolutionFailure {
  success: false;
  error: RepairResolutionError;
}

export type RepairResolutionResult = RepairResolutionSuccess | RepairResolutionFailure;

// ─── Manifest Audit on Repair Proposals ────────────────────────────────────

/**
 * Compares repair proposals with the planning manifest for audit/provenance.
 * This result is not mutation authorization and must not gate execution.
 */
export function auditRepairManifestPlan(
  proposals: readonly RepairChangeProposal[],
  manifest: FileManifest | null | undefined,
): { valid: true } | { valid: false; error: RepairResolutionError } {
  if (!manifest || !Array.isArray(manifest.files)) {
    return { valid: true };
  }

  const manifestMap = new Map<string, "create" | "modify" | "delete">();
  for (const decl of manifest.files) {
    if (decl && typeof decl.path === "string") {
      manifestMap.set(normalizeRepoPath(decl.path), decl.action);
    }
  }

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];
    if (!proposal || typeof proposal.path !== "string") continue;

    const normPath = normalizeRepoPath(proposal.path);
    const declaredAction = manifestMap.get(normPath);

    if (!declaredAction) {
      return {
        valid: false,
        error: {
          code: "REPAIR_UNDECLARED_FILE",
          message: `Repair proposal for "${proposal.path}" was not present in the planning manifest.`,
          path: proposal.path,
          proposalIndex: i,
        },
      };
    }

    // For repair, files declared as CREATE or MODIFY can be repaired via MODIFY or CREATE.
    // Preserve action differences as legacy-coded audit observations.
    if (proposal.action === "delete" && declaredAction !== "delete") {
      return {
        valid: false,
        error: {
          code: "REPAIR_ACTION_MISMATCH",
          message: `Repair proposal for "${proposal.path}" requested deletion while the planning manifest proposed "${declaredAction}".`,
          path: proposal.path,
          proposalIndex: i,
        },
      };
    }

    if (declaredAction === "delete" && proposal.action !== "delete") {
      return {
        valid: false,
        error: {
          code: "REPAIR_ACTION_MISMATCH",
          message: `Repair proposal for "${proposal.path}" requested "${proposal.action}" while the planning manifest proposed deletion.`,
          path: proposal.path,
          proposalIndex: i,
        },
      };
    }
  }

  return { valid: true };
}

/** @deprecated Planning audit only. Use auditRepairManifestPlan. */
export const validateRepairManifestScope = auditRepairManifestPlan;

// ─── Repair Proposal Resolver ───────────────────────────────────────────────

/**
 * Resolves structured repair proposals into full AgentFileChange[] using PatchApplicator.
 *
 * Rules:
 * - MODIFY: proposal.edits must be non-empty and applied against exact currentFileContext.
 * - CREATE: content passes through.
 * - DELETE: converted to AgentFileChange with isDeleted/empty content.
 * - All-or-nothing: if any proposal fails, the entire repair attempt fails.
 * - Pure function: no direct disk I/O.
 */
export function resolveRepairProposals(
  proposals: readonly RepairChangeProposal[],
  currentFileContext: Readonly<Record<string, string>>,
): RepairResolutionResult {
  const changes: AgentFileChange[] = [];
  const expectedSourceHashes: Record<string, string> = {};

  for (let i = 0; i < proposals.length; i++) {
    const proposal = proposals[i];

    switch (proposal.action) {
      case "create": {
        changes.push({
          path: proposal.path,
          content: proposal.content,
          description: proposal.description,
          action: "create",
          editPrimitive: {
            type: "CREATE_FILE",
            path: proposal.path,
            content: proposal.content,
            description: proposal.description,
          },
        });
        break;
      }

      case "delete": {
        const normDeletePath = normalizeRepoPath(proposal.path);
        const deleteSource = Object.entries(currentFileContext).find(([ctxPath]) => normalizeRepoPath(ctxPath) === normDeletePath)?.[1];
        changes.push({
          path: proposal.path,
          content: "",
          description: proposal.description,
          action: "delete",
          isDeleted: true,
          editPrimitive: {
            type: "DELETE_FILE",
            path: proposal.path,
            description: proposal.description,
            expectedSourceFingerprint: deleteSource === undefined ? undefined : sha256(deleteSource),
          },
        });
        break;
      }

      case "modify": {
        if (!proposal.edits || !Array.isArray(proposal.edits) || proposal.edits.length === 0) {
          return {
            success: false,
            error: {
              code: "MODIFY_PATCH_REQUIRED",
              message: `Repair proposal ${i} (${proposal.path}): MODIFY action requires a non-empty edits[] array. Complete file replacement is forbidden.`,
              path: proposal.path,
              proposalIndex: i,
            },
          };
        }

        const normProposalPath = normalizeRepoPath(proposal.path);
        let originalContent: string | undefined;

        for (const [ctxPath, ctxContent] of Object.entries(currentFileContext)) {
          if (normalizeRepoPath(ctxPath) === normProposalPath) {
            originalContent = ctxContent;
            break;
          }
        }

        if (originalContent === undefined) {
          return {
            success: false,
            error: {
              code: "PATCH_SOURCE_FILE_NOT_FOUND",
              message: `Repair proposal ${i} (${proposal.path}): Current file content not found in repair context.`,
              path: proposal.path,
              proposalIndex: i,
            },
          };
        }

        // Anchor hash of exact source content used for patch resolution
        expectedSourceHashes[normProposalPath] = sha256(originalContent);

        const patchResult = applyPatchToFile(originalContent, proposal.edits);
        if (!patchResult.success) {
          return {
            success: false,
            error: {
              code: patchResult.error.code,
              message: `Repair proposal ${i} (${proposal.path}): Patch application failed — ${patchResult.error.message}`,
              path: proposal.path,
              proposalIndex: i,
            },
          };
        }

        changes.push({
          path: proposal.path,
          content: patchResult.content,
          description: proposal.description,
          action: "modify",
          editPrimitive: {
            type: "PATCH_HUNK",
            path: proposal.path,
            description: proposal.description,
            edits: proposal.edits,
            expectedSourceFingerprint: expectedSourceHashes[normProposalPath],
          },
        });
        break;
      }
    }
  }

  return { success: true, changes, expectedSourceHashes };
}
