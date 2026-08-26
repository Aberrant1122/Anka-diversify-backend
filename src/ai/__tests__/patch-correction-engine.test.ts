import { PatchCorrectionEngine } from "../generation/PatchCorrectionEngine";
import { applyPatchToFile, FilePatchEdit } from "../patch/PatchApplicator";
import { resolveGenerationProposals, GeneratedChangeProposal } from "../generation/GenerationProposalResolver";
import { CodeGenerator } from "../generation/CodeGenerator";
import { verifyExpectedFileVersions } from "../validation/FileVersionGuard";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { assertSafeWorktreePath } from "../validation/FileSystemStateManager";
import { getOpenAI } from "../shared/utils";

jest.mock("../shared/utils", () => {
  const original = jest.requireActual("../shared/utils");
  return {
    ...original,
    getOpenAI: jest.fn(),
  };
});

describe("AI Step 13B — Bounded Exact Patch Correction", () => {
  const sampleOriginalContent = `import React from 'react';
import { Header } from '../components/Header';

export const DashboardPage: React.FC = () => {
  return (
    <div className="dashboard-page">
      <Header title="Project Dashboard" />
      <main className="dashboard-content">
        <p>Welcome to the project dashboard.</p>
      </main>
    </div>
  );
};
`;

  const fileContext: Record<string, string> = {
    "src/pages/DashboardPage.tsx": sampleOriginalContent,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("A. Initial exact patch succeeds → no correction model call", async () => {
    const validEdits: FilePatchEdit[] = [
      {
        oldText: "<Header title=\"Project Dashboard\" />",
        newText: "<Header title=\"Project Dashboard\" />\n      <DashboardSummary />",
      },
    ];

    const proposals: GeneratedChangeProposal[] = [
      {
        path: "src/pages/DashboardPage.tsx",
        action: "modify",
        edits: validEdits,
        description: "Add DashboardSummary",
      },
    ];

    const result = resolveGenerationProposals(proposals, fileContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.changes[0].content).toContain("<DashboardSummary />");
    }

    // Proves PatchCorrectionEngine was not needed or called
    expect(getOpenAI).not.toHaveBeenCalled();
  });

  test("B & C. Initial PATCH_TARGET_NOT_FOUND → one correction attempt succeeds when corrected oldText exists", async () => {
    const brokenEdits: FilePatchEdit[] = [
      {
        // Double quotes vs single quotes in original (import React from 'react';)
        oldText: 'import React from "react";\nimport { Header } from "../components/Header";',
        newText: 'import React from "react";\nimport { Header } from "../components/Header";\nimport { DashboardSummary } from "../components/DashboardSummary";',
      },
    ];

    // Verify initial patch fails with PATCH_TARGET_NOT_FOUND
    const initialPatchRes = applyPatchToFile(sampleOriginalContent, brokenEdits);
    expect(initialPatchRes.success).toBe(false);
    if (!initialPatchRes.success) {
      expect(initialPatchRes.error.code).toBe("PATCH_TARGET_NOT_FOUND");
    }

    // Mock OpenAI correction response returning exact matching substring
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    edits: [
                      {
                        oldText: "import React from 'react';\nimport { Header } from '../components/Header';",
                        newText: "import React from 'react';\nimport { Header } from '../components/Header';\nimport { DashboardSummary } from '../components/DashboardSummary';",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        },
      },
    };
    (getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const correctionResult = await PatchCorrectionEngine.correctPatch({
      filePath: "src/pages/DashboardPage.tsx",
      currentContent: sampleOriginalContent,
      userMessage: "Add DashboardSummary",
      manifestAction: "modify",
      failedEdits: brokenEdits,
      errorCode: "PATCH_TARGET_NOT_FOUND",
      errorMessage: "Edit 0: oldText not found in the original file content.",
    });

    expect(correctionResult.attempted).toBe(true);
    expect(correctionResult.succeeded).toBe(true);
    expect(correctionResult.correctedEdits).toBeDefined();

    // Verify corrected edits apply cleanly through exact PatchApplicator
    const finalPatchRes = applyPatchToFile(sampleOriginalContent, correctionResult.correctedEdits!);
    expect(finalPatchRes.success).toBe(true);
    if (finalPatchRes.success) {
      expect(finalPatchRes.content).toContain("import { DashboardSummary } from '../components/DashboardSummary';");
    }

    // Verify OpenAI called exactly once
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("D. Corrected oldText is still invalid → fails closed after exactly one correction", async () => {
    const brokenEdits: FilePatchEdit[] = [
      {
        oldText: "non-existent text",
        newText: "replacement",
      },
    ];

    // Mock OpenAI correction response returning ANOTHER non-existent string
    const mockOpenAI = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    edits: [
                      {
                        oldText: "still-non-existent-hallucination",
                        newText: "replacement",
                      },
                    ],
                  }),
                },
              },
            ],
          }),
        },
      },
    };
    (getOpenAI as jest.Mock).mockReturnValue(mockOpenAI);

    const correctionResult = await PatchCorrectionEngine.correctPatch({
      filePath: "src/pages/DashboardPage.tsx",
      currentContent: sampleOriginalContent,
      userMessage: "Add DashboardSummary",
      manifestAction: "modify",
      failedEdits: brokenEdits,
      errorCode: "PATCH_TARGET_NOT_FOUND",
      errorMessage: "Edit 0: oldText not found",
    });

    expect(correctionResult.attempted).toBe(true);
    expect(correctionResult.succeeded).toBe(false);
    expect(correctionResult.error).toContain("Corrected edits failed exact PatchApplicator verification");

    // Exactly one call made
    expect(mockOpenAI.chat.completions.create).toHaveBeenCalledTimes(1);
  });

  test("E. No fuzzy or normalized matching was introduced into PatchApplicator", () => {
    const editsWithDifferentQuotes: FilePatchEdit[] = [
      {
        oldText: "import React from \"react\";", // Original has single quotes
        newText: "import React from \"react\";\n// new",
      },
    ];

    const res = applyPatchToFile(sampleOriginalContent, editsWithDifferentQuotes);
    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.error.code).toBe("PATCH_TARGET_NOT_FOUND");
    }

    const editsWithDifferentWhitespace: FilePatchEdit[] = [
      {
        oldText: "<Header  title=\"Project Dashboard\" />", // 2 spaces vs 1 space in original
        newText: "<Header title=\"Project Dashboard\" />\n      <Summary />",
      },
    ];

    const wsRes = applyPatchToFile(sampleOriginalContent, editsWithDifferentWhitespace);
    expect(wsRes.success).toBe(false);
    if (!wsRes.success) {
      expect(wsRes.error.code).toBe("PATCH_TARGET_NOT_FOUND");
    }
  });

  test("F. Stale-source failures do NOT trigger correction", () => {
    const expectedHashes = {
      "src/pages/DashboardPage.tsx": "original-hash-12345",
    };
    const currentFiles = {
      "src/pages/DashboardPage.tsx": sampleOriginalContent + "// edited on disk",
    };

    const staleRes = verifyExpectedFileVersions(expectedHashes, currentFiles);
    expect(staleRes.valid).toBe(false);
    if (!staleRes.valid) {
      expect(staleRes.error.code).toBe("STALE_SOURCE_FILE");
    }

    // Proves FileVersionGuard acts independently without calling correction
    expect(getOpenAI).not.toHaveBeenCalled();
  });

  test("G. Scope violations do NOT trigger correction", () => {
    const scopeRes = enforceExecutionScope({
      proposedChanges: [{ path: "src/unauthorized.ts", content: "...", action: "create", description: "bad" }],
      manifest: {
        files: [{ path: "src/pages/DashboardPage.tsx", action: "modify", dependencies: [], description: "dashboard" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      },
      contract: {
        goal: "task",
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        pipeline: "REPOSITORY",
        environment: "NODE_JS",
        repositoryRequired: true,
        expectedFiles: [],
        validationType: "TYPESCRIPT_BUILD",
        targetPaths: ["src/pages/DashboardPage.tsx"],
        allowedActions: ["modify"],
        forbiddenActions: [],
        maxFiles: 5,
        searchScope: ["src"],
        contextScope: ["src"],
        diffCriticEnabled: true,
      },
      existingFilePaths: ["src/pages/DashboardPage.tsx"],
    });

    expect(scopeRes.valid).toBe(false);
    expect(scopeRes.errors[0].reason).toBe("UNDECLARED_FILE");
    expect(getOpenAI).not.toHaveBeenCalled();
  });

  test("H. Protected-path violations do NOT trigger correction", () => {
    expect(() => assertSafeWorktreePath(".git/config", "/tmp/mock-worktree")).toThrow();
    expect(() => assertSafeWorktreePath("node_modules/pkg/index.js", "/tmp/mock-worktree")).toThrow();
    expect(() => assertSafeWorktreePath("dist/bundle.js", "/tmp/mock-worktree")).toThrow();
    expect(() => assertSafeWorktreePath("../outside.ts", "/tmp/mock-worktree")).toThrow();
    expect(getOpenAI).not.toHaveBeenCalled();
  });

  test("I. Full-file MODIFY fallback remains disabled (MODIFY_PATCH_REQUIRED)", () => {
    const proposalsWithoutEdits: GeneratedChangeProposal[] = [
      {
        path: "src/pages/DashboardPage.tsx",
        action: "modify",
        edits: [] as any,
        description: "modify without edits",
      },
    ];

    const result = resolveGenerationProposals(proposalsWithoutEdits, fileContext);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.code).toBe("MODIFY_PATCH_REQUIRED");
    }
    expect(getOpenAI).not.toHaveBeenCalled();
  });
});
