import {
  ErrorDiagnosticsParser,
  SurgicalPatchEngine,
  SurgicalRepairSessionTracker,
  DiagnosticError,
  PublicContractGuard,
  DeterministicTs6133Repair,
} from "../surgical-repair.engine";
import { applyPatchToFile } from "../../ai/patch/PatchApplicator";

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

    it("should parse mixed colon-format, parenthesis-format, and Next.js error formats without shadowing", () => {
      const mixedLog = `
src/components/dashboard/DashboardOverview.tsx:28:9 - error TS6133: 'filteredActivities' is declared but its value is never read.
src/services/ai-service.ts(2521,9): error TS2322: Type 'string' is not assignable to type 'number'.
./components/Calculator.tsx:7:14
Type error: Cannot redeclare exported variable 'CalculatorButton'.
`;
      const diags = ErrorDiagnosticsParser.parse(mixedLog);
      expect(diags.length).toBe(3);

      expect(diags[0].file).toBe("src/components/dashboard/DashboardOverview.tsx");
      expect(diags[0].code).toBe("TS6133");
      expect(diags[0].symbolName).toBe("filteredActivities");

      expect(diags[1].file).toBe("src/services/ai-service.ts");
      expect(diags[1].code).toBe("TS2322");

      expect(diags[2].file).toBe("components/Calculator.tsx");
      expect(diags[2].code).toBe("TS2440");
      expect(diags[2].symbolName).toBe("CalculatorButton");
    });

    it("should deduplicate identical compiler diagnostics from repeated validation commands", () => {
      const duplicatedLog = `
npm run build failed:
src/components/dashboard/DashboardOverview.tsx:28:9 - error TS6133: 'filteredActivities' is declared but its value is never read.

npx tsc --noEmit failed:
src/components/dashboard/DashboardOverview.tsx:28:9 - error TS6133: 'filteredActivities' is declared but its value is never read.
`;
      const diags = ErrorDiagnosticsParser.parse(duplicatedLog);
      expect(diags.length).toBe(1);
      expect(diags[0].file).toBe("src/components/dashboard/DashboardOverview.tsx");
      expect(diags[0].line).toBe(28);
      expect(diags[0].code).toBe("TS6133");
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

  // ─── Public Contract Guard ──────────────────────────────────────────────────

  describe("PublicContractGuard", () => {
    const baselineSource = `
import React from 'react';
import { ActivityItem } from '../../types/activity';
import { Project } from '../../types/project';

export interface DashboardOverviewProps {
  projects: Project[];
  activities: ActivityItem[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({ projects, activities }) => {
  return <div>{activities.length}</div>;
};
`;

    it("should reject repair that deletes exported activities prop without explicit user request", () => {
      const driftingSource = `
import React from 'react';
import { Project } from '../../types/project';

export interface DashboardOverviewProps {
  projects: Project[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({ projects }) => {
  return <div>Clean</div>;
};
`;
      const res = PublicContractGuard.validatePublicContract({
        filePath: "src/components/dashboard/DashboardOverview.tsx",
        baselineContent: baselineSource,
        proposedContent: driftingSource,
        userMessage: "Remove the deprecated activity widget and clean every reference to it.",
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe("PUBLIC_CONTRACT_DRIFT");
      expect(res.message).toContain("Removed property 'activities' from exported interface 'DashboardOverviewProps'");
    });

    it("should permit repair if user explicitly requests removing the activities prop", () => {
      const modifiedSource = `
import React from 'react';
import { Project } from '../../types/project';

export interface DashboardOverviewProps {
  projects: Project[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({ projects }) => {
  return <div>Clean</div>;
};
`;
      const res = PublicContractGuard.validatePublicContract({
        filePath: "src/components/dashboard/DashboardOverview.tsx",
        baselineContent: baselineSource,
        proposedContent: modifiedSource,
        userMessage: "Remove the activities prop from DashboardOverview",
      });

      expect(res.valid).toBe(true);
    });

    it("should permit repair when interface retains activities prop but destructuring drops it", () => {
      const correctMinimalSource = `
import React from 'react';
import { ActivityItem } from '../../types/activity';
import { Project } from '../../types/project';

export interface DashboardOverviewProps {
  projects: Project[];
  activities: ActivityItem[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({ projects }) => {
  return <div>Clean</div>;
};
`;
      const res = PublicContractGuard.validatePublicContract({
        filePath: "src/components/dashboard/DashboardOverview.tsx",
        baselineContent: baselineSource,
        proposedContent: correctMinimalSource,
        userMessage: "Remove the deprecated activity widget and clean every reference to it.",
      });

      expect(res.valid).toBe(true);
    });

    it("should reject repair that removes type import when retained interface still references it", () => {
      const missingImportSource = `
import React from 'react';
import { Project } from '../../types/project';

export interface DashboardOverviewProps {
  projects: Project[];
  activities: ActivityItem[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({ projects }) => {
  return <div>Clean</div>;
};
`;
      const res = PublicContractGuard.validatePublicContract({
        filePath: "src/components/dashboard/DashboardOverview.tsx",
        baselineContent: baselineSource,
        proposedContent: missingImportSource,
        userMessage: "Remove the deprecated activity widget",
      });

      expect(res.valid).toBe(false);
      expect(res.errorCode).toBe("PUBLIC_CONTRACT_DRIFT");
      expect(res.message).toContain("Repair removed type import for 'ActivityItem'");
    });
  });

  // ─── Deterministic TS6133 Fast Path (Cluster D) ───────────────────────────

  describe("DeterministicTs6133Repair", () => {
    const sampleDashboardBaseline = `
import React from 'react';
import { ActivityItem, ActivityFilterType } from '../../types/activity';
import { Project } from '../../types/project';

export interface DashboardOverviewProps {
  projects: Project[];
  activities: ActivityItem[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  projects,
  activities,
}) => {
  const filteredActivities = activities;
  return <div>{filteredActivities.length}</div>;
};
`;

    it("1: single local variable TS6133 -> declaration removed safely", () => {
      const source = `
import React from 'react';
export const Dashboard = () => {
  const filteredActivities = [];
  return <div>Dashboard</div>;
};
`;
      const diag: DiagnosticError = {
        file: "src/components/Dashboard.tsx",
        line: 4,
        code: "TS6133",
        message: "'filteredActivities' is declared but its value is never read.",
        symbolName: "filteredActivities",
        rawTrace: "src/components/Dashboard.tsx:4:9 - error TS6133: 'filteredActivities' is declared but its value is never read.",
      };

      const patch = DeterministicTs6133Repair.tryRepair({
        filePath: diag.file,
        fileContent: source,
        diagnostic: diag,
      });

      expect(patch).not.toBeNull();
      const patchResult = applyPatchToFile(source, [patch!]);
      expect(patchResult.success).toBe(true);
      if (patchResult.success) {
        expect(patchResult.content).not.toContain("filteredActivities");
        expect(patchResult.content).toContain("export const Dashboard");
      }
    });

    it("2 & 3: destructured activities TS6133 -> local binding removed only, DashboardOverviewProps.activities retained", () => {
      const source = `
import React from 'react';
import { ActivityItem } from '../../types/activity';
import { Project } from '../../types/project';

export interface DashboardOverviewProps {
  projects: Project[];
  activities: ActivityItem[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = ({
  projects,
  activities,
}) => {
  return <div>Dashboard</div>;
};
`;
      const diag: DiagnosticError = {
        file: "src/components/dashboard/DashboardOverview.tsx",
        line: 13,
        code: "TS6133",
        message: "'activities' is declared but its value is never read.",
        symbolName: "activities",
        rawTrace: "src/components/dashboard/DashboardOverview.tsx:13:3 - error TS6133: 'activities' is declared but its value is never read.",
      };

      const patch = DeterministicTs6133Repair.tryRepair({
        filePath: diag.file,
        fileContent: source,
        diagnostic: diag,
        preTaskSource: sampleDashboardBaseline,
        userMessage: "Remove the deprecated activity widget and clean every reference to it.",
      });

      expect(patch).not.toBeNull();
      const patchResult = applyPatchToFile(source, [patch!]);
      expect(patchResult.success).toBe(true);
      if (patchResult.success) {
        // Public interface retains activities
        expect(patchResult.content).toContain("activities: ActivityItem[];");
        // Component destructuring drops activities
        expect(patchResult.content).not.toContain("  activities,\n");
        expect(patchResult.content).toContain("projects,");
      }
    });

    it("4: type import retained because interface still uses it", () => {
      const source = `
import React from 'react';
import { ActivityItem } from '../../types/activity';

export interface DashboardOverviewProps {
  activities: ActivityItem[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = () => {
  return <div>Dashboard</div>;
};
`;
      const diag: DiagnosticError = {
        file: "src/components/dashboard/DashboardOverview.tsx",
        line: 3,
        code: "TS6133",
        message: "'ActivityItem' is declared but its value is never read.",
        symbolName: "ActivityItem",
        rawTrace: "src/components/dashboard/DashboardOverview.tsx:3:10 - error TS6133: 'ActivityItem' is declared but its value is never read.",
      };

      // Because ActivityItem is referenced in DashboardOverviewProps, tryRepair MUST decline
      const patch = DeterministicTs6133Repair.tryRepair({
        filePath: diag.file,
        fileContent: source,
        diagnostic: diag,
        preTaskSource: source,
      });

      expect(patch).toBeNull();
    });

    it("5: truly unused ActivityFilterType import may be removed", () => {
      const source = `
import React from 'react';
import { ActivityItem, ActivityFilterType } from '../../types/activity';

export interface DashboardOverviewProps {
  activities: ActivityItem[];
}

export const DashboardOverview: React.FC<DashboardOverviewProps> = () => {
  return <div>Dashboard</div>;
};
`;
      const diag: DiagnosticError = {
        file: "src/components/dashboard/DashboardOverview.tsx",
        line: 3,
        code: "TS6133",
        message: "'ActivityFilterType' is declared but its value is never read.",
        symbolName: "ActivityFilterType",
        rawTrace: "src/components/dashboard/DashboardOverview.tsx:3:24 - error TS6133: 'ActivityFilterType' is declared but its value is never read.",
      };

      const patch = DeterministicTs6133Repair.tryRepair({
        filePath: diag.file,
        fileContent: source,
        diagnostic: diag,
      });

      expect(patch).not.toBeNull();
      const patchResult = applyPatchToFile(source, [patch!]);
      expect(patchResult.success).toBe(true);
      if (patchResult.success) {
        expect(patchResult.content).not.toContain("ActivityFilterType");
        expect(patchResult.content).toContain("ActivityItem");
      }
    });

    it("6: multi-declarator: removes only safe unused declarator", () => {
      const source = `
export const run = () => {
  const a = 1, b = 2;
  return a;
};
`;
      const diag: DiagnosticError = {
        file: "src/utils.ts",
        line: 3,
        code: "TS6133",
        message: "'b' is declared but its value is never read.",
        symbolName: "b",
        rawTrace: "src/utils.ts:3:17 - error TS6133: 'b' is declared but its value is never read.",
      };

      const patch = DeterministicTs6133Repair.tryRepair({
        filePath: diag.file,
        fileContent: source,
        diagnostic: diag,
      });

      expect(patch).not.toBeNull();
      const patchResult = applyPatchToFile(source, [patch!]);
      expect(patchResult.success).toBe(true);
      if (patchResult.success) {
        expect(patchResult.content).toContain("const a = 1;");
        expect(patchResult.content).not.toContain("b = 2");
      }
    });

    it("7: alias, nested destructuring, or rest element: fast path declines safely", () => {
      // 7A: Alias binding
      const aliasSource = `
export const Component = ({ activities: acts }: any) => {
  return <div>Component</div>;
};
`;
      const aliasDiag: DiagnosticError = {
        file: "src/Comp.tsx",
        line: 2,
        code: "TS6133",
        message: "'acts' is declared but its value is never read.",
        symbolName: "acts",
        rawTrace: "src/Comp.tsx:2:27 - error TS6133: 'acts' is declared but its value is never read.",
      };
      expect(DeterministicTs6133Repair.tryRepair({ filePath: aliasDiag.file, fileContent: aliasSource, diagnostic: aliasDiag })).toBeNull();

      // 7B: Rest element
      const restSource = `
export const Component = ({ ...rest }: any) => {
  return <div>Component</div>;
};
`;
      const restDiag: DiagnosticError = {
        file: "src/Comp.tsx",
        line: 2,
        code: "TS6133",
        message: "'rest' is declared but its value is never read.",
        symbolName: "rest",
        rawTrace: "src/Comp.tsx:2:32 - error TS6133: 'rest' is declared but its value is never read.",
      };
      expect(DeterministicTs6133Repair.tryRepair({ filePath: restDiag.file, fileContent: restSource, diagnostic: restDiag })).toBeNull();
    });

    it("8: exported declaration target: fast path declines safely", () => {
      const exportedSource = `
export const unusedHelper = () => {
  return "unused";
};
`;
      const expDiag: DiagnosticError = {
        file: "src/helper.ts",
        line: 2,
        code: "TS6133",
        message: "'unusedHelper' is declared but its value is never read.",
        symbolName: "unusedHelper",
        rawTrace: "src/helper.ts:2:14 - error TS6133: 'unusedHelper' is declared but its value is never read.",
      };

      const patch = DeterministicTs6133Repair.tryRepair({
        filePath: expDiag.file,
        fileContent: exportedSource,
        diagnostic: expDiag,
      });

      expect(patch).toBeNull();
    });
  });
});
