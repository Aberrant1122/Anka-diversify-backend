import { AgentFileChange } from "../shared/types";
import { applyPatchToFile, FilePatchEdit, PatchErrorCode } from "../patch/PatchApplicator";
import { sha256 } from "../validation/FileVersionGuard";

// ─── Generation Proposal Types (internal to CodeGenerator) ──────────────────

/**
 * A single generated file change proposal as returned by the LLM.
 * This is the internal representation used ONLY between CodeGenerator
 * and the resolver. Downstream consumers always receive AgentFileChange.
 */
export type GeneratedChangeProposal =
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
      content: "";
      description: string;
      isDeleted: true;
    };

// ─── Resolution Error Types ─────────────────────────────────────────────────

export type ProposalResolutionErrorCode =
  | "MODIFY_PATCH_REQUIRED"
  | "PATCH_SOURCE_FILE_NOT_FOUND"
  | PatchErrorCode;

export interface ProposalResolutionError {
  code: ProposalResolutionErrorCode;
  message: string;
  path: string;
  proposalIndex: number;
}

export interface ResolutionSuccess {
  success: true;
  changes: AgentFileChange[];
  /**
   * SHA-256 hex of the authoritative source content used for each MODIFY resolution.
   * Keyed by canonical POSIX path. Only MODIFY files are included.
   */
  expectedSourceHashes: Record<string, string>;
}

export interface ResolutionFailure {
  success: false;
  error: ProposalResolutionError;
}

export type ResolutionResult = ResolutionSuccess | ResolutionFailure;

// ─── Path Normalization ─────────────────────────────────────────────────────

/**
 * Normalize a file path to forward-slash POSIX form for canonical comparison.
 */
function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

// ─── Resolver ───────────────────────────────────────────────────────────────

/**
 * Resolves raw LLM generation proposals into AgentFileChange[] using PatchApplicator.
 *
 * Rules:
 * - CREATE: content passes through unchanged.
 * - DELETE: converted to AgentFileChange with isDeleted/empty content.
 * - MODIFY: edits[] are resolved via PatchApplicator against authoritative file content.
 * - Resolution is ALL-OR-NOTHING: one failed proposal fails the entire batch.
 * - No disk I/O; pure function using provided fileContext.
 * - Never mutates input proposals or fileContext.
 */
export function resolveGenerationProposals(
  proposals: readonly GeneratedChangeProposal[],
  // eslint-disable-next-line @typescript-eslint/no-shadow
  fileContext: Readonly<Record<string, string>>,
): ResolutionResult {
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
        // Guard: MODIFY must have edits[]
        if (!proposal.edits || !Array.isArray(proposal.edits) || proposal.edits.length === 0) {
          return {
            success: false,
            error: {
              code: "MODIFY_PATCH_REQUIRED",
              message: `Proposal ${i} (${proposal.path}): MODIFY action requires a non-empty edits[] array. Full-file replacement is not permitted for modify operations.`,
              path: proposal.path,
              proposalIndex: i,
            },
          };
        }

        // Locate authoritative file content
        const normalizedProposalPath = normalizePath(proposal.path);
        let originalContent: string | undefined;

        for (const [contextPath, contextContent] of Object.entries(fileContext)) {
          if (normalizePath(contextPath) === normalizedProposalPath) {
            originalContent = contextContent;
            break;
          }
        }

        if (originalContent === undefined) {
          return {
            success: false,
            error: {
              code: "PATCH_SOURCE_FILE_NOT_FOUND",
              message: `Proposal ${i} (${proposal.path}): Cannot resolve MODIFY patch — the file was not found in the generation context. The authoritative source content is required to apply search/replace edits.`,
              path: proposal.path,
              proposalIndex: i,
            },
          };
        }

        // Record expected source hash for stale-file detection
        expectedSourceHashes[normalizedProposalPath] = sha256(originalContent);

        // Apply patch
        const patchResult = applyPatchToFile(originalContent, proposal.edits);

        if (!patchResult.success) {
          return {
            success: false,
            error: {
              code: patchResult.error.code,
              message: `Proposal ${i} (${proposal.path}): Patch resolution failed — ${patchResult.error.message}`,
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
