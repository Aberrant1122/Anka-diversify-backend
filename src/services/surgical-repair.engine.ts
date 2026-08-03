import fs from "fs";
import path from "path";
import { performance } from "perf_hooks";

// ─── Interfaces & Schemas ─────────────────────────────────────────────────────

export interface DiagnosticError {
  file: string;
  line: number;
  column?: number;
  code?: string; // e.g. TS2304, TS2305, TS2322, TS2339
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
   * Parse TypeScript, SWC, Next.js, and Node build error logs into structured diagnostics.
   */
  static parse(errorLog: string): DiagnosticError[] {
    if (!errorLog) return [];
    const diagnostics: DiagnosticError[] = [];

    // TS Format: src/services/ai-service.ts(2521,9): error TS2322: Type 'X' is not assignable to type 'Y'
    const tsRegex = /([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx))\(([0-9]+),([0-9]+)\):\s*error\s*(TS[0-9]+)?:\s*(.+)/g;
    let match: RegExpExecArray | null;

    while ((match = tsRegex.exec(errorLog)) !== null) {
      const filePath = match[1].replace(/\\/g, "/");
      const line = parseInt(match[2], 10);
      const column = parseInt(match[3], 10);
      const code = match[4] || "TS0000";
      const message = match[5].trim();

      // Extract symbol name if available (e.g. Cannot find name 'Foo')
      const symMatch = message.match(/['"`]([A-Za-z0-9_]+)['"`]/);
      const symbolName = symMatch ? symMatch[1] : undefined;

      diagnostics.push({
        file: filePath,
        line,
        column,
        code,
        message,
        symbolName,
        rawTrace: match[0],
      });
    }

    // Fallback Next.js / SWC format: ./src/app/page.tsx:14:23
    if (diagnostics.length === 0) {
      const genericRegex = /([a-zA-Z0-9_\-\/\\.]+\.(?:ts|tsx|js|jsx)):([0-9]+):([0-9]+)[\s\-:]+(.+)/g;
      while ((match = genericRegex.exec(errorLog)) !== null) {
        const filePath = match[1].replace(/\\/g, "/");
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
    const replacementLines = patch.replacementContent.split("\n");

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
   * Generate a minimal surgical patch for missing imports or line type errors.
   */
  static generateMinimalPatch(
    fileContent: string,
    filePath: string,
    diag: DiagnosticError,
  ): SurgicalPatchChunk {
    const lines = fileContent.split("\n");
    const targetLineIdx = Math.max(0, diag.line - 1);
    const targetLineContent = lines[targetLineIdx] || "";

    // Case 1: Missing Symbol / Import (TS2304 / TS2552)
    if ((diag.code === "TS2304" || diag.code === "TS2552") && diag.symbolName) {
      // Find last import line at top of file
      let lastImportLine = 0;
      for (let i = 0; i < Math.min(lines.length, 30); i++) {
        if (lines[i].trim().startsWith("import ")) lastImportLine = i + 1;
      }

      const insertLine = lastImportLine > 0 ? lastImportLine + 1 : 1;
      const targetContent = lines[insertLine - 1] || "";
      const missingImportLine = `import { ${diag.symbolName} } from "./${diag.symbolName.toLowerCase()}";`;
      const replacementContent = `${missingImportLine}\n${targetContent}`;

      return {
        file: filePath,
        startLine: insertLine,
        endLine: insertLine,
        targetContent,
        replacementContent,
        affectedNodeName: `ImportDeclaration (${diag.symbolName})`,
        linesAdded: 1,
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
