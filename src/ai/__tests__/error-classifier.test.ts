import { ErrorClassifier } from "../validation/ErrorClassifier";

describe("ErrorClassifier", () => {
  it("should classify TypeScript errors with TS codes as COMPILE_TS", () => {
    const errorLog = `src/services/payment.service.ts:15:10 - error TS2304: Cannot find name 'PaymentGateway'`;
    const result = ErrorClassifier.classify(errorLog);

    expect(result.type).toBe("COMPILE_TS");
    expect(result.isCompile).toBe(true);
    expect(result.isInfrastructure).toBe(false);
    expect(result.canSurgicalPatch).toBe(true);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  });

  it("should classify ENOENT as INFRA with isInfrastructure=true", () => {
    const errorLog = `npm run build failed (exit code unknown): ENOENT: no such file or directory`;
    const result = ErrorClassifier.classify(errorLog);

    expect(result.type).toBe("INFRA");
    expect(result.isInfrastructure).toBe(true);
    expect(result.isCompile).toBe(false);
    expect(result.canSurgicalPatch).toBe(false);
  });

  it("should classify 'command not found' as INFRA", () => {
    const errorLog = `tsc: command not found`;
    const result = ErrorClassifier.classify(errorLog);

    expect(result.type).toBe("INFRA");
    expect(result.isInfrastructure).toBe(true);
  });

  it("should classify 'Cannot find module' as MISSING_DEP", () => {
    const errorLog = `Error: Cannot find module 'lodash'`;
    const result = ErrorClassifier.classify(errorLog);

    expect(result.type).toBe("MISSING_DEP");
    expect(result.isInfrastructure).toBe(false);
    expect(result.isCompile).toBe(false);
    expect(result.canSurgicalPatch).toBe(false);
  });

  it("should classify 'Failed to compile' without TS codes as COMPILE_NEXT", () => {
    const errorLog = `Failed to compile\n./src/app/page.tsx\nSome unstructured error message`;
    const result = ErrorClassifier.classify(errorLog);

    expect(result.type).toBe("COMPILE_NEXT");
    expect(result.isCompile).toBe(true);
  });

  it("should classify empty string as UNKNOWN", () => {
    const result = ErrorClassifier.classify("");

    expect(result.type).toBe("UNKNOWN");
    expect(result.isInfrastructure).toBe(false);
    expect(result.isCompile).toBe(false);
    expect(result.canSurgicalPatch).toBe(false);
    expect(result.diagnostics).toEqual([]);
  });

  it("should set canSurgicalPatch=false for INFRA errors", () => {
    const errorLog = `exit code 127\ncommand not found: tsc`;
    const result = ErrorClassifier.classify(errorLog);

    expect(result.type).toBe("INFRA");
    expect(result.canSurgicalPatch).toBe(false);
  });

  it("should set canSurgicalPatch=true for COMPILE_TS with parsed diagnostics", () => {
    const errorLog = `src/index.ts:10:5 - error TS2339: Property 'foo' does not exist on type 'Bar'`;
    const result = ErrorClassifier.classify(errorLog);

    expect(result.type).toBe("COMPILE_TS");
    expect(result.canSurgicalPatch).toBe(true);
    expect(result.diagnostics.length).toBe(1);
    expect(result.diagnostics[0].code).toBe("TS2339");
  });

  it("should classify Angular NG errors as COMPILE_ANGULAR", () => {
    const errorLog = `src/app/component.ts:5:3 - error NG8001: 'app-unknown' is not a known element`;
    const result = ErrorClassifier.classify(errorLog);

    expect(result.type).toBe("COMPILE_ANGULAR");
    expect(result.isCompile).toBe(true);
    expect(result.canSurgicalPatch).toBe(true);
  });

  it("should classify Rust compile errors as COMPILE_RUST", () => {
    const errorLog = `error[E0425]: cannot find value 'x' in this scope`;
    const result = ErrorClassifier.classify(errorLog);

    expect(result.type).toBe("COMPILE_RUST");
    expect(result.isCompile).toBe(true);
    expect(result.canSurgicalPatch).toBe(false);
  });
});
