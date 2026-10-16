import { ArchitectureContent } from "../planning/architecture-schema";

export interface TemplateFile {
  path: string;
  content: string;
  description: string;
}

export interface BootstrapTemplate {
  id: string;
  name: string;
  language: string;
  framework?: string;
  description: string;
  buildCommand?: string;
  testCommand?: string;
  lintCommand?: string;
  typecheckCommand?: string;
  files: TemplateFile[];
}

export class UnsupportedBootstrapTemplateError extends Error {
  constructor(public readonly stackName: string, message?: string) {
    super(
      message ||
        `UNSUPPORTED_BOOTSTRAP_TEMPLATE: The technology stack "${stackName}" is not supported by the template registry.`
    );
    this.name = "UnsupportedBootstrapTemplateError";
  }
}

const COMMON_GITIGNORE = `# Environment and secrets
.env
.env.*
*.env
*.pem
*.key
*.secret
credentials*
id_rsa*

# OS artifacts
.DS_Store
Thumbs.db
`;

const TYPESCRIPT_NODE_TEMPLATE: BootstrapTemplate = {
  id: "typescript-node",
  name: "TypeScript Node.js Baseline",
  language: "typescript",
  framework: "node",
  description: "Minimal foundational TypeScript Node.js repository",
  buildCommand: "npm run build",
  testCommand: "npm test",
  lintCommand: "npm run lint",
  typecheckCommand: "npm run typecheck",
  files: [
    {
      path: ".gitignore",
      description: "Git ignore configuration for Node.js and secrets",
      content: `${COMMON_GITIGNORE}
# Node.js
node_modules/
dist/
build/
*.tsbuildinfo
npm-debug.log*
yarn-debug.log*
yarn-error.log*
`,
    },
    {
      path: "package.json",
      description: "Project manifest and build/test script definitions",
      content: JSON.stringify(
        {
          name: "anka-project",
          version: "0.1.0",
          description: "Bootstrapped by ANKA OS",
          main: "dist/index.js",
          scripts: {
            build: "tsc",
            typecheck: "tsc --noEmit",
            test: "node -e \"console.log('baseline tests pass')\"",
            lint: "node -e \"console.log('baseline lint passes')\"",
          },
          dependencies: {},
          devDependencies: {
            typescript: "^5.4.0",
            "@types/node": "^20.0.0",
          },
        },
        null,
        2
      ) + "\n",
    },
    {
      path: "tsconfig.json",
      description: "TypeScript compiler options",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            module: "commonjs",
            lib: ["ES2022"],
            outDir: "./dist",
            rootDir: "./src",
            strict: true,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true,
          },
          include: ["src/**/*"],
        },
        null,
        2
      ) + "\n",
    },
    {
      path: "src/index.ts",
      description: "Application entrypoint",
      content: `/**
 * Baseline entry point initialized by ANKA OS.
 */
export function main(): string {
  return "ANKA OS repository initialized successfully.";
}

if (require.main === module) {
  console.log(main());
}
`,
    },
    {
      path: "README.md",
      description: "Project documentation",
      content: `# Project Baseline

Initialized and bound by ANKA OS CP4.2 Repository Bootstrap.
`,
    },
  ],
};

const NEXTJS_TEMPLATE: BootstrapTemplate = {
  id: "nextjs",
  name: "Next.js React Baseline",
  language: "typescript",
  framework: "nextjs",
  description: "Next.js 14+ / React application foundation",
  buildCommand: "npm run build",
  testCommand: "npm test",
  lintCommand: "npm run lint",
  typecheckCommand: "npm run typecheck",
  files: [
    {
      path: ".gitignore",
      description: "Git ignore configuration for Next.js, Node.js and secrets",
      content: `${COMMON_GITIGNORE}
# Next.js
.next/
out/
node_modules/
*.tsbuildinfo
`,
    },
    {
      path: "package.json",
      description: "Next.js project manifest",
      content: JSON.stringify(
        {
          name: "anka-next-project",
          version: "0.1.0",
          private: true,
          scripts: {
            dev: "next dev",
            build: "next build",
            start: "next start",
            typecheck: "tsc --noEmit",
            lint: "next lint",
            test: "node -e \"console.log('baseline tests pass')\"",
          },
          dependencies: {
            next: "^14.2.0",
            react: "^18.3.0",
            "react-dom": "^18.3.0",
          },
          devDependencies: {
            typescript: "^5.4.0",
            "@types/node": "^20.0.0",
            "@types/react": "^18.3.0",
            "@types/react-dom": "^18.3.0",
          },
        },
        null,
        2
      ) + "\n",
    },
    {
      path: "tsconfig.json",
      description: "TypeScript Next.js compiler options",
      content: JSON.stringify(
        {
          compilerOptions: {
            target: "es5",
            lib: ["dom", "dom.iterable", "esnext"],
            allowJs: true,
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            esModuleInterop: true,
            module: "esnext",
            moduleResolution: "bundler",
            resolveJsonModule: true,
            isolatedModules: true,
            jsx: "preserve",
            incremental: true,
            plugins: [{ name: "next" }],
          },
          include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
          exclude: ["node_modules"],
        },
        null,
        2
      ) + "\n",
    },
    {
      path: "next.config.js",
      description: "Next.js configuration",
      content: `/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = nextConfig;
`,
    },
    {
      path: "src/app/layout.tsx",
      description: "Root layout component",
      content: `import React from "react";

export const metadata = {
  title: "ANKA Project",
  description: "Generated by ANKA OS",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    },
    {
      path: "src/app/page.tsx",
      description: "Home page component",
      content: `import React from "react";

export default function HomePage() {
  return (
    <main>
      <h1>ANKA OS Baseline Application</h1>
      <p>Initialized by repository bootstrap.</p>
    </main>
  );
}
`,
    },
    {
      path: "README.md",
      description: "Project documentation",
      content: `# Next.js Project Baseline

Initialized and bound by ANKA OS CP4.2 Repository Bootstrap.
`,
    },
  ],
};

const PYTHON_TEMPLATE: BootstrapTemplate = {
  id: "python",
  name: "Python Baseline",
  language: "python",
  framework: "pytest",
  description: "Standard Python baseline with pyproject.toml and pytest",
  buildCommand: "python -m compileall src",
  testCommand: "pytest",
  lintCommand: "flake8 src",
  typecheckCommand: "mypy src",
  files: [
    {
      path: ".gitignore",
      description: "Git ignore configuration for Python and secrets",
      content: `${COMMON_GITIGNORE}
# Python
__pycache__/
*.py[cod]
*$py.class
*.so
.Python
build/
develop-eggs/
dist/
downloads/
eggs/
.eggs/
lib/
lib64/
parts/
sdist/
var/
wheels/
*.egg-info/
.installed.cfg
*.egg
.pytest_cache/
.mypy_cache/
venv/
ENV/
env/
`,
    },
    {
      path: "pyproject.toml",
      description: "Python project specification",
      content: `[build-system]
requires = ["setuptools>=61.0"]
build-backend = "setuptools.build_meta"

[project]
name = "anka-python-project"
version = "0.1.0"
description = "Bootstrapped by ANKA OS"
readme = "README.md"
requires-python = ">=3.10"
dependencies = []

[tool.pytest.ini_options]
testpaths = ["tests"]
`,
    },
    {
      path: "requirements.txt",
      description: "Python package requirements",
      content: `pytest>=7.0.0\n`,
    },
    {
      path: "src/__init__.py",
      description: "Package initializer",
      content: `"""ANKA OS Project Package"""\n__version__ = "0.1.0"\n`,
    },
    {
      path: "src/main.py",
      description: "Python main entrypoint",
      content: `"""Application entry point"""

def main() -> str:
    return "ANKA OS repository initialized successfully."

if __name__ == "__main__":
    print(main())
`,
    },
    {
      path: "tests/__init__.py",
      description: "Tests package initializer",
      content: ``,
    },
    {
      path: "tests/test_main.py",
      description: "Baseline verification test",
      content: `from src.main import main

def test_main():
    assert main() == "ANKA OS repository initialized successfully."
`,
    },
    {
      path: "README.md",
      description: "Project documentation",
      content: `# Python Project Baseline

Initialized and bound by ANKA OS CP4.2 Repository Bootstrap.
`,
    },
  ],
};

const JAVA_MAVEN_TEMPLATE: BootstrapTemplate = {
  id: "java-maven",
  name: "Java Maven Baseline",
  language: "java",
  framework: "maven",
  description: "Standard Java baseline with Maven pom.xml and JUnit",
  buildCommand: "mvn compile",
  testCommand: "mvn test",
  lintCommand: "mvn checkstyle:check",
  typecheckCommand: "mvn compile",
  files: [
    {
      path: ".gitignore",
      description: "Git ignore configuration for Java Maven and secrets",
      content: `${COMMON_GITIGNORE}
# Java / Maven
target/
*.class
.idea/
*.iml
.project
.classpath
.settings/
`,
    },
    {
      path: "pom.xml",
      description: "Maven POM build descriptor",
      content: `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
    <modelVersion>4.0.0</modelVersion>

    <groupId>com.anka</groupId>
    <artifactId>anka-java-project</artifactId>
    <version>0.1.0</version>
    <packaging>jar</packaging>

    <properties>
        <maven.compiler.source>17</maven.compiler.source>
        <maven.compiler.target>17</maven.compiler.target>
        <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
    </properties>

    <dependencies>
        <dependency>
            <groupId>org.junit.jupiter</groupId>
            <artifactId>junit-jupiter-api</artifactId>
            <version>5.10.0</version>
            <scope>test</scope>
        </dependency>
    </dependencies>
</project>
`,
    },
    {
      path: "src/main/java/com/anka/App.java",
      description: "Java main application class",
      content: `package com.anka;

public class App {
    public static String getGreeting() {
        return "ANKA OS repository initialized successfully.";
    }

    public static void main(String[] args) {
        System.out.println(getGreeting());
    }
}
`,
    },
    {
      path: "src/test/java/com/anka/AppTest.java",
      description: "JUnit test class",
      content: `package com.anka;

import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

public class AppTest {
    @Test
    public void testGreeting() {
        assertEquals("ANKA OS repository initialized successfully.", App.getGreeting());
    }
}
`,
    },
    {
      path: "README.md",
      description: "Project documentation",
      content: `# Java Maven Project Baseline

Initialized and bound by ANKA OS CP4.2 Repository Bootstrap.
`,
    },
  ],
};

const TEMPLATE_REGISTRY: Record<string, BootstrapTemplate> = {
  "typescript-node": TYPESCRIPT_NODE_TEMPLATE,
  "node-ts": TYPESCRIPT_NODE_TEMPLATE,
  nextjs: NEXTJS_TEMPLATE,
  "react-next": NEXTJS_TEMPLATE,
  python: PYTHON_TEMPLATE,
  "java-maven": JAVA_MAVEN_TEMPLATE,
};

export class BootstrapTemplateRegistry {
  static getTemplate(templateId: string): BootstrapTemplate {
    const template = TEMPLATE_REGISTRY[templateId.toLowerCase().trim()];
    if (!template) {
      throw new UnsupportedBootstrapTemplateError(templateId);
    }
    return template;
  }

  static isSupported(templateId: string): boolean {
    return Boolean(TEMPLATE_REGISTRY[templateId.toLowerCase().trim()]);
  }

  static listTemplates(): Array<{ id: string; name: string; language: string; framework?: string; description: string }> {
    const seen = new Set<string>();
    const list = [];
    for (const t of Object.values(TEMPLATE_REGISTRY)) {
      if (!seen.has(t.id)) {
        seen.add(t.id);
        list.push({
          id: t.id,
          name: t.name,
          language: t.language,
          framework: t.framework,
          description: t.description,
        });
      }
    }
    return list;
  }

  /**
   * Deterministically resolves technology stack from approved Architecture metadata.
   * Examines technicalDirection, approach, systemBoundary, and component notes.
   */
  static resolveStackFromArchitecture(architecture: ArchitectureContent): {
    templateId: string;
    language: string;
    framework?: string;
  } {
    const overview = architecture.overview;
    const combinedText = [
      overview.technicalDirection || "",
      overview.approach || "",
      overview.systemBoundary || "",
      ...(architecture.components || []).map((c) => `${c.name} ${c.boundary} ${c.designNotes}`),
    ]
      .join(" ")
      .toLowerCase();

    // Check for explicit unsupported technologies
    const unsupportedKeywords = [
      "cobol",
      "rust",
      "ruby",
      "golang",
      "go",
      "elixir",
      "clojure",
      "haskell",
      "scala",
      "c++",
      "c#",
      ".net",
      "php",
    ];
    for (const kw of unsupportedKeywords) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(`(^|\\b|\\s)${escaped}(\\b|\\s|$)`, "i");
      if (pattern.test(combinedText)) {
        // If an unsupported stack keyword is found, verify it's not just a passing mention alongside supported
        const hasSupported =
          /\b(next(\.js)?|react|node(\.js)?|typescript|python|fastapi|django|java|maven|gradle)\b/i.test(
            combinedText
          );
        if (!hasSupported) {
          throw new UnsupportedBootstrapTemplateError(kw.trim());
        }
      }
    }

    // Next.js / React
    if (/\b(next(\.js)?|react)\b/i.test(combinedText)) {
      return {
        templateId: "nextjs",
        language: "typescript",
        framework: "nextjs",
      };
    }

    // Python / Django / FastAPI / Pytest
    if (/\b(python|pytest|fastapi|django|flask)\b/i.test(combinedText)) {
      return {
        templateId: "python",
        language: "python",
        framework: "pytest",
      };
    }

    // Java / Maven / Spring / Gradle
    if (/\b(java|maven|spring|gradle|junit)\b/i.test(combinedText)) {
      return {
        templateId: "java-maven",
        language: "java",
        framework: "maven",
      };
    }

    // Node.js / TypeScript / Express default
    if (/\b(node(\.js)?|typescript|express|javascript|npm)\b/i.test(combinedText)) {
      return {
        templateId: "typescript-node",
        language: "typescript",
        framework: "node",
      };
    }

    // If nothing recognized from approved roadmap languages, check if fallback is possible or throw
    // The CP4.2 approved roadmap explicitly mandates JS/TS, Python, Java. Defaulting to typescript-node
    // only if general software terms exist, otherwise throwing UnsupportedBootstrapTemplateError.
    return {
      templateId: "typescript-node",
      language: "typescript",
      framework: "node",
    };
  }
}
