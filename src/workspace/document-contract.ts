import { createHash } from "crypto";

export class WorkspaceError extends Error {
  constructor(
    public code: string,
    public status = 409,
  ) {
    super(code);
  }
}
export interface Named {
  id: string;
  description: string;
}
export interface Question {
  id: string;
  question: string;
  blocking: boolean;
}
export interface MainDocument {
  schemaVersion: 1;
  brief: string;
  purpose: string;
  requirements: {
    id: string;
    description: string;
    acceptanceCriteria: Named[];
  }[];
  features: Named[];
  journeys: Named[];
  constraints: string[];
  exclusions: string[];
  questions: Question[];
  decisions: Named[];
  legacySources: string[];
}
export interface Unit {
  id: string;
  title: string;
  requirementIds: string[];
  dependsOn: string[];
  repositoryId: string;
  files: { path: string; action: "create" | "modify" | "delete" }[];
  checks: {
    id: string;
    criterionId: string;
    type: "contains" | "not_contains" | "json" | "absent";
    path: string;
    expected: string;
  }[];
  commands?: VerificationCommand[];
}
export interface VerificationCommand {
  id: string;
  criterionId: string;
  argv: string[];
  cwd: string;
  timeoutMs: number;
}
export function parseCommands(
  raw: unknown,
  criteria: Set<string>,
): VerificationCommand[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 4)
    throw new WorkspaceError("COMMAND_POLICY_INVALID", 422);
  const seen = new Set<string>();
  const executables = new Set([
    "node",
    "npm",
    "pnpm",
    "yarn",
    "python3",
    "pytest",
    "go",
    "cargo",
    "dotnet",
  ]);
  return raw.map((command: any) => {
    record(command, ["id", "criterionId", "argv", "cwd", "timeoutMs"]);
    if (
      typeof command.id !== "string" ||
      !/^CMD-[A-Z0-9-]+$/.test(command.id) ||
      seen.has(command.id) ||
      !criteria.has(command.criterionId) ||
      !Array.isArray(command.argv) ||
      command.argv.length < 1 ||
      command.argv.length > 32 ||
      !executables.has(command.argv[0]) ||
      command.argv.some(
        (a: unknown) =>
          typeof a !== "string" || a.length > 1000 || a.includes("\0"),
      ) ||
      typeof command.cwd !== "string" ||
      !Number.isInteger(command.timeoutMs) ||
      command.timeoutMs < 1000 ||
      command.timeoutMs > 30000
    )
      throw new WorkspaceError("COMMAND_POLICY_INVALID", 422);
    if (command.cwd !== ".") safePath(command.cwd);
    seen.add(command.id);
    return command;
  });
}
export interface ArchitectureDocument {
  schemaVersion: 1;
  sourceMain: { id: string; hash: string };
  overview: string;
  components: Named[];
  dataMigrations: string[];
  interfaces: string[];
  security: string[];
  operations: string[];
  repositories: { id: string; baseline: string }[];
  units: Unit[];
  questions: Question[];
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value !== null && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
export const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const fail = (): never => {
  throw new WorkspaceError("DOCUMENT_INVALID", 422);
};
function record(v: any, keys: string[], optional: string[] = []): any {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.keys(v).some((k) => !keys.includes(k) && !optional.includes(k)) ||
    keys.some((k) => !(k in v))
  )
    fail();
  return v;
}
function text(v: any): asserts v is string {
  if (typeof v !== "string" || !v.trim() || v.length > 100000) fail();
}
function array(v: any): asserts v is any[] {
  if (!Array.isArray(v) || v.length > 1000) fail();
}
function strings(v: any) {
  array(v);
  v.forEach(text);
}
function ids(v: any[], prefix?: string) {
  const seen = new Set<string>();
  for (const item of v) {
    text(item.id);
    if (
      !/^[A-Z][A-Z0-9-]*$/.test(item.id) ||
      (prefix && !item.id.startsWith(prefix)) ||
      seen.has(item.id)
    )
      fail();
    seen.add(item.id);
  }
}
function named(v: any) {
  array(v);
  ids(v);
  v.forEach((i: any) => {
    record(i, ["id", "description"]);
    text(i.description);
  });
}
function questions(v: any) {
  array(v);
  ids(v);
  v.forEach((i: any) => {
    record(i, ["id", "question", "blocking"]);
    text(i.question);
    if (typeof i.blocking !== "boolean") fail();
  });
}
export function safePath(v: unknown): string {
  if (
    typeof v !== "string" ||
    v.length > 300 ||
    !/^[a-zA-Z0-9_./-]+$/.test(v) ||
    v.startsWith("/") ||
    v
      .split("/")
      .some(
        (p) =>
          !p ||
          p === "." ||
          p === ".." ||
          p.endsWith(".") ||
          /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p) ||
          p.toLowerCase() === ".git" ||
          p.toLowerCase() === "node_modules" ||
          p.toLowerCase().startsWith(".env"),
      )
  )
    throw new WorkspaceError("SCOPE_PATH_INVALID", 422);
  return v;
}
export function parseMain(raw: unknown): MainDocument {
  const v = record(raw, [
    "schemaVersion",
    "brief",
    "purpose",
    "requirements",
    "features",
    "journeys",
    "constraints",
    "exclusions",
    "questions",
    "decisions",
    "legacySources",
  ]);
  if (v.schemaVersion !== 1) fail();
  text(v.brief);
  text(v.purpose);
  array(v.requirements);
  ids(v.requirements, "REQ-");
  if (!v.requirements.length) fail();
  const criteria: any[] = [];
  for (const r of v.requirements) {
    record(r, ["id", "description", "acceptanceCriteria"]);
    text(r.description);
    named(r.acceptanceCriteria);
    if (!r.acceptanceCriteria.length) fail();
    criteria.push(...r.acceptanceCriteria);
  }
  ids(criteria, "AC-");
  named(v.features);
  named(v.journeys);
  strings(v.constraints);
  strings(v.exclusions);
  questions(v.questions);
  named(v.decisions);
  strings(v.legacySources);
  if (Buffer.byteLength(canonical(v)) > 256000) fail();
  return JSON.parse(canonical(v));
}
export function parseArchitecture(
  raw: unknown,
  main: MainDocument,
): ArchitectureDocument {
  const v = record(raw, [
    "schemaVersion",
    "sourceMain",
    "overview",
    "components",
    "dataMigrations",
    "interfaces",
    "security",
    "operations",
    "repositories",
    "units",
    "questions",
  ]);
  if (v.schemaVersion !== 1) fail();
  record(v.sourceMain, ["id", "hash"]);
  text(v.sourceMain.id);
  if (!/^[a-f0-9]{64}$/.test(v.sourceMain.hash)) fail();
  text(v.overview);
  named(v.components);
  for (const key of ["dataMigrations", "interfaces", "security", "operations"])
    strings(v[key]);
  if (!v.components.length || !v.security.length || !v.operations.length)
    fail();
  array(v.repositories);
  const repos = new Set<string>();
  for (const r of v.repositories) {
    record(r, ["id", "baseline"]);
    text(r.id);
    if (repos.has(r.id) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r.baseline))
      fail();
    repos.add(r.id);
  }
  array(v.units);
  ids(v.units, "UNIT-");
  const requirements = new Set(main.requirements.map((r) => r.id));
  const units = new Set(v.units.map((u: any) => u.id));
  const checkIds = new Set<string>();
  for (const u of v.units) {
    record(
      u,
      [
        "id",
        "title",
        "requirementIds",
        "dependsOn",
        "repositoryId",
        "files",
        "checks",
      ],
      ["commands"],
    );
    text(u.title);
    strings(u.requirementIds);
    strings(u.dependsOn);
    if (
      !u.requirementIds.length ||
      new Set(u.requirementIds).size !== u.requirementIds.length ||
      u.requirementIds.some((id: string) => !requirements.has(id)) ||
      u.dependsOn.some((id: string) => !units.has(id) || id === u.id) ||
      !repos.has(u.repositoryId)
    )
      fail();
    array(u.files);
    const paths = new Set<string>();
    if (!u.files.length) fail();
    for (const f of u.files) {
      record(f, ["path", "action"]);
      safePath(f.path);
      if (
        paths.has(f.path.toLowerCase()) ||
        !["create", "modify", "delete"].includes(f.action)
      )
        fail();
      paths.add(f.path.toLowerCase());
    }
    array(u.checks);
    const criteria = new Set(
      main.requirements
        .filter((r) => u.requirementIds.includes(r.id))
        .flatMap((r) => r.acceptanceCriteria.map((a) => a.id)),
    );
    parseCommands(u.commands, criteria);
    if (!u.checks.length) fail();
    for (const c of u.checks) {
      record(c, ["id", "criterionId", "type", "path", "expected"]);
      text(c.id);
      safePath(c.path);
      if (
        !criteria.has(c.criterionId) ||
        !["contains", "not_contains", "json", "absent"].includes(c.type) ||
        checkIds.has(c.id) ||
        typeof c.expected !== "string" ||
        (!["json", "absent"].includes(c.type) && !c.expected)
      )
        fail();
      checkIds.add(c.id);
    }
    if (
      [...criteria].some(
        (id) => !u.checks.some((c: any) => c.criterionId === id),
      )
    )
      fail();
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) fail();
    if (done.has(id)) return;
    visiting.add(id);
    v.units.find((u: any) => u.id === id).dependsOn.forEach(visit);
    visiting.delete(id);
    done.add(id);
  };
  v.units.forEach((u: any) => visit(u.id));
  questions(v.questions);
  if (Buffer.byteLength(canonical(v)) > 256000) fail();
  return JSON.parse(canonical(v));
}
export function changedRequirements(
  before: MainDocument,
  after: MainDocument,
): string[] {
  const global = (m: MainDocument) => ({
    purpose: m.purpose,
    features: m.features,
    journeys: m.journeys,
    constraints: m.constraints,
    exclusions: m.exclusions,
    decisions: m.decisions,
    questions: m.questions,
  });
  const all = [
    ...new Set(
      [...before.requirements, ...after.requirements].map((r) => r.id),
    ),
  ];
  if (hash(global(before)) !== hash(global(after))) return all;
  return all.filter(
    (id) =>
      hash(before.requirements.find((r) => r.id === id) ?? null) !==
      hash(after.requirements.find((r) => r.id === id) ?? null),
  );
}
export function affectedUnits(
  architecture: ArchitectureDocument,
  changed: string[],
): string[] {
  const affected = new Set(
    architecture.units
      .filter((u) => u.requirementIds.some((id) => changed.includes(id)))
      .map((u) => u.id),
  );
  let size;
  do {
    size = affected.size;
    architecture.units
      .filter((u) => u.dependsOn.some((id) => affected.has(id)))
      .forEach((u) => affected.add(u.id));
  } while (size !== affected.size);
  return [...affected];
}
export function mainFromBrief(brief: string): MainDocument {
  text(brief);
  return {
    schemaVersion: 1,
    brief,
    purpose: brief,
    requirements: [
      {
        id: "REQ-001",
        description: brief,
        acceptanceCriteria: [
          {
            id: "AC-001",
            description:
              "Replace this draft criterion with an observable outcome.",
          },
        ],
      },
    ],
    features: [],
    journeys: [],
    constraints: [],
    exclusions: [],
    questions: [
      {
        id: "Q-001",
        question:
          "Review the requirements and acceptance criteria before approving Architecture.",
        blocking: true,
      },
    ],
    decisions: [],
    legacySources: [],
  };
}

export function requireDocumentAuthority(): void {
  throw new WorkspaceError("DOCUMENT_AUTHORITY_REQUIRED");
}

// V1 only stores/parses this purpose. The baseline lifecycle is not executable.
export type WorkspacePurpose = "IMPLEMENTATION" | "BASELINE_VALIDATION";
export function parseWorkspacePurpose(raw: unknown): WorkspacePurpose {
  if (raw === undefined) return "IMPLEMENTATION";
  if (raw !== "IMPLEMENTATION" && raw !== "BASELINE_VALIDATION")
    throw new WorkspaceError("WORKSPACE_PURPOSE_INVALID", 422);
  return raw;
}
export function assertImplementationPurpose(raw: unknown): void {
  if (parseWorkspacePurpose(raw) !== "IMPLEMENTATION")
    throw new WorkspaceError("VALIDATION_LIFECYCLE_UNAVAILABLE", 409);
}
export interface ValidationBudget {
  hash: string;
  measurementHash: string;
  limits: {
    totalTimeoutMs: number;
    memoryMiB: number;
    workMiB: number;
    tmpMiB: number;
    stdoutBytes: number;
    stderrBytes: number;
  };
}
export interface ValidationProfile {
  id: string;
  title: string;
  requirementIds: string[];
  criterionIds: string[];
  repositoryId: string;
  baseline: string;
  runtimeProfileHash: string;
  budgetProfile: ValidationBudget;
  commands: VerificationCommand[];
}
export interface ValidationArchitectureDocument
  extends Omit<ArchitectureDocument, "schemaVersion"> {
  schemaVersion: 2;
  validationProfiles: ValidationProfile[];
}
function digest(v: unknown): asserts v is string {
  if (typeof v !== "string" || !/^[a-f0-9]{64}$/.test(v)) fail();
}
function uniqueStrings(v: unknown): asserts v is string[] {
  strings(v);
  if (
    !(v as string[]).length ||
    new Set(v as string[]).size !== (v as string[]).length
  )
    fail();
}
export function parseValidationArchitecture(
  raw: unknown,
  main: MainDocument,
): ValidationArchitectureDocument {
  const v = record(raw, [
    "schemaVersion",
    "sourceMain",
    "overview",
    "components",
    "dataMigrations",
    "interfaces",
    "security",
    "operations",
    "repositories",
    "units",
    "questions",
    "validationProfiles",
  ]);
  if (v.schemaVersion !== 2) fail();
  // Reuse schema1 validation without changing its parser or canonical bytes.
  const { validationProfiles, ...base } = v;
  const common = parseArchitecture({ ...base, schemaVersion: 1 }, main);
  array(validationProfiles);
  ids(validationProfiles, "VAL-");
  if (!validationProfiles.length) fail();
  const profiles = validationProfiles.map((profile: any): ValidationProfile => {
    record(profile, [
      "id",
      "title",
      "requirementIds",
      "criterionIds",
      "repositoryId",
      "baseline",
      "runtimeProfileHash",
      "budgetProfile",
      "commands",
    ]);
    text(profile.title);
    uniqueStrings(profile.requirementIds);
    uniqueStrings(profile.criterionIds);
    const requirements = main.requirements.filter((r) =>
      profile.requirementIds.includes(r.id),
    );
    if (requirements.length !== profile.requirementIds.length) fail();
    const criteria = new Set(
      requirements.flatMap((r) => r.acceptanceCriteria.map((c) => c.id)),
    );
    if (
      profile.criterionIds.some((id: string) => !criteria.has(id)) ||
      requirements.some(
        (r) =>
          !r.acceptanceCriteria.some((c) =>
            profile.criterionIds.includes(c.id),
          ),
      )
    )
      fail();
    const repo = common.repositories.find((r) => r.id === profile.repositoryId);
    if (!repo || repo.baseline !== profile.baseline) fail();
    digest(profile.runtimeProfileHash);
    const budget = record(profile.budgetProfile, [
      "hash",
      "measurementHash",
      "limits",
    ]);
    digest(budget.hash);
    digest(budget.measurementHash);
    const limits = record(budget.limits, [
      "totalTimeoutMs",
      "memoryMiB",
      "workMiB",
      "tmpMiB",
      "stdoutBytes",
      "stderrBytes",
    ]);
    const maxima = {
      totalTimeoutMs: 120000,
      memoryMiB: 512,
      workMiB: 256,
      tmpMiB: 64,
      stdoutBytes: 65536,
      stderrBytes: 65536,
    };
    for (const [key, maximum] of Object.entries(maxima))
      if (
        !Number.isInteger(limits[key]) ||
        limits[key] < 1 ||
        limits[key] > maximum
      )
        fail();
    if (
      budget.hash !== hash({ measurementHash: budget.measurementHash, limits })
    )
      fail();
    const commands = parseCommands(
      profile.commands,
      new Set<string>(profile.criterionIds),
    );
    if (
      !commands.length ||
      profile.criterionIds.some(
        (id: string) => !commands.some((c) => c.criterionId === id),
      ) ||
      commands.reduce((n, c) => n + c.timeoutMs, 0) > limits.totalTimeoutMs
    )
      fail();
    return { ...profile, commands };
  });
  const parsed = {
    ...common,
    schemaVersion: 2 as const,
    validationProfiles: profiles,
  };
  if (Buffer.byteLength(canonical(parsed)) > 256000) fail();
  return JSON.parse(canonical(parsed));
}
export function parseArchitectureDraft(
  raw: unknown,
  main: MainDocument,
): ArchitectureDocument | ValidationArchitectureDocument {
  return (raw as any)?.schemaVersion === 2
    ? parseValidationArchitecture(raw, main)
    : parseArchitecture(raw, main);
}
export interface ExactDocument<T> {
  id: string;
  contentHash: string;
  content: T;
}
export interface BaselineValidationBinding {
  purpose: "BASELINE_VALIDATION";
  main: { id: string; hash: string };
  architecture: { id: string; hash: string };
  selectedProfileIds: string[];
  profiles: ValidationProfile[];
}
// Pure binding construction, never an approval or executable run. Runtime and
// measurement digests identify evidence; the future lifecycle must verify it.
export function bindBaselineValidation(
  main: ExactDocument<unknown>,
  architecture: ExactDocument<unknown>,
  selectedProfileIds: string[],
): BaselineValidationBinding {
  text(main.id);
  text(architecture.id);
  digest(main.contentHash);
  digest(architecture.contentHash);
  const m = parseMain(main.content),
    a = parseValidationArchitecture(architecture.content, m);
  if (main.contentHash !== hash(m) || architecture.contentHash !== hash(a))
    throw new WorkspaceError("DOCUMENT_HASH_MISMATCH");
  if (a.sourceMain.id !== main.id || a.sourceMain.hash !== main.contentHash)
    throw new WorkspaceError("MAIN_VERSION_MISMATCH");
  if ([...m.questions, ...a.questions].some((q) => q.blocking))
    throw new WorkspaceError("BLOCKING_QUESTIONS");
  uniqueStrings(selectedProfileIds);
  const profiles = selectedProfileIds.map((id) =>
    a.validationProfiles.find((p) => p.id === id),
  );
  if (profiles.some((p) => !p)) fail();
  const selected = profiles as ValidationProfile[];
  const commands = selected.flatMap((p) => p.commands);
  if (
    commands.length > 8 ||
    commands.reduce((n, c) => n + c.timeoutMs, 0) > 120000
  )
    throw new WorkspaceError("COMMAND_BUDGET_EXCEEDED", 422);
  return JSON.parse(
    canonical({
      purpose: "BASELINE_VALIDATION",
      main: { id: main.id, hash: main.contentHash },
      architecture: { id: architecture.id, hash: architecture.contentHash },
      selectedProfileIds,
      profiles: selected,
    }),
  );
}
