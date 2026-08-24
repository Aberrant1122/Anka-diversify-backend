import crypto from "crypto";
import fs from "fs";
import path from "path";

// ─── Content Hash ───────────────────────────────────────────────────────────

/**
 * Compute a SHA-256 hex digest of the exact UTF-8 string content.
 * No trimming, no whitespace normalization, no CRLF conversion.
 */
export function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

// ─── Path Normalization ─────────────────────────────────────────────────────

function normalizePath(p: string): string {
  return p.replace(/\\/g, "/");
}

// ─── Types ──────────────────────────────────────────────────────────────────

export type FileVersionErrorCode =
  | "STALE_SOURCE_FILE"
  | "SOURCE_FILE_DISAPPEARED";

export interface FileVersionError {
  code: FileVersionErrorCode;
  path: string;
  message: string;
  expectedHashPrefix?: string;
  actualHashPrefix?: string;
}

export interface FileVersionSuccess {
  valid: true;
  verifiedFiles: number;
}

export interface FileVersionFailure {
  valid: false;
  error: FileVersionError;
}

export type FileVersionResult = FileVersionSuccess | FileVersionFailure;

// ─── Pure Version Guard (for testing with provided current content) ─────────

/**
 * Verifies that the current file contents match the expected source hashes
 * that were used during patch resolution.
 *
 * Pure function: receives current file content as a Record, no disk I/O.
 * All-or-nothing: one mismatch fails the entire validation.
 *
 * @param expectedSourceHashes - Map of canonical path → SHA-256 of content
 *                               used during patch resolution (MODIFY only).
 * @param currentFiles         - Map of canonical path → current content string.
 *                               A missing key means the file no longer exists.
 */
export function verifyExpectedFileVersions(
  expectedSourceHashes: Readonly<Record<string, string>>,
  currentFiles: Readonly<Record<string, string | null>>,
): FileVersionResult {
  const entries = Object.entries(expectedSourceHashes);

  for (const [rawPath, expectedHash] of entries) {
    const canonicalPath = normalizePath(rawPath);
    // Find the current file content by normalized path
    let currentContent: string | null | undefined;
    let found = false;

    for (const [currentPath, content] of Object.entries(currentFiles)) {
      if (normalizePath(currentPath) === canonicalPath) {
        currentContent = content;
        found = true;
        break;
      }
    }

    if (!found || currentContent === null || currentContent === undefined) {
      return {
        valid: false,
        error: {
          code: "SOURCE_FILE_DISAPPEARED",
          path: canonicalPath,
          message: `File "${canonicalPath}" existed during patch resolution but is now missing from the repository.`,
          expectedHashPrefix: expectedHash.slice(0, 12),
        },
      };
    }

    const actualHash = sha256(currentContent);

    if (actualHash !== expectedHash) {
      return {
        valid: false,
        error: {
          code: "STALE_SOURCE_FILE",
          path: canonicalPath,
          message: `File "${canonicalPath}" has changed since patch resolution. The file on disk no longer matches the content used to generate edits.`,
          expectedHashPrefix: expectedHash.slice(0, 12),
          actualHashPrefix: actualHash.slice(0, 12),
        },
      };
    }
  }

  return {
    valid: true,
    verifiedFiles: entries.length,
  };
}

// ─── Disk-Reading Version Guard ─────────────────────────────────────────────

/**
 * Reads current file content from the bounded repository root and verifies
 * against expected source hashes. ALL-OR-NOTHING: one mismatch rejects all.
 *
 * @param expectedSourceHashes - Map of canonical path → SHA-256 hex.
 * @param repositoryRoot       - Absolute path to the bounded repository root.
 *                               Never falls back to process.cwd().
 */
export async function verifyFileVersionsFromDisk(
  expectedSourceHashes: Readonly<Record<string, string>>,
  repositoryRoot: string,
): Promise<FileVersionResult> {
  const currentFiles: Record<string, string | null> = {};

  for (const rawPath of Object.keys(expectedSourceHashes)) {
    const canonicalPath = normalizePath(rawPath);
    const absPath = path.join(repositoryRoot, canonicalPath);

    try {
      if (fs.existsSync(absPath)) {
        const content = await fs.promises.readFile(absPath, "utf8");
        currentFiles[canonicalPath] = content;
      } else {
        currentFiles[canonicalPath] = null;
      }
    } catch {
      currentFiles[canonicalPath] = null;
    }
  }

  return verifyExpectedFileVersions(expectedSourceHashes, currentFiles);
}
