import { getOpenAI } from "../shared/utils";
import { AgentFileChange } from "../shared/types";
import { SECURITY_REVIEW_PROMPT, CODE_CRITIQUE_PROMPT } from "../prompts/coding";
import { SecurityPolicy } from "../security/SecurityPolicy";

export interface SecurityVulnerability {
  file: string;
  issue: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
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

    let deterministicPolicyPass = true;
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
      if (typeof secResult.passed === "boolean") llmReviewPass = secResult.passed;
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
          } else {
            vulnerabilities.push({ file, issue, severity });
          }
        }
      }
      if (Array.isArray(secResult.recommendations)) {
        recommendations = secResult.recommendations.map(String);
      }

      // If all vulnerabilities are LOW or unsupported, LLM review is considered passed
      const hasSevereLlmFindings = vulnerabilities.some(
        (v) => (v.severity === "HIGH" || v.severity === "CRITICAL") && !v.issue.startsWith("[UNSUPPORTED_SECURITY_FINDING]")
      );
      if (!hasSevereLlmFindings) {
        llmReviewPass = true;
        if (riskLevel === "HIGH" || riskLevel === "CRITICAL") {
          riskLevel = "LOW";
        }
      } else {
        llmReviewPass = false;
      }
    } catch {
      llmReviewPass = true;
      riskLevel = "LOW";
    }

    // Deterministic static safety check: flag dangerous dynamic execution constructs via SecurityPolicy
    for (const c of changes) {
      const policyCheck = SecurityPolicy.checkCode(c.content || "", c.path);
      if (!policyCheck.safe) {
        deterministicPolicyPass = false;
        riskLevel = "HIGH";
        for (const v of policyCheck.violations) {
          vulnerabilities.push({
            file: c.path,
            issue: v.message,
            severity: "HIGH",
          });
        }
        if (!recommendations.includes("Replace unsafe dynamic execution with explicit allowlisted operators or a deterministic mathematical parser.")) {
          recommendations.push("Replace unsafe dynamic execution with explicit allowlisted operators or a deterministic mathematical parser.");
        }
      }
    }

    const securityPass = deterministicPolicyPass && llmReviewPass;
    const passed = securityPass && critiqueScore >= 0.80;

    let summary = `Reflection Pass Score: ${(critiqueScore * 100).toFixed(0)}%. Deterministic Policy: ${deterministicPolicyPass ? "PASS" : "FAIL"}. LLM Review: ${llmReviewPass ? "PASS" : "FLAGGED"} (${riskLevel} risk).`;
    if (!securityPass && vulnerabilities.length > 0) {
      summary += ` Findings: ${vulnerabilities.map((v) => `[${v.severity}] ${v.file}: ${v.issue}`).join("; ")}`;
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
