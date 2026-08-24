import fs from "fs";
import path from "path";
import os from "os";
import {
  AgentEvalCase,
  EvalSuiteSummary,
} from "../evals/types";
import {
  captureFilesystemSnapshot,
  computeFilesystemDiff,
  computeRankingMetrics,
  computeRagMetrics,
  classifyFailureStage,
  getGitCommitSha,
  EvalRunner,
} from "../evals/EvalRunner";
import { ModelObserver } from "../evals/ModelObserver";
import { MemoryPersistence } from "../memory/MemoryPersistence";
import { RepositoryScanner } from "../repository/RepositoryScanner";
import { RepositoryContextBuilder } from "../repository/RepositoryContextBuilder";
import { IntentClassifier } from "../classification/IntentClassifier";
import { ManifestGenerator } from "../../services/manifest-generator";
import { ManifestValidator } from "../../services/manifest-validator";
import { CodeGenerator } from "../generation/CodeGenerator";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { SecurityAuditor } from "../review/SecurityAuditor";
import { ValidationDetector } from "../validation/ValidationDetector";

// Mock PrismaClient to prevent DB connection attempts
jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      project: {
        findUnique: jest.fn().mockResolvedValue({
          localPath: null,
          githubUrl: "https://github.com/mock/mock",
          githubToken: "mock-token",
        }),
      },
      projectMemorySummary: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      aiChatMessage: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      task: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      phaseArtifact: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      taskDecomposition: {
        create: jest.fn().mockResolvedValue({}),
      },
      agentManifest: {
        create: jest.fn().mockResolvedValue({}),
      },
    })),
  };
});

describe("AI Step 10C — RAG Diagnostics & 10-Case Evaluation Harness", () => {
  const fixturesBaseDir = path.resolve(__dirname, "../evals/fixtures");
  const originalApiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-mock-api-key";

    jest.spyOn(MemoryPersistence, "getOrCreateSession").mockResolvedValue({ id: "sess-1", title: "test" } as any);
    jest.spyOn(MemoryPersistence, "saveMessage").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "persistProjectMemory").mockResolvedValue(undefined as any);
    jest.spyOn(MemoryPersistence, "updateSessionTitle").mockResolvedValue(undefined as any);

    jest.spyOn(RepositoryContextBuilder, "buildProjectContext").mockImplementation(async (projectId) => ({
      project: { id: projectId, name: "eval-project" },
      activeTasks: [],
      repoSnapshot: {
        repoName: "eval-repo",
        defaultBranch: "main",
        fileTree: [],
        keyFiles: [],
        revision: { contentHash: "hash-eval" },
      },
    } as any));

    jest.spyOn(SecurityAuditor, "runReflectionAndSecurityAudit").mockResolvedValue({
      securityPass: true,
      summary: "Pass",
    } as any);

    jest.spyOn(ValidationDetector, "runFeatureValidation").mockResolvedValue({
      overallPassed: true,
      checks: [],
      failedChecks: [],
    } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env.OPENAI_API_KEY = originalApiKey;
  });

  // ── 1. Pure Unit Tests for Filesystem Diff & RAG Diagnostics (Tests A–H) ─────

  describe("Filesystem Diff & Snapshot Utilities", () => {
    test("correctly identifies modified, created, and deleted files", () => {
      const before = new Map<string, string>([
        ["src/auth.ts", "hash_a1"],
        ["src/old.ts", "hash_b1"],
        ["src/unchanged.ts", "hash_c1"],
      ]);

      const after = new Map<string, string>([
        ["src/auth.ts", "hash_a2"],
        ["src/new.ts", "hash_d1"],
        ["src/unchanged.ts", "hash_c1"],
      ]);

      const diff = computeFilesystemDiff(before, after);

      expect(diff.modifiedFiles).toEqual(["src/auth.ts"]);
      expect(diff.createdFiles).toEqual(["src/new.ts"]);
      expect(diff.deletedFiles).toEqual(["src/old.ts"]);
      expect(diff.allChangedFiles).toEqual(["src/auth.ts", "src/new.ts", "src/old.ts"]);
    });
  });

  describe("RAG Ranking & Diagnostics Metrics (Tests A–H)", () => {
    test("Test A & B: Deduplicates raw and reranked chunk lists into unique files preserving first occurrence", () => {
      const rawChunks = [
        "src/auth/token.service.ts",
        "src/auth/token.service.ts", // duplicate chunk
        "src/routes.ts",
        "src/auth/auth.service.ts",
        "src/routes.ts",             // duplicate chunk
        "src/db.ts",
      ];

      const metrics = computeRankingMetrics(["src/auth/token.service.ts"], rawChunks);
      // Top 3 unique files must be: token.service.ts, routes.ts, auth.service.ts
      expect(metrics.recallAt1).toBe(1.0);
      expect(metrics.precisionAt1).toBe(1.0);
      expect(metrics.mrr).toBe(1.0);
    });

    test("Test C & D: Computes Recall@1/3/5 and Precision@1/3/5 formulas precisely", () => {
      const expected = ["src/a.ts", "src/b.ts"];
      const ranked = ["src/x.ts", "src/a.ts", "src/y.ts", "src/b.ts", "src/z.ts"];

      const metrics = computeRankingMetrics(expected, ranked);

      // Top 1: ['src/x.ts'] -> 0 hits
      expect(metrics.recallAt1).toBe(0.0);
      expect(metrics.precisionAt1).toBe(0.0);

      // Top 3: ['src/x.ts', 'src/a.ts', 'src/y.ts'] -> 1 hit / 2 expected = 0.5 recall, 1 / 3 = 0.3333 precision
      expect(metrics.recallAt3).toBe(0.5);
      expect(metrics.precisionAt3).toBe(0.3333);

      // Top 5: ['src/x.ts', 'src/a.ts', 'src/y.ts', 'src/b.ts', 'src/z.ts'] -> 2 hits / 2 expected = 1.0 recall, 2 / 5 = 0.4 precision
      expect(metrics.recallAt5).toBe(1.0);
      expect(metrics.precisionAt5).toBe(0.4);
    });

    test("Test E, F, G: Computes raw MRR, reranked MRR, and diagnostic deltas accurately", () => {
      const expected = ["src/target.ts"];

      const stageMetrics = {
        embeddingProvider: "local-feature-hashing-128",
        // Raw: target is at rank 3 -> raw MRR = 1/3 = 0.3333, raw Recall@5 = 1.0, raw Precision@5 = 0.2
        rawRankedFiles: ["src/distractor1.ts", "src/distractor2.ts", "src/target.ts", "src/d3.ts", "src/d4.ts"],
        // Reranked: target moved to rank 1 -> reranked MRR = 1/1 = 1.0, reranked Recall@5 = 1.0, reranked Precision@5 = 0.2
        rerankedFiles: ["src/target.ts", "src/distractor1.ts", "src/distractor2.ts", "src/d3.ts", "src/d4.ts"],
        includedFiles: ["src/target.ts", "src/distractor1.ts"],
        excludedFiles: [],
      };

      const ragMetrics = computeRagMetrics(expected, stageMetrics);

      expect(ragMetrics.raw.mrr).toBe(0.3333);
      expect(ragMetrics.reranked.mrr).toBe(1.0);
      expect(ragMetrics.delta.mrrDelta).toBe(0.6667);
      expect(ragMetrics.delta.recallAt5Delta).toBe(0.0);
      expect(ragMetrics.delta.precisionAt5Delta).toBe(0.0);
    });

    test("Test H: Measures ContextPacker inclusion rate and expected file counts accurately", () => {
      const expected = ["src/a.ts", "src/b.ts", "src/c.ts"];
      const stageMetrics = {
        embeddingProvider: "local-feature-hashing-128",
        rawRankedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
        rerankedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
        includedFiles: ["src/a.ts", "src/b.ts"], // 2 out of 3 packed
        excludedFiles: ["src/c.ts"],
      };

      const ragMetrics = computeRagMetrics(expected, stageMetrics);

      expect(ragMetrics.context.expectedFilesTotal).toBe(3);
      expect(ragMetrics.context.expectedFilesIncludedCount).toBe(2);
      expect(ragMetrics.context.inclusionRate).toBe(0.6667);
      expect(ragMetrics.context.allExpectedIncluded).toBe(false);
    });
  });

  // ── 2. Deterministic Mode 1 End-to-End Fixture Cases (Tests I & J) ──────────

  describe("End-to-End Fixture Evaluations (Mode 1 Deterministic)", () => {
    // ── CASE 01: Simple Bug Fix ─────────────────────────────────────────────
    test("Test I — Case 01: Simple bug fix in pagination helper", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-01-pagination-bug", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const originalPagination = fs.readFileSync(
        path.join(fixturesBaseDir, evalCase.fixtureDir, "repo", "src", "pagination.ts"),
        "utf8",
      );
      const fixedPagination = originalPagination.replace("return page * limit;", "return (page - 1) * limit;");

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: ["src/pagination.ts"],
        keyFiles: [{ path: "src/pagination.ts", content: originalPagination }],
        revision: { contentHash: "hash-case-01" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Fix pagination offset",
        targetPath: "src/pagination.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Clear task",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/pagination.ts", action: "modify", dependencies: [], description: "fix offset" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/pagination.ts", content: fixedPagination, description: "fix offset", action: "modify" }],
        explanation: "Fixed offset calculation",
        commitMessage: "fix: compute page offset using (page - 1) * limit",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return {
          success: true,
          attempts: 1,
          finalChanges: changes,
        };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.modifiedFiles).toEqual(["src/pagination.ts"]);
      expect(result.unauthorizedFiles).toHaveLength(0);
      expect(result.contentRulesPassed).toBe(true);
    });

    // ── CASE 02: Type Error Repair ──────────────────────────────────────────
    test("Test I — Case 02: Compile / type error repair", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-02-type-repair", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const originalUserService = fs.readFileSync(
        path.join(fixturesBaseDir, evalCase.fixtureDir, "repo", "src", "services", "user.service.ts"),
        "utf8",
      );
      const repairedUserService = `import { UserDTO } from "../models/user";\n\nexport function formatUser(id: string, name: string): UserDTO {\n  return {\n    id,\n    name,\n    role: "user",\n  };\n}\n`;

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: ["src/models/user.ts", "src/services/user.service.ts"],
        keyFiles: [
          { path: "src/models/user.ts", content: "export interface UserDTO { id: string; name: string; role: 'admin' | 'user'; }" },
          { path: "src/services/user.service.ts", content: originalUserService },
        ],
        revision: { contentHash: "hash-case-02" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Fix type error",
        targetPath: "src/services/user.service.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Type fix",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/services/user.service.ts", action: "modify", dependencies: [], description: "fix role" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/services/user.service.ts", content: repairedUserService, description: "fix role", action: "modify" }],
        explanation: "Added role",
        commitMessage: "fix: add role to UserDTO",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return {
          success: true,
          attempts: 2,
          finalChanges: changes,
        };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.modifiedFiles).toEqual(["src/services/user.service.ts"]);
      expect(result.contentRulesPassed).toBe(true);
    });

    // ── CASE 03: Cross-File Feature ─────────────────────────────────────────
    test("Test I — Case 03: Cross-file feature addition (config + middleware)", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-03-cross-file-feature", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const updatedServerConfig = `export interface ServerConfig {\n  port: number;\n  rateLimitMs?: number;\n}\n\nexport const config: ServerConfig = {\n  port: 3000,\n  rateLimitMs: 500,\n};\n`;
      const updatedRateLimiter = `import { config } from "../config/server";\n\nexport function getRateLimitMs(): number {\n  return config.rateLimitMs ?? 500;\n}\n`;

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: ["src/config/server.ts", "src/middleware/rateLimiter.ts"],
        keyFiles: [
          { path: "src/config/server.ts", content: updatedServerConfig },
          { path: "src/middleware/rateLimiter.ts", content: updatedRateLimiter },
        ],
        revision: { contentHash: "hash-case-03" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "FEATURE_ADD",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Add rateLimitMs option",
        targetPath: "src/config/server.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Cross-file config update",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [
          { path: "src/config/server.ts", action: "modify", dependencies: [], description: "add rateLimitMs" },
          { path: "src/middleware/rateLimiter.ts", action: "modify", dependencies: [], description: "use rateLimitMs" },
        ],
        totalFiles: 2,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [
          { path: "src/config/server.ts", content: updatedServerConfig, description: "config", action: "modify" },
          { path: "src/middleware/rateLimiter.ts", content: updatedRateLimiter, description: "middleware", action: "modify" },
        ],
        explanation: "Configured rate limiting",
        commitMessage: "feat: add rateLimitMs option",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return {
          success: true,
          attempts: 1,
          finalChanges: changes,
        };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.allChangedFiles).toEqual(["src/config/server.ts", "src/middleware/rateLimiter.ts"]);
      expect(result.contentRulesPassed).toBe(true);
    });

    // ── CASE 04: Scope Challenge ────────────────────────────────────────────
    test("Test I — Case 04: Scope challenge (single file fix in multi-file repository)", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-04-scope-challenge", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const updatedAuth = `export const jwtSecret = process.env.JWT_SECRET || "default-secret";\n`;

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: ["src/auth.ts", "src/routes.ts", "src/server.ts", "src/db.ts", "src/config.ts"],
        keyFiles: [
          { path: "src/auth.ts", content: updatedAuth },
          { path: "src/routes.ts", content: "export function setupRoutes() {}" },
          { path: "src/server.ts", content: "export function startServer() {}" },
          { path: "src/db.ts", content: "export function connectDb() {}" },
          { path: "src/config.ts", content: "export const appConfig = { name: 'scope-app' };" },
        ],
        revision: { contentHash: "hash-case-04" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Update jwtSecret",
        targetPath: "src/auth.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Update auth",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/auth.ts", action: "modify", dependencies: [], description: "update jwtSecret" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/auth.ts", content: updatedAuth, description: "update jwtSecret", action: "modify" }],
        explanation: "Updated jwtSecret",
        commitMessage: "fix: fallback to process.env.JWT_SECRET",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return {
          success: true,
          attempts: 1,
          finalChanges: changes,
        };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.allChangedFiles).toEqual(["src/auth.ts"]);
      expect(result.unauthorizedFiles).toHaveLength(0);
      expect(result.contentRulesPassed).toBe(true);
    });

    // ── CASE 05: Retrieval Challenge ────────────────────────────────────────
    test("Test I — Case 05: Retrieval challenge (target file among similar auth/token files)", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-05-retrieval-challenge", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const fixedTokenService = `export class TokenService {\n  static isTokenExpired(exp: number): boolean {\n    return Date.now() >= exp * 1000;\n  }\n\n  static generateToken(userId: string): string {\n    return \`token_\${userId}_\${Date.now()}\`;\n  }\n}\n`;

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: [
          "src/token.service.ts",
          "src/auth.service.ts",
          "src/auth.controller.ts",
          "src/auth.middleware.ts",
          "src/session.service.ts",
          "src/user.service.ts",
        ],
        keyFiles: [
          { path: "src/token.service.ts", content: fixedTokenService },
          { path: "src/auth.service.ts", content: "export class AuthService {}" },
          { path: "src/auth.controller.ts", content: "export class AuthController {}" },
          { path: "src/auth.middleware.ts", content: "export function authMiddleware() {}" },
          { path: "src/session.service.ts", content: "export class SessionService {}" },
          { path: "src/user.service.ts", content: "export class UserService {}" },
        ],
        revision: { contentHash: "hash-case-05" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Fix isTokenExpired check",
        targetPath: "src/token.service.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Fix token expiration bug",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/token.service.ts", action: "modify", dependencies: [], description: "fix expiration" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/token.service.ts", content: fixedTokenService, description: "fix expiration", action: "modify" }],
        explanation: "Fixed expiration check",
        commitMessage: "fix: reject expired tokens",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return {
          success: true,
          attempts: 1,
          finalChanges: changes,
        };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.allChangedFiles).toEqual(["src/token.service.ts"]);
      expect(result.unauthorizedFiles).toHaveLength(0);
      expect(result.contentRulesPassed).toBe(true);
      expect(result.ragMetrics?.reranked.recallAt5).toBe(1.0);
    });

    // ── CASE 06: Duplicate Symbol ───────────────────────────────────────────
    test("Test J — Case 06: Duplicate Symbol grounding", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-06-duplicate-symbol", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const updatedAuthService = `export class AuthService {\n  static validateSession(token: string): boolean {\n    return token.startsWith("v2_auth_");\n  }\n}\n`;

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: ["src/auth/AuthService.ts", "src/admin/AuthService.ts", "src/legacy/AuthService.ts"],
        keyFiles: [
          { path: "src/auth/AuthService.ts", content: updatedAuthService },
          { path: "src/admin/AuthService.ts", content: "export class AuthService { static validateSession(t: string) { return t.startsWith('admin_'); } }" },
          { path: "src/legacy/AuthService.ts", content: "export class AuthService { static validateSession(t: string) { return t.startsWith('legacy_'); } }" },
        ],
        revision: { contentHash: "hash-case-06" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Update validateSession in auth/AuthService.ts",
        targetPath: "src/auth/AuthService.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Specific path target",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/auth/AuthService.ts", action: "modify", dependencies: [], description: "update prefix" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/auth/AuthService.ts", content: updatedAuthService, description: "update prefix", action: "modify" }],
        explanation: "Updated prefix",
        commitMessage: "fix: require v2_auth_ prefix",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return { success: true, attempts: 1, finalChanges: changes };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.allChangedFiles).toEqual(["src/auth/AuthService.ts"]);
      expect(result.unauthorizedFiles).toHaveLength(0);
      expect(result.contentRulesPassed).toBe(true);
      expect(result.ragMetrics?.reranked.recallAt5).toBe(1.0);
    });

    // ── CASE 07: Misleading Filenames ───────────────────────────────────────
    test("Test J — Case 07: Misleading Filenames", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-07-misleading-filenames", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const updatedSession = `export class SessionManager {\n  static isSessionActive(createdAt: number, maxAgeMs: number): boolean {\n    return Date.now() - createdAt < maxAgeMs;\n  }\n}\n`;

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: ["src/token.ts", "src/token-config.ts", "src/token-utils.ts", "src/token-history.ts", "src/session.ts"],
        keyFiles: [
          { path: "src/token.ts", content: "export const TOKEN_VERSION = '1.0';" },
          { path: "src/token-config.ts", content: "export const tokenConfig = { maxAge: 3600 };" },
          { path: "src/token-utils.ts", content: "export function formatToken(t: string) { return t.trim(); }" },
          { path: "src/token-history.ts", content: "export const tokenHistory = [];" },
          { path: "src/session.ts", content: updatedSession },
        ],
        revision: { contentHash: "hash-case-07" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Fix session active check",
        targetPath: "src/session.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Session logic fix",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/session.ts", action: "modify", dependencies: [], description: "fix active check" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/session.ts", content: updatedSession, description: "fix active check", action: "modify" }],
        explanation: "Fixed session expiration check",
        commitMessage: "fix: correct session active condition",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return { success: true, attempts: 1, finalChanges: changes };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.allChangedFiles).toEqual(["src/session.ts"]);
      expect(result.unauthorizedFiles).toHaveLength(0);
      expect(result.contentRulesPassed).toBe(true);
      expect(result.ragMetrics?.reranked.recallAt5).toBe(1.0);
    });

    // ── CASE 08: Multi-File Bug Fix ─────────────────────────────────────────
    test("Test J — Case 08: Multi-File Bug Fix across gateway and caller", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-08-multi-file-bug-fix", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const updatedGateway = `export interface GatewayOptions {\n  apiKey: string;\n  sandbox?: boolean;\n  timeoutMs?: number;\n}\n\nexport function createGateway(opts: GatewayOptions) {\n  return opts;\n}\n`;
      const updatedCheckout = `import { createGateway } from "./gateway";\n\nexport function processCheckout(apiKey: string) {\n  return createGateway({ apiKey, sandbox: true, timeoutMs: 3000 });\n}\n`;

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: ["src/payment/gateway.ts", "src/payment/checkout.ts", "src/payment/currency.ts", "src/user/account.ts"],
        keyFiles: [
          { path: "src/payment/gateway.ts", content: updatedGateway },
          { path: "src/payment/checkout.ts", content: updatedCheckout },
          { path: "src/payment/currency.ts", content: "export function formatCurrency(a: number) { return '$' + a; }" },
          { path: "src/user/account.ts", content: "export function getAccount() { return {}; }" },
        ],
        revision: { contentHash: "hash-case-08" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Add timeoutMs across payment files",
        targetPath: "src/payment/gateway.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Coordinated payment update",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [
          { path: "src/payment/gateway.ts", action: "modify", dependencies: [], description: "add timeoutMs option" },
          { path: "src/payment/checkout.ts", action: "modify", dependencies: [], description: "pass timeoutMs" },
        ],
        totalFiles: 2,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [
          { path: "src/payment/gateway.ts", content: updatedGateway, description: "add timeoutMs", action: "modify" },
          { path: "src/payment/checkout.ts", content: updatedCheckout, description: "pass timeoutMs", action: "modify" },
        ],
        explanation: "Added timeoutMs",
        commitMessage: "fix: configure gateway timeoutMs",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return { success: true, attempts: 1, finalChanges: changes };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.allChangedFiles).toEqual(["src/payment/checkout.ts", "src/payment/gateway.ts"]);
      expect(result.unauthorizedFiles).toHaveLength(0);
      expect(result.contentRulesPassed).toBe(true);
      expect(result.ragMetrics?.reranked.recallAt5).toBe(1.0);
    });

    // ── CASE 09: Nested Service ─────────────────────────────────────────────
    test("Test J — Case 09: Nested Service deep path retrieval", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-09-nested-service", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const updatedNestedService = `export function isTokenValid(token: string): boolean {\n  return token.length >= 32;\n}\n`;

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: [
          "src/modules/auth/services/token-validation.service.ts",
          "src/modules/auth/auth.ts",
          "src/services/validation.ts",
          "src/utils/helpers.ts",
        ],
        keyFiles: [
          { path: "src/modules/auth/services/token-validation.service.ts", content: updatedNestedService },
          { path: "src/modules/auth/auth.ts", content: "export const authModule = 'auth';" },
          { path: "src/services/validation.ts", content: "export function validateInput() { return true; }" },
          { path: "src/utils/helpers.ts", content: "export function noop() {}" },
        ],
        revision: { contentHash: "hash-case-09" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Update token validation length rule",
        targetPath: "src/modules/auth/services/token-validation.service.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Deep service fix",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/modules/auth/services/token-validation.service.ts", action: "modify", dependencies: [], description: "update length" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/modules/auth/services/token-validation.service.ts", content: updatedNestedService, description: "update length", action: "modify" }],
        explanation: "Updated token length rule",
        commitMessage: "fix: enforce 32 character token length",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return { success: true, attempts: 1, finalChanges: changes };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.allChangedFiles).toEqual(["src/modules/auth/services/token-validation.service.ts"]);
      expect(result.unauthorizedFiles).toHaveLength(0);
      expect(result.contentRulesPassed).toBe(true);
      expect(result.ragMetrics?.reranked.recallAt5).toBe(1.0);
    });

    // ── CASE 10: Implementation + Test ──────────────────────────────────────
    test("Test J — Case 10: Implementation + Test Co-retrieval", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-10-impl-and-test", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      const updatedSessionImpl = `export function getSessionTtlSeconds(): number {\n  return 7200;\n}\n`;

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockReturnValue({
        repoName: "test-repo",
        defaultBranch: "main",
        fileTree: ["src/services/session.ts", "src/services/__tests__/session.test.ts", "src/services/logger.ts", "src/config/app.ts"],
        keyFiles: [
          { path: "src/services/session.ts", content: updatedSessionImpl },
          { path: "src/services/__tests__/session.test.ts", content: "import { getSessionTtlSeconds } from '../session'; export function testSessionTtl() { return getSessionTtlSeconds() === 7200; }" },
          { path: "src/services/logger.ts", content: "export function logSession() {}" },
          { path: "src/config/app.ts", content: "export const appName = 'session-app';" },
        ],
        revision: { contentHash: "hash-case-10" },
      } as any);

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Update session TTL to match test",
        targetPath: "src/services/session.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Test alignment",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/services/session.ts", action: "modify", dependencies: [], description: "update TTL" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });
      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/services/session.ts", content: updatedSessionImpl, description: "update TTL", action: "modify" }],
        explanation: "Updated TTL to 7200",
        commitMessage: "fix: align getSessionTtlSeconds with test",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return { success: true, attempts: 1, finalChanges: changes };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(result.status).toBe("PASS");
      expect(result.taskSuccess).toBe(true);
      expect(result.filesystemDiff.allChangedFiles).toEqual(["src/services/session.ts"]);
      expect(result.unauthorizedFiles).toHaveLength(0);
      expect(result.contentRulesPassed).toBe(true);
      expect(result.ragMetrics?.reranked.recallAt5).toBe(1.0);
    });

    // ── SUITE RUNNER: All 10 cases executed as a unified suite (Test K) ─────
    test("Test K: Suite Runner aggregates all 10 eval cases into a complete summary with raw/reranked diagnostics", async () => {
      const caseDirs = [
        "case-01-pagination-bug",
        "case-02-type-repair",
        "case-03-cross-file-feature",
        "case-04-scope-challenge",
        "case-05-retrieval-challenge",
        "case-06-duplicate-symbol",
        "case-07-misleading-filenames",
        "case-08-multi-file-bug-fix",
        "case-09-nested-service",
        "case-10-impl-and-test",
      ];

      const cases: AgentEvalCase[] = caseDirs.map((dir) =>
        JSON.parse(fs.readFileSync(path.join(fixturesBaseDir, dir, "case.json"), "utf8")),
      );

      jest.spyOn(RepositoryScanner, "getEffectiveSnapshot").mockImplementation((_snap, localPath) => {
        const fileTree: string[] = [];
        const keyFiles: Array<{ path: string; content: string }> = [];

        if (localPath && fs.existsSync(localPath)) {
          const snapshot = captureFilesystemSnapshot(localPath);
          for (const [p] of snapshot.entries()) {
            fileTree.push(p);
            try {
              keyFiles.push({ path: p, content: fs.readFileSync(path.join(localPath, p), "utf8") });
            } catch {}
          }
        }

        return {
          repoName: "test-suite-repo",
          defaultBranch: "main",
          fileTree,
          keyFiles,
          revision: { contentHash: "suite-hash" },
        } as any;
      });

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockImplementation(async (msg) => {
        let targetPath: string | undefined;
        if (msg.includes("pagination")) targetPath = "src/pagination.ts";
        else if (msg.includes("UserDTO") || msg.includes("formatUser") || msg.includes("user.service.ts")) targetPath = "src/services/user.service.ts";
        else if (msg.includes("rateLimitMs")) targetPath = "src/config/server.ts";
        else if (msg.includes("jwtSecret") || msg.includes("auth.ts")) targetPath = "src/auth.ts";
        else if (msg.includes("isTokenExpired")) targetPath = "src/token.service.ts";
        else if (msg.includes("v2_auth_") || msg.includes("AuthService.ts")) targetPath = "src/auth/AuthService.ts";
        else if (msg.includes("getSessionTtlSeconds")) targetPath = "src/services/session.ts";
        else if (msg.includes("isSessionActive") || msg.includes("session.ts")) targetPath = "src/session.ts";
        else if (msg.includes("GatewayOptions") || msg.includes("gateway.ts")) targetPath = "src/payment/gateway.ts";
        else if (msg.includes("token-validation.service.ts")) targetPath = "src/modules/auth/services/token-validation.service.ts";

        return {
          taskType: "BUG_FIX",
          risk: "LOW",
          estimatedComplexity: "SMALL",
          intent: "Fix issue",
          targetPath,
          confidence: 0.95,
          requiresClarification: false,
          reasoning: "Task",
        } as any;
      });

      jest.spyOn(ManifestValidator.prototype, "validate").mockReturnValue({ valid: true, errors: [] });

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockImplementation(async (msg) => {
        if (msg.includes("pagination")) {
          return { files: [{ path: "src/pagination.ts", action: "modify", dependencies: [], description: "fix" }], totalFiles: 1, manifestVersion: "1.0.0" };
        }
        if (msg.includes("isTokenExpired")) {
          return { files: [{ path: "src/token.service.ts", action: "modify", dependencies: [], description: "token" }], totalFiles: 1, manifestVersion: "1.0.0" };
        }
        if (msg.includes("UserDTO") || msg.includes("formatUser")) {
          return { files: [{ path: "src/services/user.service.ts", action: "modify", dependencies: [], description: "fix" }], totalFiles: 1, manifestVersion: "1.0.0" };
        }
        if (msg.includes("rateLimitMs")) {
          return { files: [{ path: "src/config/server.ts", action: "modify", dependencies: [], description: "config" }, { path: "src/middleware/rateLimiter.ts", action: "modify", dependencies: [], description: "middleware" }], totalFiles: 2, manifestVersion: "1.0.0" };
        }
        if (msg.includes("jwtSecret") || msg.includes("auth.ts")) {
          return { files: [{ path: "src/auth.ts", action: "modify", dependencies: [], description: "auth" }], totalFiles: 1, manifestVersion: "1.0.0" };
        }
        if (msg.includes("v2_auth_") || msg.includes("AuthService.ts")) {
          return { files: [{ path: "src/auth/AuthService.ts", action: "modify", dependencies: [], description: "auth" }], totalFiles: 1, manifestVersion: "1.0.0" };
        }
        if (msg.includes("getSessionTtlSeconds")) {
          return { files: [{ path: "src/services/session.ts", action: "modify", dependencies: [], description: "session" }], totalFiles: 1, manifestVersion: "1.0.0" };
        }
        if (msg.includes("isSessionActive") || msg.includes("session.ts")) {
          return { files: [{ path: "src/session.ts", action: "modify", dependencies: [], description: "session" }], totalFiles: 1, manifestVersion: "1.0.0" };
        }
        if (msg.includes("GatewayOptions") || msg.includes("gateway.ts")) {
          return {
            files: [
              { path: "src/payment/gateway.ts", action: "modify", dependencies: [], description: "gateway" },
              { path: "src/payment/checkout.ts", action: "modify", dependencies: [], description: "checkout" },
            ],
            totalFiles: 2,
            manifestVersion: "1.0.0",
          };
        }
        if (msg.includes("token-validation.service.ts")) {
          return { files: [{ path: "src/modules/auth/services/token-validation.service.ts", action: "modify", dependencies: [], description: "nested" }], totalFiles: 1, manifestVersion: "1.0.0" };
        }
        return { files: [], totalFiles: 0, manifestVersion: "1.0.0" };
      });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockImplementation(async (message: string) => {
        const msg = message || "";
        if (msg.includes("pagination")) {
          return {
            roadmap: [],
            changes: [{ path: "src/pagination.ts", content: "export function getPageOffset(page: number, limit: number): number { return (page - 1) * limit; }\n", description: "fix", action: "modify" }],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        if (msg.includes("UserDTO") || msg.includes("formatUser")) {
          return {
            roadmap: [],
            changes: [{ path: "src/services/user.service.ts", content: 'import { UserDTO } from "../models/user";\nexport function formatUser(id: string, name: string): UserDTO { return { id, name, role: "user" }; }\n', description: "fix", action: "modify" }],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        if (msg.includes("rateLimitMs")) {
          return {
            roadmap: [],
            changes: [
              { path: "src/config/server.ts", content: "export interface ServerConfig { port: number; rateLimitMs?: number; } export const config: ServerConfig = { port: 3000, rateLimitMs: 500 };\n", description: "fix", action: "modify" },
              { path: "src/middleware/rateLimiter.ts", content: 'import { config } from "../config/server"; export function getRateLimitMs(): number { return config.rateLimitMs ?? 500; }\n', description: "fix", action: "modify" },
            ],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        if (msg.includes("isTokenExpired")) {
          const fixedToken = `export class TokenService {\n  static isTokenExpired(exp: number): boolean {\n    return Date.now() >= exp * 1000;\n  }\n\n  static generateToken(userId: string): string {\n    return \`token_\${userId}_\${Date.now()}\`;\n  }\n}\n`;
          return {
            roadmap: [],
            changes: [{ path: "src/token.service.ts", content: fixedToken, description: "fix", action: "modify" }],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        if (msg.includes("jwtSecret") || msg.includes("auth.ts")) {
          return {
            roadmap: [],
            changes: [{ path: "src/auth.ts", content: 'export const jwtSecret = process.env.JWT_SECRET || "default-secret";\n', description: "fix", action: "modify" }],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        if (msg.includes("v2_auth_") || msg.includes("AuthService.ts")) {
          return {
            roadmap: [],
            changes: [{ path: "src/auth/AuthService.ts", content: 'export class AuthService { static validateSession(token: string): boolean { return token.startsWith("v2_auth_"); } }\n', description: "fix", action: "modify" }],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        if (msg.includes("getSessionTtlSeconds")) {
          return {
            roadmap: [],
            changes: [{ path: "src/services/session.ts", content: "export function getSessionTtlSeconds(): number { return 7200; }\n", description: "fix", action: "modify" }],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        if (msg.includes("isSessionActive") || msg.includes("session.ts")) {
          return {
            roadmap: [],
            changes: [{ path: "src/session.ts", content: "export class SessionManager { static isSessionActive(createdAt: number, maxAgeMs: number): boolean { return Date.now() - createdAt < maxAgeMs; } }\n", description: "fix", action: "modify" }],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        if (msg.includes("GatewayOptions") || msg.includes("gateway.ts")) {
          return {
            roadmap: [],
            changes: [
              { path: "src/payment/gateway.ts", content: "export interface GatewayOptions { apiKey: string; sandbox?: boolean; timeoutMs?: number; } export function createGateway(opts: GatewayOptions) { return opts; }\n", description: "fix", action: "modify" },
              { path: "src/payment/checkout.ts", content: 'import { createGateway } from "./gateway"; export function processCheckout(apiKey: string) { return createGateway({ apiKey, sandbox: true, timeoutMs: 3000 }); }\n', description: "fix", action: "modify" },
            ],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        if (msg.includes("token-validation.service.ts")) {
          return {
            roadmap: [],
            changes: [{ path: "src/modules/auth/services/token-validation.service.ts", content: "export function isTokenValid(token: string): boolean { return token.length >= 32; }\n", description: "fix", action: "modify" }],
            explanation: "fix",
            commitMessage: "fix",
            validationCommands: [],
          };
        }
        return { roadmap: [], changes: [], explanation: "", commitMessage: "", validationCommands: [] };
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return {
          success: true,
          attempts: 1,
          finalChanges: changes,
        };
      });

      const summary: EvalSuiteSummary = await EvalRunner.runSuite(cases, fixturesBaseDir);
      if (summary.passedCases !== 10) {
        console.log("TEST K FAILED CASES:", summary.results.filter(r => r.status !== "PASS").map(r => ({ id: r.caseId, status: r.status, err: r.errorDetails, diff: r.filesystemDiff })));
      }

      expect(summary.totalCases).toBe(10);
      expect(summary.passedCases).toBe(10);
      expect(summary.failedCases).toBe(0);
      expect(summary.passRatePct).toBe(100.0);
      expect(summary.firstPassSuccessRatePct).toBe(100.0);
      expect(summary.rerankedAvgRecallAt5).toBe(1.0);
      expect(summary.rawAvgRecallAt5).toBeGreaterThanOrEqual(0.8);
      expect(summary.avgContextInclusionRate).toBe(0.95);
      expect(summary.embeddingProvider).toBeDefined();

      // Verify each case has structured RAG diagnostic output
      for (const res of summary.results) {
        if (res.ragMetrics) {
          expect(res.ragMetrics.raw).toBeDefined();
          expect(res.ragMetrics.reranked).toBeDefined();
          expect(res.ragMetrics.delta).toBeDefined();
          expect(res.ragMetrics.context).toBeDefined();
        }
      }
    });
  });

  // ── 3. Step 10D1 — Real-Model Mode Infrastructure & Telemetry (Tests A–M) ────

  describe("Step 10D1 — Real-Model Mode Infrastructure & Telemetry", () => {
    test("Test A: EvalMode defaults to DETERMINISTIC when unspecified", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-01-pagination-bug", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Fix pagination offset",
        targetPath: "src/pagination.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Task",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/pagination.ts", action: "modify", dependencies: [], description: "fix offset" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/pagination.ts", content: "export function getPageOffset(page: number, limit: number): number { return (page - 1) * limit; }\n", description: "fix", action: "modify" }],
        explanation: "fix",
        commitMessage: "fix",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return { success: true, attempts: 1, finalChanges: changes };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir);
      expect(result.mode).toBe("DETERMINISTIC");
    });

    test("Test B & C: DETERMINISTIC Mode 1 never requires OPENAI_API_KEY and retains stubs without network calls", async () => {
      const savedKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      const caseJsonPath = path.join(fixturesBaseDir, "case-01-pagination-bug", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Fix offset",
        targetPath: "src/pagination.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Deterministic stub",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/pagination.ts", action: "modify", dependencies: [], description: "fix offset" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/pagination.ts", content: "export function getPageOffset(page: number, limit: number): number { return (page - 1) * limit; }\n", description: "fix", action: "modify" }],
        explanation: "fix",
        commitMessage: "fix",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return { success: true, attempts: 1, finalChanges: changes };
      });

      const result = await EvalRunner.runCase(evalCase, fixturesBaseDir, { mode: "DETERMINISTIC" });
      expect(result.status).toBe("PASS");
      expect(result.mode).toBe("DETERMINISTIC");

      process.env.OPENAI_API_KEY = savedKey;
    });

    test("Test E, F, G, H, I: ModelObserver records distinct model names, actual token usage, and embedding provider", () => {
      const observer = new ModelObserver();

      observer.recordEvent({
        provider: "openai",
        model: "gpt-4o",
        promptTokens: 500,
        completionTokens: 250,
        totalTokens: 750,
        durationMs: 450,
        timestamp: new Date().toISOString(),
      });

      observer.recordEvent({
        provider: "openai",
        model: "gpt-4o-mini",
        promptTokens: 120,
        completionTokens: 60,
        totalTokens: 180,
        durationMs: 180,
        timestamp: new Date().toISOString(),
      });

      observer.recordEvent({
        provider: "openai",
        model: "text-embedding-3-small",
        promptTokens: 45,
        totalTokens: 45,
        durationMs: 90,
        timestamp: new Date().toISOString(),
      });

      const profile = observer.buildModelProfile("text-embedding-3-small");
      expect(profile.modelsObserved).toEqual(["gpt-4o", "gpt-4o-mini", "text-embedding-3-small"]);
      expect(profile.callCount).toBe(3);
      expect(profile.callsByModel["gpt-4o"]).toBe(1);
      expect(profile.callsByModel["gpt-4o-mini"]).toBe(1);
      expect(profile.callsByModel["text-embedding-3-small"]).toBe(1);
      expect(profile.embeddingProvider).toBe("text-embedding-3-small");

      const usage = observer.aggregateActualTokenUsage();
      expect(usage).toBeDefined();
      expect(usage?.promptTokens).toBe(665);
      expect(usage?.completionTokens).toBe(310);
      expect(usage?.totalTokens).toBe(975);
    });

    test("Test J: Machine-readable result files are saved to unique filenames without overwriting previous runs", async () => {
      const tempResultsDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-eval-results-test-"));
      const caseJsonPath = path.join(fixturesBaseDir, "case-01-pagination-bug", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Fix offset",
        targetPath: "src/pagination.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Test",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/pagination.ts", action: "modify", dependencies: [], description: "fix offset" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/pagination.ts", content: "export function getPageOffset(page: number, limit: number): number { return (page - 1) * limit; }\n", description: "fix", action: "modify" }],
        explanation: "fix",
        commitMessage: "fix",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return { success: true, attempts: 1, finalChanges: changes };
      });

      const summary1 = await EvalRunner.runSuite([evalCase], fixturesBaseDir, {
        mode: "REAL_MODEL",
        saveResults: true,
        outputDir: tempResultsDir,
      });

      const summary2 = await EvalRunner.runSuite([evalCase], fixturesBaseDir, {
        mode: "REAL_MODEL",
        saveResults: true,
        outputDir: tempResultsDir,
      });

      const files = fs.readdirSync(tempResultsDir).filter((f) => f.endsWith(".json"));
      expect(files.length).toBe(2);
      expect(summary1.runId).not.toBe(summary2.runId);

      // Verify content structure
      const saved1 = JSON.parse(fs.readFileSync(path.join(tempResultsDir, files[0]), "utf8"));
      expect(saved1.schemaVersion).toBe("1.0.0");
      expect(saved1.mode).toBe("REAL_MODEL");
      expect(saved1.modelProfile).toBeDefined();

      fs.rmSync(tempResultsDir, { recursive: true, force: true });
    });

    test("Test K: Git commit metadata retrieval gracefully returns string or null without throwing", async () => {
      const sha = await getGitCommitSha();
      if (sha !== null) {
        expect(typeof sha).toBe("string");
        expect(sha.length).toBeGreaterThan(0);
      } else {
        expect(sha).toBeNull();
      }
    });

    test("Test L: Isolation teardown removes temp workspace and cache directory cleanly", async () => {
      const caseJsonPath = path.join(fixturesBaseDir, "case-01-pagination-bug", "case.json");
      const evalCase: AgentEvalCase = JSON.parse(fs.readFileSync(caseJsonPath, "utf8"));

      let seenWorkspace: string | undefined;
      const originalMkdir = fs.mkdtempSync;
      jest.spyOn(fs, "mkdtempSync").mockImplementation((prefix: string) => {
        const dir = originalMkdir(prefix);
        if (prefix.includes("anka-eval-")) {
          seenWorkspace = dir;
        }
        return dir;
      });

      jest.spyOn(IntentClassifier, "classifyIntentAndAmbiguity").mockResolvedValue({
        taskType: "BUG_FIX",
        risk: "LOW",
        estimatedComplexity: "SMALL",
        intent: "Fix offset",
        targetPath: "src/pagination.ts",
        confidence: 0.95,
        requiresClarification: false,
        reasoning: "Test",
      } as any);

      jest.spyOn(ManifestGenerator.prototype, "generateManifest").mockResolvedValue({
        files: [{ path: "src/pagination.ts", action: "modify", dependencies: [], description: "fix" }],
        totalFiles: 1,
        manifestVersion: "1.0.0",
      });

      jest.spyOn(CodeGenerator, "generateRoadmapAndDiffs").mockResolvedValue({
        roadmap: [],
        changes: [{ path: "src/pagination.ts", content: "export function getPageOffset(page: number, limit: number): number { return (page - 1) * limit; }\n", description: "fix", action: "modify" }],
        explanation: "fix",
        commitMessage: "fix",
        validationCommands: [],
      });

      jest.spyOn(SelfHealingEngine, "runSelfHealingLoop").mockImplementation(async (changes, localPath, _cmds, _sp, _msg, fsManager) => {
        if (fsManager && localPath) {
          await fsManager.apply(changes, localPath);
        }
        return { success: true, attempts: 1, finalChanges: changes };
      });

      await EvalRunner.runCase(evalCase, fixturesBaseDir);

      expect(seenWorkspace).toBeDefined();
      expect(fs.existsSync(seenWorkspace!)).toBe(false);
    });

    test("Test M: classifyFailureStage deterministically identifies all failure stages", () => {
      expect(classifyFailureStage(true, [], [], true, true)).toBeUndefined();
      expect(classifyFailureStage(false, [], [], true, true, undefined, "STALE_SOURCE_FILE")).toBe("STALE_STATE");
      expect(classifyFailureStage(false, ["src/unauthorized.ts"], [], true, true)).toBe("SCOPE");
      expect(classifyFailureStage(false, [], ["src/required.ts"], true, true)).toBe("MANIFEST");
      expect(classifyFailureStage(false, [], [], false, true)).toBe("VALIDATION");
      expect(classifyFailureStage(false, [], [], true, false)).toBe("GENERATION");
      expect(classifyFailureStage(false, [], [], true, true, { buildErrors: "error TS1234", buildVerified: false })).toBe("REPAIR");
      expect(classifyFailureStage(false, [], [], true, true, { infrastructureError: true })).toBe("INFRASTRUCTURE");
      expect(classifyFailureStage(false, [], [], true, true)).toBe("UNKNOWN");
    });
  });
});
