import path from "path";

export type FrameworkType = "NEXT_JS" | "VITE_REACT" | "EXPRESS" | "NODE_JS" | "UNKNOWN";
export type RouterType = "APP_ROUTER" | "PAGES_ROUTER" | "HYBRID" | "NONE";

export const NODE_BUILTIN_MODULES = new Set([
  "assert",
  "async_hooks",
  "buffer",
  "child_process",
  "cluster",
  "console",
  "constants",
  "crypto",
  "dgram",
  "diagnostics_channel",
  "dns",
  "domain",
  "events",
  "fs",
  "fs/promises",
  "http",
  "http2",
  "https",
  "inspector",
  "module",
  "net",
  "os",
  "path",
  "path/posix",
  "path/win32",
  "perf_hooks",
  "process",
  "punycode",
  "querystring",
  "readline",
  "repl",
  "stream",
  "stream/consumers",
  "stream/promises",
  "stream/web",
  "string_decoder",
  "timers",
  "timers/promises",
  "tls",
  "trace_events",
  "tty",
  "url",
  "util",
  "util/types",
  "v8",
  "vm",
  "wasi",
  "worker_threads",
  "zlib",
]);

/**
 * Normalizes package subpath imports to their root package identifier:
 * - next/link -> next
 * - lodash/get -> lodash
 * - @scope/pkg/subpath -> @scope/pkg
 */
export function extractPackageRoot(specifier: string): string {
  const clean = specifier.trim().replace(/^node:/, "");
  if (clean.startsWith("@")) {
    const parts = clean.split("/");
    return parts.slice(0, 2).join("/");
  }
  return clean.split("/")[0];
}

/**
 * Checks whether an import specifier is an allowed Node builtin or an installed external package.
 */
export function isAllowedBuiltinOrInstalled(
  specifier: string,
  installedPackages: string[] | Set<string>
): boolean {
  const clean = specifier.trim();
  if (clean.startsWith("node:")) {
    const withoutNode = clean.slice(5);
    return NODE_BUILTIN_MODULES.has(withoutNode) || NODE_BUILTIN_MODULES.has(clean);
  }
  if (NODE_BUILTIN_MODULES.has(clean)) {
    return true;
  }
  const root = extractPackageRoot(clean);
  if (NODE_BUILTIN_MODULES.has(root)) {
    return true;
  }
  const installedSet = installedPackages instanceof Set ? installedPackages : new Set(installedPackages);
  return installedSet.has(root);
}

export interface RepositoryArchitectureSummary {
  framework: FrameworkType;
  router: RouterType;
  hasAppRouter: boolean;
  hasPagesRouter: boolean;
  hasTailwind: boolean;
  existingEntryPoints: string[];
  guidelines: string[];
  installedPackages: string[];
  packageVersions: Record<string, string>;
}

/**
 * Deterministically analyzes canonical repository files and package configurations
 * to determine framework, router type, legitimate entry points, and installed packages inventory.
 */
export function detectRepositoryArchitecture(
  existingFiles: string[] = [],
  packageJsonContent?: string | object
): RepositoryArchitectureSummary {
  const normalizedFiles = existingFiles.map((f) => f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase());

  let parsedPackage: any = null;
  if (typeof packageJsonContent === "string") {
    try {
      parsedPackage = JSON.parse(packageJsonContent);
    } catch {
      parsedPackage = null;
    }
  } else if (typeof packageJsonContent === "object" && packageJsonContent !== null) {
    parsedPackage = packageJsonContent;
  }

  const allDependencies: Record<string, string> = {
    ...(parsedPackage?.dependencies || {}),
    ...(parsedPackage?.devDependencies || {}),
  };

  const installedPackages = Object.keys(allDependencies);
  const packageVersions = { ...allDependencies };

  // 1. Detect App Router & Pages Router presence
  const hasAppRouter = normalizedFiles.some(
    (f) =>
      /^(src\/)?app\/(page|layout|route|not-found|error|loading|template)\.(tsx|jsx|ts|js)$/.test(f) ||
      /^(src\/)?app\/.*\/page\.(tsx|jsx|ts|js)$/.test(f)
  );

  const hasPagesRouter = normalizedFiles.some(
    (f) =>
      /^(src\/)?pages\/.*(index|_app|_document|\[.*\])\.(tsx|jsx|ts|js)$/.test(f) ||
      /^(src\/)?pages\/.*\.(tsx|jsx|ts|js)$/.test(f)
  );

  let router: RouterType = "NONE";
  if (hasAppRouter && hasPagesRouter) {
    router = "HYBRID";
  } else if (hasAppRouter) {
    router = "APP_ROUTER";
  } else if (hasPagesRouter) {
    router = "PAGES_ROUTER";
  }

  // 2. Detect Framework
  let framework: FrameworkType = "UNKNOWN";
  if ("next" in allDependencies || normalizedFiles.some((f) => /^next\.config\.(ts|mjs|js)$/.test(f)) || hasAppRouter || hasPagesRouter) {
    framework = "NEXT_JS";
  } else if ("vite" in allDependencies || normalizedFiles.some((f) => /^vite\.config\.(ts|js|mjs)$/.test(f))) {
    framework = "VITE_REACT";
  } else if ("express" in allDependencies) {
    framework = "EXPRESS";
  } else if (normalizedFiles.some((f) => f.endsWith("package.json") || f.endsWith("tsconfig.json"))) {
    framework = "NODE_JS";
  }

  // 3. Detect Styling System (Tailwind vs Vanilla/CSS Modules)
  const hasTailwind =
    "tailwindcss" in allDependencies ||
    "@tailwindcss/postcss" in allDependencies ||
    normalizedFiles.some((f) => /^tailwind\.config\.(ts|js|mjs|cjs)$/.test(f));

  // 4. Extract Verified Existing Entry Points
  const existingEntryPoints = existingFiles.filter((f) => {
    const norm = f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    const basename = path.basename(norm);

    if (hasAppRouter && /^(src\/)?app\/.*(page|layout|route)\.(tsx|jsx|ts|js)$/.test(norm)) {
      return true;
    }
    if (hasPagesRouter && /^(src\/)?pages\/.*\.(tsx|jsx|ts|js)$/.test(norm)) {
      return true;
    }
    return [
      "index.html",
      "main.tsx",
      "main.jsx",
      "main.ts",
      "main.js",
      "app.tsx",
      "app.jsx",
      "app.ts",
      "app.js",
      "index.ts",
      "index.js",
      "server.ts",
      "server.js",
    ].includes(basename);
  });

  // 5. Generate Deterministic Planning Guidelines
  const guidelines: string[] = [];
  if (framework === "NEXT_JS") {
    if (router === "APP_ROUTER") {
      guidelines.push("This repository uses Next.js App Router (app/ directory). Do NOT invent pages/ or src/pages/ files.");
      guidelines.push("Integration routes must use app/**/page.tsx or embed components in existing app/page.tsx.");
    } else if (router === "PAGES_ROUTER") {
      guidelines.push("This repository uses Next.js Pages Router (pages/ directory). Do NOT invent app/ route files.");
    }
  }

  if (hasTailwind) {
    guidelines.push("Tailwind CSS is verified. Use standard Tailwind utility classes in component JSX/TSX.");
  } else {
    guidelines.push("Tailwind CSS is NOT verified in this repository. In stylesheets (.css/.scss), use valid standard CSS class selectors (e.g. .calculator-card, .btn-primary) — NEVER write Tailwind utility syntax like '.dark:bg-gray-900' as raw CSS selectors.");
  }

  guidelines.push("Prefer reusing and modifying existing components before creating duplicate or parallel architecture.");
  guidelines.push("Every created local code, helper, or stylesheet file must be declared in the dependencies of the component/page that imports it.");
  if (installedPackages.length > 0) {
    guidelines.push(`Only use installed external packages: [${installedPackages.join(", ")}]. Do NOT invent or import uninstalled packages.`);
  }

  return {
    framework,
    router,
    hasAppRouter,
    hasPagesRouter,
    hasTailwind,
    existingEntryPoints,
    guidelines,
    installedPackages,
    packageVersions,
  };
}
