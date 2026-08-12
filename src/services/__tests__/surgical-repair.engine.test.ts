import {
  ErrorDiagnosticsParser,
  SurgicalPatchEngine,
  SurgicalRepairSessionTracker,
  DiagnosticError,
} from "../surgical-repair.engine";

describe("Surgical Repair Engine", () => {
  // ─── Error Diagnostics Parser ──────────────────────────────────────────────

  describe("ErrorDiagnosticsParser", () => {
    const sampleTrace = `
src/services/payment.service.ts(15,10): error TS2304: Cannot find name 'PaymentGateway'
src/components/Header.tsx(42,5): error TS2322: Type 'string' is not assignable to type 'number'
`;

    it("should parse 2 TypeScript diagnostic errors", () => {
      const diags = ErrorDiagnosticsParser.parse(sampleTrace);
      expect(diags.length).toBe(2);
    });

    it("should correctly parse file path, line, code, and symbol", () => {
      const diags = ErrorDiagnosticsParser.parse(sampleTrace);
      expect(diags[0].file).toBe("src/services/payment.service.ts");
      expect(diags[0].line).toBe(15);
      expect(diags[0].code).toBe("TS2304");
      expect(diags[0].symbolName).toBe("PaymentGateway");
    });
  });

  // ─── Surgical Patch Generator ──────────────────────────────────────────────

  describe("SurgicalPatchEngine.generateMinimalPatch", () => {
    it("should return a no-op patch for TS2304 (missing import) — deferred to LLM", () => {
      const fileContent = `import fs from 'fs';\n\nexport class Service {\n  public run() { return PaymentGateway.process(); }\n}`;
      const diag: DiagnosticError = {
        file: "src/services/payment.service.ts",
        line: 4,
        code: "TS2304",
        message: "Cannot find name 'PaymentGateway'",
        symbolName: "PaymentGateway",
        rawTrace: "src/services/payment.service.ts(4,30): error TS2304: Cannot find name 'PaymentGateway'",
      };

      const patch = SurgicalPatchEngine.generateMinimalPatch(fileContent, diag.file, diag);

      // No-op: targetContent === replacementContent
      expect(patch.targetContent).toBe(patch.replacementContent);
      expect(patch.linesAdded).toBe(0);
      expect(patch.linesRemoved).toBe(0);
      expect(patch.affectedNodeName).toContain("deferred to LLM");
    });

    it("should return a no-op patch for TS2552 (missing import) — deferred to LLM", () => {
      const fileContent = `export const x = SomeService.doStuff();`;
      const diag: DiagnosticError = {
        file: "src/app/page.ts",
        line: 1,
        code: "TS2552",
        message: "Cannot find name 'SomeService'. Did you mean 'SomeOtherService'?",
        symbolName: "SomeService",
        rawTrace: "src/app/page.ts:1:19 - error TS2552: Cannot find name 'SomeService'",
      };

      const patch = SurgicalPatchEngine.generateMinimalPatch(fileContent, diag.file, diag);

      expect(patch.targetContent).toBe(patch.replacementContent);
      expect(patch.linesAdded).toBe(0);
      expect(patch.affectedNodeName).toContain("deferred to LLM");
    });

    it("should return an identity patch for non-import type errors (line-specific)", () => {
      const fileContent = `import fs from 'fs';\n\nexport class Service {\n  public run(): number { return "hello"; }\n}`;
      const diag: DiagnosticError = {
        file: "src/services/payment.service.ts",
        line: 4,
        code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'",
        symbolName: undefined,
        rawTrace: 'src/services/payment.service.ts(4,26): error TS2322: Type \'string\' is not assignable to type \'number\'',
      };

      const patch = SurgicalPatchEngine.generateMinimalPatch(fileContent, diag.file, diag);

      expect(patch.startLine).toBe(4);
      expect(patch.endLine).toBe(4);
      expect(patch.affectedNodeName).toContain("ASTNode");
    });
  });

  // ─── Patch Applicator ──────────────────────────────────────────────────────

  describe("SurgicalPatchEngine.applyPatch", () => {
    it("should preserve surrounding formatting when applying a patch", () => {
      const fileContent = `import fs from 'fs';\nimport path from 'path';\n\nexport class Service {\n  public run() {}\n}`;
      const patch = {
        file: "test.ts",
        startLine: 4,
        endLine: 4,
        targetContent: "export class Service {",
        replacementContent: "export class UpdatedService {",
        affectedNodeName: "ClassDeclaration",
        linesAdded: 0,
        linesRemoved: 0,
      };

      const result = SurgicalPatchEngine.applyPatch(fileContent, patch);

      expect(result.newContent).toContain("import fs from 'fs';");
      expect(result.newContent).toContain("export class UpdatedService {");
      expect(result.newContent).toContain("  public run() {}");
    });
  });

  // ─── Session Tracker ───────────────────────────────────────────────────────

  describe("SurgicalRepairSessionTracker", () => {
    it("should record attempt and produce correct metrics", () => {
      const diag: DiagnosticError = {
        file: "test.ts",
        line: 1,
        code: "TS2304",
        message: "test",
        rawTrace: "test",
      };

      const tracker = new SurgicalRepairSessionTracker("test_session");
      tracker.recordAttempt({
        attempt: 1,
        timestamp: new Date().toISOString(),
        diagnostics: [diag],
        patchesApplied: [],
        totalFileLines: 10,
        linesChanged: 2,
        patchSizePct: 20.0,
        repairTimeMs: 12.5,
        compileSuccess: true,
      });

      const metrics = tracker.getMetrics(true);
      expect(metrics.totalAttempts).toBe(1);
      expect(metrics.successful).toBe(true);
      expect(metrics.averagePatchSizePct).toBe(20.0);
    });

    it("should generate a markdown summary report", () => {
      const tracker = new SurgicalRepairSessionTracker("test_session");
      tracker.recordAttempt({
        attempt: 1,
        timestamp: new Date().toISOString(),
        diagnostics: [],
        patchesApplied: [],
        totalFileLines: 5,
        linesChanged: 1,
        patchSizePct: 10.0,
        repairTimeMs: 5.0,
        compileSuccess: true,
      });

      const markdown = tracker.generateSummaryMarkdown(true);
      expect(markdown).toContain("SURGICAL REPAIR SESSION METRICS REPORT");
    });
  });
});
