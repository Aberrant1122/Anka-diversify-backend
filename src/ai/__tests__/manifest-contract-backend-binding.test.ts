import { LLMGateway } from "../gateway/LLMGateway";
import { LLMSchemaInvalidError } from "../gateway/LLMError";
import { PipelineStages } from "../gateway/PipelineStage";
import { bindBackendManifestEvidence } from "../orchestration/AgentPlanner";
import { MANIFEST_GENERATION_PROMPT } from "../prompts/coding";
import { ManifestGenerator } from "../../services/manifest-generator";
import type { ExecutionContract, FileManifest } from "../../types";

function contract(maxFiles = 6): ExecutionContract {
  return {
    goal: "Update dashboard",
    taskType: "REFACTOR",
    risk: "MEDIUM",
    estimatedComplexity: "SMALL",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    allowedActions: ["modify_file", "delete_file", "create_file"],
    forbiddenActions: [],
    maxFiles,
    targetPaths: [],
    searchScope: [],
    contextScope: [],
    diffCriticEnabled: true,
  };
}

function completion(content: unknown): any {
  return {
    choices: [{
      finish_reason: "stop",
      message: { content: typeof content === "string" ? content : JSON.stringify(content) },
    }],
  };
}

function clientReturning(...responses: unknown[]): any {
  return {
    chat: {
      completions: {
        create: jest.fn().mockImplementation(() => Promise.resolve(completion(responses.shift()))),
      },
    },
  };
}

function proposal(evidenceIds?: unknown): any {
  return {
    files: [{
      path: "src/Dashboard.tsx",
      action: "modify",
      dependencies: [],
      description: "Update dashboard",
      ...(evidenceIds === undefined ? {} : { evidenceIds }),
    }],
    totalFiles: 1,
    manifestVersion: "1.0.0",
  };
}

describe("model manifest contract and backend evidence binding", () => {
  test.each([
    ["omitted", undefined],
    ["legacy empty", []],
    ["invented", ["evi_fake"]],
    ["semantic citation", ["evi_semantic"]],
    ["malformed legacy value", "evi_fake"],
  ])("model evidenceIds are ignored when %s", async (_label, ids) => {
    const manifest = await new ManifestGenerator(clientReturning(proposal(ids)))
      .generateManifest("Update dashboard", { existingFiles: ["src/Dashboard.tsx"] }, contract());

    expect(manifest.files).toHaveLength(1);
    expect(manifest.files[0].evidenceIds).toEqual([]);
  });

  test("model-facing prompt and required schema contain no evidence-ID responsibility", async () => {
    const client = clientReturning(proposal());
    await new ManifestGenerator(client).generateManifest(
      "Update dashboard",
      { existingFiles: ["src/Dashboard.tsx"] },
      contract(),
    );

    expect(MANIFEST_GENERATION_PROMPT).not.toContain('"evidenceIds"');
    const request = client.chat.completions.create.mock.calls[0][0];
    const required = request.response_format.json_schema.schema.properties.files.items.required;
    expect(required).toEqual(["path", "action", "dependencies"]);
  });

  test("trusted destructive obligations are merged and cannot be omitted or action-downgraded", async () => {
    const obligations = [
      { path: "src/widget/Widget.tsx", requiredAction: "delete" as const, role: "PRIMARY_TARGET" as const, evidenceIds: ["evi_widget"] },
      { path: "src/widget/Widget.css", requiredAction: "delete" as const, role: "PRIMARY_TARGET" as const, evidenceIds: ["evi_style"] },
      { path: "src/App.tsx", requiredAction: "modify" as const, role: "DEPENDENCY_CLEANUP" as const, evidenceIds: ["evi_import"] },
    ];
    const modelProposal = {
      files: [{ path: "src/widget/Widget.tsx", action: "modify", dependencies: [], description: "Keep widget" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
    const manifest = await new ManifestGenerator(clientReturning(modelProposal)).generateManifest(
      "Delete widget",
      { existingFiles: obligations.map((item) => item.path), actionObligations: obligations },
      { ...contract(), actionObligations: obligations },
    );

    expect(manifest.files.map((file) => [file.path, file.action])).toEqual([
      ["src/widget/Widget.tsx", "delete"],
      ["src/widget/Widget.css", "delete"],
      ["src/App.tsx", "modify"],
    ]);
    expect(manifest.files.find((file) => file.path === "src/App.tsx")?.dependencies).toEqual([
      "src/widget/Widget.tsx",
      "src/widget/Widget.css",
    ]);
    expect(manifest.files.every((file) => file.evidenceIds?.length === 0)).toBe(true);
  });

  test("backend binding filters advisory and stale obligation evidence and never reads model IDs", () => {
    const records = new Map([
      ["evi_current", { id: "evi_current", repositoryRevision: "rev-current" }],
      ["evi_advisory", { id: "evi_advisory", repositoryRevision: "rev-current" }],
      ["evi_stale", { id: "evi_stale", repositoryRevision: "rev-old" }],
      ["evi_acquired", { id: "evi_acquired", repositoryRevision: "rev-current" }],
    ]);
    const evidenceStore = {
      getEvidence: (id: string) => records.get(id),
      isAuthorityEligible: (item: { id: string }) => item.id !== "evi_advisory",
    } as any;
    const files: FileManifest["files"] = [
      { path: "src/Widget.tsx", action: "modify", dependencies: [], description: "Widget", evidenceIds: ["evi_fake"] },
      { path: "src/App.tsx", action: "modify", dependencies: [], description: "App", evidenceIds: ["evi_advisory"] },
    ];
    const bound = bindBackendManifestEvidence({
      files,
      obligations: [{
        path: "src/Widget.tsx",
        requiredAction: "modify",
        role: "DEPENDENCY_CLEANUP",
        evidenceIds: ["evi_advisory", "evi_stale", "evi_current"],
      }],
      acquiredEvidence: new Map([
        ["src/Widget.tsx", ["evi_acquired"]],
        ["src/App.tsx", ["evi_acquired"]],
      ]),
      evidenceStore,
      currentRevision: "rev-current",
    });

    expect(bound[0].evidenceIds).toEqual(["evi_current"]);
    expect(bound[1].evidenceIds).toEqual(["evi_acquired"]);
    expect(bound.flatMap((item) => item.evidenceIds)).not.toContain("evi_fake");
    expect(bound.flatMap((item) => item.evidenceIds)).not.toContain("evi_advisory");
    expect(bound.flatMap((item) => item.evidenceIds)).not.toContain("evi_stale");
  });

  test("literal escaped-dot repository paths are rejected instead of rewritten", async () => {
    const escaped = {
      files: [{ path: "src/DashboardOverview\\.tsx", action: "modify", dependencies: [], description: "Update" }],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };
    await expect(new ManifestGenerator(clientReturning(escaped, escaped)).generateManifest(
      "Update dashboard",
      { existingFiles: ["src/DashboardOverview.tsx"] },
      contract(),
    )).rejects.toThrow(/MANIFEST_GENERATION_FAILED/);
  });
});

describe("manifest-specific structured correction", () => {
  test("malformed manifest JSON gets exactly one manifest-specific correction opportunity", async () => {
    const client = clientReturning("{not-json", proposal());
    const result = await new LLMGateway().callStructured({
      stage: PipelineStages.MANIFEST_GENERATION,
      messages: [{ role: "user", content: "manifest" }],
      maxRetries: 5,
      retryDelayMs: 0,
      openaiClient: client,
      schema: {
        name: "ManifestProposal",
        schema: { type: "object", required: ["files"] },
        validate: (parsed) => ({ valid: Array.isArray(parsed?.files), errors: ["files is required"] }),
      },
    });

    expect(result.content.files).toHaveLength(1);
    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
    const repairMessage = client.chat.completions.create.mock.calls[1][0].messages.at(-1).content;
    expect(repairMessage).toContain("MANIFEST CORRECTION INSTRUCTIONS");
    expect(repairMessage).not.toContain("targeted edits");
  });

  test("a still-invalid correction terminates with a typed manifest schema failure", async () => {
    const client = clientReturning({ bad: true }, { stillBad: true }, { wouldLoop: true });
    await expect(new LLMGateway().callStructured({
      stage: PipelineStages.MANIFEST_GENERATION,
      messages: [{ role: "user", content: "manifest" }],
      maxRetries: 5,
      retryDelayMs: 0,
      openaiClient: client,
      schema: {
        name: "ManifestProposal",
        schema: { type: "object", required: ["files"] },
        validate: (parsed) => ({ valid: Array.isArray(parsed?.files), errors: ["files is required"] }),
      },
    })).rejects.toBeInstanceOf(LLMSchemaInvalidError);

    expect(client.chat.completions.create).toHaveBeenCalledTimes(2);
  });
});
