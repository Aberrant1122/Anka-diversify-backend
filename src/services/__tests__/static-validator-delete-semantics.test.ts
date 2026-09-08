import { StaticValidationEngine } from "../static-validator.engine";

describe("StaticValidationEngine — Delete Semantics & Malformed Modify Guard", () => {
  const baseSnapshot = [
    {
      path: "app/components/Calculator.tsx",
      content: `import React from 'react';\nexport const Calculator = () => <div>Calculator</div>;`,
    },
    {
      path: "app/page.tsx",
      content: `import React from 'react';\nimport { Calculator } from './components/Calculator';\nexport default function Page() {\n  return <Calculator />;\n}`,
    },
  ];

  test("1 & 2. DELETE action removes file from effective snapshot rather than setting undefined", () => {
    const changes = [
      {
        path: "app/components/Calculator.tsx",
        action: "delete" as const,
        isDeleted: true,
      },
    ];

    const result = StaticValidationEngine.validate(baseSnapshot, changes);
    // Calculator is deleted, but page.tsx still imports it, so it should report broken_import
    expect(result.status).toBe("FAIL");
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.checkId === "broken_import")).toBe(true);
    // Crucially, it did not crash with content.split("\n") or undefined property access
  });

  test("3. DELETE component + MODIFY page to remove import passes cleanly", () => {
    const changes = [
      {
        path: "app/components/Calculator.tsx",
        action: "delete" as const,
        isDeleted: true,
      },
      {
        path: "app/page.tsx",
        action: "modify" as const,
        content: `import React from 'react';\nexport default function Page() {\n  return <div>Enhanced Dashboard</div>;\n}`,
      },
    ];

    const result = StaticValidationEngine.validate(baseSnapshot, changes);
    expect(result.status).toBe("PASS");
    expect(result.passed).toBe(true);
    expect(result.issues.length).toBe(0);
  });

  test("4. DELETE component with stale importer fails closed with broken_import", () => {
    const changes = [
      {
        path: "app/components/Calculator.tsx",
        action: "delete" as const,
        isDeleted: true,
      },
    ];

    const result = StaticValidationEngine.validate(baseSnapshot, changes);
    const brokenImport = result.issues.find((i) => i.checkId === "broken_import");
    expect(brokenImport).toBeDefined();
    expect(brokenImport?.file).toBe("app/page.tsx");
  });

  test("7. Malformed MODIFY with undefined content fails closed with structured error", () => {
    const malformedChanges = [
      {
        path: "app/page.tsx",
        action: "modify" as const,
        content: undefined as any,
      },
    ];

    const result = StaticValidationEngine.validate(baseSnapshot, malformedChanges);
    expect(result.status).toBe("FAIL");
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => i.reason.includes("missing required string content"))).toBe(true);
  });

  test("8. Existing CREATE and MODIFY behavior remains unchanged", () => {
    const normalChanges = [
      {
        path: "app/components/Header.tsx",
        action: "create" as const,
        content: `import React from 'react';\nexport const Header = () => <header>Header</header>;`,
      },
      {
        path: "app/page.tsx",
        action: "modify" as const,
        content: `import React from 'react';\nimport { Calculator } from './components/Calculator';\nimport { Header } from './components/Header';\nexport default function Page() {\n  return <div><Header /><Calculator /></div>;\n}`,
      },
    ];

    const result = StaticValidationEngine.validate(baseSnapshot, normalChanges);
    expect(result.status).toBe("PASS");
    expect(result.passed).toBe(true);
  });
});
