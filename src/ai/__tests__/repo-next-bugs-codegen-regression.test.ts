import { CodeGenerator } from "../generation/CodeGenerator";
import { resolveGenerationProposals } from "../generation/GenerationProposalResolver";
import { ExecutionContract, FileManifest } from "../../types";

const contract: ExecutionContract = {
  goal: "Fix a project task filter",
  taskType: "BUG_FIX",
  risk: "LOW",
  estimatedComplexity: "SMALL",
  pipeline: "REPOSITORY",
  environment: "REACT_TS",
  repositoryRequired: true,
  expectedFiles: [],
  validationType: "TYPESCRIPT_BUILD",
  targetPaths: ["lib/mock-data.ts"],
  allowedActions: ["modify_file"],
  forbiddenActions: [],
  maxFiles: 1,
  searchScope: ["lib/"],
  contextScope: ["lib/"],
  diffCriticEnabled: true,
};

const emptyManifest: FileManifest = {
  manifestVersion: "1.0.0",
  totalFiles: 0,
  files: [],
};

const source = [
  "export const mockProjects = [{ id: 'proj-1' }];",
  "export const mockTasks = [{ id: 'task-1', projectId: 'proj-1' }];",
  "export function getTasksByProject(projectId: string) {",
  "  return mockTasks.filter((task) => task.id === projectId);",
  "}",
  "export const unrelated = 'preserved';",
].join("\n");

function installGenerationResponse(changes: unknown[]) {
  const utils = require("../shared/utils");
  const original = utils.getOpenAI;
  utils.getOpenAI = () => ({
    chat: { completions: { create: async () => ({
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify({
        explanation: "Apply the focused fix",
        commitMessage: "fix project task filter",
        changes,
      }) } }],
    }) } },
  });
  return () => { utils.getOpenAI = original; };
}

describe("repo-01-next-bugs CodeGenerator regression", () => {
  test("empty approved manifest still honors structured edits and preserves unrelated bytes", async () => {
    const restore = installGenerationResponse([{
      path: "lib/mock-data.ts",
      action: "modify",
      description: "Use the project foreign key",
      edits: [{
        oldText: "return mockTasks.filter((task) => task.id === projectId);",
        newText: "return mockTasks.filter((task) => task.projectId === projectId);",
      }],
    }]);

    try {
      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Fix tasks not appearing on the project page",
        { intent: "BUG_FIX", taskType: "BUG_FIX", targetPath: "lib/mock-data.ts" },
        { fileContext: { "lib/mock-data.ts": source } },
        "system prompt",
        contract,
        emptyManifest,
        {},
        { "lib/mock-data.ts": source },
      );

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].editPrimitive?.type).toBe("PATCH_HUNK");
      expect(result.changes[0].content).toBe(source.replace("task.id === projectId", "task.projectId === projectId"));
      expect(result.changes[0].content).toContain("export const unrelated = 'preserved';");
    } finally {
      restore();
    }
  });

  test("modify without edits or content fails closed instead of creating an empty replacement", () => {
    const result = resolveGenerationProposals([{
      path: "lib/mock-data.ts",
      action: "modify",
      edits: [],
      description: "invalid missing mutation body",
    }], { "lib/mock-data.ts": source });

    expect(result).toMatchObject({ success: false, error: { code: "MODIFY_PATCH_REQUIRED" } });
  });

  test("legacy explicit whole-file replacement remains supported", async () => {
    const replacement = source.replace("task.id === projectId", "task.projectId === projectId");
    const restore = installGenerationResponse([{
      path: "lib/mock-data.ts",
      content: replacement,
      description: "Explicit complete-file replacement",
    }]);

    try {
      const result = await CodeGenerator.generateRoadmapAndDiffs(
        "Fix tasks not appearing on the project page",
        { intent: "BUG_FIX", taskType: "BUG_FIX", targetPath: "lib/mock-data.ts" },
        { fileContext: { "lib/mock-data.ts": source } },
        "system prompt",
        contract,
        emptyManifest,
        {},
        { "lib/mock-data.ts": source },
      );

      expect(result.changes[0]).toMatchObject({ action: "modify", content: replacement });
      expect(result.changes[0].editPrimitive?.type).toBe("REPLACE_FILE");
    } finally {
      restore();
    }
  });
});
