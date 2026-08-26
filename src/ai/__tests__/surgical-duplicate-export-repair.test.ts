import fs from "fs";
import path from "path";
import os from "os";
import { SurgicalPatchEngine, ErrorDiagnosticsParser } from "../../services/surgical-repair.engine";
import { SelfHealingEngine } from "../repair/SelfHealingEngine";
import { ValidationRunner } from "../validation/ValidationRunner";
import { FileSystemStateManager } from "../validation/FileSystemStateManager";

describe("Deterministic TypeScript Duplicate-Export Surgical Repair (Steps A-H)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "anka-test-surgical-dup-export-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
    jest.restoreAllMocks();
  });

  test("A. export const Foo = ...; export { Foo }; -> removes redundant export declaration entirely", () => {
    const input = `import React from 'react';

export const CalculatorButton: React.FC<{ label: string }> = ({ label }) => (
  <button>{label}</button>
);

export default CalculatorButton;
export { CalculatorButton };
`;

    const diag = {
      file: "components/Calculator.tsx",
      line: 3,
      column: 14,
      code: "TS2440",
      message: "Cannot redeclare exported variable 'CalculatorButton'.",
      symbolName: "CalculatorButton",
      rawTrace: "Cannot redeclare exported variable 'CalculatorButton'.",
    };

    const patch = SurgicalPatchEngine.generateDuplicateExportPatch(input, "components/Calculator.tsx", diag);
    expect(patch).not.toBeNull();
    expect(patch?.replacementContent).toBe("");

    const res = SurgicalPatchEngine.applyPatch(input, patch!);
    expect(res.newContent).toContain("export const CalculatorButton");
    expect(res.newContent).toContain("export default CalculatorButton;");
    expect(res.newContent).not.toContain("export { CalculatorButton };");
  });

  test("B. export const Foo = ...; const Bar = ...; export { Foo, Bar }; -> preserves Bar and removes only Foo", () => {
    const input = `export const Foo = "foo";
const Bar = "bar";

export { Foo, Bar };
`;

    const diag = {
      file: "src/utils.ts",
      line: 1,
      column: 14,
      code: "TS2440",
      message: "Cannot redeclare exported variable 'Foo'.",
      symbolName: "Foo",
      rawTrace: "Cannot redeclare exported variable 'Foo'.",
    };

    const patch = SurgicalPatchEngine.generateDuplicateExportPatch(input, "src/utils.ts", diag);
    expect(patch).not.toBeNull();
    expect(patch?.replacementContent).toBe("export { Bar };");

    const res = SurgicalPatchEngine.applyPatch(input, patch!);
    expect(res.newContent).toContain('export const Foo = "foo";');
    expect(res.newContent).toContain('const Bar = "bar";');
    expect(res.newContent).toContain("export { Bar };");
    expect(res.newContent).not.toContain("export { Foo, Bar };");
  });

  test("C. const Foo = ...; export { Foo }; -> unchanged because export is required", () => {
    const input = `const Foo = "foo";
export { Foo };
`;

    const diag = {
      file: "src/utils.ts",
      line: 1,
      column: 7,
      code: "TS2300",
      message: "Duplicate identifier 'Foo'.",
      symbolName: "Foo",
      rawTrace: "Duplicate identifier 'Foo'.",
    };

    const patch = SurgicalPatchEngine.generateDuplicateExportPatch(input, "src/utils.ts", diag);
    expect(patch).toBeNull();

    const minPatch = SurgicalPatchEngine.generateMinimalPatch(input, "src/utils.ts", diag);
    // Returns default node target where replacementContent === targetContent (no destructive change)
    expect(minPatch.replacementContent).toBe(minPatch.targetContent);
  });

  test("D. export default Foo; export { Foo }; -> do not incorrectly remove unless direct named export is independently proven", () => {
    const input = `const Calculator = () => <div>Calc</div>;

export default Calculator;
export { Calculator };
`;

    const diag = {
      file: "components/Calculator.tsx",
      line: 1,
      column: 7,
      code: "TS2300",
      message: "Duplicate identifier 'Calculator'.",
      symbolName: "Calculator",
      rawTrace: "Duplicate identifier 'Calculator'.",
    };

    const patch = SurgicalPatchEngine.generateDuplicateExportPatch(input, "components/Calculator.tsx", diag);
    expect(patch).toBeNull();
  });

  test("E & F & G. SelfHealingEngine uses surgical duplicate export repair inside approved scope and rebuild advances to clean", async () => {
    const calcFile = "components/Calculator.tsx";
    const initialContent = `"use client";
import React, { useState } from 'react';

export const CalculatorButton: React.FC<{ label: string }> = ({ label }) => (
  <button>{label}</button>
);

export const CalculatorDisplay: React.FC<{ value: string }> = ({ value }) => (
  <div>{value}</div>
);

const Calculator: React.FC = () => {
  return <div><CalculatorDisplay value="0" /></div>;
};

export default Calculator;
export { CalculatorButton, CalculatorDisplay };
`;

    const fsManager = new FileSystemStateManager();
    const initialChanges = [
      {
        path: calcFile,
        content: initialContent,
        action: "modify" as const,
        description: "Calculator with use client",
      },
    ];

    const approvedManifest = {
      files: [{ path: calcFile, action: "modify" as const, reason: "Calculator" }],
    };

    const executionContract = {
      allowedFiles: [calcFile],
      immutableFiles: [],
      forbiddenPatterns: [],
    };

    let buildAttempts = 0;
    jest.spyOn(ValidationRunner, "validateWithShell").mockImplementation(async () => {
      buildAttempts++;
      if (buildAttempts === 1) {
        // First build fails with Next.js type error about duplicate CalculatorButton
        return {
          success: false,
          errors: `./components/Calculator.tsx:4:14\nType error: Cannot redeclare exported variable 'CalculatorButton'.`,
        };
      }
      // After surgical removal of line 17, second build succeeds!
      return {
        success: true,
        errors: "",
      };
    });

    const res = await SelfHealingEngine.runSelfHealingLoop(
      initialChanges,
      tempDir,
      ["npm run build"],
      "system",
      "Fix use client and duplicate export",
      fsManager,
      "proj-test-surgical",
      undefined,
      approvedManifest as any,
      executionContract as any
    );

    expect(res.success).toBe(true);
    expect(res.repaired).toBe(true);
    const finalCalc = res.finalChanges.find((c) => c.path === calcFile);
    expect(finalCalc).toBeDefined();
    expect(finalCalc?.content).toContain("export const CalculatorButton");
    expect(finalCalc?.content).toContain("export const CalculatorDisplay");
    expect(finalCalc?.content).toContain("export default Calculator;");
    expect(finalCalc?.content).not.toContain("export { CalculatorButton, CalculatorDisplay };");
  });

  test("H. Non-matching COMPILE_TS errors keep existing behavior (no false-positive duplicate export patch)", () => {
    const input = `export const Calculator = () => {
  const x: number = "not-a-number";
  return <div>{x}</div>;
};
`;

    const diag = {
      file: "components/Calculator.tsx",
      line: 2,
      column: 9,
      code: "TS2322",
      message: "Type 'string' is not assignable to type 'number'.",
      rawTrace: "Type 'string' is not assignable to type 'number'.",
    };

    const patch = SurgicalPatchEngine.generateDuplicateExportPatch(input, "components/Calculator.tsx", diag);
    expect(patch).toBeNull();
  });
});
