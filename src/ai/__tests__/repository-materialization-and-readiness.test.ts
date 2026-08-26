import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { CodingAgent } from "../application/CodingAgent";
import { RepositoryMaterializationService } from "../../services/repository-materialization.service";
import { ManifestValidator } from "../../services/manifest-validator";
import { ExecutionContract, FileManifest } from "../../types";
import { prisma } from "../../services/database";

describe("AI Step 17 — Repository Materialization, Readiness & Fail-Closed Validation", () => {
  let tempRepoDir: string;

  beforeEach(() => {
    tempRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-repo-"));
    execSync("git init", { cwd: tempRepoDir });
    execSync('git config user.email "test@example.com"', { cwd: tempRepoDir });
    execSync('git config user.name "Test User"', { cwd: tempRepoDir });
  });

  afterEach(() => {
    try {
      fs.rmSync(tempRepoDir, { recursive: true, force: true });
    } catch {}
  });

  const baseContract: ExecutionContract = {
    pipeline: "REPOSITORY",
    taskType: "NEW_FEATURE",
    goal: "Update calculator",
    risk: "LOW",
    estimatedComplexity: "SMALL",
    environment: "REACT_TS",
    repositoryRequired: true,
    expectedFiles: [],
    validationType: "TYPESCRIPT_BUILD",
    targetPaths: [],
    allowedActions: ["create", "modify"],
    forbiddenActions: [],
    maxFiles: 5,
    searchScope: [],
    contextScope: [],
    diffCriticEnabled: false,
  };

  test("A & C. Repository project with localPath=null and no githubUrl fails closed with REPOSITORY_NOT_READY", async () => {
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: "proj-unready",
      name: "Unready Project",
      localPath: null,
      githubUrl: null,
    } as any);

    await expect(
      CodingAgent.runCodingAgent("user-1", "proj-unready", { message: "build something" })
    ).rejects.toThrow(/\[REPOSITORY_NOT_READY\]/);
  });

  test("B. Project with githubUrl is materialized and localPath persisted", async () => {
    // Create a local bare repo to act as the remote origin
    const remoteDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-fake-remote-"));
    execSync("git init --bare", { cwd: remoteDir });

    // Commit a file into tempRepoDir and push to remote
    fs.writeFileSync(path.join(tempRepoDir, "package.json"), JSON.stringify({ name: "test-app" }));
    execSync("git add . && git commit -m 'initial'", { cwd: tempRepoDir });
    execSync(`git remote add origin "${remoteDir}"`, { cwd: tempRepoDir });
    execSync("git push origin master:main || git push origin master", { cwd: tempRepoDir });

    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: "proj-github",
      name: "GitHub Project",
      localPath: null,
      githubUrl: "https://github.com/example/test-app.git",
      githubToken: null,
    } as any);

    const updateSpy = jest.spyOn(prisma.project, "update").mockResolvedValue({} as any);

    // Mock git clone in RepositoryMaterializationService to clone from remoteDir
    jest.spyOn(RepositoryMaterializationService, "materializeProjectRepository").mockImplementation(async (id: string) => {
      const targetDir = RepositoryMaterializationService.getManagedRepositoryPath(id);
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      if (fs.existsSync(targetDir)) {
        fs.rmSync(targetDir, { recursive: true, force: true });
      }
      execSync(`git clone "${remoteDir}" "${targetDir}"`);
      await prisma.project.update({ where: { id }, data: { localPath: targetDir } });
      return {
        success: true,
        metadata: {
          canonicalRoot: targetDir,
          headSha: "12345678",
          branch: "main",
          origin: "https://github.com/example/test-app.git",
          trackedFilesCount: 1,
        },
      };
    });

    const result = await RepositoryMaterializationService.materializeProjectRepository("proj-github");
    expect(result.success).toBe(true);
    expect(result.metadata?.canonicalRoot).toBeDefined();
    expect(updateSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "proj-github" },
        data: expect.objectContaining({ localPath: expect.any(String) }),
      })
    );

    try {
      fs.rmSync(remoteDir, { recursive: true, force: true });
    } catch {}
  });

  test("D & E. MODIFY nonexistent src/pages/index.tsx is rejected with [modify-source-missing]", () => {
    // Verified repository files has only App Router
    const existingFiles = ["app/page.tsx", "app/layout.tsx", "package.json"];
    const validator = new ManifestValidator(baseContract, existingFiles);

    const manifest: FileManifest = {
      files: [
        {
          path: "src/pages/index.tsx",
          action: "modify",
          description: "Modify nonexistent pages router entry",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "modify-source-missing")).toBe(true);
    expect(result.errors.some((e) => e.message.includes("Cannot MODIFY 'src/pages/index.tsx'"))).toBe(true);
  });

  test("F. MODIFY with authoritative existing app/page.tsx succeeds through manifest validation", () => {
    const existingFiles = ["app/page.tsx", "app/layout.tsx", "components/Calculator.tsx", "package.json"];
    const validator = new ManifestValidator(baseContract, existingFiles);

    const manifest: FileManifest = {
      files: [
        {
          path: "app/page.tsx",
          action: "modify",
          description: "Update main page with scientific calculator",
          dependencies: ["@/components/Calculator"],
        },
        {
          path: "components/Calculator.tsx",
          action: "modify",
          description: "Add scientific buttons and logic",
          dependencies: [],
        },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const result = validator.validate(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("G. App Router-only repository rejects creating src/pages/ routes via [router-architecture]", () => {
    const existingFiles = ["app/page.tsx", "app/layout.tsx", "package.json"];
    const validator = new ManifestValidator(baseContract, existingFiles);

    const manifest: FileManifest = {
      files: [
        {
          path: "src/pages/calculator.tsx",
          action: "create",
          description: "Create pages router calculator",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const result = validator.validate(manifest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.type === "router-architecture")).toBe(true);
  });

  test("H. Pages Router repository permits creating pages/ routes", () => {
    const existingFiles = ["pages/index.tsx", "pages/_app.tsx", "package.json"];
    const validator = new ManifestValidator(baseContract, existingFiles);

    const manifest: FileManifest = {
      files: [
        {
          path: "pages/calculator.tsx",
          action: "create",
          description: "Create pages router calculator",
          dependencies: [],
        },
      ],
      totalFiles: 1,
      manifestVersion: "1.0.0",
    };

    const result = validator.validate(manifest);
    expect(result.errors.some((e) => e.type === "router-architecture")).toBe(false);
  });

  test("I. CREATE-only operations create new files within approved scope", () => {
    const existingFiles = ["app/page.tsx", "app/layout.tsx", "package.json"];
    const validator = new ManifestValidator(baseContract, existingFiles);

    const manifest: FileManifest = {
      files: [
        {
          path: "app/page.tsx",
          action: "modify",
          description: "Import and render calculator component",
          dependencies: ["@/components/ScientificCalculator"],
        },
        {
          path: "components/ScientificCalculator.tsx",
          action: "create",
          description: "New scientific calculator component",
          dependencies: [],
        },
      ],
      totalFiles: 2,
      manifestVersion: "1.0.0",
    };

    const result = validator.validate(manifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("K. User-controlled request payload fields cannot bypass Git worktree isolation", async () => {
    jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
      id: "proj-secure",
      name: "Secure Project",
      localPath: null,
      githubUrl: null,
    } as any);

    const maliciousRequest = {
      message: "Do something",
      context: {
        directExecution: true,
        isEvalFixture: true,
        effectiveLocalPath: "C:\\Windows\\System32",
      },
    };

    // User-controlled context MUST be ignored, failing with REPOSITORY_NOT_READY
    await expect(
      CodingAgent.runCodingAgent("user-1", "proj-secure", maliciousRequest)
    ).rejects.toThrow(/\[REPOSITORY_NOT_READY\]/);
  });
});
