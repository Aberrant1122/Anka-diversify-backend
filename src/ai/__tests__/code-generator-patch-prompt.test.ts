import { buildApprovedFilePlanSection } from "../generation/CodeGenerator";
import { FileManifest } from "../../types";

describe("CodeGenerator — Patch-Aware Prompt Format Tests", () => {
  const manifest: FileManifest = {
    files: [
      { path: "src/auth.ts", action: "modify", dependencies: [], description: "Update auth" },
      { path: "src/new.ts", action: "create", dependencies: [], description: "New file" },
      { path: "src/old.ts", action: "delete", dependencies: [], description: "Remove old" },
    ],
    totalFiles: 3,
    manifestVersion: "1.0.0",
  };

  const section = buildApprovedFilePlanSection(manifest);

  // ── TEST A: MODIFY instructions require edits[] ──
  test("TEST A: MODIFY instructions require edits[]", () => {
    expect(section).toContain("edits");
    expect(section).toContain('"action": "modify"');
    expect(section).toContain('"oldText"');
    expect(section).toContain('"newText"');
  });

  // ── TEST B: Prompt explicitly prohibits full-file content for MODIFY ──
  test("TEST B: Prompt explicitly prohibits full-file content for MODIFY", () => {
    expect(section).toContain("Do NOT output complete file content for modify");
  });

  // ── TEST C: CREATE still requires complete content ──
  test("TEST C: CREATE still requires complete content", () => {
    expect(section).toContain('"action": "create"');
    expect(section).toContain("100% complete new file");
  });

  // ── TEST D: DELETE keeps existing representation ──
  test("TEST D: DELETE keeps existing deletion marker representation", () => {
    expect(section).toContain('"action": "delete"');
    expect(section).toContain('"isDeleted": true');
    expect(section).toContain('"content": ""');
  });

  // ── TEST E: Prompt tells model oldText must be exact source ──
  test("TEST E: Prompt tells model oldText must be exact source", () => {
    expect(section).toContain("copied EXACTLY from the provided full file context");
    expect(section).toContain("Exact byte match required");
  });

  // ── TEST F: Prompt prohibits line-number/unified-diff/ellipsis patch syntax ──
  test("TEST F: Prompt prohibits line-number/unified-diff/ellipsis patch syntax", () => {
    expect(section).toContain("Do NOT use line numbers");
    expect(section).toContain("Do NOT use unified diff syntax");
    expect(section).toContain("Do NOT use ellipses");
    expect(section).toContain("// existing code");
  });
});
