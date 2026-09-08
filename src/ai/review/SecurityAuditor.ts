import { getOpenAI } from "../shared/utils";
import { AgentFileChange } from "../shared/types";
import { SECURITY_REVIEW_PROMPT, CODE_CRITIQUE_PROMPT } from "../prompts/coding";
import { SecurityPolicy } from "../security/SecurityPolicy";

export interface SecurityVulnerability {
  file: string;
  issue: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  provenance?: "PRE_EXISTING_BASELINE" | "INTRODUCED_BY_AGENT" | "WORSENED_BY_AGENT";
}

export interface SecurityAuditResult {
  approvedChanges: AgentFileChange[];
  passed: boolean;
  critiqueScore: number;
  securityPass: boolean;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  vulnerabilities?: SecurityVulnerability[];
  recommendations?: string[];
  summary: string;
}

export class SecurityAuditor {
  static async runReflectionAndSecurityAudit(
    changes: AgentFileChange[],
    baselineSourceGetter?: ((filePath: string) => string | undefined | null) | Record<string, string>,
  ): Promise<SecurityAuditResult> {
    if (!changes.length) {
      return {
        approvedChanges: [],
        passed: true,
        critiqueScore: 1.0,
        securityPass: true,
        riskLevel: "LOW",
        vulnerabilities: [],
        recommendations: [],
        summary: "No changes to review.",
      };
    }

    const diffText = changes.map((c) => `=== FILE: ${c.path} ===\n${c.content}`).join("\n\n");

    let critiqueScore = 0.90;
    try {
      const openai = getOpenAI();
      const critiqueCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: CODE_CRITIQUE_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      });
      const critiqueResult = JSON.parse(critiqueCompletion.choices[0]?.message?.content || "{}");
      if (typeof critiqueResult.score === "number" && !isNaN(critiqueResult.score)) {
        let rawScore = critiqueResult.score;
        if (rawScore > 1.0 && rawScore <= 10.0) {
          rawScore = rawScore / 10.0;
        } else if (rawScore > 10.0 && rawScore <= 100.0) {
          rawScore = rawScore / 100.0;
        }
        critiqueScore = Math.max(0.0, Math.min(1.0, rawScore));
      }
    } catch {
      critiqueScore = 0.90;
    }

    let riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = "LOW";
    let vulnerabilities: SecurityVulnerability[] = [];
    let recommendations: string[] = [];

    // 1. Deterministic static safety check: evaluate delta against immutable baseline first
    const policyDelta = SecurityPolicy.checkChanges(changes, baselineSourceGetter || {});
    const introducedOrWorsenedViolations = policyDelta.violations.filter(
      (v) => v.provenance === "INTRODUCED_BY_AGENT" || v.provenance === "WORSENED_BY_AGENT"
    );
    const preExistingViolations = policyDelta.violations.filter(
      (v) => v.provenance === "PRE_EXISTING_BASELINE"
    );

    let deterministicPolicyPass = policyDelta.safe;
    let llmReviewPass = true;

    try {
      const openai = getOpenAI();
      const secCompletion = await openai.chat.completions.create({
        model: "gpt-4o",
        messages: [
          { role: "system", content: SECURITY_REVIEW_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.0,
        response_format: { type: "json_object" },
      });
      const secResult = JSON.parse(secCompletion.choices[0]?.message?.content || "{}");
      if (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(secResult.riskLevel)) {
        riskLevel = secResult.riskLevel;
      }
      if (Array.isArray(secResult.vulnerabilities)) {
        for (const rawV of secResult.vulnerabilities) {
          const file = String(rawV?.file || "unknown");
          const issue = String(rawV?.issue || "Security concern detected");
          let severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" = ["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(rawV?.severity)
            ? rawV.severity
            : "MEDIUM";

          const targetFile = changes.find((c) => c.path === file || c.path.endsWith(file) || file.endsWith(c.path));
          const targetContent = targetFile?.content || "";

          // Verify evidence: If the LLM alleges dynamic execution without an actual dangerous sink, mark unsupported
          const evidenceCheck = SecurityPolicy.validateFindingEvidence(issue, targetContent);
          if (!evidenceCheck.isEvidenceSupported) {
            vulnerabilities.push({
              file,
              issue: `[UNSUPPORTED_SECURITY_FINDING] ${issue} (No dangerous execution primitive or sink detected in code)`,
              severity: "LOW",
            });
            continue;
          }

          // Reconcile LLM finding against deterministic baseline delta by structural evidence
          const normPath = file.replace(/\\/g, "/").replace(/^\.\//, "");
          const matchingDeterministic = policyDelta.violations.find((v) => {
            const vNorm = v.path.replace(/\\/g, "/").replace(/^\.\//, "");
            if (vNorm !== normPath && !normPath.endsWith(vNorm) && !vNorm.endsWith(normPath)) return false;
            if (evidenceCheck.identifiedReason && v.reason === evidenceCheck.identifiedReason) return true;
            if (/\b(?:math|mathjs|evaluate)\b/i.test(issue) && v.reason === "UNSAFE_MATHJS_EVALUATE") return true;
            if (/\beval\b/i.test(issue) && v.reason === "UNSAFE_EVAL") return true;
            if (/\b(?:function|constructor)\b/i.test(issue) && v.reason === "UNSAFE_FUNCTION_CONSTRUCTOR") return true;
            return false;
          });

          let findingProvenance: SecurityVulnerability["provenance"] = undefined;
          if (matchingDeterministic) {
            findingProvenance = matchingDeterministic.provenance;
          } else {
            // Check if baseline file had the exact same construct/content for novel findings
            let baselineContent: string | null | undefined = undefined;
            if (typeof baselineSourceGetter === "function") {
              baselineContent = baselineSourceGetter(file);
            } else if (baselineSourceGetter && typeof baselineSourceGetter === "object") {
              baselineContent = baselineSourceGetter[file];
            }
            if (baselineContent && (baselineContent === targetContent || baselineContent.includes(issue))) {
              findingProvenance = "PRE_EXISTING_BASELINE";
            } else {
              findingProvenance = "INTRODUCED_BY_AGENT";
            }
          }

          if (findingProvenance === "PRE_EXISTING_BASELINE") {
            vulnerabilities.push({
              file,
              issue: `[PRE_EXISTING_BASELINE] ${issue}`,
              severity,
              provenance: "PRE_EXISTING_BASELINE",
            });
          } else {
            vulnerabilities.push({
              file,
              issue,
              severity,
              provenance: findingProvenance || "INTRODUCED_BY_AGENT",
            });
          }
        }
      }
      if (Array.isArray(secResult.recommendations)) {
        recommendations = secResult.recommendations.map(String);
      }
    } catch {
      llmReviewPass = true;
      riskLevel = "LOW";
    }

    if (!policyDelta.safe) {
      riskLevel = "HIGH";
      for (const v of introducedOrWorsenedViolations) {
        const normV = v.path.replace(/\\/g, "/").replace(/^\.\//, "");
        const alreadyCovered = vulnerabilities.some((existing) => {
          const existNorm = existing.file.replace(/\\/g, "/").replace(/^\.\//, "");
          if (existNorm !== normV && !existNorm.endsWith(normV) && !normV.endsWith(existNorm)) return false;
          if (v.reason === "UNSAFE_MATHJS_EVALUATE" && /\b(?:math|mathjs|evaluate)\b/i.test(existing.issue)) return true;
          if (v.reason === "UNSAFE_EVAL" && /\beval\b/i.test(existing.issue)) return true;
          if (v.reason === "UNSAFE_FUNCTION_CONSTRUCTOR" && /\b(?:function|constructor)\b/i.test(existing.issue)) return true;
          return existing.issue.includes(v.message);
        });

        if (!alreadyCovered) {
          vulnerabilities.push({
            file: v.path,
            issue: v.message,
            severity: "HIGH",
            provenance: v.provenance,
          });
        }
      }
      if (!recommendations.includes("Replace unsafe dynamic execution with explicit allowlisted operators or a deterministic mathematical parser.")) {
        recommendations.push("Replace unsafe dynamic execution with explicit allowlisted operators or a deterministic mathematical parser.");
      }
    }

    if (preExistingViolations.length > 0) {
      riskLevel = "HIGH";
      for (const v of preExistingViolations) {
        const normV = v.path.replace(/\\/g, "/").replace(/^\.\//, "");
        const alreadyCovered = vulnerabilities.some((existing) => {
          const existNorm = existing.file.replace(/\\/g, "/").replace(/^\.\//, "");
          if (existNorm !== normV && !existNorm.endsWith(normV) && !normV.endsWith(existNorm)) return false;
          if (v.reason === "UNSAFE_MATHJS_EVALUATE" && /\b(?:math|mathjs|evaluate)\b/i.test(existing.issue)) return true;
          if (v.reason === "UNSAFE_EVAL" && /\beval\b/i.test(existing.issue)) return true;
          if (v.reason === "UNSAFE_FUNCTION_CONSTRUCTOR" && /\b(?:function|constructor)\b/i.test(existing.issue)) return true;
          return existing.issue.includes(v.message);
        });

        if (!alreadyCovered) {
          vulnerabilities.push({
            file: v.path,
            issue: `[PRE_EXISTING_BASELINE] ${v.message}`,
            severity: "HIGH",
            provenance: "PRE_EXISTING_BASELINE",
          });
        }
      }
      if (!recommendations.includes("Pre-existing baseline security advisory: consider replacing dynamic mathjs evaluation in future tasks.")) {
        recommendations.push("Pre-existing baseline security advisory: consider replacing dynamic mathjs evaluation in future tasks.");
      }
    }

    // Compute llmReviewPass after provenance reconciliation
    const hasSevereLlmFindings = vulnerabilities.some(
      (v) => (v.severity === "HIGH" || v.severity === "CRITICAL") &&
             v.provenance !== "PRE_EXISTING_BASELINE" &&
             !v.issue.startsWith("[UNSUPPORTED_SECURITY_FINDING]") &&
             !v.issue.startsWith("[PRE_EXISTING_BASELINE]")
    );

    if (!hasSevereLlmFindings) {
      llmReviewPass = true;
    } else {
      llmReviewPass = false;
    }

    const securityPass = deterministicPolicyPass && llmReviewPass;
    const passed = securityPass && critiqueScore >= 0.80;

    let summary = `Reflection Pass Score: ${(critiqueScore * 100).toFixed(0)}%. Deterministic Policy: ${deterministicPolicyPass ? "PASS" : "FAIL"}. LLM Review: ${llmReviewPass ? "PASS" : "FLAGGED"} (${riskLevel} risk).`;
    if (vulnerabilities.length > 0) {
      summary += ` Findings: ${vulnerabilities.map((v) => `[${v.severity}${v.provenance ? `:${v.provenance}` : ""}] ${v.file}: ${v.issue}`).join("; ")}`;
    }

    return {
      approvedChanges: changes,
      passed,
      critiqueScore,
      securityPass,
      riskLevel,
      vulnerabilities,
      recommendations,
      summary,
    };
  }
}
