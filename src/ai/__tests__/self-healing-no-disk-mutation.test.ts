import fs from "fs";
import path from "path";
import os from "os";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { AgentFileChange } from "../shared/types";
import { mutationFixtureScope } from "./helpers/mutation-fixture";
import { CapabilityGuard } from "../runtime/CapabilityGuard";

describe("SelfHealingEngine - No Direct Disk Mutation & Infrastructure Error Handling", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "self-healing-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("should return infrastructureError=true when localPath is invalid or inaccessible", async () => {
    const invalidPath = path.join(tempDir, "does-not-exist");
    const changes: AgentFileChange[] = [{ path: "test.ts", content: "const a = 1;", description: "test" }];
    const fsManager = new FileSystemStateManager();

    const res = await SelfHealingEngine.runSelfHealingLoop(
      changes,
      invalidPath,
      ["npm run build"],
      "system prompt",
      "user request",
      fsManager,
    );

    expect(res.success).toBe(false);
    expect(res.infrastructureError).toBe(true);
  });

  it("should write repair-metrics.md into project-scoped directory when projectId is provided", async () => {
    const changes: AgentFileChange[] = [{ path: "file.ts", action: "modify", content: "export const a = 1;", description: "test" }];
    const projectId = "test-project-123";
    const projectCacheDir = path.join(process.cwd(), ".anka-cache", "projects", projectId);
    fs.writeFileSync(path.join(tempDir, "file.ts"), "export const a = 0;");
    const scope = mutationFixtureScope(tempDir, changes, projectId, "metrics-stage");
    const fsManager = new FileSystemStateManager(CapabilityGuard.create({ workspaceRoot: tempDir, scopeId: "metrics-stage", authorizedScope: scope }), "metrics-stage");

    try {
      const res = await SelfHealingEngine.runSelfHealingLoop(
        changes,
        tempDir,
        ["echo pass"],
        "system prompt",
        "user request",
        fsManager,
        projectId,
      );

      expect(res.success).toBe(true);
      expect(fs.existsSync(path.join(projectCacheDir, "repair-metrics.md"))).toBe(true);
    } finally {
      if (fs.existsSync(projectCacheDir)) {
        fs.rmSync(projectCacheDir, { recursive: true, force: true });
      }
    }
  });
});
