import { AgentFileChange } from "../shared/types";
import { SECURITY_REVIEW_PROMPT, CODE_CRITIQUE_PROMPT } from "../prompts/coding";
import { SecurityPolicy } from "../security/SecurityPolicy";
import { LLMGateway } from "../gateway/LLMGateway";
import { PipelineStages } from "../gateway/PipelineStage";

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

interface SecurityCritiquePayload {
  score: number;
  passed: boolean;
  critique: string[];
  improvements: string;
}

interface SecurityReviewPayload {
  passed: boolean;
  riskLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  vulnerabilities: Array<{ file: string; issue: string; severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" }>;
  recommendations: string[];
}

const securityCritiqueSchema = {
  name: "SecurityCritiqueSchema",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["score", "passed", "critique", "improvements"],
    properties: {
      score: { type: "number", minimum: 0, maximum: 1 },
      passed: { type: "boolean" },
      critique: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
      improvements: { type: "string" },
    },
  },
  validate: (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Security critique must be an object"] };
    const critique = value as Record<string, unknown>;
    if (Object.keys(critique).some((key) => !["score", "passed", "critique", "improvements"].includes(key)) || typeof critique.score !== "number" || !Number.isFinite(critique.score) || critique.score < 0 || critique.score > 1 || typeof critique.passed !== "boolean" || !Array.isArray(critique.critique) || typeof critique.improvements !== "string") return { valid: false, errors: ["Security critique fields are invalid"] };
    if (critique.critique.some((item) => typeof item !== "string" || !item.trim())) return { valid: false, errors: ["Security critique entries are invalid"] };
    return { valid: true, data: critique as unknown as SecurityCritiquePayload };
  },
};

const securityReviewSchema = {
  name: "SecurityReviewSchema",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["passed", "riskLevel", "vulnerabilities", "recommendations"],
    properties: {
      passed: { type: "boolean" },
      riskLevel: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
      vulnerabilities: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["file", "issue", "severity"],
          properties: {
            file: { type: "string", minLength: 1 },
            issue: { type: "string", minLength: 1 },
            severity: { type: "string", enum: ["LOW", "MEDIUM", "HIGH", "CRITICAL"] },
          },
        },
      },
      recommendations: { type: "array", maxItems: 100, items: { type: "string", minLength: 1 } },
    },
  },
  validate: (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Security review must be an object"] };
    const review = value as Record<string, unknown>;
    if (Object.keys(review).some((key) => !["passed", "riskLevel", "vulnerabilities", "recommendations"].includes(key)) || typeof review.passed !== "boolean" || !["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(String(review.riskLevel)) || !Array.isArray(review.vulnerabilities) || !Array.isArray(review.recommendations)) return { valid: false, errors: ["Security review fields are invalid"] };
    if (review.vulnerabilities.some((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return true;
      const finding = item as Record<string, unknown>;
      return Object.keys(finding).some((key) => !["file", "issue", "severity"].includes(key)) || typeof finding.file !== "string" || !finding.file.trim() || typeof finding.issue !== "string" || !finding.issue.trim() || !["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(String(finding.severity));
    }) || review.recommendations.some((item) => typeof item !== "string" || !item.trim())) return { valid: false, errors: ["Security review findings are invalid"] };
    return { valid: true, data: review as unknown as SecurityReviewPayload };
  },
};

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
    let critiqueAvailable = true;
    try {
      const critiqueResult = await LLMGateway.getInstance().callStructured<SecurityCritiquePayload>({
        stage: PipelineStages.SECURITY_AUDIT,
        messages: [
          { role: "system", content: CODE_CRITIQUE_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.1,
        schema: securityCritiqueSchema,
      });
      critiqueScore = critiqueResult.content.score;
    } catch {
      critiqueScore = 0.0;
      critiqueAvailable = false;
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
    let llmReviewAvailable = true;
    let modelReportedSecurityFailure = false;

    try {
      const secResult = await LLMGateway.getInstance().callStructured<SecurityReviewPayload>({
        stage: PipelineStages.SECURITY_AUDIT,
        messages: [
          { role: "system", content: SECURITY_REVIEW_PROMPT },
          { role: "user", content: diffText },
        ],
        temperature: 0.0,
        schema: securityReviewSchema,
      });
      if (!secResult.content.passed) modelReportedSecurityFailure = true;
      if (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(secResult.content.riskLevel)) {
        riskLevel = secResult.content.riskLevel;
      }
      if (Array.isArray(secResult.content.vulnerabilities)) {
        for (const rawV of secResult.content.vulnerabilities) {
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
      if (Array.isArray(secResult.content.recommendations)) {
        recommendations = secResult.content.recommendations.map(String);
      }
    } catch {
      llmReviewPass = false;
      llmReviewAvailable = false;
      riskLevel = "HIGH";
      recommendations.push("Security review unavailable; changes remain unverified.");
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

    if (!llmReviewAvailable) {
      llmReviewPass = false;
    } else if (modelReportedSecurityFailure) {
      llmReviewPass = false;
    } else if (!hasSevereLlmFindings) {
      llmReviewPass = true;
    } else {
      llmReviewPass = false;
    }

    const securityPass = deterministicPolicyPass && llmReviewPass && critiqueAvailable;
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
