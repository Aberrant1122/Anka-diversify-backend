import path from "path";
import ts from "typescript";
import { normalizeRepoPath } from "./SemanticContextResolver";

export interface FrameworkRouteDescriptor {
  readonly filePath: string;
  readonly routingScope: string;
  readonly routePattern: string;
  readonly framework: "NEXT_APP_ROUTER" | "NEXT_PAGES_ROUTER";
}

const ROUTE_FILE_EXTENSIONS = /\.(?:js|jsx|ts|tsx)$/i;

/** Config wrappers, computed keys and custom routing require framework execution.
 * Do not guess their effect when constructing an authorization root. */
export function supportsStaticRouteDiscovery(files: ReadonlyMap<string, string>): boolean {
  for (const [file, encoded] of files) {
    if (/(?:^|\/)(?:middleware|proxy)\.[cm]?[jt]s$/.test(file)) return false;
    if (!/(?:^|\/)next\.config\.[cm]?[jt]s$/.test(file)) continue;
    const source = ts.createSourceFile(file, Buffer.from(encoded, "base64").toString("utf8"), ts.ScriptTarget.Latest, true);
    if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) return false;
    let executableConfig = false;
    const inspect = (node: ts.Node): void => {
      if (ts.isCallExpression(node) || ts.isNewExpression(node) || ts.isElementAccessExpression(node) ||
          ts.isDeleteExpression(node) || ts.isPostfixUnaryExpression(node) ||
          (ts.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)) ||
          (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly)) executableConfig = true;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment && !(node.operatorToken.kind === ts.SyntaxKind.EqualsToken && node.left.getText(source) === "module.exports")) executableConfig = true;
      ts.forEachChild(node, inspect);
    };
    inspect(source);
    if (executableConfig) return false;
    const locals = new Map<string, ts.Expression>();
    let config: ts.Expression | undefined;
    for (const statement of source.statements) {
      const moduleExport = ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && statement.expression.left.getText(source) === "module.exports";
      if (!ts.isVariableStatement(statement) && !ts.isExportAssignment(statement) && !ts.isImportDeclaration(statement) &&
          !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement) && !moduleExport) return false;
      if (ts.isVariableStatement(statement)) for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) locals.set(d.name.text, d.initializer);
      }
      if (ts.isExportAssignment(statement)) config = statement.expression;
      if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression) && statement.expression.left.getText(source) === "module.exports") config = statement.expression.right;
    }
    const seen = new Set<string>();
    while (config) {
      if (ts.isAsExpression(config) || ts.isSatisfiesExpression(config) || ts.isParenthesizedExpression(config)) { config = config.expression; continue; }
      if (!ts.isIdentifier(config)) break;
      if (seen.has(config.text)) return false;
      seen.add(config.text); config = locals.get(config.text);
    }
    if (!config || !ts.isObjectLiteralExpression(config)) return false;
    for (const property of config.properties) {
      if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) return false;
      const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
      if (!name || ["rewrites", "redirects", "basePath", "i18n", "pageExtensions", "useFileSystemPublicRoutes", "__proto__"].includes(name)) return false;
    }
  }
  return true;
}

function normalizedSegments(filePath: string): string[] {
  return normalizeRepoPath(filePath).split("/").filter(Boolean);
}

function isRouteGroup(segment: string): boolean {
  return /^\([^.)][^)]*\)$/.test(segment);
}

/** Derives only route forms represented by ANKA's Next.js repository index. */
export function describeFrameworkRoute(filePath: string): FrameworkRouteDescriptor | null {
  const normalized = normalizeRepoPath(filePath);
  const segments = normalizedSegments(normalized);
  const fileName = segments[segments.length - 1] || "";

  // Known Next roots only; arbitrary nested folders named app/pages are not projects.
  const routeRoot = /^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/)?(app|pages)\//.exec(normalized);
  if (!routeRoot) return null;
  const rootIndex = routeRoot[0].split("/").length - 2;
  const appIndex = routeRoot[1] === "app" ? rootIndex : -1;
  if (appIndex >= 0 && /^page\.(?:js|jsx|ts|tsx)$/i.test(fileName)) {
    const routeSegments: string[] = [];
    for (const segment of segments.slice(appIndex + 1, -1)) {
      if (segment.startsWith("@") || segment.startsWith("_")) return null;
      if (isRouteGroup(segment)) continue;
      // Intercepting routes need parent-layout context that the current index
      // does not represent. They therefore fail closed for authority.
      if (/^\(\.\.?.*\)/.test(segment)) return null;
      routeSegments.push(segment);
    }
    return {
      filePath: normalized,
      routingScope: segments.slice(0, appIndex).filter((segment, index, list) => !(segment === "src" && index === list.length - 1)).join("/"),
      routePattern: `/${routeSegments.join("/")}`.replace(/\/$/, "") || "/",
      framework: "NEXT_APP_ROUTER",
    };
  }

  const pagesIndex = routeRoot[1] === "pages" ? rootIndex : -1;
  if (
    pagesIndex >= 0 &&
    ROUTE_FILE_EXTENSIONS.test(fileName) &&
    !segments.slice(pagesIndex + 1).includes("api") &&
    !/^(?:_(?:app|document|error)|404|500)\./i.test(fileName)
  ) {
    const routeSegments = segments.slice(pagesIndex + 1);
    routeSegments[routeSegments.length - 1] = path.posix.basename(fileName, path.posix.extname(fileName));
    if (routeSegments[routeSegments.length - 1] === "index") routeSegments.pop();
    return {
      filePath: normalized,
      routingScope: segments.slice(0, pagesIndex).filter((segment, index, list) => !(segment === "src" && index === list.length - 1)).join("/"),
      routePattern: `/${routeSegments.join("/")}`.replace(/\/$/, "") || "/",
      framework: "NEXT_PAGES_ROUTER",
    };
  }

  return null;
}

function splitRoute(route: string): string[] | null {
  try {
    const pathname = route.startsWith("http://") || route.startsWith("https://")
      ? new URL(route).pathname
      : route.split(/[?#]/, 1)[0];
    if (!pathname.startsWith("/") || pathname.includes("\\") || pathname.includes("\0")) return null;
    if (pathname.includes("//")) return null;
    const segments = pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    if (segments.some((segment) => segment === "." || segment === ".." || /[\\/\0]/.test(segment))) return null;
    return segments;
  } catch {
    return null;
  }
}

/** Exact framework-segment matching; no fuzzy score participates in authority. */
export function frameworkRouteMatches(routePattern: string, runtimeRoute: string): boolean {
  const patternSegments = splitRoute(routePattern);
  const runtimeSegments = splitRoute(runtimeRoute);
  if (!patternSegments || !runtimeSegments) return false;

  let patternIndex = 0;
  let runtimeIndex = 0;
  while (patternIndex < patternSegments.length) {
    const segment = patternSegments[patternIndex];
    if (/^\[\[\.\.\.[^\]]+\]\]$/.test(segment)) {
      return patternIndex === patternSegments.length - 1;
    }
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
      return patternIndex === patternSegments.length - 1 && runtimeIndex < runtimeSegments.length;
    }
    if (runtimeIndex >= runtimeSegments.length) return false;
    if (!/^\[[^\]]+\]$/.test(segment) && segment !== runtimeSegments[runtimeIndex]) return false;
    patternIndex++;
    runtimeIndex++;
  }
  return runtimeIndex === runtimeSegments.length;
}

/** Lexicographic segment precedence from Next's routing tree, never relevance scoring. */
export function selectFrameworkRoutes(descriptors: readonly FrameworkRouteDescriptor[], runtimeRoute: string): FrameworkRouteDescriptor[] {
  const matches = descriptors.filter((d) => frameworkRouteMatches(d.routePattern, runtimeRoute));
  if (new Set(matches.map((d) => d.routingScope)).size > 1) return matches;
  const category = (segment: string | undefined): number => segment === undefined ? 4
    : /^\[\[\.\.\./.test(segment) ? 0 : /^\[\.\.\./.test(segment) ? 1 : /^\[/.test(segment) ? 2 : 3;
  const compare = (a: FrameworkRouteDescriptor, b: FrameworkRouteDescriptor): number => {
    const left = splitRoute(a.routePattern)!; const right = splitRoute(b.routePattern)!;
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      const difference = category(right[i]) - category(left[i]);
      if (difference) return difference;
    }
    return 0;
  };
  matches.sort(compare);
  return matches.length ? matches.filter((d) => compare(matches[0], d) === 0) : [];
}
