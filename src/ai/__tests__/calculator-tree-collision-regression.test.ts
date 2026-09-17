import { CodeGenerator } from "../generation/CodeGenerator";
import { TargetScopeExpander } from "../contracts/TargetScopeExpander";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { ExecutionContract, FileManifest } from "../../types";

const rootCalculator = "components/Calculator.tsx";
const pagePath = "app/page.tsx";
const unrelatedApp = "src/app.ts";
const unrelatedIndex = "src/components/calculator/index.ts";
const unrelatedCalculator = "src/components/calculator/Calculator.tsx";

const fixture = {
  [pagePath]: 'import Calculator from "../components/Calculator";\nexport default function Page() { return <Calculator />; }',
  [rootCalculator]: "export default function Calculator() { return <div>calculator</div>; }",
  [unrelatedApp]: 'import { Calculator } from "./components/calculator";\nexport default Calculator;',
  [unrelatedIndex]: 'export { Calculator } from "./Calculator";',
  [unrelatedCalculator]: "export function Calculator() { return 42; }",
};

const deleteContract: ExecutionContract = {
  goal: "remove the calculator",
  taskType: "DELETE_FILE",
  risk: "MEDIUM",
  estimatedComplexity: "SMALL",
  pipeline: "REPOSITORY",
  environment: "REACT_TS",
  repositoryRequired: true,
  expectedFiles: [rootCalculator, pagePath],
  validationType: "TYPESCRIPT_BUILD",
  targetPaths: [rootCalculator],
  targetProvenance: { [rootCalculator]: "UNIQUE_NAMED_ENTITY" },
  allowedActions: ["delete_file", "modify_file"],
  forbiddenActions: [],
  maxFiles: 2,
  searchScope: ["app", "components"],
  contextScope: ["app", "components"],
  diffCriticEnabled: true,
};

const manifest: FileManifest = {
  manifestVersion: "1",
  totalFiles: 2,
  files: [
    { path: pagePath, action: "modify", description: "Remove the active calculator import", dependencies: [] },
    { path: rootCalculator, action: "delete", description: "Delete the active calculator", dependencies: [] },
  ],
};

function gatewayResult(content: unknown, stage: string) {
  return { content, rawResponse: {}, finishReason: "stop", latencyMs: 1, model: "test", stage };
}

describe("calculator tree collision production regression", () => {
  afterEach(() => jest.restoreAllMocks());

  test("identical Calculator symbols do not authorize cleanup outside the active module tree", () => {
    const result = TargetScopeExpander.expandReverseReferenceCleanupTargets({
      contract: deleteContract,
      candidatePaths: Object.keys(fixture),
      snapshotFiles: Object.entries(fixture).map(([path, content]) => ({ path, content })),
      fileContext: fixture,
    });

    expect(result.approvedExpansions).toEqual([
      expect.objectContaining({
        path: pagePath,
        sourceTarget: rootCalculator,
        evidence: "IMPORT_RELATION",
        action: "modify",
      }),
    ]);
    expect(result.expandedTargetPaths).toEqual(expect.arrayContaining([rootCalculator, pagePath]));
    expect(result.expandedTargetPaths).not.toEqual(expect.arrayContaining([
      unrelatedApp,
      unrelatedIndex,
      unrelatedCalculator,
    ]));
  });

  test("a real exact relative import and re-export remain valid reverse relations", () => {
    const widget = "components/Widget.tsx";
    const barrel = "components/index.ts";
    const widgetPage = "app/widget-page.tsx";
    const widgetFixture = {
      [widget]: "export default function Widget() { return null; }",
      [barrel]: 'export { default as Widget } from "./Widget";',
      [widgetPage]: 'import Widget from "../components/Widget";\nexport default Widget;',
    };

    const importers = TargetScopeExpander.findDirectReverseReferences(
      widget,
      [barrel, widgetPage],
      {
        fileContext: widgetFixture,
        snapshotFiles: Object.entries(widgetFixture).map(([path, content]) => ({ path, content })),
      },
    );

    expect(importers).toEqual(expect.arrayContaining([barrel, widgetPage]));
  });

  test("an out-of-manifest delete fails before it can create a generated contract delta", async () => {
    const gateway = jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(gatewayResult({ roadmap: [{
        phase: 1,
        title: "Remove active calculator",
        layer: "UI",
        targetFiles: [pagePath, rootCalculator],
        description: "Remove only the approved active calculator tree.",
      }] }, PipelineStages.ROADMAP_PLANNING) as never)
      .mockResolvedValueOnce(gatewayResult({
        explanation: "Remove calculator",
        commitMessage: "fix: remove calculator",
        changes: [
          {
            path: pagePath,
            action: "modify",
            description: "Remove calculator import and render",
            edits: [{ oldText: fixture[pagePath], newText: "export default function Page() { return <main />; }" }],
          },
          { path: rootCalculator, action: "delete", content: "", description: "Delete active calculator" },
          { path: unrelatedIndex, action: "delete", content: "", description: "Unapproved model-invented delete" },
        ],
      }, PipelineStages.CODE_GENERATION) as never);

    await expect(CodeGenerator.generateRoadmapAndDiffs(
      deleteContract.goal,
      { intent: "DELETE_FILE", taskType: "DELETE_FILE" },
      { fileContext: fixture, skeletonContext: {} },
      "system",
      deleteContract,
      manifest,
      {
        [pagePath]: { path: pagePath, content: fixture[pagePath], sha256: "page-sha" },
        [rootCalculator]: { path: rootCalculator, content: fixture[rootCalculator], sha256: "calculator-sha" },
      },
      fixture,
    )).rejects.toThrow(/\[GENERATED_MANIFEST_MISMATCH\].*src\/components\/calculator\/index\.ts/);
    expect(gateway).toHaveBeenCalledTimes(2);
  });

  test("a generated action that differs from the approved manifest action fails closed", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured")
      .mockResolvedValueOnce(gatewayResult({ roadmap: [{
        phase: 1,
        title: "Remove active calculator",
        layer: "UI",
        targetFiles: [pagePath, rootCalculator],
        description: "Remove only the approved active calculator tree.",
      }] }, PipelineStages.ROADMAP_PLANNING) as never)
      .mockResolvedValueOnce(gatewayResult({
        explanation: "Remove calculator",
        commitMessage: "fix: remove calculator",
        changes: [
          { path: pagePath, action: "delete", content: "", description: "Wrong action" },
          { path: rootCalculator, action: "delete", content: "", description: "Delete active calculator" },
        ],
      }, PipelineStages.CODE_GENERATION) as never);

    await expect(CodeGenerator.generateRoadmapAndDiffs(
      deleteContract.goal,
      { intent: "DELETE_FILE", taskType: "DELETE_FILE" },
      { fileContext: fixture, skeletonContext: {} },
      "system",
      deleteContract,
      manifest,
      undefined,
      fixture,
    )).rejects.toThrow(/\[GENERATED_MANIFEST_MISMATCH\].*app\/page\.tsx.*expected modify.*received delete/);
  });
});
