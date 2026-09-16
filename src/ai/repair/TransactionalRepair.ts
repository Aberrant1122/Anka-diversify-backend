import { AgentFileChange, AgentProgressEvent, BaselineDiagnostic, RootBuildFailure } from "../../types";
import { MutationTransaction, ExecutionWorkspaceBinding } from "../runtime/MutationTransaction";
import { ValidationRunner } from "../validation/ValidationRunner";
import { DiagnosticNormalizer } from "../validation/DiagnosticNormalizer";
import { BaselineDiagnosticVerifier, DiagnosticValidationSnapshot } from "../runtime/BaselineDiagnosticVerifier";
import { LLMGateway } from "../gateway/LLMGateway";
import { LLMError } from "../gateway/LLMError";
import { PipelineStages } from "../gateway/PipelineStage";
import { fingerprintBytes } from "../editing/EditingPrimitives";
import { PublicContractGuard, DeterministicTs6133Repair, SurgicalPatchEngine, DiagnosticError } from "../../services/surgical-repair.engine";
import { MutationCompiler, MutationFailure, MutationOperation } from "../runtime/MutationCompiler";
import { SecurityPolicy } from "../security/SecurityPolicy";
import { resolveLocalImportEdges } from "../repository/DeterministicImportResolver";
import { normalizeRepoPath } from "../repository/SemanticContextResolver";

export interface TransactionalRepairResult {
  finalChanges: AgentFileChange[];
  success: boolean;
  attempts: number;
  errorType?: string;
  errorLog?: string;
  infrastructureError?: boolean;
  taskVerified?: boolean;
  repositoryClean?: boolean;
  repairApplied?: boolean;
  repaired?: boolean;
  modelRepairAttempts?: number;
  buildAttemptsCount?: number;
  repairTrigger?: "SHELL_VALIDATION_FAILURE" | "NONE";
  rootFailure?: RootBuildFailure;
  patchesAppliedCount?: number;
}

function schema(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["Expected an operations object."] };
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Array.isArray(record.operations)) return { valid: false, errors: ["Only operations is permitted; task, manifest, proof and workspace overrides are forbidden."] };
  try { return { valid: true, data: { operations: MutationCompiler.parse(record.operations) } }; }
  catch (error) {
    if (!(error instanceof MutationFailure)) throw error;
    return { valid: false, errors: [`${error.code}: ${error.message}`] };
  }
}

const IMPORT_EXPORT_DIAGNOSTIC = /(?:TS2305|TS2614|has no exported member|doesn['’]t exist in (?:the )?target module|not exported from|cannot import named export|attempted import error)/i;

export function attributeImportExportDiagnostics<T extends {
    category: string;
    filePath?: string;
    line?: number;
    column?: number;
    code?: string;
    message: string;
    rawTrace?: string;
  }>(input: {
  diagnostics: readonly T[];
  workspaceRoot: string;
  candidateChanges: readonly Pick<AgentFileChange, "path" | "action">[];
  capabilities: readonly { path: string; action: string }[];
}): T[] {
  const changed = new Set(input.candidateChanges
    .filter((change) => change.action === "modify" || change.action === "create" || change.action === undefined)
    .map((change) => normalizeRepoPath(change.path)));
  const authorized = new Set(input.capabilities
    .filter((grant) => grant.action === "FILE_MODIFY" || grant.action === "FILE_CREATE")
    .map((grant) => normalizeRepoPath(grant.path)));

  return input.diagnostics.map((diagnostic) => {
    if (!diagnostic.filePath || !IMPORT_EXPORT_DIAGNOSTIC.test(`${diagnostic.code ?? ""} ${diagnostic.message} ${diagnostic.rawTrace ?? ""}`)) {
      return diagnostic;
    }
    const trace = `${diagnostic.message}\n${diagnostic.rawTrace ?? ""}`.replace(/\\/g, "/");
    const candidates = resolveLocalImportEdges(input.workspaceRoot, diagnostic.filePath).filter((edge) => {
      const target = normalizeRepoPath(edge.targetFile);
      if (!changed.has(target) || !authorized.has(target)) return false;
      return trace.includes(edge.moduleSpecifier) || trace.includes(target) || trace.includes(target.replace(/\.[^.\/]+$/, ""));
    });
    if (candidates.length !== 1) return diagnostic;
    return {
      ...diagnostic,
      filePath: candidates[0].targetFile,
      message: `[CAUSED_BY_MODIFIED_EXPORTER:${candidates[0].targetFile}] ${diagnostic.message}`,
    } as T;
  });
}

function isCommandEnvelopeBlock(block: string, commands: readonly string[]): boolean {
  const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return true;

  const isKnownFailureWrapper = (line: string) => commands.some((command) =>
    line.startsWith(`${command} failed (exit code `) || line === `Command failed: ${command}`,
  );
  const isPackageScriptHeader = (line: string) =>
    /^>\s+(?:@[^/\s]+\/)?[^@\s]+@\S+\s+\S+/.test(line);
  const isPackageScriptCommand = (line: string) => /^>\s+\S/.test(line);

  const hasEnvelopeAnchor = lines.some((line) => isKnownFailureWrapper(line) || isPackageScriptHeader(line));
  return hasEnvelopeAnchor && lines.every((line) =>
    isKnownFailureWrapper(line) || isPackageScriptHeader(line) || isPackageScriptCommand(line),
  );
}

/**
 * Extracts deterministic validation facts without promoting package-manager
 * command echoes to repair authority. Unknown output is retained unless a
 * typed diagnostic exists and the unknown block is provably only an execution
 * envelope. If no typed facts remain, BaselineDiagnosticVerifier still creates
 * a fail-closed UNKNOWN_FAILURE fact.
 */
export function normalizeTransactionalValidationDiagnostics(
  errorLog: string,
  commands: readonly string[],
) {
  const diagnostics = errorLog.split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block && block !== "Failed to compile.")
    .flatMap((block) => DiagnosticNormalizer.normalize(block));
  const hasTypedDiagnostic = diagnostics.some((diagnostic) => diagnostic.category !== "UNKNOWN_FAILURE");
  if (!hasTypedDiagnostic) return diagnostics;
  return diagnostics.filter((diagnostic) =>
    diagnostic.category !== "UNKNOWN_FAILURE" ||
    !isCommandEnvelopeBlock(diagnostic.rawTrace ?? diagnostic.message, commands),
  );
}

/** Fixed task/authority repair. Every failed candidate is disposable, including schema failures. */
export async function runTransactionalRepair(input: {
  transaction: MutationTransaction;
  initialChanges: readonly AgentFileChange[];
  originalTask: string;
  commands: readonly string[];
  onProgress?: (event: AgentProgressEvent) => void;
  targetedBaselineDiagnostics?: readonly BaselineDiagnostic[];
}): Promise<TransactionalRepairResult> {
  const transaction = input.transaction;
  const commands = Object.freeze([...input.commands]);
  const originalTask = input.originalTask;
  const targetedBaselinePaths = Object.freeze((input.targetedBaselineDiagnostics ?? []).map(d => d.filePath?.replace(/\\/g, "/").replace(/^\.\//, "") ?? null));
  let attempts = 0;
  let builds = 0;
  let promoted = false;
  let correctionFailures = 0;
  let neutralRepairs = 0;
  let promotedPatches = 0;
  let rootFailure: RootBuildFailure | undefined;
  const validationLogs = new WeakMap<DiagnosticValidationSnapshot, string>();
  const result = (success: boolean, errorType?: string, errorLog?: string): TransactionalRepairResult => ({
    finalChanges: transaction.changes, attempts, success, errorType,
    errorLog: errorLog && rootFailure ? `ROOT BUILD FAILURE:\n${rootFailure.stderr ?? ""}\n\nFINAL REPAIR STATE:\n${errorLog}` : errorLog,
    taskVerified: success, rootFailure, patchesAppliedCount: promotedPatches,
    repairApplied: promoted, repaired: promoted, modelRepairAttempts: attempts, buildAttemptsCount: builds,
    repairTrigger: attempts ? "SHELL_VALIDATION_FAILURE" : "NONE",
  });
  const validate = async (binding: ExecutionWorkspaceBinding, phase: "BASELINE" | "CURRENT"): Promise<DiagnosticValidationSnapshot> => {
    transaction.verify(binding);
    builds++;
    const validation = await ValidationRunner.validateWithShell([], binding.workspaceRoot, [...commands]);
    transaction.verify(binding);
    // Normalize separate tool diagnostic blocks independently. A source diagnostic
    // must not hide a second dependency/environment failure in the same log, while
    // package-manager command echoes must not become pathless repair diagnostics.
    const diagnostics = validation.success
      ? []
      : normalizeTransactionalValidationDiagnostics(validation.errors, commands);
    const snapshot = BaselineDiagnosticVerifier.capture({ phase, passed: validation.success, commands: [...commands], repositoryRoot: binding.workspaceRoot,
      source: "DETERMINISTIC_TOOL", diagnostics });
    validationLogs.set(snapshot, validation.errors);
    return snapshot;
  };
  try {
    if (!commands.length) return result(false, "REPAIR_UNRESOLVED", "No deterministic validation commands available.");
    const baseline = await validate(transaction.primary, "BASELINE");
    if (input.initialChanges.length) transaction.applyChanges(input.initialChanges);
    let current = await validate(transaction.primary, "CURRENT");
    const diagnosis = Object.freeze(current.diagnostics.map(d => Object.freeze({ ...d })));
    if (current.passed) return { ...result(true), repositoryClean: true };
    rootFailure = Object.freeze({ command: commands[0], exitCode: 1, stderr: validationLogs.get(current),
      errorType: diagnosis[0]?.category, filePath: diagnosis[0]?.filePath, line: diagnosis[0]?.line, column: diagnosis[0]?.column });
    let feedback = "";
    // A repair run is bounded independently from malformed-output corrections.
    // At most two corrections follow a failed proposal; successful progress can
    // continue up to the overall fifteen-attempt limit.
    const attemptedDeterministicSignatures = new Set<string>();
    for (let cycle = 0; cycle < 15; cycle++) {
      if (!current.diagnostics.length) return result(false, "REPAIR_UNRESOLVED", "Failed validation produced no diagnostic facts; absence of parsed errors is not proof of success.");
      const comparison = BaselineDiagnosticVerifier.compare(baseline, current);
      const introduced = attributeImportExportDiagnostics({
        diagnostics: comparison.currentOutcomes.filter(d => d.classification === "INTRODUCED").map(d => d.diagnostic),
        workspaceRoot: transaction.primary.workspaceRoot,
        candidateChanges: transaction.changes,
        capabilities: transaction.capabilities,
      });
      if (!introduced.length) {
        if (targetedBaselinePaths.includes(null) || current.diagnostics.some(d => d.filePath && targetedBaselinePaths.includes(d.filePath))) {
          return result(false, "REINVESTIGATION_REQUIRED", "The original targeted baseline failure remains; repair cannot redefine the task to ignore it.");
        }
        return { ...result(true), repositoryClean: false };
      }
      if (introduced.some(d => !d.filePath || !transaction.capabilities.some(g => g.path === d.filePath && (g.action === "FILE_MODIFY" || g.action === "FILE_CREATE")))) {
        return result(false, "REINVESTIGATION_REQUIRED", "Introduced failure requires fresh investigation outside the fixed repair scope.");
      }
      const snapshot = transaction.verify();
      const relevant = transaction.capabilities.filter(g => g.action === "FILE_MODIFY" || g.action === "FILE_CREATE").map(g => {
        const bytes = snapshot.files.get(g.path);
        return Object.freeze({ path: g.path, expectedFileHash: bytes === undefined ? null : fingerprintBytes(Buffer.from(bytes, "base64")),
          content: bytes === undefined ? null : Buffer.from(bytes, "base64").toString("utf8") });
      });
      // JSON serialization gives the model a value copy. No writable runtime objects are exposed.
      const context = Object.freeze({ originalTask, originalDiagnosis: diagnosis, capabilities: transaction.capabilities,
        authorityProofIds: transaction.authorityProofIds, transactionId: transaction.id, currentRevision: transaction.currentRevision,
        manifestVersion: transaction.manifestVersion, manifest: transaction.manifest, baselineValidation: baseline,
        currentValidation: current, introducedFailures: introduced, currentFiles: relevant, targetedBaselinePaths });
      let binding: ExecutionWorkspaceBinding | undefined;
      try {
        attempts++;
        input.onProgress?.({ step: 8, stageName: "SELF_HEALING", label: "Repair introduced validation failures",
          detail: `Validating a disposable repair candidate (attempt ${attempts}/15).`, badge: "STAGE 8 · REPAIR", progress: 87 });

        let operationsToApply: readonly MutationOperation[];
        let isDeterministic = false;

        // Workstream B: Deterministic TypeScript & Surgical Repair Migration
        let deterministicCandidate: MutationOperation[] | null = null;
        for (const diag of introduced) {
          if (!diag.filePath) continue;
          const normPath = diag.filePath.replace(/\\/g, "/").replace(/^\.\//, "");
          const fileItem = relevant.find(f => f.path === normPath || normPath.endsWith(f.path) || f.path.endsWith(normPath));
          if (!fileItem || !fileItem.content) continue;

          const diagError: DiagnosticError = {
            file: fileItem.path,
            line: diag.line ?? 1,
            column: diag.column,
            code: diag.code || diag.category,
            message: diag.message,
            symbolName: diag.message.match(/['"`]([A-Za-z0-9_$]+)['"`]/)?.[1],
            rawTrace: diag.message,
          };

          let patchEdit: { oldText: string; newText: string } | null = null;
          if (
            diag.code === "TS6133" ||
            diag.category === "TS6133" ||
            diag.message.includes("TS6133") ||
            /is declared but (?:its value is never read|never used)/i.test(diag.message)
          ) {
            patchEdit = DeterministicTs6133Repair.tryRepair({
              filePath: fileItem.path,
              fileContent: fileItem.content,
              diagnostic: diagError,
              userMessage: originalTask,
            });
          }

          if (!patchEdit) {
            const dupPatch = SurgicalPatchEngine.generateDuplicateExportPatch(fileItem.content, fileItem.path, diagError);
            if (dupPatch && dupPatch.targetContent !== dupPatch.replacementContent) {
              patchEdit = { oldText: dupPatch.targetContent, newText: dupPatch.replacementContent };
            }
          }

          if (patchEdit && patchEdit.oldText && patchEdit.oldText !== patchEdit.newText) {
            const sig = `${fileItem.path}:${patchEdit.oldText}:${patchEdit.newText}`;
            if (!attemptedDeterministicSignatures.has(sig)) {
              attemptedDeterministicSignatures.add(sig);
              deterministicCandidate = [
                {
                  op: "replace_exact",
                  path: fileItem.path,
                  oldText: patchEdit.oldText,
                  newText: patchEdit.newText,
                  expectedFileHash: fileItem.expectedFileHash,
                },
              ];
              break;
            }
          }
        }

        if (deterministicCandidate) {
          operationsToApply = deterministicCandidate;
          isDeterministic = true;
        } else {
          const response = await LLMGateway.getInstance().callStructured<{ operations: unknown }>({
            stage: PipelineStages.REPAIR,
            messages: [
              { role: "system", content: "Repair only newly introduced failures within the supplied immutable task, diagnosis, capability and manifest. Return only {operations:[...]}. Each operation has op, path, expectedFileHash. Use replace_exact with nonempty oldText/newText; insert_before or insert_after with nonempty anchor/content; create_file with content and null expectedFileHash; delete_file with expectedFileHash. Actions must be explicitly authorized. Never supply generic modify, receipts, workspace roots, manifest updates or task/proof changes. Copy current file hashes and exact text from context. Do not reinterpret the task or change unrelated behavior." },
              { role: "user", content: JSON.stringify(context) + (feedback ? `\nStructured correction required: ${feedback}` : "") },
            ],
            temperature: 0.1, maxTokens: 8000,
            schema: { name: "TransactionalRepairMutationIR", strict: false,
              schema: { type: "object", additionalProperties: false, required: ["operations"], properties: { operations: { type: "array", minItems: 1, maxItems: 100, items: { type: "object" } } } }, validate: schema },
          });
          // Revalidate even deterministic fake model responses; the gateway is not authority.
          const checked = schema(response.content);
          if (!checked.valid || !checked.data) throw new MutationFailure("REPAIR_SCHEMA_INVALID", checked.errors?.join("; ") || "Invalid repair response.");
          operationsToApply = checked.data.operations;
        }

        transaction.verify();
        binding = transaction.createRepairWorkspace();
        for (const operation of operationsToApply) {
          transaction.authorize(binding, operation.path, operation.op === "create_file" ? "FILE_CREATE" : operation.op === "delete_file" ? "FILE_DELETE" : "FILE_MODIFY");
        }
        const compiled = MutationCompiler.compile(operationsToApply, snapshot.files);
        for (const mutation of compiled) {
          const before = mutation.before === null ? "" : Buffer.from(mutation.before, "base64").toString("utf8");
          const after = mutation.after === null ? "" : Buffer.from(mutation.after, "base64").toString("utf8");
          if (mutation.operation.op !== "create_file" && mutation.operation.op !== "delete_file"
            && !PublicContractGuard.validatePublicContract({ filePath: mutation.operation.path, baselineContent: before, proposedContent: after, userMessage: originalTask }).valid) {
            throw new MutationFailure("REINVESTIGATION_REQUIRED", "Repair would change a public contract outside the original diagnosis.");
          }
          if (!SecurityPolicy.checkChanges([{ path: mutation.operation.path, action: mutation.operation.op === "delete_file" ? "delete" : "modify", content: after, description: "repair" }], { [mutation.operation.path]: before }).safe) {
            throw new MutationFailure("REINVESTIGATION_REQUIRED", "Repair violates the existing deterministic security policy.");
          }
        }
        transaction.apply(operationsToApply, binding);
        let candidate: DiagnosticValidationSnapshot | undefined;
        const accepted = await transaction.validateAndPromote(binding, async () => {
          candidate = await validate(binding!, "CURRENT");
          if (candidate.passed) return true;
          if (!candidate.diagnostics.length) return false;
          // A multiset subset forbids trading one failure for a different failure,
          // even when the total diagnostic count happens to improve.
          const remaining = new Map<string, number>();
          current.diagnostics.forEach(d => remaining.set(d.identity, (remaining.get(d.identity) ?? 0) + 1));
          return candidate.diagnostics.every(d => {
            const count = remaining.get(d.identity) ?? 0;
            if (count > 0) {
              remaining.set(d.identity, count - 1);
              return true;
            }
            if (
              (d.code === "TS6133" || d.category === "TS6133" || /is declared but/i.test(d.message)) &&
              d.filePath &&
              transaction.capabilities.some(g => g.path === d.filePath && (g.action === "FILE_MODIFY" || g.action === "FILE_CREATE"))
            ) {
              return true;
            }
            return false;
          });
        });
        if (accepted && candidate) {
          promoted = true;
          promotedPatches += compiled.length;
          neutralRepairs = candidate.diagnostics.length < current.diagnostics.length ? 0 : neutralRepairs + 1;
          correctionFailures = 0;
          current = candidate;
          if (current.passed) return { ...result(true), repositoryClean: true };
          if (neutralRepairs >= 2) return result(false, "REPAIR_UNRESOLVED", "Two neutral repairs did not resolve introduced failures.");
          feedback = "Previous repair was neutral or better but introduced failures remain. Repair only those failures.";
        } else {
          if (!isDeterministic) correctionFailures++;
          feedback = "Previous repair worsened validation and was discarded. Primary revision is unchanged.";
        }
      } catch (error) {
        if (error instanceof MutationFailure) {
          if (["MUTATION_IR_INVALID", "REPAIR_SCHEMA_INVALID", "EDIT_ANCHOR_NOT_FOUND", "EDIT_ANCHOR_AMBIGUOUS", "FILE_HASH_MISMATCH"].includes(error.code)) { correctionFailures++; feedback = `${error.code}: ${error.message}`; }
          else return result(false, error.code, error.message);
        } else if (error instanceof LLMError && ["LLM_SCHEMA_INVALID", "LLM_INVALID_JSON", "LLM_TRUNCATED"].includes(error.code)) {
          correctionFailures++;
          feedback = `REPAIR_SCHEMA_INVALID: ${error.message}. Use canonical explicit operations and nonempty exact anchors.`;
        } else throw error;
      } finally {
        if (binding) transaction.discard(binding);
      }
      if (correctionFailures >= 3) return result(false, "REPAIR_UNRESOLVED", "Bounded repair corrections exhausted.");
    }
    return result(false, "REPAIR_UNRESOLVED", "Bounded repair corrections exhausted.");
  } catch (error) {
    if (error instanceof MutationFailure) return result(false, error.code, error.message);
    throw error;
  }
}
