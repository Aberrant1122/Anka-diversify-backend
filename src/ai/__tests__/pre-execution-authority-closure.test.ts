import fs from "fs";
import os from "os";
import path from "path";
import { PreExecutionAuthorityClosure } from "../contracts/PreExecutionAuthorityClosure";
import { PolicyContract } from "../contracts/PolicyContract";
import { TaskIntentSpec } from "../shared/TaskIntentSpec";
import { RepositoryEvidenceStore } from "../repository/RepositoryEvidenceStore";

const policy: PolicyContract = {
  goal: "Repair an observed record flow", taskType: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM",
  destructive: false, allowedActions: ["modify_file"], forbiddenActions: ["delete_file"], maxFiles: 4,
  diffCriticEnabled: true, pipeline: "REPOSITORY", environment: "GENERIC", repositoryRequired: true,
  expectedFiles: [], validationType: "TYPESCRIPT_BUILD", explicitUserPaths: [], userConstraints: [], requiresClarification: false,
};
const intent: TaskIntentSpec = {
  goal: policy.goal, operations: [{ kind: "MODIFY", subject: "observed record flow" }], constraints: [], acceptanceCriteria: [],
  destructive: false, requiresClarification: false, taskType: "BUG_FIX", risk: "MEDIUM", estimatedComplexity: "MEDIUM", explicitUserPaths: [],
};

describe("Hotfix 05 — pre-execution authority closure", () => {
  let workspace: string;
  beforeEach(() => { workspace = fs.mkdtempSync(path.join(os.tmpdir(), "anka-hf05-")); fs.mkdirSync(path.join(workspace, "src")); });
  afterEach(() => fs.rmSync(workspace, { recursive: true, force: true }));

  test("late generated target is authorized only after authentic deterministic relation evidence", () => {
    fs.writeFileSync(path.join(workspace, "src", "consumer.ts"), "import { loadItems } from './implementation'; loadItems();");
    fs.writeFileSync(path.join(workspace, "src", "implementation.ts"), "export function loadItems() { return []; }");
    const evidence = new RepositoryEvidenceStore("repo", workspace);
    evidence.observeRepository({ kind: "REFERENCE", filePath: "src/implementation.ts", sourceFile: "src/consumer.ts", symbol: "loadItems", provenance: "REFERENCE_SEARCH" });
    const closed = PreExecutionAuthorityClosure.close({ changes: [{ path: "src/implementation.ts", action: "modify", content: "x", description: "repair" }], policy, intentSpec: intent, evidenceStore: evidence, existingFiles: ["src/consumer.ts", "src/implementation.ts"], repositoryId: "repo", workspaceRoot: workspace, stageId: "stage-1" });
    expect(closed.valid).toBe(true);
    expect(closed.result.approvedPaths).toEqual(["src/implementation.ts"]);
  });

  test("unrelated generated file rejects the entire atomic group before execution", () => {
    fs.writeFileSync(path.join(workspace, "src", "a.ts"), "export const a = 1;");
    fs.writeFileSync(path.join(workspace, "src", "b.ts"), "export const b = 1;");
    const evidence = new RepositoryEvidenceStore("repo", workspace);
    evidence.observeRepository({ kind: "SYMBOL", filePath: "src/a.ts", symbol: "a", provenance: "AST_GRAPH" });
    const closed = PreExecutionAuthorityClosure.close({ changes: [{ path: "src/a.ts", action: "modify", content: "x", description: "repair" }, { path: "src/b.ts", action: "modify", content: "x", description: "unrelated" }], policy, intentSpec: intent, evidenceStore: evidence, existingFiles: ["src/a.ts", "src/b.ts"], repositoryId: "repo", workspaceRoot: workspace, stageId: "stage-1" });
    expect(closed.valid).toBe(false);
    expect(closed.result.approvedPaths).toEqual(["src/a.ts"]);
    expect(closed.result.rejectedPaths).toHaveLength(1);
  });
});
