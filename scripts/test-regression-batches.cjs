// Fresh bounded Jest processes avoid the full-run ts-jest/V8 heap accumulation.
// Run against a pinned checkout; native database suites are accounted separately.
const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync, execFileSync } = require("node:child_process");
const root = process.cwd();
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const label =
  process.argv.find((a) => a.startsWith("--label="))?.slice(8) ||
  head.slice(0, 12);
if (!/^[A-Za-z0-9_-]+$/.test(label)) throw new Error("Invalid result label");
const output = path.resolve(root, "../../outputs/regression-batches", label);
fs.mkdirSync(output, { recursive: true });
const env = {
  ...process.env,
  NODE_ENV: "test",
  DATABASE_URL:
    "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic?connect_timeout=1",
  ANKA_WORKSPACE_AI_ENABLED: "false",
  AWS_EC2_METADATA_DISABLED: "true",
};
for (const key of Object.keys(env))
  if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL|PRIVATE_KEY)/i.test(key))
    delete env[key];
env.JWT_SECRET = "synthetic-bounded-regression-key";
env.ENCRYPTION_KEY = "00000000000000000000000000000000";
delete env.NODE_OPTIONS;
const jest = path.join(root, "node_modules/jest/bin/jest.js");
const config = JSON.parse(fs.readFileSync("jest.config.json", "utf8"));
config.rootDir = root;
const configFile = path.join(output, "jest.config.json");
fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
const list = spawnSync(
  process.execPath,
  [jest, "--config", configFile, "--listTests", "--json", "--runInBand"],
  { env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
if (list.status) throw new Error(list.stderr);
const native =
  /\/(?:planning-(?:(?:requirements|documentation)-(?:readiness-|revision-|run-|artifact-|approval-)?lifecycle|architecture-(?:revision-)?lifecycle|initial-architecture-generation)|primary-repository-registration)\.test\.ts$/;
const all = JSON.parse(list.stdout)
  .map((p) => p.replaceAll("\\", "/"))
  .sort();
const match = process.argv.find((a) => a.startsWith("--match="))?.slice(8);
const files = all.filter(
  (f) => !native.test(f) && (!match || new RegExp(match).test(f)),
);
const excludedNative = all.filter((f) => native.test(f));
const summary = {
  head,
  root,
  mode: "fresh-process-batches",
  database: "synthetic closed endpoint; native suites run separately",
  excludedNative,
  selected: files.length,
  passed: 0,
  failed: 0,
  pending: 0,
  suitesPassed: 0,
  suitesFailed: 0,
  batches: [],
  failedFiles: [],
};
const save = () =>
  fs.writeFileSync(
    path.join(output, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
save();
for (let start = 0; start < files.length; start += 4) {
  const batch = files.slice(start, start + 4),
    id = String(start / 4 + 1).padStart(3, "0");
  const resultFile = path.join(output, id + ".json"),
    log = path.join(output, id + ".log");
  const fd = fs.openSync(log, "w");
  const result = spawnSync(
    process.execPath,
    [
      "--max-old-space-size=3072",
      "--experimental-vm-modules",
      jest,
      "--config",
      configFile,
      "--runInBand",
      "--runTestsByPath",
      ...batch,
      "--testTimeout=15000",
      "--forceExit",
      "--json",
      "--outputFile=" + resultFile,
    ],
    { env, stdio: ["ignore", fd, fd] },
  );
  fs.closeSync(fd);
  const entry = { id, files: batch, exitCode: result.status, resultFile, log };
  if (fs.existsSync(resultFile)) {
    const r = JSON.parse(fs.readFileSync(resultFile, "utf8"));
    entry.passed = r.numPassedTests;
    entry.failed = r.numFailedTests;
    entry.suitesPassed = r.numPassedTestSuites;
    entry.suitesFailed = r.numFailedTestSuites;
    summary.passed += r.numPassedTests;
    summary.failed += r.numFailedTests;
    summary.pending += r.numPendingTests;
    summary.suitesPassed += r.numPassedTestSuites;
    summary.suitesFailed += r.numFailedTestSuites;
    for (const test of r.testResults)
      if (test.status !== "passed")
        summary.failedFiles.push({
          file: test.name,
          status: test.status,
          assertions: test.assertionResults
            .filter((a) => a.status === "failed")
            .map((a) => ({ name: a.fullName, messages: a.failureMessages })),
          message: test.message,
        });
  } else {
    entry.processFailure = true;
    summary.suitesFailed += batch.length;
    summary.failedFiles.push(
      ...batch.map((file) => ({ file, status: "process_failure", log })),
    );
  }
  summary.batches.push(entry);
  save();
  console.log(
    JSON.stringify({
      batch: id,
      of: Math.ceil(files.length / 4),
      passed: entry.passed,
      failed: entry.failed,
      suitesFailed: entry.suitesFailed,
      exitCode: result.status,
    }),
  );
}
summary.completed = true;
save();
process.exitCode = summary.suitesFailed ? 1 : 0;
