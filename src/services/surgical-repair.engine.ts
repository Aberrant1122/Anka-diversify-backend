import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";
import ts from "typescript";

// ─── Interfaces & Schemas ─────────────────────────────────────────────────────

export interface DiagnosticError {
  file: string;
  line: number;
  column?: number;
  code?: string; // e.g. TS2304, TS2305, TS2322, TS2339, TS2440
  message: string;
  symbolName?: string;
  rawTrace: string;
}

export interface SurgicalPatchChunk {
  file: string;
  startLine: number;
  endLine: number;
  targetContent: string;
  replacementContent: string;
  affectedNodeName?: string;
  linesAdded: number;
  linesRemoved: number;
}

export interface RepairAttemptRecord {
  attempt: number;
  timestamp: string;
  diagnostics: DiagnosticError[];
  patchesApplied: SurgicalPatchChunk[];
  totalFileLines: number;
  linesChanged: number;
  patchSizePct: number;
  repairTimeMs: number;
  compileSuccess: boolean;
}

export interface RepairSessionMetrics {
  sessionId: string;
  totalAttempts: number;
  successful: boolean;
  totalTimeMs: number;
  averagePatchSizePct: number;
  history: RepairAttemptRecord[];
}

export interface AgentFileChange {
  path: string;
  content: string;
}

// ─── 1. Compiler Diagnostics Parser ──────────────────────────────────────────

export class ErrorDiagnosticsParser {
  /**
   * Parse TypeScript, SWC, Next.js, Angular, and Node build error logs into structured diagnostics.
   */
  static parse(errorLog: string): DiagnosticError[] {
    if (!errorLog) return [];
    const diagnostics: DiagnosticError[] = [];

    // 1. Angular / TS / Next Format: Error: src/app/foo.ts:15:10 - error TS2304: Cannot find name 'x'
    const angularTsRegex = /(?:Error:\s*)?([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx|html|css|scss)):([0-9]+):([0-9]+)\s*-\s*error\s*([A-Za-z0-9_]+)?:\s*(.+)/g;
    let match: RegExpExecArray | null;

    while ((match = angularTsRegex.exec(errorLog)) !== null) {
      const filePath = match[1].replace(/^\.\//, "").replace(/\\/g, "/");
      const line = parseInt(match[2], 10);
      const column = parseInt(match[3], 10);
      const code = match[4] || "BUILD_ERR";
      const message = match[5].trim();
      const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);

      diagnostics.push({
        file: filePath,
        line,
        column,
        code,
        message,
        symbolName: symMatch ? symMatch[1] : undefined,
        rawTrace: match[0],
      });
    }

    // 2. Next.js Type Error format (multi-line): ./components/Calculator.tsx:7:14\nType error: Cannot redeclare exported variable 'CalculatorButton'.
    if (diagnostics.length === 0) {
      const nextTypeErrorRegex = /(?:Error:\s*)?([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx)):([0-9]+):([0-9]+)[\r\n]+\s*(?:Type error:\s*)?(.+)/g;
      while ((match = nextTypeErrorRegex.exec(errorLog)) !== null) {
        const filePath = match[1].replace(/^\.\//, "").replace(/\\/g, "/");
        const line = parseInt(match[2], 10);
        const column = parseInt(match[3], 10);
        const message = match[4].trim();
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        const code = /cannot redeclare exported variable/i.test(message) ? "TS2440" : "BUILD_ERR";

        diagnostics.push({
          file: filePath,
          line,
          column,
          code,
          message,
          symbolName: symMatch ? symMatch[1] : undefined,
          rawTrace: match[0],
        });
      }
    }

    // 3. Standard TS Format: src/services/ai-service.ts(2521,9): error TS2322: Type 'X' is not assignable to type 'Y'
    if (diagnostics.length === 0) {
      const tsRegex = /([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx|css|scss))\(([0-9]+),([0-9]+)\):\s*error\s*([A-Za-z0-9_]+)?:\s*(.+)/g;
      while ((match = tsRegex.exec(errorLog)) !== null) {
        const filePath = match[1].replace(/^\.\//, "").replace(/\\/g, "/");
        const line = parseInt(match[2], 10);
        const column = parseInt(match[3], 10);
        const code = match[4] || "TS0000";
        const message = match[5].trim();
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);

        diagnostics.push({
          file: filePath,
          line,
          column,
          code,
          message,
          symbolName: symMatch ? symMatch[1] : undefined,
          rawTrace: match[0],
        });
      }
    }

    // 4. Fallback Next.js / SWC format: ./src/app/page.tsx:14:23
    if (diagnostics.length === 0) {
      const genericRegex = /([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx)):([0-9]+):([0-9]+)[\s\-:]+(.+)/g;
      while ((match = genericRegex.exec(errorLog)) !== null) {
        const filePath = match[1].replace(/^\.\//, "").replace(/\\/g, "/");
        const line = parseInt(match[2], 10);
        const column = parseInt(match[3], 10);
        const message = match[4].trim();
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);

        diagnostics.push({
          file: filePath,
          line,
          column,
          code: "BUILD_ERR",
          message,
          symbolName: symMatch ? symMatch[1] : undefined,
          rawTrace: match[0],
        });
      }
    }

    return diagnostics;
  }
}

// ─── 2. Surgical Patch Generator & Applicator ─────────────────────────────────

export class SurgicalPatchEngine {
  /**
   * Replaces ONLY affected lines/nodes without touching surrounding code or formatting.
   */
  static applyPatch(
    originalContent: string,
    patch: SurgicalPatchChunk,
  ): { newContent: string; linesChanged: number; patchSizePct: number } {
    const lines = originalContent.split("\n");
    const totalLines = lines.length || 1;

    const startIdx = Math.max(0, patch.startLine - 1);
    const endIdx = Math.min(lines.length, patch.endLine);

    const before = lines.slice(0, startIdx);
    const after = lines.slice(endIdx);
    const replacementLines = patch.replacementContent === "" ? [] : patch.replacementContent.split("\n");

    const newLines = [...before, ...replacementLines, ...after];
    const newContent = newLines.join("\n");

    const linesRemoved = endIdx - startIdx;
    const linesAdded = replacementLines.length;
    const linesChanged = Math.max(linesAdded, linesRemoved);
    const patchSizePct = parseFloat(((linesChanged / totalLines) * 100).toFixed(2));

    return {
      newContent,
      linesChanged,
      patchSizePct,
    };
  }

  /**
   * Generates a deterministic surgical patch for redundant duplicate export statements.
   * e.g.:
   *   export const Foo = ...;
   *   export { Foo, Bar };
   * -> removes Foo from export { Foo, Bar }, or deletes export { Foo } completely if all are directly exported.
   */
  static generateDuplicateExportPatch(
    fileContent: string,
    filePath: string,
    diag?: DiagnosticError,
  ): SurgicalPatchChunk | null {
    if (!fileContent || !filePath.match(/\.(?:ts|tsx|js|jsx)$/)) {
      return null;
    }

    const isDuplicateExportDiag =
      !diag ||
      /cannot redeclare exported variable|duplicate identifier|already been declared|export declaration conflicts/i.test(
        diag.message || ""
      ) ||
      diag.code === "TS2440" ||
      diag.code === "TS2300" ||
      diag.code === "TS2451";

    if (!isDuplicateExportDiag && diag) {
      return null;
    }

    try {
      const scriptKind = filePath.endsWith(".tsx")
        ? ts.ScriptKind.TSX
        : filePath.endsWith(".jsx")
        ? ts.ScriptKind.JSX
        : filePath.endsWith(".js")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

      const sourceFile = ts.createSourceFile(filePath, fileContent, ts.ScriptTarget.Latest, true, scriptKind);

      const directlyExportedSymbols = new Set<string>();

      // 1. Identify all symbols directly exported at their declaration
      for (const statement of sourceFile.statements) {
        // Variable statement: export const/let/var Foo = ...
        if (ts.isVariableStatement(statement)) {
          const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (isExported) {
            for (const decl of statement.declarationList.declarations) {
              if (ts.isIdentifier(decl.name)) {
                directlyExportedSymbols.add(decl.name.text);
              }
            }
          }
        }
        // Function declaration: export function Foo() ...
        else if (ts.isFunctionDeclaration(statement)) {
          const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          const isDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
          if (isExported && !isDefault && statement.name) {
            directlyExportedSymbols.add(statement.name.text);
          }
        }
        // Class declaration: export class Foo ...
        else if (ts.isClassDeclaration(statement)) {
          const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          const isDefault = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
          if (isExported && !isDefault && statement.name) {
            directlyExportedSymbols.add(statement.name.text);
          }
        }
        // Interface declaration: export interface Foo ...
        else if (ts.isInterfaceDeclaration(statement)) {
          const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (isExported && statement.name) {
            directlyExportedSymbols.add(statement.name.text);
          }
        }
        // Type alias declaration: export type Foo = ...
        else if (ts.isTypeAliasDeclaration(statement)) {
          const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (isExported && statement.name) {
            directlyExportedSymbols.add(statement.name.text);
          }
        }
        // Enum declaration: export enum Foo ...
        else if (ts.isEnumDeclaration(statement)) {
          const isExported = statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
          if (isExported && statement.name) {
            directlyExportedSymbols.add(statement.name.text);
          }
        }
      }

      if (directlyExportedSymbols.size === 0) {
        return null;
      }

      // 2. Find local export declarations: export { X, Y, ... }
      for (const statement of sourceFile.statements) {
        if (ts.isExportDeclaration(statement) && statement.exportClause && !statement.moduleSpecifier) {
          if (ts.isNamedExports(statement.exportClause)) {
            const elements = statement.exportClause.elements;
            const redundantElements: ts.ExportSpecifier[] = [];
            const validElements: ts.ExportSpecifier[] = [];

            for (const el of elements) {
              const exportedName = el.name.text;
              if (directlyExportedSymbols.has(exportedName)) {
                redundantElements.push(el);
              } else {
                validElements.push(el);
              }
            }

            if (redundantElements.length > 0) {
              const startPos = statement.getStart(sourceFile);
              const endPos = statement.getEnd();
              const startLine = sourceFile.getLineAndCharacterOfPosition(startPos).line + 1;
              const endLine = sourceFile.getLineAndCharacterOfPosition(endPos).line + 1;

              const lines = fileContent.split("\n");

              // Case A: All specifiers in this statement are redundant -> Remove the entire export statement
              if (validElements.length === 0) {
                const targetLines = lines.slice(startLine - 1, endLine);
                const targetContent = targetLines.join("\n");

                return {
                  file: filePath,
                  startLine,
                  endLine,
                  targetContent,
                  replacementContent: "", // Remove statement cleanly
                  affectedNodeName: `ExportDeclaration (${redundantElements.map((e) => e.name.text).join(", ")})`,
                  linesAdded: 0,
                  linesRemoved: endLine - startLine + 1,
                };
              } else {
                // Case B: Some specifiers are valid -> keep only valid specifiers
                const targetLines = lines.slice(startLine - 1, endLine);
                const targetContent = targetLines.join("\n");
                const validSpecifierNames = validElements.map((e) =>
                  e.propertyName ? `${e.propertyName.text} as ${e.name.text}` : e.name.text
                );
                const replacementContent = `export { ${validSpecifierNames.join(", ")} };`;

                return {
                  file: filePath,
                  startLine,
                  endLine,
                  targetContent,
                  replacementContent,
                  affectedNodeName: `ExportDeclaration (removed ${redundantElements.map((e) => e.name.text).join(", ")})`,
                  linesAdded: 1,
                  linesRemoved: endLine - startLine + 1,
                };
              }
            }
          }
        }
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Generate a minimal surgical patch for missing imports, duplicate exports, or line type errors.
   */
  static generateMinimalPatch(
    fileContent: string,
    filePath: string,
    diag: DiagnosticError,
  ): SurgicalPatchChunk {
    // Case 0: Redundant Duplicate Export Repair
    const dupPatch = this.generateDuplicateExportPatch(fileContent, filePath, diag);
    if (dupPatch) {
      return dupPatch;
    }

    const lines = fileContent.split("\n");
    const targetLineIdx = Math.max(0, diag.line - 1);
    const targetLineContent = lines[targetLineIdx] || "";

    // Case 1: Missing Symbol / Import (TS2304 / TS2552)
    // Cannot safely determine the correct import path from the symbol name alone.
    // Return a no-op patch (targetContent === replacementContent) so the repair loop
    // falls through to the LLM path which has full file context.
    if ((diag.code === "TS2304" || diag.code === "TS2552") && diag.symbolName) {
      const firstLineContent = lines[0] || "";
      return {
        file: filePath,
        startLine: 1,
        endLine: 1,
        targetContent: firstLineContent,
        replacementContent: firstLineContent,
        affectedNodeName: `ImportDeclaration (${diag.symbolName}) — deferred to LLM`,
        linesAdded: 0,
        linesRemoved: 0,
      };
    }

    // Case 2: Line-specific Type Error or Syntax Fix
    const startLine = Math.max(1, diag.line);
    const endLine = Math.min(lines.length, diag.line);
    const targetContent = lines.slice(startLine - 1, endLine).join("\n");

    return {
      file: filePath,
      startLine,
      endLine,
      targetContent,
      replacementContent: targetContent, // Default node targeted for LLM surgical fix
      affectedNodeName: `ASTNode @ Line ${diag.line}`,
      linesAdded: 0,
      linesRemoved: 0,
    };
  }
}

// ─── 3. Session & History Tracker ──────────────────────────────────────────────

export class SurgicalRepairSessionTracker {
  private sessionId: string;
  private startTime: number;
  private history: RepairAttemptRecord[] = [];

  constructor(sessionId?: string) {
    this.sessionId = sessionId || `repair_${Date.now()}`;
    this.startTime = performance.now();
  }

  recordAttempt(record: RepairAttemptRecord) {
    this.history.push(record);
  }

  getMetrics(successful: boolean): RepairSessionMetrics {
    const totalTimeMs = performance.now() - this.startTime;
    const totalPatchPcts = this.history.map((h) => h.patchSizePct);
    const avgPatchSizePct = totalPatchPcts.length > 0
      ? parseFloat((totalPatchPcts.reduce((a, b) => a + b, 0) / totalPatchPcts.length).toFixed(2))
      : 0;

    return {
      sessionId: this.sessionId,
      totalAttempts: this.history.length,
      successful,
      totalTimeMs: parseFloat(totalTimeMs.toFixed(2)),
      averagePatchSizePct: avgPatchSizePct,
      history: this.history,
    };
  }

  generateSummaryMarkdown(successful: boolean): string {
    const metrics = this.getMetrics(successful);

    let md = `# SURGICAL REPAIR SESSION METRICS REPORT\n\n`;
    md += `**Session ID**: \`${metrics.sessionId}\`  \n`;
    md += `**Status**: ${metrics.successful ? "✅ **REPAIRED (SUCCESS)**" : "❌ **FAILED**"}  \n`;
    md += `**Total Attempts**: ${metrics.totalAttempts}  \n`;
    md += `**Total Repair Latency**: ${metrics.totalTimeMs} ms  \n`;
    md += `**Average Patch Size**: **${metrics.averagePatchSizePct}% of file** (Surgical Scope)  \n\n`;
    md += `---\n\n`;
    md += `## 📜 Repair Attempt History\n\n`;
    md += `| Attempt | Diagnostics Found | Affected File | Lines Changed | Patch Size % | Latency | Compile Status |\n`;
    md += `| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n`;

    for (const h of metrics.history) {
      const fileBase = h.patchesApplied[0] ? path.basename(h.patchesApplied[0].file) : "N/A";
      md += `| Attempt ${h.attempt} | ${h.diagnostics.length} errors | \`${fileBase}\` | ${h.linesChanged} lines | ${h.patchSizePct}% | ${h.repairTimeMs.toFixed(1)} ms | ${h.compileSuccess ? "✅ PASS" : "❌ FAIL"} |\n`;
    }

    return md;
  }
}
