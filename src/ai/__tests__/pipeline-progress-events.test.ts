import fs from "fs";
import path from "path";
import os from "os";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { AgentProgressEvent, AgentFileChange } from "../shared/types";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { mutationFixtureScope } from "./helpers/mutation-fixture";
import { MutationTransaction } from "../runtime/MutationTransaction";
import { CapabilityGuard } from "../runtime/CapabilityGuard";
import { reconcileExecutionManifest } from "../runtime/ExecutionManifest";
import { LLMGateway } from "../gateway/LLMGateway";
import { fingerprintBytes } from "../editing/EditingPrimitives";

describe("Pipeline & SelfHealingEngine Progress Events (Phase 6C)", () => {
  let tempDir: string;
  let transaction: MutationTransaction | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "progress-events-test-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    transaction?.abort();
    transaction = undefined;
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should trigger onProgress with stageName='SELF_HEALING' during repair attempts", async () => {
    const events: AgentProgressEvent[] = [];
    const onProgress = (evt: AgentProgressEvent) => {
      events.push(evt);
    };

    const changes: AgentFileChange[] = [
      { path: "test.ts", action: "modify", content: "export const x = missing;", description: "test" },
    ];
    fs.writeFileSync(path.join(tempDir, "test.ts"), "export const x = 1;");
    fs.writeFileSync(path.join(tempDir, "validate.cjs"), "if(require('fs').readFileSync('test.ts','utf8').includes('missing')) { console.error('test.ts(1,18): error TS2304: Cannot find name missing.'); process.exitCode=1; }");
    const scope = mutationFixtureScope(tempDir, changes);
    transaction = MutationTransaction.create(scope, reconcileExecutionManifest(scope, null));
    const fsManager = new FileSystemStateManager(CapabilityGuard.forTransaction(transaction, transaction.primary), transaction.id, transaction);
    jest.spyOn(LLMGateway.getInstance(), "callStructured").mockResolvedValue({ content: { operations: [{ op: "replace_exact", path: "test.ts",
      expectedFileHash: fingerprintBytes(changes[0].content), oldText: "missing", newText: "1" }] } } as Awaited<ReturnType<LLMGateway["callStructured"]>>);

    const res = await SelfHealingEngine.runSelfHealingLoop(
      changes,
      tempDir,
      ["node validate.cjs"],
      "system prompt",
      "user request",
      fsManager,
      undefined,
      onProgress,
    );

    expect(res.success).toBe(true);
    expect(events.length).toBeGreaterThan(0);

    const selfHealingEvt = events.find((e) => e.stageName === "SELF_HEALING");
    expect(selfHealingEvt).toBeDefined();
    expect(selfHealingEvt?.step).toBe(8);
    expect(selfHealingEvt?.badge).toContain("STAGE 8");
  });

  it("AgentPipeline source should emit step 9 SECURITY_AUDIT and step 10 MEMORY_PERSISTENCE", () => {
    const pipelinePath = path.join(__dirname, "..", "orchestration", "AgentPipeline.ts");
    const coordinatorPath = path.join(__dirname, "..", "orchestration", "ValidationCoordinator.ts");
    const content = fs.readFileSync(pipelinePath, "utf8") + fs.readFileSync(coordinatorPath, "utf8");

    expect(content).toContain('stageName: "SECURITY_AUDIT"');
    expect(content).toContain("step: 9");
    expect(content).toContain('stageName: "MEMORY_PERSISTENCE"');
    expect(content).toContain("step: 10");
  });
});
