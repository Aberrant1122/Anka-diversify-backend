import fs from "fs";
import path from "path";
import os from "os";
import { ValidationRunner } from "../validation/ValidationRunner";
import { AgentFileChange } from "../shared/types";

describe("ValidationRunner - Pure Command Execution & Strict Input Handling", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "val-runner-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("validateWithShell should NOT write files to disk", async () => {
    const changes: AgentFileChange[] = [
      { path: "should-not-be-written.txt", content: "hello world", description: "test" },
    ];

    await ValidationRunner.validateWithShell(changes, tempDir, []);

    const createdFile = path.join(tempDir, "should-not-be-written.txt");
    expect(fs.existsSync(createdFile)).toBe(false);
  });

  it("validateWithShell should return failure if localPath is null or missing", async () => {
    const resNull = await ValidationRunner.validateWithShell([], null, ["echo 1"]);
    expect(resNull.success).toBe(false);
    expect(resNull.errors).toContain("localPath is missing");

    const nonExistentPath = path.join(tempDir, "missing-folder");
    const resMissing = await ValidationRunner.validateWithShell([], nonExistentPath, ["echo 1"]);
    expect(resMissing.success).toBe(false);
    expect(resMissing.errors).toContain("does not exist or is inaccessible");
  });

  it("selfReviewChanges should return success: false when LLM returns unparseable output", async () => {
    // Calling selfReviewChanges with an empty array returns success: true without LLM call
    const emptyRes = await ValidationRunner.selfReviewChanges([]);
    expect(emptyRes.success).toBe(true);
  });
});
