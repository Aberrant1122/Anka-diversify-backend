import { CodeGenerator, findIntroducedModuleContractIssues } from "../generation/CodeGenerator";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { ExecutionContract, FileManifest } from "../../types";

const servicePath = "src/services/user.service.ts";
const controllerPath = "src/controllers/user.controller.ts";
const serviceSource = [
  "export class UserService {",
  "  public getAllUsers(): string[] { return []; }",
  "}",
  "export const userService = new UserService();",
].join("\n");
const controllerSource = [
  "import { userService } from '../services/user.service';",
  "export const userController = { getAllUsers: () => userService.getAllUsers() };",
].join("\n");
const sourceMap = { [servicePath]: serviceSource, [controllerPath]: controllerSource };

function gatewayResult(content: unknown, stage: string) {
  return { content, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "test", stage };
}

const contract: ExecutionContract = {
  goal: "Add an active-users service method",
  taskType: "NEW_FEATURE",
  risk: "LOW",
  estimatedComplexity: "SMALL",
  pipeline: "REPOSITORY",
  environment: "NODE_JS",
  repositoryRequired: true,
  expectedFiles: [servicePath, controllerPath],
  validationType: "TYPESCRIPT_BUILD",
  targetPaths: [servicePath, controllerPath],
  allowedActions: ["modify_file"],
  forbiddenActions: [],
  maxFiles: 2,
  searchScope: ["src/"],
  contextScope: ["src/"],
  diffCriticEnabled: true,
};

const manifest: FileManifest = {
  manifestVersion: "1",
  totalFiles: 2,
  files: [
    { path: servicePath, action: "modify", description: "Add service method", dependencies: [] },
    { path: controllerPath, action: "modify", description: "Expose service method", dependencies: [servicePath] },
  ],
};

describe("generated module-contract preflight", () => {
  afterEach(() => jest.restoreAllMocks());

  // 1. Named export removal
  test("detects a newly removed named export with resolved exporter file", () => {
    const issues = findIntroducedModuleContractIssues(sourceMap, [{
      path: servicePath,
      action: "modify",
      content: serviceSource.replace("export const userService", "const userService"),
      description: "Bad generated patch removing named export",
    }]);
    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: "missing_export",
        file: controllerPath,
        relatedFile: servicePath,
      }),
    ]));
  });

  // 2. Default export removal
  test("detects a newly removed default export with resolved exporter file", () => {
    const authServicePath = "src/services/auth.service.ts";
    const authControllerPath = "src/controllers/auth.controller.ts";
    const authServiceSource = [
      "export default class AuthService {",
      "  public login(): boolean { return true; }",
      "}",
    ].join("\n");
    const authControllerSource = [
      "import AuthService from '../services/auth.service';",
      "export const authController = new AuthService();",
    ].join("\n");
    const authSourceMap = {
      [authServicePath]: authServiceSource,
      [authControllerPath]: authControllerSource,
    };

    // Removal of default export (keeping only named class export)
    const issues = findIntroducedModuleContractIssues(authSourceMap, [{
      path: authServicePath,
      action: "modify",
      content: "export class AuthService {\n  public login(): boolean { return true; }\n}",
      description: "Patch removing default export",
    }]);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: "missing_export",
        file: authControllerPath,
        relatedFile: authServicePath,
      }),
    ]));
  });

  // 3. Broken importer/exporter relation
  test("detects a broken import introduced by a modified importer", () => {
    const issues = findIntroducedModuleContractIssues(sourceMap, [{
      path: controllerPath,
      action: "modify",
      content: "import { missingModule } from '../services/nonexistent.service';\n" + controllerSource,
      description: "Patch introducing non-existent module import",
    }]);

    expect(issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        checkId: "broken_import",
        file: controllerPath,
      }),
    ]));
  });

  // 4. Baseline pre-existing issue not treated as introduced
  test("ignores pre-existing baseline contract issues and does not flag them as introduced", () => {
    const baselineBrokenService = "export class UserService {}";
    const baselineBrokenController = [
      "import { userService } from '../services/user.service';",
      "export const userController = { check: () => userService };",
    ].join("\n");
    const baselineBrokenSourceMap = {
      [servicePath]: baselineBrokenService,
      [controllerPath]: baselineBrokenController,
    };

    // The baseline already has missing_export: userService.
    // The proposed change modifies only an unrelated part or adds another export without fixing/touching the baseline issue.
    const issues = findIntroducedModuleContractIssues(baselineBrokenSourceMap, [{
      path: servicePath,
      action: "modify",
      content: baselineBrokenService + "\nexport const otherHelper = 42;",
      description: "Clean addition that does not introduce the pre-existing error",
    }]);

    expect(issues).toEqual([]);
  });

  // 5. Bounded correction preserves named export and allows requested change
  test("corrects an offending patch before returning executable changes", async () => {
    const correctedOldText = "  public getAllUsers(): string[] { return []; }";
    const correctedNewText = [
      correctedOldText,
      "  public getActiveUsers(): string[] { return []; }",
    ].join("\n");
    const gateway = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(gatewayResult({ roadmap: [{
        phase: 1,
        title: "Implement API service",
        layer: "Service",
        targetFiles: [servicePath, controllerPath],
        description: "Preserve the existing module contract while adding the method.",
      }] }, PipelineStages.ROADMAP_PLANNING) as never)
      .mockResolvedValueOnce(gatewayResult({
        explanation: "Add active users support",
        commitMessage: "feat: add active users endpoint",
        changes: [{
          path: servicePath,
          action: "modify",
          description: "Incorrectly replace the singleton export",
          edits: [{ oldText: "export const userService = new UserService();", newText: "const userService = new UserService();" }],
        }],
      }, PipelineStages.CODE_GENERATION) as never)
      .mockResolvedValueOnce(gatewayResult({ edits: [{ oldText: correctedOldText, newText: correctedNewText }] }, PipelineStages.CODE_CORRECTION) as never);

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      contract.goal,
      { intent: "NEW_FEATURE", taskType: "NEW_FEATURE" },
      { fileContext: sourceMap, skeletonContext: {} },
      "system",
      contract,
      manifest,
      {
        [servicePath]: { path: servicePath, content: serviceSource, sha256: "service-sha" },
        [controllerPath]: { path: controllerPath, content: controllerSource, sha256: "controller-sha" },
      },
      sourceMap,
    );

    expect(gateway).toHaveBeenCalledTimes(3);
    expect(gateway.mock.calls[2][0]).toEqual(expect.objectContaining({ stage: PipelineStages.CODE_CORRECTION }));
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].content).toContain("export const userService = new UserService();");
    expect(result.changes[0].content).toContain("getActiveUsers");
    expect(findIntroducedModuleContractIssues(sourceMap, result.changes)).toEqual([]);
  });

  // 6. Correction failure fails closed
  test("fails closed with GENERATED_CONTRACT_INVALID when bounded correction fails", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(gatewayResult({ roadmap: [{
        phase: 1,
        title: "Implement API service",
        layer: "Service",
        targetFiles: [servicePath, controllerPath],
        description: "Preserve the existing module contract.",
      }] }, PipelineStages.ROADMAP_PLANNING) as never)
      .mockResolvedValueOnce(gatewayResult({
        explanation: "Add active users support",
        commitMessage: "feat: add active users endpoint",
        changes: [{
          path: servicePath,
          action: "modify",
          description: "Incorrectly remove the singleton export",
          edits: [{ oldText: "export const userService = new UserService();", newText: "const userService = new UserService();" }],
        }],
      }, PipelineStages.CODE_GENERATION) as never)
      // Correction returns empty/invalid edits:
      .mockResolvedValueOnce(gatewayResult({ edits: [] }, PipelineStages.CODE_CORRECTION) as never);

    await expect(
      CodeGenerator.generateRoadmapAndDiffs(
        contract.goal,
        { intent: "NEW_FEATURE", taskType: "NEW_FEATURE" },
        { fileContext: sourceMap, skeletonContext: {} },
        "system",
        contract,
        manifest,
        {
          [servicePath]: { path: servicePath, content: serviceSource, sha256: "service-sha" },
          [controllerPath]: { path: controllerPath, content: controllerSource, sha256: "controller-sha" },
        },
        sourceMap,
      )
    ).rejects.toThrow(/\[GENERATED_CONTRACT_INVALID\]/);
  });
});
