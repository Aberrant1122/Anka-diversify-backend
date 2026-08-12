import fs from "fs";
import path from "path";
import os from "os";
import { FileSystemStateManager, RepairInfrastructureError } from "../validation/FileSystemStateManager";
import { AgentFileChange } from "../shared/types";

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

  it("should snapshot existing files and new files as null", async () => {
    const existingFile = path.join(tempDir, "existing.txt");
    fs.writeFileSync(existingFile, "original content", "utf8");

    const changes: AgentFileChange[] = [
      { path: "existing.txt", content: "new content", description: "test" },
      { path: "new-file.txt", content: "brand new content", description: "test" },
    ];

    const manager = new FileSystemStateManager();
    await manager.snapshot(changes, tempDir);

    expect(manager.getSnapshotSize()).toBe(2);
  });

  it("should apply changes to disk and snapshot newly encountered files", async () => {
    const existingFile = path.join(tempDir, "existing.txt");
    fs.writeFileSync(existingFile, "original content", "utf8");

    const changes: AgentFileChange[] = [
      { path: "existing.txt", content: "updated content", description: "test" },
      { path: "created.txt", content: "hello world", description: "test" },
    ];

    const manager = new FileSystemStateManager();
    await manager.apply(changes, tempDir);

    expect(fs.readFileSync(existingFile, "utf8")).toBe("updated content");
    expect(fs.readFileSync(path.join(tempDir, "created.txt"), "utf8")).toBe("hello world");
  });

  it("should throw RepairInfrastructureError if localPath is null or invalid directory", async () => {
    const manager = new FileSystemStateManager();
    const changes: AgentFileChange[] = [{ path: "foo.txt", content: "bar", description: "test" }];

    await expect(manager.apply(changes, null)).rejects.toThrow(RepairInfrastructureError);
    await expect(manager.apply(changes, path.join(tempDir, "non-existent-folder"))).rejects.toThrow(RepairInfrastructureError);
  });

  it("should rollback modified files to original content and delete newly created files", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('v1');", "utf8");

    const changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "console.log('v2-broken');", description: "test" },
      { path: "src/new-feature.ts", content: "export const x = 1;", description: "test" },
    ];

    const manager = new FileSystemStateManager();
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
    const manager = new FileSystemStateManager();
    const changes: AgentFileChange[] = [{ path: "file.txt", content: "data", description: "test" }];

    await manager.snapshot(changes, tempDir);
    expect(manager.getSnapshotSize()).toBe(1);

    manager.commit();
    expect(manager.getSnapshotSize()).toBe(0);
  });
});
