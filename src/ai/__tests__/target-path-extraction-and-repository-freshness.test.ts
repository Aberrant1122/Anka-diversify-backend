import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { TargetPathExtractor } from "../contracts/TargetPathExtractor";
import { buildExecutionContract as buildContractNew } from "../contracts/ExecutionContractBuilder";
import { buildExecutionContract as buildContractEngine } from "../../services/execution-contract.engine";
import { RepositoryMaterializationService } from "../../services/repository-materialization.service";
import { GitWorktreeService } from "../../services/git-worktree.service";
import { enforceExecutionScope } from "../contracts/ExecutionScopeEnforcer";
import { ManifestValidator } from "../../services/manifest-validator";
import { PersistentRepositoryGraphEngine } from "../../services/persistent-repository-graph.engine";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { prisma } from "../../services/database";

describe("Execution Contract Path Extraction + Iterative Repository Freshness (Sections 8, 9, 10)", () => {
  let tempBase: string;

  beforeEach(() => {
    jest.setTimeout(30000);
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-freshness-"));
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (fs.existsSync(tempBase)) {
      fs.rmSync(tempBase, { recursive: true, force: true });
    }
  });

  // ── SECTION 9: PATH EXTRACTION REGRESSION TESTS ───────────────────────────

  describe("Section 9: Path Extraction Regression Tests", () => {
    test("1. 'Remove the default Next.js starter content' produces targetPaths=[]", () => {
      const paths = TargetPathExtractor.extract("Remove the default Next.js starter content", {
        taskType: "NEW_FEATURE",
      });
      expect(paths).toEqual([]);
    });

    test("2. 'Improve my Node.js application' produces targetPaths=[]", () => {
      const paths = TargetPathExtractor.extract("Improve my Node.js application", {
        taskType: "NEW_FEATURE",
      });
      expect(paths).toEqual([]);
    });

    test("3. 'Update React.js app styling' produces targetPaths=[]", () => {
      const paths = TargetPathExtractor.extract("Update React.js app styling", {
        taskType: "NEW_FEATURE",
      });
      expect(paths).toEqual([]);
    });

    test("4. 'Fix app/page.tsx' produces targetPaths=['app/page.tsx']", () => {
      const paths = TargetPathExtractor.extract("Fix app/page.tsx", {
        taskType: "BUG_FIX",
      });
      expect(paths).toEqual(["app/page.tsx"]);
    });

    test("5. 'Update page.tsx' when repo contains app/page.tsx resolves to 'app/page.tsx'", () => {
      const paths = TargetPathExtractor.extract("Update page.tsx", {
        taskType: "BUG_FIX",
        repoFiles: ["app/page.tsx", "app/layout.tsx", "package.json"],
      });
      expect(paths).toEqual(["app/page.tsx"]);
    });

    test("6. 'Create utils.ts' explicit file-creation wording extracts 'utils.ts'", () => {
      const paths = TargetPathExtractor.extract("Create utils.ts for helper functions", {
        taskType: "FILE_CREATION",
      });
      expect(paths).toEqual(["utils.ts"]);
    });

    test("7. 'Use JavaScript and TypeScript' must not produce fake paths", () => {
      const paths = TargetPathExtractor.extract("Use JavaScript and TypeScript for the application", {
        taskType: "NEW_FEATURE",
      });
      expect(paths).toEqual([]);
    });

    test("8. 'Modify src/components/Calculator.tsx only' must remain hard constrained", () => {
      const paths = TargetPathExtractor.extract("Modify src/components/Calculator.tsx only", {
        taskType: "BUG_FIX",
      });
      expect(paths).toEqual(["src/components/Calculator.tsx"]);
    });
  });

  // ── SECTION 10: MANAGED-REPO REGRESSION TESTS ─────────────────────────────

  describe("Section 10: Managed-Repo Freshness Tests", () => {
    test("A, B, C: Remote commit advancing updates managed clone HEAD before new run", async () => {
      // Create a remote origin git repo
      const originDir = path.join(tempBase, "remote-origin.git");
      const initialCloneDir = path.join(tempBase, "initial-work");
      execSync(`git init --bare "${originDir}"`);
      execSync(`git clone "${originDir}" "${initialCloneDir}"`);
      
      // Setup initial commit
      fs.writeFileSync(path.join(initialCloneDir, "package.json"), JSON.stringify({ name: "app" }));
      fs.writeFileSync(path.join(initialCloneDir, "app.js"), "console.log('v1');");
      execSync('git add . && git commit -m "Initial_commit" && (git push origin main || git push origin master)', {
        cwd: initialCloneDir,
      });

      const managedDir = RepositoryMaterializationService.getManagedRepositoryPath("test-proj-freshness");
      if (fs.existsSync(managedDir)) {
        fs.rmSync(managedDir, { recursive: true, force: true });
      }

      // First materialization
      jest.spyOn(prisma.project, "findUnique").mockResolvedValue({
        id: "test-proj-freshness",
        name: "Test Freshness",
        localPath: managedDir,
        githubUrl: originDir,
        githubToken: null,
      } as any);
      jest.spyOn(prisma.project, "update").mockResolvedValue({} as any);

      // Clone into managed
      execSync(`git clone "${originDir}" "${managedDir}"`);
      const head1 = await GitWorktreeService.getHeadCommitSha(managedDir);

      // Advance remote commit in initialCloneDir
      fs.writeFileSync(path.join(initialCloneDir, "calculator.js"), "export function calc() {}");
      execSync('git add . && git commit -m "Add_calculator" && (git push origin main || git push origin master)', {
        cwd: initialCloneDir,
      });
      const remoteHead = execSync("git rev-parse HEAD", { cwd: initialCloneDir, encoding: "utf8" }).trim();

      expect(remoteHead).not.toBe(head1);

      // Now ensure freshness
      const mat = await RepositoryMaterializationService.ensureProjectRepositoryCurrent("test-proj-freshness");
      expect(mat.success).toBe(true);
      expect(mat.metadata?.headSha).toBe(remoteHead);

      // Managed clone HEAD is now at remoteHead
      const managedHeadAfter = await GitWorktreeService.getHeadCommitSha(managedDir);
      expect(managedHeadAfter).toBe(remoteHead);

      // Newly pushed file exists in managed clone
      expect(fs.existsSync(path.join(managedDir, "calculator.js"))).toBe(true);
    }, 30000);

    test("D, E: Newly-pushed created file becomes visible to repository scan on next run", async () => {
      const repoDir = path.join(tempBase, "local-repo");
      execSync(`git init "${repoDir}"`);
      fs.writeFileSync(path.join(repoDir, "app.ts"), "const a = 1;");
      execSync('git add . && git commit -m "Initial"', { cwd: repoDir });

      const snap1 = RepositoryScanner.getEffectiveSnapshot(null, repoDir);
      const files1 = snap1.keyFiles.map((f: any) => (typeof f === "string" ? f : f.path));
      expect(files1).toContain("app.ts");
      expect(files1).not.toContain("Calculator.tsx");

      // Add Calculator.tsx
      fs.writeFileSync(path.join(repoDir, "Calculator.tsx"), "export const Calc = () => null;");
      execSync('git add . && git commit -m "Add_Calc"', { cwd: repoDir });

      const snap2 = RepositoryScanner.getEffectiveSnapshot(null, repoDir);
      const files2 = snap2.keyFiles.map((f: any) => (typeof f === "string" ? f : f.path));
      expect(files2).toContain("Calculator.tsx");
      expect(snap2.revision?.contentHash).not.toBe(snap1.revision?.contentHash);
    }, 30000);

    test("H: User-owned external localPath is never hard-reset by managed sync logic", () => {
      const externalPath = "C:\\Users\\Developer\\Projects\\my-custom-next-app";
      expect(RepositoryMaterializationService.isManagedRepositoryPath(externalPath)).toBe(false);
    });
  });

  // ── SECTION 8: FULL ITERATIVE FEATURE TEST ────────────────────────────────

  describe("Section 8: Iterative Feature Flow", () => {
    test("Run 2 request with 'Next.js' creates unconstrained contract and allows modifying Calculator.tsx", () => {
      const run2Message =
        "Improve the existing calculator. Remove the default Next.js starter content from the page, center the calculator on the screen, add a backspace button and percentage operation, and keep the existing calculator functionality working.";

      const repoFiles = [
        "package.json",
        "app/page.tsx",
        "app/layout.tsx",
        "app/components/Calculator.tsx",
        "app/styles/calculator.css",
      ];

      // A. "Next.js" does not become a target path
      const extracted = TargetPathExtractor.extract(run2Message, {
        repoFiles,
        taskType: "NEW_FEATURE",
      });
      expect(extracted).not.toContain("Next.js");
      expect(extracted).not.toContain("Next");

      // B. executionContract.targetPaths is []
      const contract = buildContractNew(
        {
          taskType: "NEW_FEATURE",
          intent: "NEW_FEATURE",
          confidence: 0.95,
          requiresClarification: false,
          reasoning: "Feature improvement",
          risk: "LOW",
          estimatedComplexity: "MEDIUM",
        },
        run2Message,
        repoFiles
      );

      expect(contract.targetPaths).toEqual([]);

      // C & D & E: Manifest can modify page.tsx, Calculator.tsx, calculator.css
      const proposedManifest = {
        files: [
          { path: "app/page.tsx", action: "modify" as const, dependencies: [], description: "center calculator" },
          { path: "app/components/Calculator.tsx", action: "modify" as const, dependencies: [], description: "add backspace & percentage" },
          { path: "app/styles/calculator.css", action: "modify" as const, dependencies: [], description: "update styles" },
        ],
        totalFiles: 3,
        manifestVersion: "1.0.0",
      };

      const validator = new ManifestValidator(contract, repoFiles);
      const manifestValidation = validator.validate(proposedManifest);
      expect(manifestValidation.valid).toBe(true);

      const scopeCheck = enforceExecutionScope({
        proposedChanges: [
          { path: "app/page.tsx", action: "modify", content: "export default function Page() {}", description: "update" },
          { path: "app/components/Calculator.tsx", action: "modify", content: "'use client'; export function Calc() {}", description: "update" },
          { path: "app/styles/calculator.css", action: "modify", content: ".calc { color: red; }", description: "update" },
        ],
        manifest: proposedManifest,
        contract,
        existingFilePaths: repoFiles,
      });

      expect(scopeCheck.valid).toBe(true);
    });
  });
});
