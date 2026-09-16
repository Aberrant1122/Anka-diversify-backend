import { ValidationDetector } from "../validation/ValidationDetector";
import { AgentFileChange, ExecutionContract } from "../shared/types";

describe("ValidationDetector — trusted dependency-cleanup intent satisfaction", () => {
  const cleanupPath = "src/components/dashboard/DashboardOverview.tsx";
  const unrelatedPath = "src/components/dashboard/RandomPanel.tsx";
  const snapshot = {
    keyFiles: [
      {
        path: "src/App.tsx",
        content: "export function App() { return <main>Active app</main>; }",
      },
      {
        path: cleanupPath,
        content: "export function DashboardOverview() { return <section>Legacy activity</section>; }",
      },
      {
        path: unrelatedPath,
        content: "export function RandomPanel() { return <aside>Random</aside>; }",
      },
    ],
  };
  const contract: ExecutionContract = {
    goal: "Remove the deprecated activity widget and clean every reference to it",
    taskType: "DELETE_FILE",
    risk: "MEDIUM",
    estimatedComplexity: "MEDIUM",
    pipeline: "REPOSITORY",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: [cleanupPath],
    allowedActions: ["modify", "delete"],
    forbiddenActions: [],
    maxFiles: 4,
    searchScope: ["src/"],
    contextScope: ["src/"],
    diffCriticEnabled: true,
  };
  const cleanupChange: AgentFileChange = {
    path: cleanupPath,
    action: "modify",
    content: "export function DashboardOverview() { return <section>Dashboard</section>; }",
    description: "Remove the deleted widget reference",
  };
  const unrelatedChange: AgentFileChange = {
    path: unrelatedPath,
    action: "modify",
    content: "export function RandomPanel() { return <aside>Changed</aside>; }",
    description: "Unrelated UI modification",
  };

  const cleanupObligation = (path = cleanupPath) => ({
    path,
    role: "DEPENDENCY_CLEANUP" as const,
    requiredAction: "modify" as const,
    evidenceIds: ["evidence-importer"],
  });

  const intentCheck = async (changes: AgentFileChange[], executionContract: ExecutionContract) => {
    const result = await ValidationDetector.runFeatureValidation(
      changes,
      snapshot,
      executionContract.goal,
      executionContract,
    );
    return result.checks.find((check) => check.id === "intent_satisfaction");
  };

  test("A. unreachable importer modify satisfies intent through its exact trusted cleanup obligation", async () => {
    const check = await intentCheck([cleanupChange], {
      ...contract,
      actionObligations: [cleanupObligation()],
    });

    expect(check?.status).toBe("PASS");
    expect(check?.details).not.toBe("Modified UI target is not reachable from any active frontend entry point.");
  });

  test("B. ordinary unreachable UI modification still fails active-entry reachability", async () => {
    const check = await intentCheck([cleanupChange], contract);

    expect(check).toMatchObject({
      status: "FAIL",
      details: "Modified UI target is not reachable from any active frontend entry point.",
    });
  });

  test("C. cleanup exemption is per file and does not exempt an unrelated unreachable UI change", async () => {
    const check = await intentCheck([cleanupChange, unrelatedChange], {
      ...contract,
      actionObligations: [cleanupObligation()],
    });

    expect(check?.status).toBe("FAIL");
  });

  test("D. delete obligation does not exempt an actual modify", async () => {
    const check = await intentCheck([cleanupChange], {
      ...contract,
      actionObligations: [{ ...cleanupObligation(), requiredAction: "delete" }],
    });

    expect(check?.status).toBe("FAIL");
  });

  test("E. cleanup obligation for a different path does not exempt the modified file", async () => {
    const check = await intentCheck([cleanupChange], {
      ...contract,
      actionObligations: [cleanupObligation("src/components/dashboard/OtherOverview.tsx")],
    });

    expect(check?.status).toBe("FAIL");
  });

  test("F. PRIMARY_TARGET modify keeps ordinary reachability semantics", async () => {
    const check = await intentCheck([cleanupChange], {
      ...contract,
      actionObligations: [{ ...cleanupObligation(), role: "PRIMARY_TARGET" }],
    });

    expect(check?.status).toBe("FAIL");
  });

  test("G. deleted cleanup target remains outside non-deleted frontend reachability handling", async () => {
    const deletedChange: AgentFileChange = {
      path: "src/components/activity/LegacyActivityWidget.tsx",
      action: "delete",
      isDeleted: true,
      content: undefined as unknown as string,
      description: "Delete deprecated activity widget",
    };
    const check = await intentCheck([deletedChange], {
      ...contract,
      actionObligations: [{
        ...cleanupObligation(deletedChange.path),
        requiredAction: "delete",
      }],
    });

    expect(check?.status).toBe("PASS");
  });

  test("H. existing canonical slash normalization matches a Windows path representation", async () => {
    const check = await intentCheck(
      [{ ...cleanupChange, path: "src\\components\\dashboard\\DashboardOverview.tsx" }],
      { ...contract, actionObligations: [cleanupObligation()] },
    );

    expect(check?.status).toBe("PASS");
  });
});
