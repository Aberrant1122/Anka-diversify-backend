import fs from "fs";
import path from "path";
import os from "os";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { AgentProgressEvent, AgentFileChange } from "../shared/types";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";

describe("Pipeline & SelfHealingEngine Progress Events (Phase 6C)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "progress-events-test-"));
  });

  afterEach(() => {
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
      { path: "test.ts", content: "export const x = 1;", description: "test" },
    ];
    const fsManager = new FileSystemStateManager();

    const res = await SelfHealingEngine.runSelfHealingLoop(
      changes,
      tempDir,
      ["echo pass"],
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
    const content = fs.readFileSync(pipelinePath, "utf8");

    expect(content).toContain('stageName: "SECURITY_AUDIT"');
    expect(content).toContain("step: 9");
    expect(content).toContain('stageName: "MEMORY_PERSISTENCE"');
    expect(content).toContain("step: 10");
  });
});
