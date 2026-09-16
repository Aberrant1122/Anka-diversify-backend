import ts from "typescript";
import { authoritySnapshot } from "./AuthorityWorktree";
import { resolveLocalImportEdges } from "./DeterministicImportResolver";
import { normalizeRepoPath } from "./SemanticContextResolver";

export interface StaticApiRegistration {
  readonly registrationFile: string;
  readonly routeFile: string;
  readonly routePrefix: string;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const API_SOURCE_PATH = /(?:^|\/)(?:routes?|routers?|controllers?|server|app|api)(?:\/|\.|$)/i;

function staticText(node: ts.Expression | undefined): string | null {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
}

function propertyName(call: ts.CallExpression): string | null {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text.toLowerCase() : null;
}

function importedBindings(
  source: ts.SourceFile,
  workspaceRoot: string,
  sourceFile: string,
): ReadonlyMap<string, string> {
  const edgeBySpecifier = new Map(resolveLocalImportEdges(workspaceRoot, sourceFile).map((edge) => [edge.moduleSpecifier, edge.targetFile]));
  const bindings = new Map<string, string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = edgeBySpecifier.get(statement.moduleSpecifier.text);
      if (!target || !statement.importClause) continue;
      if (statement.importClause.name) bindings.set(statement.importClause.name.text, target);
      const named = statement.importClause.namedBindings;
      if (named && ts.isNamespaceImport(named)) bindings.set(named.name.text, target);
      if (named && ts.isNamedImports(named)) for (const element of named.elements) bindings.set(element.name.text, target);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isCallExpression(declaration.initializer)) continue;
      const requireCall = declaration.initializer;
      if (!ts.isIdentifier(requireCall.expression) || requireCall.expression.text !== "require") continue;
      const specifier = staticText(requireCall.arguments[0]);
      const target = specifier ? edgeBySpecifier.get(specifier) : undefined;
      if (target) bindings.set(declaration.name.text, target);
    }
  }
  return bindings;
}

function prefixFromOptions(node: ts.Expression | undefined): string | null {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? property.name.text : "";
    if (name === "prefix") return staticText(property.initializer);
  }
  return null;
}

/**
 * Discovers only statically declared JavaScript/TypeScript API composition.
 * Dynamic paths, computed handlers and unresolved imports deliberately fail closed.
 */
export function discoverStaticApiRegistrations(workspaceRoot: string): readonly StaticApiRegistration[] {
  const snapshot = authoritySnapshot(workspaceRoot);
  const registrations = new Map<string, StaticApiRegistration>();
  for (const [rawFile, encoded] of snapshot.files) {
    const file = normalizeRepoPath(rawFile);
    if (!/\.[cm]?[jt]sx?$/i.test(file) || !API_SOURCE_PATH.test(file)) continue;
    const source = ts.createSourceFile(file, Buffer.from(encoded, "base64").toString("utf8"), ts.ScriptTarget.Latest, true);
    const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
    if (diagnostics?.length) continue;
    const bindings = importedBindings(source, workspaceRoot, file);

    const record = (routePrefix: string | null, routeFile: string | undefined): void => {
      if (!routePrefix || !routePrefix.startsWith("/") || routePrefix.includes("*") || !routeFile) return;
      const normalizedRouteFile = normalizeRepoPath(routeFile);
      const value = { registrationFile: file, routeFile: normalizedRouteFile, routePrefix };
      registrations.set(`${file}:${normalizedRouteFile}:${routePrefix}`, value);
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const method = propertyName(node);
        if (method === "use") {
          const route = staticText(node.arguments[0]);
          const handler = node.arguments[1];
          record(route, handler && ts.isIdentifier(handler) ? bindings.get(handler.text) : undefined);
        } else if (method === "register") {
          const handler = node.arguments[0];
          record(prefixFromOptions(node.arguments[1]), handler && ts.isIdentifier(handler) ? bindings.get(handler.text) : undefined);
        } else if ((method && HTTP_METHODS.has(method)) || method === "route") {
          const route = staticText(node.arguments[0]);
          record(route, file);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return Object.freeze([...registrations.values()].sort((a, b) =>
    `${a.routePrefix}:${a.routeFile}:${a.registrationFile}`.localeCompare(`${b.routePrefix}:${b.routeFile}:${b.registrationFile}`),
  ));
}

export function routeResourceTokens(routePrefix: string): readonly string[] {
  return routePrefix.toLowerCase().split("/").flatMap((segment) => segment.split(/[^a-z0-9]+/)).filter((token) =>
    token.length > 1 && !/^(?:api|v\d+)$/.test(token) && !token.startsWith(":"),
  );
}

export function taskWordTokens(task: string): ReadonlySet<string> {
  return new Set((task.toLowerCase().match(/[a-z0-9]+/g) || []).filter((token) => token.length > 1));
}

export function isApiArchitectureTask(task: string): boolean {
  return /\b(?:api|endpoint|route|router|controller|service|http|request|response|server)\b/i.test(task);
}

export function testExercisesRoute(source: string, routePrefix: string): boolean {
  const escaped = routePrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\/$/, "");
  if (!escaped) return false;
  return new RegExp(`\\.(?:get|post|put|patch|delete|options|head)\\s*\\(\\s*["']${escaped}(?:[/?:][^"']*)?["']`, "i").test(source);
}
