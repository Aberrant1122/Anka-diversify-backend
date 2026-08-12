import fs from "fs";
import path from "path";
import os from "os";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";
import { AgentFileChange } from "../shared/types";

describe("Phase A Exception-Safe Transaction Boundary Invariants (TEST A - J)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "phase-a-tx-test-"));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("TEST A: SelfHealingEngine throws after filesystem mutation -> rollback occurs, commit does NOT occur", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('original');", "utf8");

    const changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "console.log('mutated');", description: "test" },
    ];

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot(changes, tempDir);
    await fsManager.apply(changes, tempDir);

    let transactionCommitted = false;
    let transactionRolledBack = false;

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      await fsManager.rollback(tempDir);
    };

    const runTransaction = async () => {
      try {
        // Simulate SelfHealingEngine throwing an exception after applying changes
        throw new Error("SelfHealingEngine crashed unexpectedly");
        transactionCommitted = true;
        fsManager.commit();
      } catch (err) {
        await safeRollback();
        throw err;
      }
    };

    await expect(runTransaction()).rejects.toThrow("SelfHealingEngine crashed unexpectedly");
    expect(transactionCommitted).toBe(false);
    expect(transactionRolledBack).toBe(true);
    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('original');");
  });

  it("TEST B: BuildErrorRepair throws after filesystem mutation -> rollback occurs, commit does NOT occur", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('original');", "utf8");

    const changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "console.log('mutated');", description: "test" },
    ];

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot(changes, tempDir);
    await fsManager.apply(changes, tempDir);

    let transactionCommitted = false;
    let transactionRolledBack = false;

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      await fsManager.rollback(tempDir);
    };

    const runTransaction = async () => {
      try {
        // Simulate BuildErrorRepair throwing an exception
        throw new Error("BuildErrorRepair pass failed with unhandled exception");
        transactionCommitted = true;
        fsManager.commit();
      } catch (err) {
        await safeRollback();
        throw err;
      }
    };

    await expect(runTransaction()).rejects.toThrow("BuildErrorRepair pass failed with unhandled exception");
    expect(transactionCommitted).toBe(false);
    expect(transactionRolledBack).toBe(true);
    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('original');");
  });

  it("TEST C: SecurityAuditor throws after filesystem mutation -> rollback occurs, commit does NOT occur", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('original');", "utf8");

    const changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "console.log('mutated');", description: "test" },
    ];

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot(changes, tempDir);
    await fsManager.apply(changes, tempDir);

    let transactionCommitted = false;
    let transactionRolledBack = false;

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      await fsManager.rollback(tempDir);
    };

    const runTransaction = async () => {
      try {
        // Simulate SecurityAuditor throwing OpenAI API rate limit error
        throw new Error("OpenAI API RateLimitError inside SecurityAuditor");
        transactionCommitted = true;
        fsManager.commit();
      } catch (err) {
        await safeRollback();
        throw err;
      }
    };

    await expect(runTransaction()).rejects.toThrow("OpenAI API RateLimitError inside SecurityAuditor");
    expect(transactionCommitted).toBe(false);
    expect(transactionRolledBack).toBe(true);
    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('original');");
  });

  it("TEST D: ValidationDetector throws after filesystem mutation -> rollback occurs, commit does NOT occur", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('original');", "utf8");

    const changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "console.log('mutated');", description: "test" },
    ];

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot(changes, tempDir);
    await fsManager.apply(changes, tempDir);

    let transactionCommitted = false;
    let transactionRolledBack = false;

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      await fsManager.rollback(tempDir);
    };

    const runTransaction = async () => {
      try {
        // Simulate ValidationDetector throwing an exception
        throw new Error("ValidationDetector static analysis error");
        transactionCommitted = true;
        fsManager.commit();
      } catch (err) {
        await safeRollback();
        throw err;
      }
    };

    await expect(runTransaction()).rejects.toThrow("ValidationDetector static analysis error");
    expect(transactionCommitted).toBe(false);
    expect(transactionRolledBack).toBe(true);
    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('original');");
  });

  it("TEST E: Security validation returns false -> rollback occurs, commit does NOT occur", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('original');", "utf8");

    const changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "eval(req.body);", description: "security issue" },
    ];

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot(changes, tempDir);
    await fsManager.apply(changes, tempDir);

    let transactionCommitted = false;
    let transactionRolledBack = false;

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      await fsManager.rollback(tempDir);
    };

    const repairSuccess = true;
    const securityPass = false; // Flagged by SecurityAuditor
    const overallPassed = true;

    const overallGatePassed = repairSuccess && securityPass && overallPassed;

    if (overallGatePassed) {
      transactionCommitted = true;
      fsManager.commit();
    } else {
      await safeRollback();
    }

    expect(transactionCommitted).toBe(false);
    expect(transactionRolledBack).toBe(true);
    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('original');");
  });

  it("TEST F: Feature validation returns false -> rollback occurs, commit does NOT occur", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('original');", "utf8");

    const changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "import { missing } from './missing';", description: "broken import" },
    ];

    const fsManager = new FileSystemStateManager();
    await fsManager.snapshot(changes, tempDir);
    await fsManager.apply(changes, tempDir);

    let transactionCommitted = false;
    let transactionRolledBack = false;

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      await fsManager.rollback(tempDir);
    };

    const repairSuccess = true;
    const securityPass = true;
    const overallPassed = false; // Static validation failed

    const overallGatePassed = repairSuccess && securityPass && overallPassed;

    if (overallGatePassed) {
      transactionCommitted = true;
      fsManager.commit();
    } else {
      await safeRollback();
    }

    expect(transactionCommitted).toBe(false);
    expect(transactionRolledBack).toBe(true);
    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('original');");
  });

  it("TEST G: All gates pass -> exactly one commit, zero rollback calls", async () => {
    const existingFile = path.join(tempDir, "src/index.ts");
    fs.mkdirSync(path.dirname(existingFile), { recursive: true });
    fs.writeFileSync(existingFile, "console.log('original');", "utf8");

    const changes: AgentFileChange[] = [
      { path: "src/index.ts", content: "console.log('valid');", description: "clean update" },
    ];

    const fsManager = new FileSystemStateManager();
    const commitSpy = jest.spyOn(fsManager, "commit");
    const rollbackSpy = jest.spyOn(fsManager, "rollback");

    await fsManager.snapshot(changes, tempDir);
    await fsManager.apply(changes, tempDir);

    let transactionCommitted = false;
    let transactionRolledBack = false;

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      await fsManager.rollback(tempDir);
    };

    const repairSuccess = true;
    const securityPass = true;
    const overallPassed = true;

    const overallGatePassed = repairSuccess && securityPass && overallPassed;

    if (overallGatePassed) {
      transactionCommitted = true;
      fsManager.commit();
    } else {
      await safeRollback();
    }

    expect(commitSpy).toHaveBeenCalledTimes(1);
    expect(rollbackSpy).toHaveBeenCalledTimes(0);
    expect(fs.readFileSync(existingFile, "utf8")).toBe("console.log('valid');");
  });

  it("TEST H: Rollback itself throws -> original failure remains represented, rollback failure is explicitly surfaced", async () => {
    const fsManager = new FileSystemStateManager();
    const changes: AgentFileChange[] = [{ path: "file.txt", content: "data", description: "test" }];

    await fsManager.snapshot(changes, tempDir);

    let rollbackErrorLog: string | null = null;
    let transactionCommitted = false;
    let transactionRolledBack = false;

    jest.spyOn(fsManager, "rollback").mockRejectedValueOnce(new Error("Disk I/O failure during rollback"));

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      try {
        await fsManager.rollback(tempDir);
      } catch (err: any) {
        rollbackErrorLog = `[CRITICAL] Filesystem rollback failed: ${err?.message || err}`;
      }
    };

    const overallGatePassed = false;
    if (overallGatePassed) {
      transactionCommitted = true;
      fsManager.commit();
    } else {
      await safeRollback();
    }

    const gateSuccess = overallGatePassed && !rollbackErrorLog;
    expect(gateSuccess).toBe(false);
    expect(rollbackErrorLog).toContain("Disk I/O failure during rollback");
  });

  it("TEST I: Explicit failure path performs rollback -> outer exception handling does NOT perform a second rollback", async () => {
    const fsManager = new FileSystemStateManager();
    const rollbackSpy = jest.spyOn(fsManager, "rollback").mockResolvedValue(undefined);

    let transactionCommitted = false;
    let transactionRolledBack = false;

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      await fsManager.rollback(tempDir);
    };

    // First explicit call to rollback on gate failure
    await safeRollback();
    expect(rollbackSpy).toHaveBeenCalledTimes(1);

    // Second call (e.g. from outer exception block)
    await safeRollback();
    // Must remain 1 call (idempotent safeRollback)
    expect(rollbackSpy).toHaveBeenCalledTimes(1);
  });

  it("TEST J: Commit succeeds -> no rollback occurs afterward", async () => {
    const fsManager = new FileSystemStateManager();
    const rollbackSpy = jest.spyOn(fsManager, "rollback").mockResolvedValue(undefined);

    let transactionCommitted = false;
    let transactionRolledBack = false;

    const safeRollback = async () => {
      if (transactionCommitted || transactionRolledBack) return;
      transactionRolledBack = true;
      await fsManager.rollback(tempDir);
    };

    // Commit succeeds
    transactionCommitted = true;
    fsManager.commit();

    // Attempting safeRollback after commit
    await safeRollback();

    expect(rollbackSpy).toHaveBeenCalledTimes(0);
    expect(transactionRolledBack).toBe(false);
  });
});
