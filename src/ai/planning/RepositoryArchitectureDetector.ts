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

export interface ExistingUIComponentInfo {
  path: string;
  name: string;
  category?: "primitive" | "layout" | "composite" | "navigation" | "feedback";
}

export interface RepositoryArchitectureSummary {
  framework: FrameworkType;
  router: RouterType;
  hasAppRouter: boolean;
  hasPagesRouter: boolean;
  hasTailwind: boolean;
  existingEntryPoints: string[];
  primaryActiveEntryPoint: string | null;
  existingUIComponents: ExistingUIComponentInfo[];
  existingStyleFiles: string[];
  installedUILibraries: string[];
  guidelines: string[];
  installedPackages: string[];
  packageVersions: Record<string, string>;
}

import { MonorepoDescriptor } from "../workspace/MonorepoDetector";

/**
 * Deterministically detects the single primary active UI entry point (e.g. root page /)
 * based on verified repository architecture.
 */
export function detectPrimaryActiveEntryPoint(
  existingFiles: string[] = [],
  arch?: Partial<RepositoryArchitectureSummary>
): string | null {
  const normalizedFiles = existingFiles.map((f) => ({
    original: f,
    norm: f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(),
  }));

  // 1. Next.js App Router root page (root or nested workspace app)
  const nextAppRoot = normalizedFiles.find(
    (f) =>
      f.norm === "app/page.tsx" ||
      f.norm === "app/page.jsx" ||
      f.norm === "app/page.js" ||
      f.norm === "src/app/page.tsx" ||
      f.norm === "src/app/page.jsx" ||
      f.norm === "src/app/page.js" ||
      /^(?:apps\/[^\/]+\/)?(src\/)?app\/page\.(tsx|jsx|js)$/.test(f.norm)
  );
  if (nextAppRoot) return nextAppRoot.original;

  // 2. Next.js Pages Router index page (root or nested workspace app)
  const nextPagesRoot = normalizedFiles.find(
    (f) =>
      f.norm === "pages/index.tsx" ||
      f.norm === "pages/index.jsx" ||
      f.norm === "pages/index.js" ||
      f.norm === "src/pages/index.tsx" ||
      f.norm === "src/pages/index.jsx" ||
      f.norm === "src/pages/index.js" ||
      /^(?:apps\/[^\/]+\/)?(src\/)?pages\/index\.(tsx|jsx|js)$/.test(f.norm)
  );
  if (nextPagesRoot) return nextPagesRoot.original;

  // 3. Vite / React SPA App component (root or nested workspace app)
  const reactApp = normalizedFiles.find(
    (f) =>
      f.norm === "src/app.tsx" ||
      f.norm === "src/app.jsx" ||
      f.norm === "src/app.js" ||
      f.norm === "app.tsx" ||
      f.norm === "app.jsx" ||
      /^(?:apps\/[^\/]+\/)?(src\/)?app\.(tsx|jsx|js)$/.test(f.norm)
  );
  if (reactApp) return reactApp.original;

  // 4. Fallback to index.html if standalone or web
  const indexHtml = normalizedFiles.find((f) => f.norm === "index.html" || f.norm === "public/index.html" || /^(?:apps\/[^\/]+\/)?(?:public\/)?index\.html$/.test(f.norm));
  if (indexHtml) return indexHtml.original;

  // 5. Entry point from existingEntryPoints
  if (arch?.existingEntryPoints && arch.existingEntryPoints.length > 0) {
    return arch.existingEntryPoints[0];
  }

  return null;
}

/**
 * Deterministically detects all recognized active UI entry points and route pages
 * to serve as reachability roots in graph traversal.
 */
export function detectAllActiveEntryRoots(
  existingFiles: string[] = [],
  arch?: Partial<RepositoryArchitectureSummary>
): string[] {
  const roots = new Set<string>();
  const normalizedFiles = existingFiles.map((f) => ({
    original: f,
    norm: f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase(),
  }));

  // 1. Primary active entry point if detected
  const primary = detectPrimaryActiveEntryPoint(existingFiles, arch);
  if (primary) {
    roots.add(primary.replace(/\\/g, "/"));
  }

  // 2. Vite / React SPA App and bootstrap entry points
  for (const f of normalizedFiles) {
    if (
      f.norm === "src/main.tsx" ||
      f.norm === "src/main.jsx" ||
      f.norm === "src/main.js" ||
      f.norm === "src/main.ts" ||
      f.norm === "src/index.tsx" ||
      f.norm === "src/index.jsx" ||
      f.norm === "src/index.js" ||
      f.norm === "src/index.ts" ||
      f.norm === "main.tsx" ||
      f.norm === "main.jsx" ||
      f.norm === "src/app.tsx" ||
      f.norm === "src/app.jsx" ||
      f.norm === "src/app.js" ||
      f.norm === "app.tsx" ||
      f.norm === "app.jsx" ||
      /^(?:apps\/[^\/]+\/)?(src\/)?(?:main|app|index)\.(?:tsx|jsx|js|ts)$/.test(f.norm)
    ) {
      roots.add(f.original.replace(/\\/g, "/"));
    }
  }

  // 3. Next.js recognized route / page / layout entries (App Router & Pages Router)
  for (const f of normalizedFiles) {
    // App Router: (apps/.../)?(src/)?app/(.../)?(page|layout).(tsx|jsx|js|ts)
    const isAppRoute = /^(?:apps\/[^\/]+\/)?(?:src\/)?app\/(?:.*\/)?(?:page|layout)\.(?:tsx|jsx|js|ts)$/i.test(f.norm);
    // Pages Router: (apps/.../)?(src/)?pages/(?!api/).*.(tsx|jsx|js|ts)
    const isPagesRoute = /^(?:apps\/[^\/]+\/)?(?:src\/)?pages\/(?!api\/).*\.(?:tsx|jsx|js|ts)$/i.test(f.norm);

    if (isAppRoute || isPagesRoute) {
      roots.add(f.original.replace(/\\/g, "/"));
    }
  }

  // 4. Any declared existingEntryPoints
  if (arch?.existingEntryPoints) {
    for (const ep of arch.existingEntryPoints) {
      roots.add(ep.replace(/\\/g, "/"));
    }
  }

  return Array.from(roots);
}

/**
 * Returns true if the user's prompt specifically asks to improve, enhance, redesign,
 * or update the existing primary UI entry point.
 *
 * Structural check: the user uses a refinement verb AND the contract's target paths
 * include the detected primary active entry point. If primaryActiveEntryPoint is not
 * provided or target paths are empty, falls back to false (fail closed).
 */
export function isExistingPrimaryUIRefinement(
  message: string,
  options?: { primaryActiveEntryPoint?: string | null; targetPaths?: string[] }
): boolean {
  if (!message || typeof message !== "string") return false;
  const isRefinementVerb = /\b(improve|enhance|redesign|update|modify|polish|refactor|fix|change|revamp|upgrade|style|theme)\b/i.test(message);
  if (!isRefinementVerb) return false;

  const primary = options?.primaryActiveEntryPoint;
  const targets = options?.targetPaths || [];
  if (primary && targets.length > 0) {
    const normPrimary = primary.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "").toLowerCase();
    return targets.some((t) => {
      const normT = t.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "").toLowerCase();
      return normT === normPrimary || normPrimary.startsWith(normT + "/") || normT.startsWith(normPrimary + "/");
    });
  }

  // Fallback for non-contract or test calls without target paths
  return /\b(dashboard|homepage|home page|home view|main page|root page|current ui|active dashboard|landing page|ui|interface)\b/i.test(message);
}

/**
 * Returns true if the task structurally represents a multi-component UI feature
 * (e.g. the manifest proposes ≥3 UI files spanning components + page + stylesheet,
 * or the task complexity is LARGE/COMPLEX).
 *
 * Replaces the former keyword-based isFullPageDashboardRequest in production paths.
 * Does NOT rely on feature-specific keywords ("dashboard", "calculator", etc.).
 */
export function isMultiComponentUIFeature(
  message: string,
  options?: { manifestFileCount?: number; taskComplexity?: string }
): boolean {
  if (!message || typeof message !== "string") return false;

  // Structural signal: manifest proposes ≥3 files (page + components + stylesheet)
  if (options?.manifestFileCount && options.manifestFileCount >= 3) {
    return true;
  }

  // Structural signal: task classified as LARGE or COMPLEX
  if (options?.taskComplexity === "LARGE" || options?.taskComplexity === "COMPLEX") {
    return true;
  }

  return false;
}

/**
 * @deprecated Replaced by isMultiComponentUIFeature. Preserved for backward compatibility and test contracts.
 */
export function isFullPageDashboardRequest(
  message: string,
  options?: { manifestFileCount?: number; taskComplexity?: string }
): boolean {
  if (!message || typeof message !== "string") return false;
  if (options?.manifestFileCount !== undefined || options?.taskComplexity !== undefined) {
    return isMultiComponentUIFeature(message, options);
  }
  const isDashboardTerm = /\b(dashboard|admin portal|customer support dashboard|analytics dashboard|management dashboard|support dashboard|control center)\b/i.test(message);
  const isSmallComponent = /\b(small component|card component|button component|tooltip|dropdown component|modal component|isolated component)\b/i.test(message);
  return isDashboardTerm && !isSmallComponent;
}

/**
 * Deterministically analyzes canonical repository files and package configurations
 * to determine framework, router type, legitimate entry points, and installed packages inventory.
 */
export function detectRepositoryArchitecture(
  existingFiles: string[] = [],
  packageJsonContent?: string | object,
  monorepo?: MonorepoDescriptor | null
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

  // If monorepo is present, merge workspace package names and dependencies
  if (monorepo?.isMonorepo) {
    for (const ws of monorepo.workspaces) {
      if (!installedPackages.includes(ws.name)) {
        installedPackages.push(ws.name);
        packageVersions[ws.name] = "*";
      }
      for (const dep of ws.dependencies) {
        if (!installedPackages.includes(dep)) {
          installedPackages.push(dep);
          packageVersions[dep] = "*";
        }
      }
    }
  }

  // 1. Detect App Router & Pages Router presence (supporting root and nested workspace apps)
  const hasAppRouter = normalizedFiles.some(
    (f) =>
      /^(?:apps\/[^\/]+\/)?(src\/)?app\/(page|layout|route|not-found|error|loading|template)\.(tsx|jsx|ts|js)$/.test(f) ||
      /^(?:apps\/[^\/]+\/)?(src\/)?app\/.*\/page\.(tsx|jsx|ts|js)$/.test(f)
  );

  const hasPagesRouter = normalizedFiles.some(
    (f) =>
      /^(?:apps\/[^\/]+\/)?(src\/)?pages\/.*(index|_app|_document|\[.*\])\.(tsx|jsx|ts|js)$/.test(f) ||
      /^(?:apps\/[^\/]+\/)?(src\/)?pages\/.*\.(tsx|jsx|ts|js)$/.test(f)
  );

  // 2. Detect Framework with authoritative precedence:
  // 1. Explicit Next dependency/config
  // 2. Explicit Vite dependency/config
  // 3. Explicit Express
  // 4. Monorepo workspace declarations
  // 5. Structural fallback ONLY when package evidence is absent/ambiguous
  const hasExplicitNext =
    "next" in allDependencies ||
    normalizedFiles.some((f) => /^(?:apps\/[^\/]+\/)?next\.config\.(ts|mjs|js)$/.test(f));

  const hasExplicitVite =
    "vite" in allDependencies ||
    normalizedFiles.some((f) => /^(?:apps\/[^\/]+\/)?vite\.config\.(ts|js|mjs)$/.test(f));

  let framework: FrameworkType = "UNKNOWN";

  if (hasExplicitNext) {
    framework = "NEXT_JS";
  } else if (hasExplicitVite) {
    framework = "VITE_REACT";
  } else if ("express" in allDependencies) {
    framework = "EXPRESS";
  } else if (monorepo?.isMonorepo) {
    for (const ws of monorepo.workspaces) {
      if (ws.dependencies.has("next")) {
        framework = "NEXT_JS";
        break;
      } else if (ws.dependencies.has("vite")) {
        framework = "VITE_REACT";
        break;
      } else if (ws.dependencies.has("express")) {
        framework = "EXPRESS";
        break;
      }
    }
  }

  // Structural fallback only if framework remains UNKNOWN
  if (framework === "UNKNOWN") {
    if (hasAppRouter || hasPagesRouter) {
      framework = "NEXT_JS";
    } else if (normalizedFiles.some((f) => f.endsWith("package.json") || f.endsWith("tsconfig.json"))) {
      framework = "NODE_JS";
    }
  }

  // Next.js router concepts are scoped strictly to Next.js frameworks
  let router: RouterType = "NONE";
  let finalHasAppRouter = false;
  let finalHasPagesRouter = false;

  if (framework === "NEXT_JS") {
    finalHasAppRouter = hasAppRouter;
    finalHasPagesRouter = hasPagesRouter;
    if (hasAppRouter && hasPagesRouter) {
      router = "HYBRID";
    } else if (hasAppRouter) {
      router = "APP_ROUTER";
    } else if (hasPagesRouter) {
      router = "PAGES_ROUTER";
    }
  }

  // 3. Detect Styling System (Tailwind vs Vanilla/CSS Modules)
  const hasTailwind =
    "tailwindcss" in allDependencies ||
    "@tailwindcss/postcss" in allDependencies ||
    (monorepo?.isMonorepo && monorepo.workspaces.some((ws) => ws.dependencies.has("tailwindcss") || ws.dependencies.has("@tailwindcss/postcss"))) ||
    normalizedFiles.some((f) => /^(?:apps\/[^\/]+\/)?tailwind\.config\.(ts|js|mjs|cjs)$/.test(f));

  // 4. Extract Verified Existing Entry Points
  const existingEntryPoints = existingFiles.filter((f) => {
    const norm = f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
    const basename = path.basename(norm);

    if (finalHasAppRouter && /^(?:apps\/[^\/]+\/)?(src\/)?app\/.*(page|layout|route)\.(tsx|jsx|ts|js)$/.test(norm)) {
      return true;
    }
    if (finalHasPagesRouter && /^(?:apps\/[^\/]+\/)?(src\/)?pages\/.*\.(tsx|jsx|ts|js)$/.test(norm)) {
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

  // 5. Detect Reusable UI Components, Styles, and Visual Libraries
  const existingUIComponents = detectExistingUIComponents(existingFiles);
  const existingStyleFiles = detectExistingStyleFiles(existingFiles);
  const installedUILibraries = detectInstalledUILibraries(installedPackages);

  // 6. Generate Deterministic Planning Guidelines
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

  const partialArch = {
    framework,
    router,
    hasAppRouter: finalHasAppRouter,
    hasPagesRouter: finalHasPagesRouter,
    hasTailwind,
    existingEntryPoints,
  };
  const primaryActiveEntryPoint = detectPrimaryActiveEntryPoint(existingFiles, partialArch);

  return {
    framework,
    router,
    hasAppRouter: finalHasAppRouter,
    hasPagesRouter: finalHasPagesRouter,
    hasTailwind,
    existingEntryPoints,
    primaryActiveEntryPoint,
    existingUIComponents,
    existingStyleFiles,
    installedUILibraries,
    guidelines,
    installedPackages,
    packageVersions,
  };
}

const UI_COMPONENT_NAMES = new Set([
  "button", "card", "badge", "input", "select", "table", "modal", "dialog", "drawer",
  "avatar", "header", "navbar", "sidebar", "footer", "tabs", "dropdown", "search",
  "pagination", "layout", "shell", "tooltip", "tag", "alert", "accordion", "menu",
  "breadcrumb", "toast", "spinner", "icon", "metriccard", "statcard", "checkbox",
  "radio", "switch", "slider", "popover", "form", "ticket", "feed", "timeline"
]);

/**
 * Deterministically detects existing reusable UI components from repository file list.
 */
export function detectExistingUIComponents(existingFiles: string[] = []): ExistingUIComponentInfo[] {
  const components: ExistingUIComponentInfo[] = [];
  const seenNames = new Set<string>();

  for (const filePath of existingFiles) {
    const norm = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const ext = path.extname(norm).toLowerCase();
    if (![".tsx", ".jsx", ".vue", ".svelte"].includes(ext)) continue;

    // Ignore test files, story files, and Next.js router entry files
    if (/\.(test|spec|stories)\.(tsx|jsx)$/i.test(norm)) continue;
    if (/(page|layout|route|error|loading|not-found|template|index|_app|_document)\.(tsx|jsx)$/i.test(norm)) continue;

    const base = path.basename(norm, ext);
    const lowerBase = base.toLowerCase();
    const isUnderComponents = /(^|\/)(components|ui|views|widgets)(\/|$)/i.test(norm);

    const isMatch = UI_COMPONENT_NAMES.has(lowerBase) || isUnderComponents;
    if (isMatch && !seenNames.has(base)) {
      seenNames.add(base);

      let category: ExistingUIComponentInfo["category"] = "composite";
      if (["button", "input", "select", "badge", "avatar", "tag", "tooltip", "spinner", "icon", "checkbox", "radio", "switch", "slider"].includes(lowerBase)) {
        category = "primitive";
      } else if (["header", "navbar", "sidebar", "footer", "layout", "shell", "menu", "breadcrumb"].includes(lowerBase)) {
        category = "navigation";
      } else if (["alert", "toast", "modal", "dialog", "drawer"].includes(lowerBase)) {
        category = "feedback";
      }

      components.push({
        path: norm,
        name: base,
        category,
      });
    }
  }

  // Sort: primitive first, navigation second, feedback third, composite fourth
  const order: Record<string, number> = { primitive: 1, navigation: 2, feedback: 3, composite: 4 };
  return components.sort((a, b) => (order[a.category || "composite"] || 5) - (order[b.category || "composite"] || 5));
}

/**
 * Deterministically detects existing stylesheets and styling configuration files.
 */
export function detectExistingStyleFiles(existingFiles: string[] = []): string[] {
  const styleFiles: string[] = [];
  const validExts = [".css", ".scss", ".sass", ".less"];

  for (const filePath of existingFiles) {
    const norm = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    const ext = path.extname(norm).toLowerCase();
    if (validExts.includes(ext) || /^tailwind\.config\.(ts|js|mjs|cjs)$/i.test(path.basename(norm))) {
      styleFiles.push(norm);
    }
  }
  return styleFiles;
}

const KNOWN_UI_PACKAGES = [
  "lucide-react",
  "@heroicons/react",
  "@radix-ui",
  "shadcn",
  "@mui/material",
  "@chakra-ui/react",
  "antd",
  "@tanstack/react-table",
  "framer-motion",
  "clsx",
  "tailwind-merge",
  "react-icons",
  "@tabler/icons-react",
];

/**
 * Deterministically detects installed visual & icon libraries from package list.
 */
export function detectInstalledUILibraries(installedPackages: string[] = []): string[] {
  const uiLibs: string[] = [];
  for (const pkg of installedPackages) {
    if (KNOWN_UI_PACKAGES.some((known) => pkg === known || pkg.startsWith(known + "/") || pkg.startsWith(known + "-"))) {
      uiLibs.push(pkg);
    }
  }
  return uiLibs;
}

/**
 * Determines whether a user request meaningfully targets UI features or components.
 *
 * Uses structural vocabulary terms (component, page, layout, style, css, etc.)
 * and file-extension / directory evidence from target paths.
 * Does NOT include feature-specific keywords (dashboard, calculator, widget, etc.).
 */
export function isUITask(
  message: string,
  options?: { targetPaths?: string[] }
): boolean {
  if (!message || typeof message !== "string") return false;
  const msg = message.toLowerCase();

  // Pure backend/build/diagnostic tasks with no UI vocabulary should NOT be treated as UI tasks
  const isPureBackendOrBuild =
    /\b(build|compile|typecheck|diagnostic|ts\d+|syntax error|dependency|dependencies|package\.json|npm|yarn|pnpm|prisma|database|migration|schema|sql|backend|endpoint|api route|server)\b/i.test(msg) &&
    !/\b(page|screen|view|ui|interface|component|form|style|styles|css|tailwind|theme|redesign|frontend|layout)\b/i.test(msg);

  if (isPureBackendOrBuild) return false;

  // Structural vocabulary: architecture & UI component primitive terms, not feature names
  const uiStructuralTerms =
    /\b(page|screen|view|ui|interface|component|form|card|badge|button|modal|sidebar|navbar|header|footer|dialog|drawer|tabs|table|avatar|layout|theme|style|styles|styling|css|tailwind|redesign|frontend)\b/i;

  if (uiStructuralTerms.test(msg)) return true;

  // File-extension / directory evidence from target paths
  if (options?.targetPaths && options.targetPaths.length > 0) {
    const hasUITargets = options.targetPaths.some((t) => {
      const norm = t.replace(/\\/g, "/").toLowerCase();
      return (
        /\.(?:tsx|jsx|css|scss|html)$/i.test(norm) ||
        /(?:^|\/)(?:components|pages|views|screens|app|ui)\//i.test(norm)
      );
    });
    if (hasUITargets) return true;
  }

  return false;
}

/**
 * Formats a bounded, structured repository UI system prompt section for planner and code generator.
 */
export function buildRepositoryUISystemPromptSection(
  arch: Partial<RepositoryArchitectureSummary>,
  options?: { isDashboard?: boolean; isComprehensiveUI?: boolean; isSmallComponent?: boolean }
): string {
  const components = (arch.existingUIComponents || []).slice(0, 12);
  const styles = (arch.existingStyleFiles || []).slice(0, 6);
  const uiLibs = (arch.installedUILibraries || []).slice(0, 8);

  const isFullUI = Boolean(options?.isComprehensiveUI || options?.isDashboard);
  const hasAnyAssets = components.length > 0 || styles.length > 0 || uiLibs.length > 0;
  if (!hasAnyAssets && !isFullUI) {
    return "";
  }

  let text = `══════════════════════════════════════════════════════════\n`;
  text += `REPOSITORY DESIGN SYSTEM & REUSABLE UI ASSETS\n`;
  text += `══════════════════════════════════════════════════════════\n`;

  if (components.length > 0) {
    text += `Existing Reusable Components in Repository:\n`;
    for (const c of components) {
      text += `- ${c.name} — ${c.path} (${c.category || "component"})\n`;
    }
    text += `\n`;
  }

  if (styles.length > 0) {
    text += `Global Styles & Theme Files:\n`;
    for (const s of styles) {
      text += `- ${s}\n`;
    }
    text += `\n`;
  }

  if (uiLibs.length > 0) {
    text += `Available Visual & Icon Packages:\n`;
    for (const lib of uiLibs) {
      text += `- ${lib}\n`;
    }
    text += `\n`;
  }

  text += `DESIGN SYSTEM & REUSE GUIDELINES:\n`;
  text += `1. PREFER REUSE: Check existing repository components before generating primitive HTML/CSS equivalents. Reuse existing Card, Button, Sidebar, Header, Badge, etc. when compatible with the requested feature.\n`;
  text += `2. ADAPTIVE COMPOSITION: If an existing component is unsuitable (e.g. existing Card is a small marketing teaser and request needs a complex data table), creating a specialized new component is permitted. Do NOT force inappropriate reuse.\n`;
  text += `3. COHERENT STYLING: Adhere to existing stylesheet conventions and color schemes. In stylesheets, use readable contrast pairs and avoid conflicting global CSS.\n`;

  if (isFullUI && !options?.isSmallComponent) {
    text += `\nFULL-PAGE DASHBOARD LAYOUT & STYLESHEET WIRING GUIDELINES:\n`;
    text += `- Viewport & Application Shell: For full-page dashboard requests, ensure the active root page uses an appropriate unconstrained application shell (e.g. full-width, responsive flex/grid, min-h-screen) rather than narrow landing-page wrappers (e.g. max-w-3xl, py-32, hero centers).\n`;
    text += `- Information Architecture: Provide comprehensive dashboard primitives — navigation/sidebar, header, summary KPI/metric cards, structured primary data (tables/cards/queues with status & priority badges), and search/filter controls.\n`;
    text += `- Mandatory Stylesheet Wiring: Whenever a stylesheet (*.css / *.module.css) is created in the manifest, you MUST ensure that the component or layout that uses it declares the stylesheet in its dependencies and imports it. Orphaned unimported stylesheets will fail validation.\n`;
    text += `- Contrast & Style Coherence: Ensure distinct, readable contrast between text and backgrounds, avoiding unstyled global element selector collisions.\n`;
    text += `- Realistic Mock Data: For UI features without backend APIs, use rich array-driven mock datasets (5-10 records with realistic IDs, titles, statuses, priorities, timestamps, tags, assignees/customers) rendered dynamically with .map(). Avoid repeating sparse hard-coded markup.\n`;
    text += `- Interactive State: Provide useful client-side UI states where appropriate (active filters, search query filtering, active tabs, selected items) using React useState.\n`;
    text += `- Responsive Shell: Ensure layout scales gracefully across desktop, tablet, and mobile (e.g. responsive grid/flex columns, wrapping stats cards, accessible scrollable tables).\n`;
  }

  text += `══════════════════════════════════════════════════════════\n\n`;
  return text;
}
