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

// ─── Manifest Precheck on Repair Proposals ─────────────────────────────────

/**
 * Deterministically verifies that every repair proposal path exists in the approved manifest
 * and that the proposed action matches the declared manifest action.
 * ALL-OR-NOTHING: one violation fails the entire check.
 */
export function validateRepairManifestScope(
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
          message: `Repair proposal for "${proposal.path}" was rejected: file was not declared in the approved manifest.`,
          path: proposal.path,
          proposalIndex: i,
        },
      };
    }

    if (declaredAction !== proposal.action) {
      return {
        valid: false,
        error: {
          code: "REPAIR_ACTION_MISMATCH",
          message: `Repair proposal for "${proposal.path}" attempted action "${proposal.action}", but manifest authorized action "${declaredAction}".`,
          path: proposal.path,
          proposalIndex: i,
        },
      };
    }
  }

  return { valid: true };
}

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
        });
        break;
      }

      case "delete": {
        changes.push({
          path: proposal.path,
          content: "",
          description: proposal.description,
          action: "delete",
          isDeleted: true,
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
        });
        break;
      }
    }
  }

  return { success: true, changes, expectedSourceHashes };
}
