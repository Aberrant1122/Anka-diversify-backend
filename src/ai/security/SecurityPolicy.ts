import { AgentFileChange } from "../../types";

export interface SecurityViolation {
  path: string;
  reason: "UNSAFE_DYNAMIC_CODE_EXECUTION" | "UNSAFE_EVAL" | "UNSAFE_FUNCTION_CONSTRUCTOR" | "UNSAFE_MATHJS_EVALUATE";
  message: string;
  lineSnippet?: string;
}

export interface SecurityPolicyResult {
  safe: boolean;
  violations: SecurityViolation[];
}

/**
 * Centralized deterministic security policy checking for unsafe dynamic execution:
 * 1. eval(...)
 * 2. new Function(...)
 * 3. mathjs evaluate / math.evaluate(...)
 * 4. vm / child_process execution on dynamic strings
 */
export class SecurityPolicy {
  private static readonly EVAL_REGEX = /\beval\s*\(/;
  private static readonly FUNCTION_CTOR_REGEX = /\bnew\s+Function\s*\(/;
  private static readonly MATHJS_IMPORT_REGEX = /\bfrom\s*["']mathjs["']|\brequire\s*\(\s*["']mathjs["']\s*\)/;
  private static readonly MATH_EVALUATE_REGEX = /\b(?:math|mathjs)\.evaluate\s*\(|\bevaluate\s*\(/;

  /**
   * Inspect a single file's content against the security policy.
   */
  public static checkCode(content: string, filePath = "unknown"): SecurityPolicyResult {
    const violations: SecurityViolation[] = [];

    if (this.EVAL_REGEX.test(content)) {
      violations.push({
        path: filePath,
        reason: "UNSAFE_EVAL",
        message: `Direct use of eval() detected in "${filePath}". Dynamic execution of user-controlled code is strictly forbidden.`,
      });
    }

    if (this.FUNCTION_CTOR_REGEX.test(content)) {
      violations.push({
        path: filePath,
        reason: "UNSAFE_FUNCTION_CONSTRUCTOR",
        message: `Direct use of new Function() constructor detected in "${filePath}". Dynamic execution is strictly forbidden.`,
      });
    }

    if (this.MATHJS_IMPORT_REGEX.test(content) || (/\bmathjs\b/.test(content) && this.MATH_EVALUATE_REGEX.test(content))) {
      violations.push({
        path: filePath,
        reason: "UNSAFE_MATHJS_EVALUATE",
        message: `Unrestricted dynamic mathematical evaluation via mathjs detected in "${filePath}". Use explicit tokenization or allowlisted operators.`,
      });
    }

    return {
      safe: violations.length === 0,
      violations,
    };
  }

  /**
   * Checks whether the code contains an actual dangerous dynamic execution primitive/sink:
   * eval(), new Function(), mathjs.evaluate, child_process execution, vm execution.
   */
  public static hasDangerousPrimitive(code: string): boolean {
    if (this.EVAL_REGEX.test(code)) return true;
    if (this.FUNCTION_CTOR_REGEX.test(code)) return true;
    if (this.MATHJS_IMPORT_REGEX.test(code) || (/\bmathjs\b/.test(code) && this.MATH_EVALUATE_REGEX.test(code))) return true;
    if (/\bvm\.(runInContext|runInNewContext|runInThisContext|Script)\b/.test(code)) return true;
    if (/\b(?:child_process|cp)\.(?:exec|execSync|spawn|spawnSync)\b/.test(code)) return true;
    return false;
  }

  /**
   * Validates whether an LLM-reported security finding is supported by concrete evidence in the code.
   * If the LLM alleges dynamic execution or eval-like behavior but no dangerous sink exists,
   * it returns isEvidenceSupported: false.
   */
  public static validateFindingEvidence(
    issue: string,
    code: string
  ): { isEvidenceSupported: boolean; identifiedPrimitive?: string } {
    const isDynamicExecClaim =
      /\b(eval|eval-like|dynamic execution|dynamic code|function constructor|code injection|mathjs|arbitrary code)\b/i.test(
        issue
      );

    if (!isDynamicExecClaim) {
      // Non-dynamic execution findings (e.g. secret leak, XSS) can stand on their own merits
      return { isEvidenceSupported: true };
    }

    const hasPrimitive = this.hasDangerousPrimitive(code);
    if (hasPrimitive) {
      return { isEvidenceSupported: true };
    }

    return {
      isEvidenceSupported: false,
    };
  }

  /**
   * Inspect a batch of proposed changes against baseline repository files.
   * Only flags violations if ANKA newly introduced or modified the unsafe construct.
   */
  public static checkChanges(
    changes: readonly AgentFileChange[],
    baselineFiles: Record<string, string> = {}
  ): SecurityPolicyResult {
    const allViolations: SecurityViolation[] = [];

    for (const change of changes) {
      if (change.action === "delete" || change.isDeleted) continue;
      const content = change.content || "";

      const fileCheck = this.checkCode(content, change.path);
      if (!fileCheck.safe) {
        const baseline = baselineFiles[change.path] || "";
        const baselineCheck = this.checkCode(baseline, change.path);
        const baselineReasons = new Set(baselineCheck.violations.map((v) => v.reason));

        for (const violation of fileCheck.violations) {
          // If baseline did not have this violation, it is newly introduced by ANKA
          if (!baselineReasons.has(violation.reason)) {
            allViolations.push(violation);
          }
        }
      }
    }

    return {
      safe: allViolations.length === 0,
      violations: allViolations,
    };
  }
}
