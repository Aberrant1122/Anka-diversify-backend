import { buildApprovedFilePlanSection } from "../generation/CodeGenerator";
import { FileManifest } from "../../types";

describe("CodeGenerator — Manifest Guidance & Approved File Plan Prompt Tests", () => {
  test("TEST A: Manifest files appear in prompt with exact actions", () => {
    const manifest: FileManifest = {
      files: [
        { path: "src/auth.ts", action: "modify", dependencies: [], description: "Update auth logic" },
        { path: "src/auth.test.ts", action: "create", dependencies: ["src/auth.ts"], description: "Add auth tests" },
        { path: "src/legacy.ts", action: "delete", dependencies: [], description: "Remove legacy code" },
      ],
      totalFiles: 3,
      manifestVersion: "1.0.0",
    };

    const section = buildApprovedFilePlanSection(manifest);

    expect(section).toContain("- MODIFY: src/auth.ts (Update auth logic)");
    expect(section).toContain("- CREATE: src/auth.test.ts (Add auth tests)");
    expect(section).toContain("- DELETE: src/legacy.ts (Remove legacy code)");
    expect(section).toContain("APPROVED FILE PLAN — MANDATORY EXECUTION SCOPE");
  });

  test("TEST B: Undeclared paths are not added by prompt construction", () => {
    const manifest: FileManifest = {
      files: [
        { path: "src/auth.ts", action: "modify", dependencies: [], description: "auth" },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const section = buildApprovedFilePlanSection(manifest);

    expect(section).toContain("- MODIFY: src/auth.ts (auth)");
    expect(section).not.toContain("- MODIFY: package.json");
    expect(section).not.toContain("- CREATE: package.json");
    expect(section).not.toContain("src/utils.ts");
  });

  test("TEST C: Windows/POSIX paths are not rewritten into invented paths", () => {
    const manifest: FileManifest = {
      files: [
        { path: "src/nested/service.ts", action: "create", dependencies: [], description: "Service" },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const section = buildApprovedFilePlanSection(manifest);

    expect(section).toContain("src/nested/service.ts");
  });

  test("TEST D: Empty/null/undefined manifest is handled deterministically", () => {
    expect(buildApprovedFilePlanSection(null)).toBe("");
    expect(buildApprovedFilePlanSection(undefined)).toBe("");
    expect(buildApprovedFilePlanSection({ files: [], totalFiles: 0, manifestVersion: "1.0.0" })).toBe("");
  });

  test("TEST E: Prompt explicitly states additional files are not allowed and requires explicit action", () => {
    const manifest: FileManifest = {
      files: [
        { path: "src/auth.ts", action: "modify", dependencies: [], description: "auth" },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const section = buildApprovedFilePlanSection(manifest);

    expect(section).toContain('Every generated change MUST explicitly set "action":');
    expect(section).toContain("Do NOT create additional helper files");
    expect(section).toContain("Do NOT modify package.json, config files, routes, or other files unless explicitly declared");
    expect(section).toContain("Stay strictly within the approved plan");
  });
});
