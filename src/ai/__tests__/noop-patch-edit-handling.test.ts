import { CodeGenerator } from "../generation/CodeGenerator";
import { PatchCorrectionEngine } from "../generation/PatchCorrectionEngine";
import { ExecutionContract, FileManifest } from "../../types";

describe("CodeGenerator — Deterministic No-Op Patch Edit Normalization", () => {
  const baseContract: ExecutionContract = {
    goal: "Repair all build errors",
    taskType: "BUG_FIX",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: ["components/Calculator.tsx"],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: ["components/Calculator.tsx", "app/page.tsx"],
    allowedActions: ["modify"],
    forbiddenActions: [],
    maxFiles: 5,
    searchScope: ["components/Calculator.tsx", "app/page.tsx"],
    contextScope: ["components/Calculator.tsx", "app/page.tsx"],
    diffCriticEnabled: true,
  };

  const approvedManifest: FileManifest = {
    files: [
      {
        path: "components/Calculator.tsx",
        action: "modify",
        dependencies: [],
        description: "Fix useState error in Calculator",
      },
      {
        path: "app/page.tsx",
        action: "modify",
        dependencies: ["./components/Calculator"],
        description: "Verify import in page",
      },
    ],
    totalFiles: 2,
    manifestVersion: "1.0.0",
  };

  const authoritativeModifySources = {
    "components/Calculator.tsx": {
      path: "components/Calculator.tsx",
      content: `import React, { useState } from 'react';\nexport function Calculator() { return <div>Calc</div>; }`,
      sha256: "hash-calc",
    },
    "app/page.tsx": {
      path: "app/page.tsx",
      content: `import { Calculator } from '@/components/Calculator';\nexport default function Page() { return <Calculator />; }`,
      sha256: "hash-page",
    },
  };

  test("Test A: Required File A has real edit, Supporting File B has only no-op edit -> B pruned, A applied, pipeline continues", async () => {
    // Mock LLM to return real edit for Calculator.tsx and identical oldText/newText for app/page.tsx
    const mockProposals = [
      {
        path: "components/Calculator.tsx",
        action: "modify",
        description: "Add use client",
        edits: [
          {
            oldText: "import React, { useState } from 'react';",
            newText: '"use client";\nimport React, { useState } from \'react\';',
          },
        ],
      },
      {
        path: "app/page.tsx",
        action: "modify",
        description: "No-op change",
        edits: [
          {
            oldText: "export default function Page() { return <Calculator />; }",
            newText: "export default function Page() { return <Calculator />; }",
          },
        ],
      },
    ];

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    roadmap: "1. Update Calculator.tsx",
                    changes: mockProposals,
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    jest.spyOn(require("../shared/utils"), "getOpenAI").mockReturnValue(mockOpenAI);

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Fix all build errors in this repository until the build passes.",
      { targetPath: "components/Calculator.tsx", intent: "repair" },
      { fileContext: { "components/Calculator.tsx": authoritativeModifySources["components/Calculator.tsx"].content, "app/page.tsx": authoritativeModifySources["app/page.tsx"].content } },
      "System prompt",
      baseContract,
      approvedManifest,
      authoritativeModifySources,
    );

    expect(result.changes.length).toBe(1);
    expect(result.changes[0].path).toBe("components/Calculator.tsx");
    expect(result.changes[0].content).toContain('"use client";');
  });

  test("Test B: Required diagnostic target File A itself has only no-op edits -> Retained and triggers bounded correction", async () => {
    const mockProposals = [
      {
        path: "components/Calculator.tsx",
        action: "modify",
        description: "No-op on required file",
        edits: [
          {
            oldText: "import React, { useState } from 'react';",
            newText: "import React, { useState } from 'react';",
          },
        ],
      },
    ];

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    roadmap: "1. Update Calculator.tsx",
                    changes: mockProposals,
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    jest.spyOn(require("../shared/utils"), "getOpenAI").mockReturnValue(mockOpenAI);

    const spyCorrectPatch = jest.spyOn(PatchCorrectionEngine, "correctPatch").mockResolvedValue({
      attempted: true,
      succeeded: true,
      correctedEdits: [
        {
          oldText: "import React, { useState } from 'react';",
          newText: '"use client";\nimport React, { useState } from \'react\';',
        },
      ],
    });

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Fix useState error in components/Calculator.tsx",
      { targetPath: "components/Calculator.tsx", intent: "repair" },
      { fileContext: { "components/Calculator.tsx": authoritativeModifySources["components/Calculator.tsx"].content } },
      "System prompt",
      baseContract,
      approvedManifest,
      authoritativeModifySources,
    );

    expect(spyCorrectPatch).toHaveBeenCalled();
    expect(result.changes.length).toBe(1);
    expect(result.changes[0].path).toBe("components/Calculator.tsx");
    expect(result.changes[0].content).toContain('"use client";');
  });

  test("Test C: All generated proposals are no-op and correction fails -> Explicit failure, never false success", async () => {
    const mockProposals = [
      {
        path: "components/Calculator.tsx",
        action: "modify",
        description: "No-op on required file",
        edits: [
          {
            oldText: "import React, { useState } from 'react';",
            newText: "import React, { useState } from 'react';",
          },
        ],
      },
    ];

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    roadmap: "1. Update Calculator.tsx",
                    changes: mockProposals,
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    jest.spyOn(require("../shared/utils"), "getOpenAI").mockReturnValue(mockOpenAI);
    jest.spyOn(PatchCorrectionEngine, "correctPatch").mockResolvedValue({
      attempted: true,
      succeeded: false,
      error: "Could not correct no-op edit",
    });

    await expect(
      CodeGenerator.generateRoadmapAndDiffs(
        "Fix useState error in components/Calculator.tsx",
        { targetPath: "components/Calculator.tsx", intent: "repair" },
        { fileContext: { "components/Calculator.tsx": authoritativeModifySources["components/Calculator.tsx"].content } },
        "System prompt",
        baseContract,
        approvedManifest,
        authoritativeModifySources,
      )
    ).rejects.toThrow(/\[PATCH_RESOLUTION_FAILED\]/);
  });

  test("Test D: File has one no-op edit and one real edit -> No-op removed, real edit preserved and applied", async () => {
    const mockProposals = [
      {
        path: "components/Calculator.tsx",
        action: "modify",
        description: "Mixed edits",
        edits: [
          {
            oldText: "export function Calculator() { return <div>Calc</div>; }",
            newText: "export function Calculator() { return <div>Calc</div>; }", // no-op
          },
          {
            oldText: "import React, { useState } from 'react';",
            newText: '"use client";\nimport React, { useState } from \'react\';', // real edit
          },
        ],
      },
    ];

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    roadmap: "1. Update Calculator.tsx",
                    changes: mockProposals,
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    jest.spyOn(require("../shared/utils"), "getOpenAI").mockReturnValue(mockOpenAI);

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Fix useState error in components/Calculator.tsx",
      { targetPath: "components/Calculator.tsx", intent: "repair" },
      { fileContext: { "components/Calculator.tsx": authoritativeModifySources["components/Calculator.tsx"].content } },
      "System prompt",
      baseContract,
      approvedManifest,
      authoritativeModifySources,
    );

    expect(result.changes.length).toBe(1);
    expect(result.changes[0].content).toContain('"use client";');
  });

  test("Test E: Normal narrow task with a valid exact patch behaves unchanged", async () => {
    const mockProposals = [
      {
        path: "components/Calculator.tsx",
        action: "modify",
        description: "Valid exact patch",
        edits: [
          {
            oldText: "import React, { useState } from 'react';",
            newText: '"use client";\nimport React, { useState } from \'react\';',
          },
        ],
      },
    ];

    const mockOpenAI: any = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    roadmap: "1. Update Calculator.tsx",
                    changes: mockProposals,
                  }),
                },
              },
            ],
          }),
        },
      },
    };

    jest.spyOn(require("../shared/utils"), "getOpenAI").mockReturnValue(mockOpenAI);

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Fix useState in Calculator",
      { targetPath: "components/Calculator.tsx", intent: "repair" },
      { fileContext: { "components/Calculator.tsx": authoritativeModifySources["components/Calculator.tsx"].content } },
      "System prompt",
      baseContract,
      approvedManifest,
      authoritativeModifySources,
    );

    expect(result.changes.length).toBe(1);
    expect(result.changes[0].path).toBe("components/Calculator.tsx");
    expect(result.changes[0].action).toBe("modify");
    expect(result.changes[0].content).toContain('"use client";');
  });
});
