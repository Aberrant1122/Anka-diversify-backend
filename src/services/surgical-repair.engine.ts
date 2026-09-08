import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";
import ts from "typescript";
import { FilePatchEdit, applyPatchToFile } from "../ai/patch/PatchApplicator";

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
    const seenKeys = new Set<string>();
    const matchedLocations = new Set<string>();

    const addDiagnostic = (diag: DiagnosticError, markLocation = true) => {
      const normFile = diag.file.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
      const normMsg = diag.message.trim().replace(/\s+/g, " ");
      const col = diag.column || 0;
      const dedupeKey = `${normFile}:${diag.line}:${col}:${diag.code || ""}:${normMsg}`;
      if (seenKeys.has(dedupeKey)) {
        return;
      }
      seenKeys.add(dedupeKey);
      if (markLocation) {
        matchedLocations.add(`${normFile}:${diag.line}:${col}`);
      }
      diagnostics.push({
        ...diag,
        file: normFile,
      });
    };

    let match: RegExpExecArray | null;

    // 1. Angular / TS / Next Colon Format: Error: src/app/foo.ts:15:10 - error TS2304: Cannot find name 'x'
    const angularTsRegex = /(?:Error:\s*)?([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx|html|css|scss)):([0-9]+):([0-9]+)\s*-\s*error\s*([A-Za-z0-9_]+)?:\s*(.+)/g;
    while ((match = angularTsRegex.exec(errorLog)) !== null) {
      const filePath = match[1];
      const line = parseInt(match[2], 10);
      const column = parseInt(match[3], 10);
      const message = match[5].trim();
      const noExportedMemberMatch = message.match(/has no exported member\s+['"`]([A-Za-z0-9_$]+)['"`]/i);
      const unusedMatch = message.match(/['"`]([A-Za-z0-9_$]+)['"`]\s+is declared but (?:its value is never read|never used)/i);
      let code = match[4] || "BUILD_ERR";
      let symbolName: string | undefined;

      if (noExportedMemberMatch) {
        symbolName = noExportedMemberMatch[1];
        if (code === "BUILD_ERR") {
          code = /did you mean to use/i.test(message) ? "TS2614" : "TS2305";
        }
      } else if (unusedMatch) {
        symbolName = unusedMatch[1];
        if (code === "BUILD_ERR") {
          code = "TS6133";
        }
      } else {
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      }

      addDiagnostic({
        file: filePath,
        line,
        column,
        code,
        message,
        symbolName,
        rawTrace: match[0],
      });
    }

    // 2. Standard TS Parenthesis Format: src/services/ai-service.ts(2521,9): error TS2322: Type 'X' is not assignable to type 'Y'
    const tsRegex = /([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx|css|scss))\(([0-9]+),([0-9]+)\):\s*error\s*([A-Za-z0-9_]+)?:\s*(.+)/g;
    while ((match = tsRegex.exec(errorLog)) !== null) {
      const filePath = match[1];
      const line = parseInt(match[2], 10);
      const column = parseInt(match[3], 10);
      const message = match[5].trim();
      const noExportedMemberMatch = message.match(/has no exported member\s+['"`]([A-Za-z0-9_$]+)['"`]/i);
      const unusedMatch = message.match(/['"`]([A-Za-z0-9_$]+)['"`]\s+is declared but (?:its value is never read|never used)/i);
      let code = match[4] || "TS0000";
      let symbolName: string | undefined;

      if (noExportedMemberMatch) {
        symbolName = noExportedMemberMatch[1];
        if (code === "TS0000") {
          code = /did you mean to use/i.test(message) ? "TS2614" : "TS2305";
        }
      } else if (unusedMatch) {
        symbolName = unusedMatch[1];
        if (code === "TS0000") {
          code = "TS6133";
        }
      } else {
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      }

      addDiagnostic({
        file: filePath,
        line,
        column,
        code,
        message,
        symbolName,
        rawTrace: match[0],
      });
    }

    // 3. Next.js Type Error format (multi-line): ./components/Calculator.tsx:7:14\nType error: Cannot redeclare exported variable 'CalculatorButton'.
    const nextTypeErrorRegex = /(?:Error:\s*)?([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx)):([0-9]+):([0-9]+)[\r\n]+\s*(?:Type error:\s*)?(.+)/g;
    while ((match = nextTypeErrorRegex.exec(errorLog)) !== null) {
      const filePath = match[1];
      const line = parseInt(match[2], 10);
      const column = parseInt(match[3], 10);
      const normFile = filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
      if (matchedLocations.has(`${normFile}:${line}:${column}`)) {
        continue;
      }
      const message = match[4].trim();
      let code = "BUILD_ERR";
      let symbolName: string | undefined;

      const noExportedMemberMatch = message.match(/has no exported member\s+['"`]([A-Za-z0-9_$]+)['"`]/i);
      const unusedMatch = message.match(/['"`]([A-Za-z0-9_$]+)['"`]\s+is declared but (?:its value is never read|never used)/i);
      if (noExportedMemberMatch) {
        symbolName = noExportedMemberMatch[1];
        code = /did you mean to use/i.test(message) ? "TS2614" : "TS2305";
      } else if (unusedMatch) {
        symbolName = unusedMatch[1];
        code = "TS6133";
      } else if (/cannot redeclare exported variable|duplicate identifier|already been declared/i.test(message)) {
        code = "TS2440";
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      } else if (/cannot find name/i.test(message)) {
        code = "TS2304";
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      } else if (/cannot find module/i.test(message)) {
        code = "TS2307";
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      } else {
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      }

      addDiagnostic({
        file: filePath,
        line,
        column,
        code,
        message,
        symbolName,
        rawTrace: match[0],
      });
    }

    // 4. Fallback Next.js / SWC format: ./src/app/page.tsx:14:23
    const genericRegex = /([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx)):([0-9]+):([0-9]+)[\s\-:]+(.+)/g;
    while ((match = genericRegex.exec(errorLog)) !== null) {
      const filePath = match[1];
      const line = parseInt(match[2], 10);
      const column = parseInt(match[3], 10);
      const normFile = filePath.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "");
      if (matchedLocations.has(`${normFile}:${line}:${column}`)) {
        continue;
      }
      const message = match[4].trim();
      if (/^\[FAIL\]/i.test(message)) {
        continue;
      }
      let code = "BUILD_ERR";
      let symbolName: string | undefined;

      const noExportedMemberMatch = message.match(/has no exported member\s+['"`]([A-Za-z0-9_$]+)['"`]/i);
      const unusedMatch = message.match(/['"`]([A-Za-z0-9_$]+)['"`]\s+is declared but (?:its value is never read|never used)/i);
      if (noExportedMemberMatch) {
        symbolName = noExportedMemberMatch[1];
        code = /did you mean to use/i.test(message) ? "TS2614" : "TS2305";
      } else if (unusedMatch) {
        symbolName = unusedMatch[1];
        code = "TS6133";
      } else if (/cannot redeclare exported variable|duplicate identifier|already been declared/i.test(message)) {
        code = "TS2440";
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      } else if (/cannot find name/i.test(message)) {
        code = "TS2304";
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      } else if (/cannot find module/i.test(message)) {
        code = "TS2307";
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      } else {
        const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
        symbolName = symMatch ? symMatch[1] : undefined;
      }

      addDiagnostic({
        file: filePath,
        line,
        column,
        code,
        message,
        symbolName,
        rawTrace: match[0],
      });
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

// ─── Public Contract Guard ──────────────────────────────────────────────────

export interface PublicContractValidationInput {
  filePath: string;
  baselineContent: string;
  proposedContent: string;
  userMessage?: string;
}

export interface PublicContractValidationResult {
  valid: boolean;
  errorCode?: "PUBLIC_CONTRACT_DRIFT";
  message?: string;
  driftDetails?: {
    file: string;
    construct: string;
    missingMember: string;
  };
}

export class PublicContractGuard {
  /**
   * Deterministically checks if the user explicitly requested modifying/removing an API member.
   * Guard applies to unintended repair drift, NOT explicit user intent.
   */
  public static isExplicitApiChangeRequested(
    userMessage: string | undefined,
    symbolName: string,
    containerName?: string
  ): boolean {
    if (!userMessage || !userMessage.trim()) return false;
    const msg = userMessage.toLowerCase();
    const sym = symbolName.toLowerCase();

    // Pattern 1: Action + target prop name + "prop" / "property" / "parameter" / "field" / "api"
    // e.g., "remove the activities prop", "delete activities property", "rename activities to"
    const propActionRegex = new RegExp(
      `\\b(remove|delete|drop|rename|change|update|deprecate)\\b[^.?!\\n]*\\b${sym}\\b[^.?!\\n]*\\b(prop|property|param|parameter|field|member|api)\\b`,
      "i"
    );
    if (propActionRegex.test(msg)) return true;

    // Pattern 2: Action + "prop" / "property" + target prop name
    // e.g., "remove prop activities", "delete property activities"
    const directPropRegex = new RegExp(
      `\\b(remove|delete|drop|rename|change|update)\\b\\s+(?:the\\s+)?(prop|property|parameter)\\s+['"\`]?${sym}['"\`]?`,
      "i"
    );
    if (directPropRegex.test(msg)) return true;

    // Pattern 3: Action + container name + "api" / "contract"
    if (containerName) {
      const container = containerName.toLowerCase();
      const containerRegex = new RegExp(
        `\\b(remove|delete|drop|rename|change|update)\\b[^.?!\\n]*\\b${container}\\b`,
        "i"
      );
      if (containerRegex.test(msg)) return true;
    }

    return false;
  }

  /**
   * Extracts public exported interfaces, types, functions, and referenced types.
   */
  public static extractPublicContract(sourceCode: string, fileName: string): {
    exportedInterfaces: Map<string, Set<string>>;
    exportedTypes: Set<string>;
    exportedFunctions: Set<string>;
    referencedTypeImports: Set<string>;
  } {
    const isTsx = fileName.endsWith(".tsx") || fileName.endsWith(".jsx");
    const sourceFile = ts.createSourceFile(
      fileName,
      sourceCode,
      ts.ScriptTarget.Latest,
      true,
      isTsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );

    const exportedInterfaces = new Map<string, Set<string>>();
    const exportedTypes = new Set<string>();
    const exportedFunctions = new Set<string>();
    const referencedTypeImports = new Set<string>();

    const isNodeExported = (node: any): boolean => {
      return Boolean(node.modifiers?.some((m: any) => m.kind === ts.SyntaxKind.ExportKeyword));
    };

    ts.forEachChild(sourceFile, (node) => {
      // 1. Exported interface declaration: export interface FooProps { ... }
      if (ts.isInterfaceDeclaration(node) && isNodeExported(node)) {
        const ifaceName = node.name.text;
        const members = new Set<string>();
        for (const member of node.members) {
          if (ts.isPropertySignature(member) && member.name) {
            const propName = member.name.getText(sourceFile).trim();
            members.add(propName);
            if (member.type) {
              const findTypeRefs = (tNode: ts.Node) => {
                if (ts.isTypeReferenceNode(tNode) && ts.isIdentifier(tNode.typeName)) {
                  referencedTypeImports.add(tNode.typeName.text);
                }
                ts.forEachChild(tNode, findTypeRefs);
              };
              findTypeRefs(member.type);
            }
          }
        }
        exportedInterfaces.set(ifaceName, members);
      }

      // 2. Exported type alias: export type Foo = ...
      if (ts.isTypeAliasDeclaration(node) && isNodeExported(node)) {
        exportedTypes.add(node.name.text);
      }

      // 3. Exported function: export function Foo(...)
      if (ts.isFunctionDeclaration(node) && isNodeExported(node) && node.name) {
        exportedFunctions.add(node.name.text);
      }

      // 4. Exported variable/const: export const Foo = ...
      if (ts.isVariableStatement(node) && isNodeExported(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            exportedFunctions.add(decl.name.text);
          }
        }
      }
    });

    return {
      exportedInterfaces,
      exportedTypes,
      exportedFunctions,
      referencedTypeImports,
    };
  }

  /**
   * Compares pre-task public contract against proposed repair contract.
   * Rejects repairs that unintentionally break or drop exported interface properties,
   * component Props, or type imports required by retained interfaces.
   */
  public static validatePublicContract(
    input: PublicContractValidationInput
  ): PublicContractValidationResult {
    const { filePath, baselineContent, proposedContent, userMessage } = input;

    if (!/\.(tsx?|jsx?)$/i.test(filePath)) {
      return { valid: true };
    }

    const baseline = this.extractPublicContract(baselineContent, filePath);
    const proposed = this.extractPublicContract(proposedContent, filePath);

    // 1. Verify that baseline exported interfaces and their properties are preserved
    for (const [ifaceName, baselineMembers] of baseline.exportedInterfaces.entries()) {
      const proposedMembers = proposed.exportedInterfaces.get(ifaceName);

      if (!proposedMembers) {
        if (!this.isExplicitApiChangeRequested(userMessage, ifaceName)) {
          return {
            valid: false,
            errorCode: "PUBLIC_CONTRACT_DRIFT",
            message: `Repair removed exported interface '${ifaceName}'. Preserve the pre-task public interface and fix only the internal implementation.`,
            driftDetails: { file: filePath, construct: `interface ${ifaceName}`, missingMember: ifaceName },
          };
        }
        continue;
      }

      for (const member of baselineMembers) {
        if (!proposedMembers.has(member)) {
          if (!this.isExplicitApiChangeRequested(userMessage, member, ifaceName)) {
            return {
              valid: false,
              errorCode: "PUBLIC_CONTRACT_DRIFT",
              message: `Repair changes an existing exported/public contract. Removed property '${member}' from exported interface '${ifaceName}'. Preserve the pre-task ${ifaceName} interface and fix only the internal unused binding.`,
              driftDetails: { file: filePath, construct: `interface ${ifaceName}`, missingMember: member },
            };
          }
        }
      }
    }

    // 2. Verify type import preservation (Fix 3):
    // If the retained public interface still references type T (e.g. ActivityItem),
    // proposedContent must retain import of T or type declaration of T.
    for (const typeName of proposed.referencedTypeImports) {
      const importRegex = new RegExp(`\\bimport\\b[^;]*\\b${typeName}\\b[^;]*from`, "m");
      const declRegex = new RegExp(`\\b(interface|type|class|enum)\\s+${typeName}\\b`, "m");
      if (!importRegex.test(proposedContent) && !declRegex.test(proposedContent)) {
        return {
          valid: false,
          errorCode: "PUBLIC_CONTRACT_DRIFT",
          message: `Repair removed type import for '${typeName}' while it is still referenced by retained exported interface. Preserve 'import { ${typeName} }' to keep the public interface valid.`,
          driftDetails: { file: filePath, construct: `type import ${typeName}`, missingMember: typeName },
        };
      }
    }

    return { valid: true };
  }
}

// ─── Deterministic TS6133 Repair Helper (Cluster D) ──────────────────────────

export interface DeterministicTs6133RepairInput {
  filePath: string;
  fileContent: string;
  diagnostic: DiagnosticError;
  preTaskSource?: string;
  userMessage?: string;
}

export class DeterministicTs6133Repair {
  /**
   * Deterministically attempts AST-based repair for authorized TS6133 diagnostics.
   *
   * Execution Order:
   * 1. deterministic local-variable repair
   * 2. deterministic destructured-binding repair
   * 3. deterministic unused-import repair
   *
   * Validates result in-memory with PatchApplicator and PublicContractGuard.
   * Returns FilePatchEdit or null if the pattern cannot be repaired deterministically.
   */
  public static tryRepair(input: DeterministicTs6133RepairInput): FilePatchEdit | null {
    const { filePath, fileContent, diagnostic, preTaskSource, userMessage } = input;

    if (!/\.(tsx?|jsx?)$/i.test(filePath)) return null;

    let symbolName = diagnostic.symbolName;
    if (!symbolName && diagnostic.message) {
      const m = diagnostic.message.match(/['"`]([A-Za-z0-9_$]+)['"`]\s+is declared but/i);
      if (m) symbolName = m[1];
    }
    if (!symbolName) return null;

    const isTsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
    const scriptKind = filePath.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : filePath.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : filePath.endsWith(".js")
      ? ts.ScriptKind.JS
      : ts.ScriptKind.TS;

    let sourceFile: ts.SourceFile;
    try {
      sourceFile = ts.createSourceFile(
        filePath,
        fileContent,
        ts.ScriptTarget.Latest,
        true,
        scriptKind
      );
    } catch {
      return null;
    }

    // 1. Deterministic local-variable repair
    let edit = this.repairLocalVariable(sourceFile, fileContent, symbolName, diagnostic);

    // 2. Deterministic destructured-binding repair
    if (!edit) {
      edit = this.repairDestructuredBinding(sourceFile, fileContent, symbolName, diagnostic);
    }

    // 3. Deterministic unused-import repair
    if (!edit) {
      edit = this.repairUnusedImport(sourceFile, fileContent, symbolName, diagnostic);
    }

    if (!edit) return null;

    // Verify patch application in-memory via applyPatchToFile (pure function)
    const patchRes = applyPatchToFile(fileContent, [edit]);
    if (!patchRes.success) return null;

    // Verify public contract preservation
    if (preTaskSource) {
      const contractCheck = PublicContractGuard.validatePublicContract({
        filePath,
        baselineContent: preTaskSource,
        proposedContent: patchRes.content,
        userMessage,
      });
      if (!contractCheck.valid) return null;
    }

    return edit;
  }

  /**
   * Case 1: Local variable TS6133
   * Removes unused local VariableStatement (single declarator) or specific VariableDeclaration (multi-declarator).
   */
  private static repairLocalVariable(
    sourceFile: ts.SourceFile,
    fileContent: string,
    symbolName: string,
    diagnostic: DiagnosticError
  ): FilePatchEdit | null {
    const matchingDecls: ts.VariableDeclaration[] = [];
    const findDecls = (node: ts.Node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === symbolName) {
        matchingDecls.push(node);
      }
      ts.forEachChild(node, findDecls);
    };
    findDecls(sourceFile);

    if (matchingDecls.length !== 1) return null;
    const targetDecl = matchingDecls[0];

    const { line } = sourceFile.getLineAndCharacterOfPosition(targetDecl.name.getStart(sourceFile));
    const nodeLine = line + 1;
    if (Math.abs(nodeLine - diagnostic.line) > 3) return null;

    if (!ts.isVariableDeclarationList(targetDecl.parent)) return null;
    const declList = targetDecl.parent;
    if (!ts.isVariableStatement(declList.parent)) return null;
    const varStmt = declList.parent;

    // Reject exported declarations (Part 5 & 7)
    const isExported = Boolean(varStmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
    if (isExported) return null;

    // Check for references outside of targetDecl.name
    let refCount = 0;
    const countRefs = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === symbolName) {
        if (node !== targetDecl.name) {
          refCount++;
        }
      }
      ts.forEachChild(node, countRefs);
    };
    countRefs(sourceFile);
    if (refCount > 0) return null;

    if (declList.declarations.length === 1) {
      const stmtStart = varStmt.getStart(sourceFile);
      let stmtEnd = varStmt.getEnd();

      const lineStart = fileContent.lastIndexOf("\n", stmtStart - 1) + 1;
      const leadingWhitespace = fileContent.slice(lineStart, stmtStart);
      const isSoleOnLine = leadingWhitespace.trim() === "";

      let editStart = isSoleOnLine ? lineStart : stmtStart;
      let editEnd = stmtEnd;

      if (fileContent[editEnd] === ";") editEnd++;
      if (isSoleOnLine) {
        if (fileContent[editEnd] === "\r" && fileContent[editEnd + 1] === "\n") {
          editEnd += 2;
        } else if (fileContent[editEnd] === "\n") {
          editEnd += 1;
        }

        // If preceding line was empty and following line is also empty, collapse one empty line
        const prevLineStart = fileContent.lastIndexOf("\n", lineStart - 2);
        const prevLine = fileContent.slice(prevLineStart + 1, lineStart - 1);
        if (prevLine.trim() === "") {
          if (fileContent[editEnd] === "\r" && fileContent[editEnd + 1] === "\n") {
            editEnd += 2;
          } else if (fileContent[editEnd] === "\n") {
            editEnd += 1;
          }
        }
      }

      const oldText = fileContent.slice(editStart, editEnd);
      if (!oldText || fileContent.indexOf(oldText) === -1) return null;
      return { oldText, newText: "" };
    } else {
      // Multi-declarator: e.g. const a = 1, b = 2;
      const declIdx = declList.declarations.indexOf(targetDecl);
      if (declIdx < 0) return null;

      if (declIdx > 0) {
        const prevDecl = declList.declarations[declIdx - 1];
        const editStart = prevDecl.getEnd();
        const editEnd = targetDecl.getEnd();
        const oldText = fileContent.slice(editStart, editEnd);
        if (!oldText || fileContent.indexOf(oldText) === -1) return null;
        return { oldText, newText: "" };
      } else {
        const nextDecl = declList.declarations[1];
        const editStart = targetDecl.getStart(sourceFile);
        const editEnd = nextDecl.getStart(sourceFile);
        const oldText = fileContent.slice(editStart, editEnd);
        if (!oldText || fileContent.indexOf(oldText) === -1) return null;
        return { oldText, newText: "" };
      }
    }
  }

  /**
   * Case 2: Destructured parameter TS6133
   * Removes ONLY the local BindingElement from component/function parameter destructuring.
   * Public interface/Props remain intact.
   */
  private static repairDestructuredBinding(
    sourceFile: ts.SourceFile,
    fileContent: string,
    symbolName: string,
    diagnostic: DiagnosticError
  ): FilePatchEdit | null {
    const matchingElements: ts.BindingElement[] = [];
    const findBindings = (node: ts.Node) => {
      if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === symbolName) {
        matchingElements.push(node);
      }
      ts.forEachChild(node, findBindings);
    };
    findBindings(sourceFile);

    if (matchingElements.length !== 1) return null;
    const targetElem = matchingElements[0];

    const { line } = sourceFile.getLineAndCharacterOfPosition(targetElem.name.getStart(sourceFile));
    const nodeLine = line + 1;
    if (Math.abs(nodeLine - diagnostic.line) > 3) return null;

    if (!ts.isObjectBindingPattern(targetElem.parent)) return null;
    const pattern = targetElem.parent;

    if (!ts.isParameter(pattern.parent)) return null;
    const param = pattern.parent;

    // Fallback rules (Part 7): alias, rest, default initializer
    if (targetElem.propertyName) return null;
    if (targetElem.dotDotDotToken) return null;
    if (targetElem.initializer) return null;

    let fnNode: ts.Node = param.parent;
    while (
      fnNode &&
      !ts.isFunctionDeclaration(fnNode) &&
      !ts.isArrowFunction(fnNode) &&
      !ts.isFunctionExpression(fnNode) &&
      !ts.isMethodDeclaration(fnNode)
    ) {
      fnNode = fnNode.parent;
    }
    if (!fnNode) return null;

    const fnBody = (fnNode as any).body;
    if (!fnBody) return null;

    let bodyRefs = 0;
    const countBodyRefs = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === symbolName) {
        bodyRefs++;
      }
      ts.forEachChild(node, countBodyRefs);
    };
    countBodyRefs(fnBody);
    if (bodyRefs > 0) return null;

    const elements = pattern.elements;
    const elemIdx = elements.indexOf(targetElem);
    if (elemIdx < 0) return null;

    if (elements.length === 1) {
      const oldText = fileContent.slice(pattern.getStart(sourceFile), pattern.getEnd());
      if (fileContent.indexOf(oldText) === -1) return null;
      return { oldText, newText: "{}" };
    }

    const elemStart = targetElem.getStart(sourceFile);
    const lineStart = fileContent.lastIndexOf("\n", elemStart - 1) + 1;
    const leadingOnLine = fileContent.slice(lineStart, elemStart);
    const isSoleOnLine = leadingOnLine.trim() === "";

    if (elemIdx < elements.length - 1) {
      const nextElem = elements[elemIdx + 1];
      let editStart = isSoleOnLine ? lineStart : elemStart;

      const commaIdx = fileContent.indexOf(",", targetElem.getEnd());
      if (commaIdx === -1 || commaIdx >= nextElem.getStart(sourceFile)) return null;

      let editEnd = commaIdx + 1;
      if (isSoleOnLine) {
        if (fileContent[editEnd] === "\r" && fileContent[editEnd + 1] === "\n") {
          editEnd += 2;
        } else if (fileContent[editEnd] === "\n") {
          editEnd += 1;
        }
      } else {
        while (editEnd < nextElem.getStart(sourceFile) && /\s/.test(fileContent[editEnd])) {
          editEnd++;
        }
      }

      const oldText = fileContent.slice(editStart, editEnd);
      // Uniqueness check: if oldText appears multiple times, include preceding element context
      if (fileContent.indexOf(oldText) !== fileContent.lastIndexOf(oldText)) {
        if (elemIdx > 0) {
          const prevElem = elements[elemIdx - 1];
          const expandedStart = prevElem.getStart(sourceFile);
          const expandedOld = fileContent.slice(expandedStart, editEnd);
          const expandedNew = fileContent.slice(expandedStart, editStart);
          return { oldText: expandedOld, newText: expandedNew };
        }
        return null;
      }
      return { oldText, newText: "" };
    } else {
      // Last element in pattern
      if (isSoleOnLine) {
        const prevElem = elements[elemIdx - 1];
        const trailingCommaIdx = fileContent.indexOf(",", targetElem.getEnd());
        const closeBraceIdx = fileContent.indexOf("}", targetElem.getEnd());
        let editEnd = targetElem.getEnd();
        if (trailingCommaIdx !== -1 && trailingCommaIdx < closeBraceIdx) {
          editEnd = trailingCommaIdx + 1;
        }
        if (fileContent[editEnd] === "\r" && fileContent[editEnd + 1] === "\n") {
          editEnd += 2;
        } else if (fileContent[editEnd] === "\n") {
          editEnd += 1;
        }

        const oldText = fileContent.slice(lineStart, editEnd);
        if (fileContent.indexOf(oldText) !== fileContent.lastIndexOf(oldText)) {
          const expandedStart = prevElem.getStart(sourceFile);
          const expandedOld = fileContent.slice(expandedStart, editEnd);
          const expandedNew = fileContent.slice(expandedStart, lineStart);
          return { oldText: expandedOld, newText: expandedNew };
        }
        return { oldText, newText: "" };
      } else {
        const prevElem = elements[elemIdx - 1];
        const commaIdx = fileContent.indexOf(",", prevElem.getEnd());
        if (commaIdx === -1 || commaIdx > elemStart) return null;
        const oldText = fileContent.slice(commaIdx, targetElem.getEnd());
        if (fileContent.indexOf(oldText) !== fileContent.lastIndexOf(oldText)) return null;
        return { oldText, newText: "" };
      }
    }
  }

  /**
   * Case 3: Type/Named import TS6133
   * Removes ImportSpecifier only if symbol is truly unused everywhere in the AST.
   * If symbol is referenced by an exported interface/type alias/function, declinesto preserve public contract.
   */
  private static repairUnusedImport(
    sourceFile: ts.SourceFile,
    fileContent: string,
    symbolName: string,
    diagnostic: DiagnosticError
  ): FilePatchEdit | null {
    const matchingSpecifiers: ts.ImportSpecifier[] = [];
    const findImports = (node: ts.Node) => {
      if (ts.isImportSpecifier(node) && ts.isIdentifier(node.name) && node.name.text === symbolName) {
        matchingSpecifiers.push(node);
      }
      ts.forEachChild(node, findImports);
    };
    findImports(sourceFile);

    if (matchingSpecifiers.length !== 1) return null;
    const targetSpec = matchingSpecifiers[0];

    const { line } = sourceFile.getLineAndCharacterOfPosition(targetSpec.name.getStart(sourceFile));
    const nodeLine = line + 1;
    if (Math.abs(nodeLine - diagnostic.line) > 3) return null;

    // Check if symbol is referenced anywhere else in the file (e.g. interfaces, types, functions)
    let otherRefs = 0;
    const countRefs = (node: ts.Node) => {
      if (ts.isIdentifier(node) && node.text === symbolName) {
        if (node !== targetSpec.name && node !== targetSpec.propertyName) {
          otherRefs++;
        }
      }
      ts.forEachChild(node, countRefs);
    };
    countRefs(sourceFile);
    if (otherRefs > 0) return null; // Required elsewhere in the file!

    if (!ts.isNamedImports(targetSpec.parent)) return null;
    const namedImports = targetSpec.parent;
    if (!ts.isImportClause(namedImports.parent)) return null;
    const importClause = namedImports.parent;
    if (!ts.isImportDeclaration(importClause.parent)) return null;
    const importDecl = importClause.parent;

    const specifiers = namedImports.elements;
    const specIdx = specifiers.indexOf(targetSpec);
    if (specIdx < 0) return null;

    if (specifiers.length === 1 && !importClause.name) {
      // Sole specifier and no default import: remove whole import statement
      const declStart = importDecl.getStart(sourceFile);
      const lineStart = fileContent.lastIndexOf("\n", declStart - 1) + 1;
      let declEnd = importDecl.getEnd();
      if (fileContent[declEnd] === ";") declEnd++;
      if (fileContent[declEnd] === "\r" && fileContent[declEnd + 1] === "\n") {
        declEnd += 2;
      } else if (fileContent[declEnd] === "\n") {
        declEnd += 1;
      }
      const oldText = fileContent.slice(lineStart, declEnd);
      if (fileContent.indexOf(oldText) === -1) return null;
      return { oldText, newText: "" };
    } else if (specifiers.length > 1) {
      if (specIdx < specifiers.length - 1) {
        const nextSpec = specifiers[specIdx + 1];
        const editStart = targetSpec.getStart(sourceFile);
        const commaIdx = fileContent.indexOf(",", targetSpec.getEnd());
        if (commaIdx === -1 || commaIdx >= nextSpec.getStart(sourceFile)) return null;
        let editEnd = commaIdx + 1;
        while (editEnd < nextSpec.getStart(sourceFile) && /\s/.test(fileContent[editEnd])) {
          editEnd++;
        }
        const oldText = fileContent.slice(editStart, editEnd);
        if (fileContent.indexOf(oldText) !== fileContent.lastIndexOf(oldText)) return null;
        return { oldText, newText: "" };
      } else {
        const prevSpec = specifiers[specIdx - 1];
        const commaIdx = fileContent.indexOf(",", prevSpec.getEnd());
        if (commaIdx === -1 || commaIdx > targetSpec.getStart(sourceFile)) return null;
        const oldText = fileContent.slice(commaIdx, targetSpec.getEnd());
        if (fileContent.indexOf(oldText) !== fileContent.lastIndexOf(oldText)) return null;
        return { oldText, newText: "" };
      }
    }
    return null;
  }
}

