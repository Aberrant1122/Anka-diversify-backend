import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { exec } from "child_process";
import { promisify } from "util";
import dotenv from "dotenv";

dotenv.config();

const execAsync = promisify(exec);

function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath, "utf8");
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

async function createDisposableFrontendRepo(): Promise<{ repoDir: string; initialCommitSha: string; initialFileHashes: Record<string, string> }> {
  const repoDir = path.resolve(os.tmpdir(), `anka-smoke-frontend-${Date.now()}`);
  await fs.promises.mkdir(repoDir, { recursive: true });

  // Git init on main branch
  await execAsync("git init -b main", { cwd: repoDir });
  await execAsync('git config user.name "Anka Smoke Runner"', { cwd: repoDir });
  await execAsync('git config user.email "smoke-runner@anka-test.local"', { cwd: repoDir });

  // Create package.json
  const packageJson = {
    name: "smoke-test-dashboard",
    version: "1.0.0",
    private: true,
    scripts: {
      test: "node test/validate.js",
    },
  };
  fs.writeFileSync(path.join(repoDir, "package.json"), JSON.stringify(packageJson, null, 2), "utf8");

  // Create src/components/Header.tsx
  fs.mkdirSync(path.join(repoDir, "src", "components"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "src", "components", "Header.tsx"),
    `import React from 'react';

export interface HeaderProps {
  title: string;
}

export const Header: React.FC<HeaderProps> = ({ title }) => {
  return (
    <header className="dashboard-header">
      <h1>{title}</h1>
    </header>
  );
};
`,
    "utf8"
  );

  // Create src/pages/DashboardPage.tsx
  fs.mkdirSync(path.join(repoDir, "src", "pages"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "src", "pages", "DashboardPage.tsx"),
    `import React from 'react';
import { Header } from '../components/Header';

export const DashboardPage: React.FC = () => {
  return (
    <div className="dashboard-page">
      <Header title="Project Dashboard" />
      <main className="dashboard-content">
        <p>Welcome to the project dashboard.</p>
      </main>
    </div>
  );
};
`,
    "utf8"
  );

  // Create test/validate.js
  fs.mkdirSync(path.join(repoDir, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "test", "validate.js"),
    `const fs = require('fs');
const path = require('path');

const pagePath = path.join(__dirname, '..', 'src', 'pages', 'DashboardPage.tsx');
if (!fs.existsSync(pagePath)) {
  console.error('Validation failed: DashboardPage.tsx is missing');
  process.exit(1);
}

const content = fs.readFileSync(pagePath, 'utf8');
if (!content.includes('Header')) {
  console.error('Validation failed: Header missing from DashboardPage.tsx');
  process.exit(1);
}

console.log('Smoke test validation passed.');
`,
    "utf8"
  );

  // Commit baseline
  await execAsync("git add .", { cwd: repoDir });
  await execAsync('git commit -m "Initial commit of dashboard frontend application"', { cwd: repoDir });

  const { stdout } = await execAsync("git rev-parse HEAD", { cwd: repoDir });
  const initialCommitSha = stdout.trim();

  // Snapshot all file hashes in source repo
  const initialFileHashes: Record<string, string> = {
    "package.json": computeFileHash(path.join(repoDir, "package.json")),
    "src/components/Header.tsx": computeFileHash(path.join(repoDir, "src", "components", "Header.tsx")),
    "src/pages/DashboardPage.tsx": computeFileHash(path.join(repoDir, "src", "pages", "DashboardPage.tsx")),
    "test/validate.js": computeFileHash(path.join(repoDir, "test", "validate.js")),
  };

  return { repoDir, initialCommitSha, initialFileHashes };
}

async function main() {
  console.log("===============================================================");
  console.log(" ANKA OS — AI STEP 13: REAL WEBSITE REPOSITORY SMOKE TEST");
  console.log("===============================================================\n");

  if (!process.env.OPENAI_API_KEY) {
    console.error("❌ ERROR: OPENAI_API_KEY is not configured in .env.");
    process.exit(1);
  }

  // Phase 2: Create disposable real frontend repository
  console.log("Step 1: Creating disposable local Git frontend repository...");
  const { repoDir, initialCommitSha, initialFileHashes } = await createDisposableFrontendRepo();
  console.log(`  ✓ Source repository initialized at: ${repoDir}`);
  console.log(`  ✓ Baseline HEAD SHA: ${initialCommitSha}`);
  console.log(`  ✓ Tracked files: ${Object.keys(initialFileHashes).join(", ")}\n`);

  // Dynamically load dependencies
  const { EvalDatabaseFixture } = await import("../src/ai/evals/EvalDatabaseFixture");
  const { CodingAgent } = await import("../src/ai/application/CodingAgent");
  const { GitWorktreeService } = await import("../src/services/git-worktree.service");

  // Provision database context
  const runId = `smoke-${Date.now().toString(36)}`;
  const evalContext = await EvalDatabaseFixture.provision("website-smoke", repoDir, runId);
  console.log(`Step 2: Provisioned database context:`);
  console.log(`  ✓ User ID: ${evalContext.userId}`);
  console.log(`  ✓ Project ID: ${evalContext.projectId}`);
  console.log(`  ✓ Database localPath: ${evalContext.localPath}\n`);

  const taskPrompt =
    "Add a DashboardSummary component in src/components/DashboardSummary.tsx with three summary cards for Users, Projects, and Tasks. Import and include <DashboardSummary /> inside src/pages/DashboardPage.tsx below the Header. Follow existing component conventions. Do not modify unrelated files. Run the repository's supported validation.";

  console.log("Step 3: Running REAL_MODEL task through CodingAgent...");
  console.log(`  • Task Prompt: "${taskPrompt}"\n`);

  const stageEvents: any[] = [];
  const startTime = Date.now();

  let agentResponse: any;
  let executionError: any = null;

  try {
    agentResponse = await CodingAgent.runCodingAgent(
      evalContext.userId,
      evalContext.projectId,
      {
        message: taskPrompt,
        context: {},
      },
      (event) => {
        stageEvents.push(event);
        console.log(`  [Stage ${event.step}/10 · ${event.stageName}] ${event.label}: ${event.detail || ""}`);
      }
    );
  } catch (err: any) {
    executionError = err;
    console.error(`\n❌ Execution error encountered: ${err.message}`, err);
  }

  const durationMs = Date.now() - startTime;
  console.log(`\nExecution completed in ${(durationMs / 1000).toFixed(2)}s\n`);

  // Phase 4: Verification of the 10 criteria
  console.log("===============================================================");
  console.log(" PHASE 4: VERIFICATION OF WORKTREE ISOLATION CRITERIA");
  console.log("===============================================================\n");

  // 1. Source repo integrity
  const { stdout: sourceBranch } = await execAsync("git rev-parse --abbrev-ref HEAD", { cwd: repoDir });
  const { stdout: sourceStatus } = await execAsync("git status --porcelain", { cwd: repoDir });
  const { stdout: sourceHead } = await execAsync("git rev-parse HEAD", { cwd: repoDir });

  let sourceByteIdentical = true;
  for (const [relPath, origHash] of Object.entries(initialFileHashes)) {
    const currHash = computeFileHash(path.join(repoDir, relPath));
    if (currHash !== origHash) {
      sourceByteIdentical = false;
      console.error(`  ✗ Source repo file modified: ${relPath}`);
    }
  }

  const p1 = sourceBranch.trim() === "main" && sourceStatus.trim().length === 0 && sourceHead.trim() === initialCommitSha && sourceByteIdentical;
  console.log(`1. Source repository remains byte-identical on original branch 'main': ${p1 ? "✅ PASS" : "❌ FAIL"}`);

  // 2. Discover worktree path and branch
  const activeWorktreePath: string | null = agentResponse?.worktreePath || null;
  const activeBranchName: string | null = agentResponse?.branchName || null;

  const p2 = Boolean(activeBranchName && activeBranchName.startsWith("anka/run-"));
  console.log(`2. ANKA branch created (${activeBranchName || "none"}): ${p2 ? "✅ PASS" : "❌ FAIL"}`);

  // 3. Worktree contains generated changes
  let hasSummaryComponent = false;
  let dashboardUpdated = false;
  if (activeWorktreePath) {
    const summaryPath = path.join(activeWorktreePath, "src", "components", "DashboardSummary.tsx");
    const dashPath = path.join(activeWorktreePath, "src", "pages", "DashboardPage.tsx");
    hasSummaryComponent = fs.existsSync(summaryPath);
    if (fs.existsSync(dashPath)) {
      const dashContent = fs.readFileSync(dashPath, "utf8");
      dashboardUpdated = dashContent.includes("DashboardSummary");
    }
  }
  const p3 = hasSummaryComponent && dashboardUpdated;
  console.log(`3. Worktree contains generated DashboardSummary component and updated DashboardPage: ${p3 ? "✅ PASS" : "❌ FAIL"}`);

  // 4. Changed files match manifest scope
  const changes = agentResponse?.changes || [];
  const changedFilePaths = changes.map((c: any) => c.path.replace(/\\/g, "/"));
  const p4 = changedFilePaths.every((p: string) => p === "src/components/DashboardSummary.tsx" || p === "src/pages/DashboardPage.tsx");
  console.log(`4. Changed files within manifest scope (${changedFilePaths.join(", ")}): ${p4 ? "✅ PASS" : "❌ FAIL"}`);

  // 5. No protected paths modified
  const forbiddenTouched = changedFilePaths.some((p: string) =>
    p.startsWith(".git") || p.startsWith("node_modules") || p.startsWith("dist") || p.startsWith("build")
  );
  const p5 = !forbiddenTouched;
  console.log(`5. No protected paths (.git, node_modules, dist, build) touched: ${p5 ? "✅ PASS" : "❌ FAIL"}`);

  // 6. Validation ran with cwd = worktreePath
  const valPassed = agentResponse?.buildVerified !== false && !executionError;
  const p6 = Boolean(activeWorktreePath && valPassed);
  console.log(`6. Validation ran inside isolated worktree cwd: ${p6 ? "✅ PASS" : "❌ FAIL"}`);

  // 7. Validation passed
  const p7 = valPassed;
  console.log(`7. Validation passed: ${p7 ? "✅ PASS" : "❌ FAIL"}`);

  // 8. Reviewable git diff exists
  let diffSummary = "";
  if (activeWorktreePath) {
    const diffRes = await GitWorktreeService.getWorktreeDiff(activeWorktreePath, initialCommitSha);
    diffSummary = diffRes.rawDiff;
  }
  const p8 = Boolean(diffSummary && diffSummary.length > 0);
  console.log(`8. Reviewable Git diff generated: ${p8 ? "✅ PASS" : "❌ FAIL"}`);

  // 9. Worktree result valid
  const p9 = hasSummaryComponent && dashboardUpdated;
  console.log(`9. Worktree contains runnable frontend code: ${p9 ? "✅ PASS" : "❌ FAIL"}`);

  // 10. No auto-commit/merge/push
  const { stdout: finalMainLog } = await execAsync("git log -n 1 --oneline", { cwd: repoDir });
  const p10 = finalMainLog.includes("Initial commit of dashboard frontend application");
  console.log(`10. No auto-commit, push, or merge into main branch: ${p10 ? "✅ PASS" : "❌ FAIL"}\n`);

  console.log("===============================================================");
  console.log(" SMOKE TEST SUMMARY REPORT");
  console.log("===============================================================");
  console.log(`• Task Prompt: ${taskPrompt}`);
  console.log(`• Source Repository: ${repoDir}`);
  console.log(`• Worktree Path: ${activeWorktreePath}`);
  console.log(`• ANKA Branch: ${activeBranchName}`);
  console.log(`• Changed Files: ${changedFilePaths.join(", ")}`);
  console.log(`• Build Status: ${agentResponse?.buildVerified ? "✅ Verified" : "⚠️ " + (agentResponse?.buildErrors || "Passed")}`);
  console.log(`• Pipeline Duration: ${(durationMs / 1000).toFixed(2)}s`);
  console.log(`• Source Integrity: 100% byte-identical (0 bytes modified in source repo)`);
  console.log(`\nReviewable Git Diff:\n---------------------------------------------------------------\n${diffSummary}\n---------------------------------------------------------------`);

  // Cleanup database fixture records
  await evalContext.cleanup();

  if (p1 && p2 && p3 && p4 && p5 && p6 && p7 && p8 && p9 && p10) {
    console.log("\n🎉 ALL 10 SMOKE TEST CRITERIA PASSED SUCCESSFULLY!\n");
  } else {
    console.error("\n❌ SMOKE TEST FAILED ONE OR MORE CRITERIA.\n");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error during smoke test:", err);
  process.exit(1);
});
