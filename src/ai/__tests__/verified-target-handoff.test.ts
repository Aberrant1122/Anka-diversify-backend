import fs from "fs";
import os from "os";
import path from "path";
import { PolicyContract } from "../contracts/PolicyContract";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { CodeGenerator, buildPriorVerifiedTargetSection } from "../generation/CodeGenerator";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";
import { TaskExecutionPlanManager } from "../planning/TaskExecutionPlanManager";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";
import { bindUserRequest } from "../repository/TrustedTaskContext";
import { TaskExecutionPlan } from "../shared/TaskExecutionPlan";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { ExecutionContract } from "../../types";

const intent: TaskIntentSpec = {
  goal: "Repair associated records on /items/current",
  operations: [{ kind: "REPAIR", subject: "associated records" }],
  constraints: [], acceptanceCriteria: [], destructive: false, requiresClarification: false,
  taskType: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM", explicitUserPaths: [],
};

function plan(): TaskExecutionPlan {
  return {
    id: "plan", goal: intent.goal, currentStageIndex: 0, status: "RUNNING",
    stages: [
      { id: "stage-1", name: "Find and repair", intent: { ...intent }, dependsOn: [], status: "RUNNING" },
      { id: "stage-2", name: "Ensure records render", intent: { ...intent }, dependsOn: ["stage-1"], status: "PENDING" },
    ],
  };
}

function checkpoint(status: "VERIFIED" | "ROLLED_BACK", targetPath: string, action: "FILE_CREATE" | "FILE_MODIFY" | "FILE_DELETE" = "FILE_MODIFY") {
  return {
    status,
    attemptedActions: [{ order: 0, action, path: targetPath, contentFingerprint: "current-bytes" }],
  } as const;
}

const contract: ExecutionContract = {
  goal: intent.goal, taskType: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM",
  pipeline: "REPOSITORY", environment: "REACT_TS", repositoryRequired: true,
  expectedFiles: [], validationType: "TYPESCRIPT_BUILD", targetPaths: [], searchScope: [], contextScope: [],
  allowedActions: ["modify_file"], forbiddenActions: ["delete_file"], maxFiles: 2, diffCriticEnabled: true,
};

const policy: PolicyContract = {
  ...contract,
  destructive: false,
  explicitUserPaths: [],
  userConstraints: [],
  requiresClarification: false,
};

describe("verified execution target handoff", () => {
  afterEach(() => jest.restoreAllMocks());

  test("promotes normalized path/action only from a VERIFIED executed ActionGroup", () => {
    const recorded = TaskExecutionPlanManager.recordVerifiedCheckpointTargets(
      plan(),
      checkpoint("VERIFIED", "./lib\\helper.ts"),
    );
    const advanced = TaskExecutionPlanManager.advancePlanStage(recorded).plan;

    expect(advanced.currentStageIndex).toBe(1);
    expect(advanced.priorVerifiedTargets).toEqual([{ path: "lib/helper.ts", action: "modify" }]);
    expect(JSON.stringify(advanced.priorVerifiedTargets)).not.toMatch(/evidence|capability|manifest|revision|fingerprint/i);
  });

  test("does not promote a target from a failed or rolled-back ActionGroup", () => {
    const unchanged = TaskExecutionPlanManager.recordVerifiedCheckpointTargets(
      plan(),
      checkpoint("ROLLED_BACK", "lib/rejected.ts"),
    );
    expect(unchanged.priorVerifiedTargets).toBeUndefined();
  });

  test("already-satisfied advancement can clear an older mutation hint", () => {
    const withHint = { ...plan(), priorVerifiedTargets: [{ path: "lib/older.ts", action: "modify" as const }] };
    const cleared = TaskExecutionPlanManager.clearPriorVerifiedTargets(withHint);
    expect(cleared.priorVerifiedTargets).toEqual([]);
  });

  test("generation receives the prior helper as advisory context and may select it again", async () => {
    const prompts: string[] = [];
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      prompts.push(options.messages.map((message: any) => message.content).join("\n"));
      if (options.stage === PipelineStages.ROADMAP_PLANNING) {
        return { content: { roadmap: [{ phase: 1, title: "Repair helper", targetFiles: ["lib/helper.ts"], description: "Keep the focused implementation target" }] } } as never;
      }
      return { content: {
        explanation: "Repair helper", commitMessage: "fix records",
        changes: [{ path: "lib/helper.ts", action: "modify", description: "Repair lookup", edits: [{ oldText: "return key;", newText: "return recordKey;" }] }],
      } } as never;
    });
    const source = "export function lookup(key: string, recordKey: string) { return key; }";

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Ensure associated records render", { intent: "BUG_FIX" },
      { fileContext: { "app/items/[id]/page.tsx": "import { lookup } from '../../../lib/helper';", "lib/helper.ts": source } },
      "system", contract, null, {}, { "lib/helper.ts": source },
      [{ path: "lib/helper.ts", action: "modify" }],
    );

    expect(result.changes.map((change) => change.path)).toEqual(["lib/helper.ts"]);
    expect(prompts.join("\n")).toContain("PRIOR VERIFIED EXECUTION TARGETS");
    expect(prompts.join("\n")).toContain("MODIFY: lib/helper.ts");
  });

  test("the hint is not mandatory when a later stage legitimately selects a frontend target", async () => {
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockImplementation(async (options: any) => {
      if (options.stage === PipelineStages.ROADMAP_PLANNING) {
        return { content: { roadmap: [{ phase: 1, title: "Update consumer", targetFiles: ["frontend/page.tsx"], description: "Use the backend response" }] } } as never;
      }
      return { content: {
        explanation: "Update consumer", commitMessage: "fix consumer",
        changes: [{ path: "frontend/page.tsx", action: "modify", description: "Render response", edits: [{ oldText: "return null;", newText: "return view;" }] }],
      } } as never;
    });
    const frontend = "export function Page({ view }: { view: unknown }) { return null; }";

    const result = await CodeGenerator.generateRoadmapAndDiffs(
      "Render the backend result in the consumer", { intent: "BUG_FIX" },
      { fileContext: { "backend/service.ts": "export const load = () => [];", "frontend/page.tsx": frontend } },
      "system", contract, null, {}, { "frontend/page.tsx": frontend },
      [{ path: "backend/service.ts", action: "modify" }],
    );

    expect(result.changes.map((change) => change.path)).toEqual(["frontend/page.tsx"]);
    expect(buildPriorVerifiedTargetSection([{ path: "backend/service.ts", action: "modify" }])).toContain("select a different target");
  });

  test("a carried path grants no authority: current evidence is reacquired and an unrelated target remains rejected", () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "anka-target-handoff-"));
    try {
      fs.mkdirSync(path.join(workspace, "app/items/[id]"), { recursive: true });
      fs.mkdirSync(path.join(workspace, "lib"), { recursive: true });
      fs.writeFileSync(path.join(workspace, "app/items/[id]/page.tsx"), "import { lookup } from '../../../lib/helper'; export default function Page() { return lookup(); }");
      fs.writeFileSync(path.join(workspace, "lib/helper.ts"), "export const lookup = () => []; ");
      fs.writeFileSync(path.join(workspace, "lib/unrelated.ts"), "export const unrelated = true;");
      const routeIntent = { ...intent };
      bindUserRequest(routeIntent, routeIntent.goal);
      const carriedPlan = TaskExecutionPlanManager.recordVerifiedCheckpointTargets(plan(), checkpoint("VERIFIED", "lib/helper.ts"));
      expect(carriedPlan.priorVerifiedTargets).toEqual([{ path: "lib/helper.ts", action: "modify" }]);

      const currentHelperEvidence = new RepositoryEvidenceStore("repo", workspace);
      const helperClosure = PreExecutionAuthorityClosure.close({
        changes: [{ path: "lib/helper.ts", action: "modify", content: "export const lookup = () => ['fixed'];", description: "current repair" }],
        policy, intentSpec: routeIntent, evidenceStore: currentHelperEvidence,
        existingFiles: ["app/items/[id]/page.tsx", "lib/helper.ts"], repositoryId: "repo", workspaceRoot: workspace, stageId: "stage-2",
      });
      expect(helperClosure.valid).toBe(true);
      expect(currentHelperEvidence.getEvidenceForFile("lib/helper.ts").some((item) => item.kind === "IMPORT" || item.kind === "REFERENCE")).toBe(true);

      const freshUnrelatedEvidence = new RepositoryEvidenceStore("repo", workspace);
      const unrelatedClosure = PreExecutionAuthorityClosure.close({
        changes: [{ path: "lib/unrelated.ts", action: "modify", content: "export const unrelated = false;", description: "wrong fallback" }],
        policy, intentSpec: routeIntent, evidenceStore: freshUnrelatedEvidence,
        existingFiles: ["app/items/[id]/page.tsx", "lib/helper.ts", "lib/unrelated.ts"], repositoryId: "repo", workspaceRoot: workspace, stageId: "stage-2",
      });
      expect(unrelatedClosure.valid).toBe(false);
      expect(unrelatedClosure.result.rejectedPaths[0].reason).toContain("NO_TASK_OR_STRUCTURAL_RELATION");
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
