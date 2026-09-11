import fs from "fs";
import path from "path";
import os from "os";
import { FileSystemStateManager, RepairInfrastructureError } from "../validation/FileSystemStateManager";
import { AgentFileChange } from "../shared/types";
import { AuthorizedCapabilityScope, CapabilityAction, CapabilityGuard } from "../runtime/CapabilityGuard";

describe("FileSystemStateManager", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-state-mgr-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function authorizedManager(changes: AgentFileChange[]): FileSystemStateManager {
    const grants = changes.map((change) => ({
      path: change.path,
      action: (change.action === "delete" || change.isDeleted
        ? "FILE_DELETE"
        : change.action === "create"
          ? "FILE_CREATE"
          : fs.existsSync(path.join(tempDir, change.path))
            ? "FILE_MODIFY"
            : "FILE_CREATE") as CapabilityAction,
    }));
    const authorizedScope = AuthorizedCapabilityScope.fromBackendConfiguration({
      workspaceRoot: tempDir,
      authorityId: "filesystem-state-manager-test",
      grants,
    });
    return new FileSystemStateManager(
      authorizedScope
        ? CapabilityGuard.create({ workspaceRoot: tempDir, scopeId: "test", authorizedScope })
        : CapabilityGuard.denyAll(),
      "test",
    );
  }

  it("should snapshot existing files and new files as null", async () => {
    const existingFile = path.join(tempDir, "existing.txt");
    fs.writeFileSync(existingFile, "original content", "utf8");

    const changes: AgentFileChange[] = [
      { path: "existing.txt", action: "modify", content: "new content", description: "test" },
      { path: "new-file.txt", action: "create", content: "brand new content", description: "test" },
    ];

    const manager = authorizedManager(changes);
    await manager.snapshot(changes, tempDir);

    expect(manager.getSnapshotSize()).toBe(2);
  });

  it("should apply changes to disk and snapshot newly encountered files", async () => {
    const existingFile = path.join(tempDir, "existing.txt");
    fs.writeFileSync(existingFile, "original content", "utf8");

    const changes: AgentFileChange[] = [
      { path: "existing.txt", action: "modify", content: "updated content", description: "test" },
      { path: "created.txt", action: "create", content: "hello world", description: "test" },
    ];

    const manager = authorizedManager(changes);
    await manager.apply(changes, tempDir);

    expect(fs.readFileSync(existingFile, "utf8")).toBe("updated content");
    expect(fs.readFileSync(path.join(tempDir, "created.txt"), "utf8")).toBe("hello world");
  });

  it("should throw RepairInfrastructureError if localPath is null or invalid directory", async () => {
    const changes: AgentFileChange[] = [{ path: "foo.txt", action: "create", content: "bar", description: "test" }];
    const manager = authorizedManager(changes);

    await expect(manager.apply(changes, null)).rejects.toThrow(RepairInfrastructureError);
    await expect(manager.apply(changes, path.join(tempDir, "non-existent-folder"))).rejects.toThrow(RepairInfrastructureError);
  });

  it("should rollback modified files to original content and delete newly created files", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('v1');", "utf8");

    const changes: AgentFileChange[] = [
      { path: "src/index.ts", action: "modify", content: "console.log('v2-broken');", description: "test" },
      { path: "src/new-feature.ts", action: "create", content: "export const x = 1;", description: "test" },
    ];

    const manager = authorizedManager(changes);
    await manager.snapshot(changes, tempDir);
    await manager.apply(changes, tempDir);

    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('v2-broken');");
    expect(fs.existsSync(path.join(tempDir, "src/new-feature.ts"))).toBe(true);

    // Perform rollback
    await manager.rollback(tempDir);

    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('v1');");
    expect(fs.existsSync(path.join(tempDir, "src/new-feature.ts"))).toBe(false);
  });

  it("should clear snapshot state on commit", async () => {
    const changes: AgentFileChange[] = [{ path: "file.txt", action: "create", content: "data", description: "test" }];
    const manager = authorizedManager(changes);

    await manager.snapshot(changes, tempDir);
    expect(manager.getSnapshotSize()).toBe(1);

    manager.commit();
    expect(manager.getSnapshotSize()).toBe(0);
  });
});
