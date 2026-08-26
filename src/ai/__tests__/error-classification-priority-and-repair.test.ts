import { ErrorClassifier } from "../validation/ErrorClassifier";
import { detectRepositoryArchitecture } from "../planning/RepositoryArchitectureDetector";

describe("AI Step 16 — Build Error Classification Priority & Self-Healing Routing", () => {
  test("Section 9A: error TS2322 with 'Command failed: npm run build' classifies COMPILE_TS", () => {
    const errorLog = `
✓ Compiled successfully in 4.8s
Running TypeScript ...

app/page.tsx(10,10): error TS2322: Type '{ children: Element; title: string; content: string; }' is not assignable to type 'IntrinsicAttributes & CardProps'.
  Property 'children' does not exist on type 'IntrinsicAttributes & CardProps'.

Failed to type check.
Command failed: npm run build
`;

    const res = ErrorClassifier.classify(errorLog);
    expect(res.type).toBe("COMPILE_TS");
    expect(res.isCompile).toBe(true);
    expect(res.isInfrastructure).toBe(false);
    expect(res.diagnostics.length).toBeGreaterThan(0);
    expect(res.diagnostics[0].code).toBe("TS2322");
    expect(res.diagnostics[0].file).toBe("app/page.tsx");
  });

  test("Section 9B & 9K: 'Failed to type check' with non-fatal CSS pseudo-class warning classifies COMPILE_TS, not INFRA", () => {
    const errorLog = `
app/styles/global.css:
.dark:bg-gray-900 {
  display: flex;
}
'bg-gray-900' is not recognized as a valid pseudo-class.

app/page.tsx(10,10): error TS2322: Property 'children' does not exist on type 'CardProps'.
Failed to type check.
`;

    const res = ErrorClassifier.classify(errorLog);
    expect(res.type).toBe("COMPILE_TS");
    expect(res.isCompile).toBe(true);
    expect(res.isInfrastructure).toBe(false);
  });

  test("Section 9C: Missing build executable (ENOENT / command not found) classifies INFRA", () => {
    const errorLog = `spawn next ENOENT\nnext: command not found`;
    const res = ErrorClassifier.classify(errorLog);
    expect(res.type).toBe("INFRA");
    expect(res.isInfrastructure).toBe(true);
    expect(res.isCompile).toBe(false);
  });

  test("Section 9D: Missing dependency error classifies MISSING_DEP", () => {
    const errorLog = `Module not found: Can't resolve 'mathjs' in '/app/page.tsx'`;
    const res = ErrorClassifier.classify(errorLog);
    expect(res.type).toBe("MISSING_DEP");
    expect(res.isInfrastructure).toBe(false);
    expect(res.isCompile).toBe(false);
  });

  test("Section 9E: Non-standard NODE_ENV classifies ENVIRONMENT", () => {
    const errorLog = `⚠ You are using a non-standard "NODE_ENV" value in your environment: "development"`;
    const res = ErrorClassifier.classify(errorLog);
    expect(res.type).toBe("ENVIRONMENT");
    expect(res.isInfrastructure).toBe(true);
    expect(res.isCompile).toBe(false);
  });

  test("Section 9F: Windows command failure without compiler diagnostics classifies INFRA", () => {
    const errorLog = `'mybuildtool' is not recognized as an internal or external command, operable program or batch file.`;
    const res = ErrorClassifier.classify(errorLog);
    expect(res.type).toBe("INFRA");
    expect(res.isInfrastructure).toBe(true);
  });

  test("Section 9G & 9H: COMPILE_TS enters repair, while INFRA has isInfrastructure = true", () => {
    const tsError = `src/auth.ts(5,3): error TS2304: Cannot find name 'jwtSecret'.`;
    const infraError = `npm ERR! code EACCES\npermission denied`;

    const tsRes = ErrorClassifier.classify(tsError);
    const infraRes = ErrorClassifier.classify(infraError);

    expect(tsRes.type).toBe("COMPILE_TS");
    expect(tsRes.isInfrastructure).toBe(false);
    expect(tsRes.canSurgicalPatch).toBe(true);

    expect(infraRes.type).toBe("INFRA");
    expect(infraRes.isInfrastructure).toBe(true);
    expect(infraRes.canSurgicalPatch).toBe(false);
  });

  test("Section 9L: Architecture detector sets hasTailwind and provides valid CSS guidelines", () => {
    // Non-tailwind repository
    const nonTailwindArch = detectRepositoryArchitecture(["app/page.tsx", "app/styles/global.css"], {
      name: "vanilla-next",
      dependencies: { next: "14.0.0", react: "18.0.0" },
    });

    expect(nonTailwindArch.hasTailwind).toBe(false);
    expect(nonTailwindArch.guidelines.some((g) => g.includes("Tailwind CSS is NOT verified"))).toBe(true);

    // Tailwind repository
    const tailwindArch = detectRepositoryArchitecture(["app/page.tsx", "tailwind.config.js"], {
      name: "tailwind-next",
      dependencies: { next: "14.0.0", tailwindcss: "^3.4.0" },
    });

    expect(tailwindArch.hasTailwind).toBe(true);
    expect(tailwindArch.guidelines.some((g) => g.includes("Tailwind CSS is verified"))).toBe(true);
  });
});
