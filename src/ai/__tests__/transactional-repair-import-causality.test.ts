import fs from "fs";
import os from "os";
import path from "path";
import {
  attributeImportExportDiagnostics,
  normalizeTransactionalValidationDiagnostics,
} from "../repair/TransactionalRepair";
import { NormalizedDiagnostic } from "../validation/DiagnosticNormalizer";

describe("TransactionalRepair import/export causal attribution", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "repair-causality-"));
    fs.mkdirSync(path.join(root, "app"), { recursive: true });
    fs.mkdirSync(path.join(root, "lib"), { recursive: true });
    fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { moduleResolution: "node" } }));
    fs.writeFileSync(path.join(root, "app/page.tsx"), 'import { getTasksByProject } from "../lib/mock-data";\nexport default getTasksByProject;');
    fs.writeFileSync(path.join(root, "lib/mock-data.ts"), "export const unrelated = true;");
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const diagnostic = (): NormalizedDiagnostic => ({
    category: "SOURCE_DIAGNOSTIC",
    filePath: "app/page.tsx",
    code: "TS2305",
    message: "Module '../lib/mock-data' has no exported member 'getTasksByProject'.",
  });

  test("attributes an importer diagnostic to its changed authorized exporter", () => {
    const result = attributeImportExportDiagnostics({
      diagnostics: [diagnostic()],
      workspaceRoot: root,
      candidateChanges: [{ path: "lib/mock-data.ts", action: "modify" }],
      capabilities: [{ path: "lib/mock-data.ts", action: "FILE_MODIFY" }],
    });

    expect(result[0].filePath).toBe("lib/mock-data.ts");
    expect(result[0].message).toContain("CAUSED_BY_MODIFIED_EXPORTER");
  });

  test("does not attribute to an exporter outside authorized candidate changes", () => {
    const result = attributeImportExportDiagnostics({
      diagnostics: [diagnostic()],
      workspaceRoot: root,
      candidateChanges: [{ path: "lib/other.ts", action: "modify" }],
      capabilities: [{ path: "lib/mock-data.ts", action: "FILE_MODIFY" }],
    });

    expect(result[0].filePath).toBe("app/page.tsx");
  });

  test("unresolved module causality remains on the importer for reinvestigation", () => {
    const unresolved = { ...diagnostic(), message: "Module '../lib/missing' has no exported member 'x'." };
    const result = attributeImportExportDiagnostics({
      diagnostics: [unresolved],
      workspaceRoot: root,
      candidateChanges: [{ path: "lib/mock-data.ts", action: "modify" }],
      capabilities: [{ path: "lib/mock-data.ts", action: "FILE_MODIFY" }],
    });

    expect(result[0].filePath).toBe("app/page.tsx");
  });
});

describe("TransactionalRepair validation output normalization", () => {
  const sourceFailure = "src/view.tsx(7,3): error TS6133: 'items' is declared but its value is never read.";
  const commandEnvelope = [
    "npm run build failed (exit code 2):",
    "> fixture@1.0.0 build\n> tsc && vite build",
  ].join("\n\n");

  test("drops only package-manager command envelopes when a typed diagnostic exists", () => {
    const diagnostics = normalizeTransactionalValidationDiagnostics(
      `${commandEnvelope}\n\n${sourceFailure}\nCommand failed: npm run build`,
      ["npm run build"],
    );

    expect(diagnostics).toEqual([
      expect.objectContaining({
        category: "SOURCE_DIAGNOSTIC",
        filePath: "src/view.tsx",
        code: "TS6133",
      }),
    ]);
  });

  test("retains an unknown failure when command output has no typed diagnostic", () => {
    const diagnostics = normalizeTransactionalValidationDiagnostics(commandEnvelope, ["npm run build"]);

    expect(diagnostics.some((diagnostic) => diagnostic.category === "UNKNOWN_FAILURE")).toBe(true);
  });

  test("retains a genuine unknown block alongside a typed diagnostic", () => {
    const diagnostics = normalizeTransactionalValidationDiagnostics(
      `${commandEnvelope}\n\n${sourceFailure}\n\ncustom verifier reported an unexplained invariant failure`,
      ["npm run build"],
    );

    expect(diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ category: "SOURCE_DIAGNOSTIC", filePath: "src/view.tsx" }),
      expect.objectContaining({ category: "UNKNOWN_FAILURE", message: expect.stringContaining("unexplained invariant") }),
    ]));
  });
});
