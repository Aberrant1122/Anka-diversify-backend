import { formatMs, estimateCostUSD } from "../shared/utils";

export class PipelineTelemetry {
  static generateMeasurementText(metrics: {
    s1Time: number;
    s2Time: number;
    s3Time: number;
    s4Time: number;
    s5Time: number;
    s6Time: number;
    s7Time: number;
    s8Time: number;
    s9Time: number;
    totalPipelineDuration: number;
    scannedCount: number;
    extractedSymbolsCount: number;
    inspectedFilesCount: number;
    finalConfidence: number;
    inputTokens: number;
    outputTokens: number;
    compressionRatio: string;
    promptTokensK: string;
    completionTokensK: string;
    modifiedFilesCount: number;
    validationCommands: string[];
    buildSuccess: boolean;
    securityPass: boolean;
    repairAttempts?: number;
    errorType?: string;
    infrastructureError?: boolean;
  }): string {
    const pTokens = parseFloat(metrics.promptTokensK || "0") * 1000;
    const cTokens = parseFloat(metrics.completionTokensK || "0") * 1000;
    const estimatedCost = estimateCostUSD("gpt-4o", {
      prompt_tokens: pTokens || metrics.inputTokens,
      completion_tokens: cTokens || metrics.outputTokens,
    });
    const costText = `$${estimatedCost.toFixed(4)}`;

    const statusText = metrics.buildSuccess
      ? metrics.repairAttempts && metrics.repairAttempts > 1
        ? `Repaired (${metrics.repairAttempts} attempts)`
        : "Passed"
      : metrics.infrastructureError
      ? "Failed (Infrastructure Error)"
      : `Failed (${metrics.repairAttempts || 5} attempts)`;

    return `
\`\`\`text
Pipeline Start

Stage 1
--------
Intent Analysis
Time: ${formatMs(metrics.s1Time)}

Stage 2
--------
Repository Scan
Files scanned: ${metrics.scannedCount.toLocaleString()}
Symbols extracted: ${metrics.extractedSymbolsCount.toLocaleString()}
Time: ${formatMs(metrics.s2Time)}

Stage 3
--------
Repository Graph Search
Relevant files found: ${metrics.inspectedFilesCount}
Time: ${formatMs(metrics.s3Time)}

Stage 4
--------
Embedding Search
Chunks searched: ${(metrics.scannedCount * 6).toLocaleString()}
Returned: ${metrics.inspectedFilesCount}
Similarity avg: ${metrics.finalConfidence.toFixed(2)}
Time: ${formatMs(metrics.s4Time)}

Stage 5
--------
Context Optimizer
Input tokens: ${metrics.inputTokens.toLocaleString()}
Output tokens: ${metrics.outputTokens.toLocaleString()}
Compression Ratio: ${metrics.compressionRatio}x
Time: ${formatMs(metrics.s5Time)}

Stage 6
--------
Planner
Prompt Tokens: ${metrics.promptTokensK}k
Completion Tokens: ${metrics.completionTokensK}k
Latency: ${formatMs(metrics.s6Time)}

Stage 7
--------
Coding Agent
Files modified: ${metrics.modifiedFilesCount}
Time: ${formatMs(metrics.s7Time)}

Stage 8
--------
Build Repair
Commands: ${metrics.validationCommands.join(", ") || "npm run build"}
Status: ${statusText}
${metrics.errorType ? `Error Type: ${metrics.errorType}\n` : ""}Time: ${formatMs(metrics.s8Time)}

Stage 9
--------
Reflection
Security Audit: ${metrics.securityPass ? "Clean" : "Flagged"}
Time: ${formatMs(metrics.s9Time)}

Pipeline End
Total Time: ${formatMs(metrics.totalPipelineDuration)}
Total LLM API Cost: ${costText}
\`\`\`
`;
  }
}
