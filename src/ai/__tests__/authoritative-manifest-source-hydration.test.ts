import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { AuthoritativeSourceHydrator } from "../manifest/AuthoritativeSourceHydrator";
import { resolveGenerationProposals, GeneratedChangeProposal } from "../generation/GenerationProposalResolver";
import { FileManifest } from "../../types";
import { verifyFileVersionsFromDisk } from "../validation/FileVersionGuard";

describe("AI Step 15 — Authoritative Manifest Source Hydration & Scope Protection", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-hydration-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  const setupRepoFiles = (files: Record<string, string>) => {
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(tempDir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, "utf8");
    }
  };

  test("Section 9 & 10E: Resolves MODIFY for app/layout.tsx when absent from semantic RAG context", () => {
    const layoutContent = `export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-white">{children}</body>
    </html>
  );
}`;
    const pageContent = `export default function Page() { return <main>Calculator Page</main>; }`;
    const calcContent = `"use client"; export default function Calculator() { return <div>Calc</div>; }`;
    const cssContent = `.calc-btn { color: red; }`;
    const pkgContent = `{"name": "calc-app", "dependencies": {"react": "^18.0.0", "next": "14.0.0"}}`;

    setupRepoFiles({
      "app/layout.tsx": layoutContent,
      "app/page.tsx": pageContent,
      "app/components/Calculator.tsx": calcContent,
      "app/styles/calculator.css": cssContent,
      "package.json": pkgContent,
    });

    const canonicalExistingFiles = [
      "app/layout.tsx",
      "app/page.tsx",
      "app/components/Calculator.tsx",
      "app/styles/calculator.css",
      "package.json",
    ];

    // Semantic retrieval context deliberately contains ONLY 3 files (omits app/layout.tsx)
    const semanticFileContext: Record<string, string> = {
      "app/page.tsx": pageContent,
      "app/components/Calculator.tsx": calcContent,
      "app/styles/calculator.css": cssContent,
    };

    // Approved manifest contains MODIFY for app/layout.tsx
    const approvedManifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 4,
      files: [
        { path: "app/page.tsx", action: "modify", dependencies: [], description: "Update page" },
        { path: "app/components/Calculator.tsx", action: "modify", dependencies: [], description: "Update calc" },
        { path: "app/styles/calculator.css", action: "modify", dependencies: [], description: "Update styles" },
        { path: "app/layout.tsx", action: "modify", dependencies: [], description: "Update layout wrapper" },
      ],
    };

    // 1. Hydrate modify sources
    const hydration = AuthoritativeSourceHydrator.hydrateModifySources(
      approvedManifest,
      tempDir,
      canonicalExistingFiles,
      semanticFileContext,
    );

    expect(hydration.success).toBe(true);
    expect(hydration.modifyTargetsCount).toBe(4);
    expect(hydration.hydratedCount).toBe(4);
    expect(hydration.missingCount).toBe(0);
    expect(hydration.authoritativeModifySources["app/layout.tsx"]).toBeDefined();
    expect(hydration.authoritativeModifySources["app/layout.tsx"].content).toBe(layoutContent);
    expect(hydration.mergedSourceMap["app/layout.tsx"]).toBe(layoutContent);

    // 2. Proposal Resolution for app/layout.tsx succeeds without PATCH_SOURCE_FILE_NOT_FOUND
    const proposals: GeneratedChangeProposal[] = [
      {
        path: "app/layout.tsx",
        action: "modify",
        description: "Dark mode body class",
        edits: [
          {
            oldText: `<body className="bg-white">{children}</body>`,
            newText: `<body className="bg-slate-950 text-white">{children}</body>`,
          },
        ],
      },
      {
        path: "app/page.tsx",
        action: "modify",
        description: "Center calculator",
        edits: [
          {
            oldText: `<main>Calculator Page</main>`,
            newText: `<main className="flex justify-center"><Calculator /></main>`,
          },
        ],
      },
    ];

    const resolution = resolveGenerationProposals(proposals, hydration.mergedSourceMap);

    expect(resolution.success).toBe(true);
    if (!resolution.success) return;

    expect(resolution.changes).toHaveLength(2);
    expect(resolution.changes[0].path).toBe("app/layout.tsx");
    expect(resolution.changes[0].content).toContain("bg-slate-950");
  });

  test("Section 10A & 10B: CREATE targets require no source hydration", () => {
    const pageContent = `export default function Page() { return <div>Home</div>; }`;
    setupRepoFiles({ "app/page.tsx": pageContent });

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 2,
      files: [
        { path: "app/page.tsx", action: "modify", dependencies: [], description: "Modify page" },
        { path: "app/components/NewBadge.tsx", action: "create", dependencies: [], description: "Create new badge" },
      ],
    };

    const hydration = AuthoritativeSourceHydrator.hydrateModifySources(
      manifest,
      tempDir,
      ["app/page.tsx"],
      {},
    );

    expect(hydration.success).toBe(true);
    expect(hydration.modifyTargetsCount).toBe(1);
    expect(hydration.hydratedCount).toBe(1);
    expect(hydration.authoritativeModifySources["app/components/NewBadge.tsx"]).toBeUndefined();
    expect(hydration.authoritativeModifySources["app/page.tsx"]).toBeDefined();
  });

  test("Section 10D: Missing approved MODIFY source fails closed with [MANIFEST_SOURCE_HYDRATION_FAILED]", () => {
    // Repo does not have app/missing-file.tsx
    setupRepoFiles({ "app/page.tsx": "content" });

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [
        { path: "app/missing-file.tsx", action: "modify", dependencies: [], description: "Missing target" },
      ],
    };

    const hydration = AuthoritativeSourceHydrator.hydrateModifySources(
      manifest,
      tempDir,
      ["app/page.tsx"],
      {},
    );

    expect(hydration.success).toBe(false);
    expect(hydration.missingCount).toBe(1);
    expect(hydration.error).toContain("[MANIFEST_SOURCE_HYDRATION_FAILED]");
    expect(hydration.error).toContain("app/missing-file.tsx");
  });

  test("Section 10G & 10H: Source content comes from current worktree and SHA matches across pipeline", async () => {
    const worktreeLayout = `export default function RootLayout() { return <div>Worktree Version</div>; }`;
    setupRepoFiles({ "app/layout.tsx": worktreeLayout });

    const expectedSha = crypto.createHash("sha256").update(worktreeLayout, "utf8").digest("hex");

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "app/layout.tsx", action: "modify", dependencies: [], description: "Modify layout" }],
    };

    const hydration = AuthoritativeSourceHydrator.hydrateModifySources(
      manifest,
      tempDir,
      ["app/layout.tsx"],
      {},
    );

    expect(hydration.authoritativeModifySources["app/layout.tsx"].sha256).toBe(expectedSha);

    const proposals: GeneratedChangeProposal[] = [
      {
        path: "app/layout.tsx",
        action: "modify",
        description: "Update",
        edits: [
          {
            oldText: `<div>Worktree Version</div>`,
            newText: `<div>Updated Worktree Version</div>`,
          },
        ],
      },
    ];

    const resolution = resolveGenerationProposals(proposals, hydration.mergedSourceMap);
    expect(resolution.success).toBe(true);
    if (!resolution.success) return;

    expect(resolution.expectedSourceHashes?.["app/layout.tsx"]).toBe(expectedSha);

    // Verify FileVersionGuard passes against disk before mutation
    const diskGuard = await verifyFileVersionsFromDisk(resolution.expectedSourceHashes!, tempDir);
    expect(diskGuard.valid).toBe(true);
  });

  test("Section 10I: Stale disk mutation triggers FILE_VERSION_MISMATCH", async () => {
    const initialContent = `export default function Test() { return 1; }`;
    setupRepoFiles({ "src/test.ts": initialContent });

    const initialSha = crypto.createHash("sha256").update(initialContent, "utf8").digest("hex");

    // External process mutates file on disk
    fs.writeFileSync(path.join(tempDir, "src/test.ts"), `export default function Test() { return 2; }`, "utf8");

    const expectedHashes = { "src/test.ts": initialSha };
    const guardResult = await verifyFileVersionsFromDisk(expectedHashes, tempDir);

    expect(guardResult.valid).toBe(false);
    if (!guardResult.valid) {
      expect(guardResult.error.code).toBe("STALE_SOURCE_FILE");
      expect(guardResult.error.path).toBe("src/test.ts");
    }
  });

  test("Section 10J: Optional RAG context can be completely empty without losing MODIFY hydration", () => {
    setupRepoFiles({ "src/util.ts": "export const a = 1;" });

    const manifest: FileManifest = {
      manifestVersion: "1.0.0",
      totalFiles: 1,
      files: [{ path: "src/util.ts", action: "modify", dependencies: [], description: "Modify util" }],
    };

    // Semantic retrieval is completely empty
    const hydration = AuthoritativeSourceHydrator.hydrateModifySources(manifest, tempDir, ["src/util.ts"], {});

    expect(hydration.success).toBe(true);
    expect(hydration.authoritativeModifySources["src/util.ts"].content).toBe("export const a = 1;");
  });
});
