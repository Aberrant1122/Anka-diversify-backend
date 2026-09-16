import { ManifestGenerator } from "../../services/manifest-generator";
import type { ExecutionContract } from "../../types";
import { MANIFEST_GENERATION_PROMPT } from "../prompts/coding";

function contract(): ExecutionContract {
  return {
    goal: "Add theme support",
    taskType: "NEW_FEATURE",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    allowedActions: ["modify_file", "create_file"],
    forbiddenActions: [],
    maxFiles: 5,
    targetPaths: [],
    searchScope: [],
    contextScope: [],
    diffCriticEnabled: true,
  };
}

function clientWithDependency(dependency: string, evidenceIds: string[] = []): any {
  return {
    chat: {
      completions: {
        create: jest.fn().mockResolvedValue({
          choices: [{
            finish_reason: "stop",
            message: {
              content: JSON.stringify({
                files: [{
                  path: "src/components/layout/AppLayout/AppLayout.tsx",
                  action: "modify",
                  description: "Integrate the theme provider",
                  dependencies: [dependency],
                  evidenceIds,
                }],
                totalFiles: 1,
                manifestVersion: "1.0.0",
              }),
            },
          }],
        }),
      },
    },
  };
}

describe("manifest dependency containment", () => {
  test("planning instructions do not propose implicit repository creates", () => {
    expect(MANIFEST_GENERATION_PROMPT).toContain(
      'Propose action "create" only when the original user request explicitly names the exact new repository path',
    );
  });

  test("repository evidence IDs are never exposed as model-owned manifest fields", async () => {
    const client = clientWithDependency("./AppLayout.css", ["evi_verified"]);
    const evidence = [
      { id: "evi_advisory", kind: "FILE", filePath: "README.md", provenance: "SEMANTIC_SEARCH" },
      { id: "evi_verified", kind: "SYMBOL", filePath: "src/App.tsx", provenance: "AST_GRAPH" },
    ];
    const evidenceStore = {
      getAllEvidence: () => evidence,
      isAuthorityEligible: (item: { id: string }) => item.id === "evi_verified",
    };

    await new ManifestGenerator(client).generateManifest(
      "Add theme support",
      {
        existingFiles: ["src/components/layout/AppLayout/AppLayout.tsx"],
        evidenceStore,
      },
      contract(),
    );

    const request = client.chat.completions.create.mock.calls[0][0];
    const userMessage = request.messages.find((message: { role: string }) => message.role === "user").content;
    expect(userMessage).not.toContain('ID: "evi_verified"');
    expect(userMessage).not.toContain('ID: "evi_advisory"');
    expect(userMessage).toContain("Do not emit repository evidence IDs");
  });

  test("accepts parent-relative imports that resolve inside the repository", async () => {
    const generator = new ManifestGenerator(clientWithDependency("../../../context/ThemeContext"));

    const manifest = await generator.generateManifest(
      "Add theme support",
      { existingFiles: ["src/components/layout/AppLayout/AppLayout.tsx"] },
      contract(),
    );

    expect(manifest.files[0].dependencies).toEqual(["../../../context/ThemeContext"]);
  });

  test("rejects parent-relative imports that escape the repository", async () => {
    const generator = new ManifestGenerator(clientWithDependency("../../../../../outside"));

    await expect(generator.generateManifest(
      "Add theme support",
      { existingFiles: ["src/components/layout/AppLayout/AppLayout.tsx"] },
      contract(),
    )).rejects.toThrow(/MANIFEST_GENERATION_FAILED/);
  });
});
