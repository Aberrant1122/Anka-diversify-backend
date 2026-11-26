import {
  mainFromBrief,
  parseMain,
  parseArchitecture,
  parseArchitectureDraft,
  parseValidationArchitecture,
  bindBaselineValidation,
  hash,
  parseWorkspacePurpose,
  assertImplementationPurpose,
} from "../document-contract";
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));
function fixture() {
  const main = mainFromBrief("Baseline validation");
  main.questions = [];
  main.requirements.push({
    id: "REQ-002",
    description: "Unassessed separate work",
    acceptanceCriteria: [{ id: "AC-002", description: "Separate criterion" }],
  });
  const architecture: any = {
    schemaVersion: 1,
    sourceMain: { id: "main-1", hash: hash(main) },
    overview: "Baseline inspection",
    components: [{ id: "COMP-ONE", description: "Read only" }],
    dataMigrations: [],
    interfaces: [],
    security: ["No network"],
    operations: ["No publication"],
    repositories: [{ id: "repo", baseline: "a".repeat(40) }],
    units: [],
    questions: [],
  };
  const limits = {
    totalTimeoutMs: 30000,
    memoryMiB: 512,
    workMiB: 256,
    tmpMiB: 64,
    stdoutBytes: 65536,
    stderrBytes: 65536,
  };
  const budget = { measurementHash: "b".repeat(64), limits };
  const v2 = {
    ...architecture,
    schemaVersion: 2,
    validationProfiles: [
      {
        id: "VAL-ONE",
        title: "One criterion only",
        requirementIds: ["REQ-001"],
        criterionIds: ["AC-001"],
        repositoryId: "repo",
        baseline: "a".repeat(40),
        runtimeProfileHash: "c".repeat(64),
        budgetProfile: { ...budget, hash: hash(budget) },
        commands: [
          {
            id: "CMD-ONE",
            criterionId: "AC-001",
            argv: ["node", "--test", "tests/scope.test.js"],
            cwd: ".",
            timeoutMs: 30000,
          },
        ],
      },
    ],
  };
  return { main, architecture, v2 };
}
function bind(f = fixture(), ids = ["VAL-ONE"]) {
  return bindBaselineValidation(
    { id: "main-1", contentHash: hash(f.main), content: f.main },
    { id: "arch-2", contentHash: hash(f.v2), content: f.v2 },
    ids,
  );
}
describe("V1 baseline-validation draft contract", () => {
  it("preserves schema1 documents, bytes and hash without adding optional fields", () => {
    const f = fixture();
    expect(parseMain(f.main)).toEqual(f.main);
    expect(parseArchitectureDraft(f.architecture, f.main)).toEqual(
      parseArchitecture(f.architecture, f.main),
    );
    expect(hash(parseMain(f.main))).toBe(
      "17941d5a2f54a6ef9df8c80366e7ddb91228d0d1b59f09ae468bf962638ec4d7",
    );
    expect(hash(parseArchitecture(f.architecture, f.main))).toBe(
      "7068e1aee1348e87253624491c672a3bb0721039899b460de34a0feb27df0b23",
    );
    expect(parseArchitecture(f.architecture, f.main)).not.toHaveProperty(
      "validationProfiles",
    );
  });
  it("parses schema2 explicitly while the schema1-only parser rejects it", () => {
    const f = fixture();
    expect(parseArchitectureDraft(f.v2, f.main)).toEqual(f.v2);
    expect(() => parseArchitecture(f.v2, f.main)).toThrow("DOCUMENT_INVALID");
  });
  it("binds exact documents, selected criteria, baseline, commands, runtime and budget without approving or mutating input", () => {
    const f = fixture(),
      before = clone(f);
    const b = bind(f);
    expect(f).toEqual(before);
    expect(b.purpose).toBe("BASELINE_VALIDATION");
    expect(b.main).toEqual({ id: "main-1", hash: hash(f.main) });
    expect(b.architecture).toEqual({ id: "arch-2", hash: hash(f.v2) });
    expect(b.profiles).toEqual(f.v2.validationProfiles);
    expect(b.profiles[0].criterionIds).toEqual(["AC-001"]);
    expect(b).not.toHaveProperty("approvalId");
    expect(b).not.toHaveProperty("changeHash");
  });
  const invalid: [string, (a: any) => void][] = [
    ["unknown schema", (a) => (a.schemaVersion = 3)],
    ["unknown field", (a) => (a.publication = true)],
    ["missing profiles", (a) => delete a.validationProfiles],
    ["empty profiles", (a) => (a.validationProfiles = [])],
    [
      "duplicate profile",
      (a) => a.validationProfiles.push(clone(a.validationProfiles[0])),
    ],
    ["mutation files", (a) => (a.validationProfiles[0].files = [])],
    ["code proposal", (a) => (a.validationProfiles[0].changes = [])],
    ["publication field", (a) => (a.validationProfiles[0].publication = {})],
    ["missing baseline", (a) => delete a.validationProfiles[0].baseline],
    [
      "wrong baseline",
      (a) => (a.validationProfiles[0].baseline = "d".repeat(40)),
    ],
    [
      "unknown repository",
      (a) => (a.validationProfiles[0].repositoryId = "other"),
    ],
    [
      "missing runtime digest",
      (a) => delete a.validationProfiles[0].runtimeProfileHash,
    ],
    [
      "bad runtime digest",
      (a) => (a.validationProfiles[0].runtimeProfileHash = "image:latest"),
    ],
    [
      "missing measurement",
      (a) => delete a.validationProfiles[0].budgetProfile.measurementHash,
    ],
    [
      "budget tamper",
      (a) => (a.validationProfiles[0].budgetProfile.limits.memoryMiB = 256),
    ],
    [
      "budget unknown field",
      (a) => (a.validationProfiles[0].budgetProfile.network = true),
    ],
    [
      "unknown requirement",
      (a) => (a.validationProfiles[0].requirementIds = ["REQ-NO"]),
    ],
    [
      "duplicate criteria",
      (a) => a.validationProfiles[0].criterionIds.push("AC-001"),
    ],
    [
      "foreign criterion",
      (a) => (a.validationProfiles[0].criterionIds = ["AC-002"]),
    ],
    [
      "uncovered requirement",
      (a) => a.validationProfiles[0].requirementIds.push("REQ-002"),
    ],
    [
      "uncovered criterion",
      (a) => {
        a.validationProfiles[0].requirementIds.push("REQ-002");
        a.validationProfiles[0].criterionIds.push("AC-002");
      },
    ],
    ["empty commands", (a) => (a.validationProfiles[0].commands = [])],
    [
      "caller environment",
      (a) => (a.validationProfiles[0].commands[0].env = {}),
    ],
    [
      "shell command",
      (a) =>
        (a.validationProfiles[0].commands[0].argv = ["sh", "-c", "echo bad"]),
    ],
    [
      "cwd escape",
      (a) => (a.validationProfiles[0].commands[0].cwd = "../outside"),
    ],
    [
      "timeout oversize",
      (a) => (a.validationProfiles[0].commands[0].timeoutMs = 30001),
    ],
    [
      "deno not admitted by V1",
      (a) => (a.validationProfiles[0].commands[0].argv = ["deno", "test"]),
    ],
  ];
  it.each(invalid)("rejects %s", (_name, mutate) => {
    const f = fixture();
    mutate(f.v2);
    expect(() => parseValidationArchitecture(f.v2, f.main)).toThrow();
  });
  it.each([
    "memoryMiB",
    "totalTimeoutMs",
    "workMiB",
    "tmpMiB",
    "stdoutBytes",
    "stderrBytes",
  ])("rejects out-of-policy budget %s even with recomputed digest", (key) => {
    const f = fixture();
    (f.v2.validationProfiles[0].budgetProfile.limits as any)[key] = 999999;
    const { hash: _, ...rest } = f.v2.validationProfiles[0].budgetProfile;
    f.v2.validationProfiles[0].budgetProfile.hash = hash(rest);
    expect(() => parseValidationArchitecture(f.v2, f.main)).toThrow();
  });
  it.each(["main", "architecture"] as const)(
    "rejects blocking %s questions at exact binding",
    (where) => {
      const f = fixture();
      (where === "main" ? f.main : f.v2).questions.push({
        id: "Q-BLOCK",
        question: "Unresolved",
        blocking: true,
      });
      f.v2.sourceMain.hash = hash(f.main);
      expect(() => bind(f)).toThrow("BLOCKING_QUESTIONS");
    },
  );
  it("rejects a wrong source Main ID/hash", () => {
    const f = fixture();
    f.v2.sourceMain.id = "other";
    expect(() => bind(f)).toThrow("MAIN_VERSION_MISMATCH");
  });
  it("rejects a document hash mismatch", () => {
    const f = fixture();
    expect(() =>
      bindBaselineValidation(
        { id: "main-1", contentHash: "e".repeat(64), content: f.main },
        { id: "arch-2", contentHash: hash(f.v2), content: f.v2 },
        ["VAL-ONE"],
      ),
    ).toThrow("DOCUMENT_HASH_MISMATCH");
  });
  it.each([[], ["VAL-ONE", "VAL-ONE"], ["VAL-NO"]].map((ids) => [ids]))(
    "rejects missing/duplicate/unmapped selection %j",
    (ids) => expect(() => bind(fixture(), ids)).toThrow(),
  );
  it("rejects aggregate command time budget across individually valid profiles", () => {
    const f = fixture();
    for (let i = 2; i <= 5; i++)
      f.v2.validationProfiles.push({
        ...clone(f.v2.validationProfiles[0]),
        id: "VAL-" + i,
      });
    expect(() =>
      bind(
        f,
        f.v2.validationProfiles.map((p: any) => p.id),
      ),
    ).toThrow("COMMAND_BUDGET_EXCEEDED");
  });
  it("rejects aggregate command count independently of time budget", () => {
    const f = fixture();
    f.v2.validationProfiles[0].commands[0].timeoutMs = 1000;
    for (let i = 2; i <= 9; i++)
      f.v2.validationProfiles.push({
        ...clone(f.v2.validationProfiles[0]),
        id: "VAL-" + i,
      });
    expect(() =>
      bind(
        f,
        f.v2.validationProfiles.map((p: any) => p.id),
      ),
    ).toThrow("COMMAND_BUDGET_EXCEEDED");
  });
  it("defaults only legacy absent purpose to implementation", () => {
    expect(parseWorkspacePurpose(undefined)).toBe("IMPLEMENTATION");
    expect(parseWorkspacePurpose("IMPLEMENTATION")).toBe("IMPLEMENTATION");
    expect(parseWorkspacePurpose("BASELINE_VALIDATION")).toBe(
      "BASELINE_VALIDATION",
    );
    expect(() => assertImplementationPurpose("BASELINE_VALIDATION")).toThrow(
      "VALIDATION_LIFECYCLE_UNAVAILABLE",
    );
  });
  it.each([null, "", "baseline_validation", "PUBLISH", {}, true])(
    "rejects unknown purpose %j",
    (p) =>
      expect(() => parseWorkspacePurpose(p)).toThrow(
        "WORKSPACE_PURPOSE_INVALID",
      ),
  );
});
