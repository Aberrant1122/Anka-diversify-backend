import fs from "fs";
import path from "path";
import ts from "typescript";
import { normalizeRepoPath } from "./SemanticContextResolver";
import { repositoryPath } from "./RepositoryBoundary";
import { authoritySnapshot, AuthoritySnapshot } from "./AuthorityWorktree";

export interface ResolvedImportEdge {
  readonly sourceFile: string;
  readonly targetFile: string;
  readonly moduleSpecifier: string;
}

const importCache = new WeakMap<AuthoritySnapshot, Map<string, ResolvedImportEdge[]>>();
const astCache = new WeakMap<AuthoritySnapshot, Map<string, ts.SourceFile | null>>();
const configCache = new WeakMap<AuthoritySnapshot, Map<string, ts.CompilerOptions | null>>();

function snapshotText(snapshot: AuthoritySnapshot, root: string, absolute: string): string | undefined {
  if (!repositoryPath(root, path.relative(root, absolute))) return undefined;
  const encoded = snapshot.files.get(normalizeRepoPath(path.relative(root, absolute)));
  return encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8");
}

function boundedHost(root: string, snapshot: AuthoritySnapshot): ts.ParseConfigHost {
  const directoryExists = (directory: string): boolean => {
    if (path.resolve(directory) === path.resolve(root)) return true;
    const absolute = repositoryPath(root, path.relative(root, directory));
    return !!absolute && fs.statSync(absolute).isDirectory();
  };
  return {
    useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames,
    readDirectory: () => [], // Input discovery is irrelevant to module resolution.
    fileExists: (file) => snapshotText(snapshot, root, file) !== undefined,
    readFile: (file) => snapshotText(snapshot, root, file),
    directoryExists,
    getCurrentDirectory: () => root,
    realpath: (file) => repositoryPath(root, path.relative(root, file)) ? fs.realpathSync(file) : file,
  };
}

function readCompilerOptions(root: string, source: string, snapshot: AuthoritySnapshot): ts.CompilerOptions | null {
  const cache = configCache.get(snapshot) ?? new Map<string, ts.CompilerOptions | null>();
  configCache.set(snapshot, cache);
  const key = path.dirname(source);
  if (cache.has(key)) return cache.get(key)!;
  const result = parseCompilerOptions(root, source, snapshot);
  cache.set(key, result);
  return result;
}

function parseCompilerOptions(root: string, source: string, snapshot: AuthoritySnapshot): ts.CompilerOptions | null {
  const host = boundedHost(root, snapshot);
  let directory = path.dirname(source);
  for (;;) {
    for (const name of ["tsconfig.json", "jsconfig.json"]) {
      const config = path.join(directory, name);
      if (!host.fileExists(config)) continue;
      const read = ts.readConfigFile(config, host.readFile);
      if (read.error) return null;
      // TypeScript owns extends, inherited baseUrl/paths and fallback semantics.
      const parsed = ts.parseJsonConfigFileContent(read.config, host, directory, undefined, config);
      if (parsed.errors.some((d) => d.code !== 18003)) return null;
      return parsed.options;
    }
    if (path.resolve(directory) === path.resolve(root)) break;
    const parent = path.dirname(directory);
    if (parent === directory || !repositoryPath(root, path.relative(root, directory))) return null;
    directory = parent;
  }
  return { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Node10 };
}

function parsedSource(snapshot: AuthoritySnapshot, root: string, file: string): ts.SourceFile | null {
  const cache = astCache.get(snapshot) ?? new Map<string, ts.SourceFile | null>();
  astCache.set(snapshot, cache);
  if (cache.has(file)) return cache.get(file)!;
  const source = parseSource(snapshot, root, file);
  cache.set(file, source);
  return source;
}

function parseSource(snapshot: AuthoritySnapshot, root: string, file: string): ts.SourceFile | null {
  const content = snapshotText(snapshot, root, path.resolve(root, file));
  if (content === undefined) return null;
  const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  const diagnostics = (source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  if (!diagnostics || diagnostics.length > 0) return null;
  return source;
}

export function resolveLocalImportEdges(workspaceRoot: string, sourceFile: string): ResolvedImportEdge[] {
  const normalizedSource = normalizeRepoPath(sourceFile);
  const absoluteSource = repositoryPath(workspaceRoot, normalizedSource);
  if (!absoluteSource) return [];
  const snapshot = authoritySnapshot(workspaceRoot);
  const cache = importCache.get(snapshot) ?? new Map<string, ResolvedImportEdge[]>();
  importCache.set(snapshot, cache);
  if (cache.has(normalizedSource)) return cache.get(normalizedSource)!;
  const source = parsedSource(snapshot, workspaceRoot, normalizedSource);
  if (!source) return [];
  const options = readCompilerOptions(workspaceRoot, absoluteSource, snapshot);
  if (!options) return [];
  const host = boundedHost(workspaceRoot, snapshot);
  const imports = ts.preProcessFile(source.text, true, true).importedFiles;
  const edges = new Map<string, ResolvedImportEdge>();
  for (const imported of imports) {
    const resolved = ts.resolveModuleName(imported.fileName, absoluteSource, options, host).resolvedModule;
    let resolvedFileName: string | null = resolved && !resolved.isExternalLibraryImport
      ? resolved.resolvedFileName
      : null;

    // TypeScript intentionally does not resolve stylesheet side-effect imports.
    // Resolve only an exact, relative stylesheet already present in this
    // authority snapshot; package imports and extension guessing stay excluded.
    if (!resolvedFileName && imported.fileName.startsWith(".") && /\.(?:css|scss|sass|less)$/i.test(imported.fileName)) {
      const exactStylesheet = path.resolve(path.dirname(absoluteSource), imported.fileName);
      const relativeStylesheet = normalizeRepoPath(path.relative(workspaceRoot, exactStylesheet));
      if (repositoryPath(workspaceRoot, relativeStylesheet) && snapshot.files.has(relativeStylesheet)) {
        resolvedFileName = exactStylesheet;
      }
    }

    if (!resolvedFileName) continue;
    const targetFile = normalizeRepoPath(path.relative(workspaceRoot, resolvedFileName));
    if (!repositoryPath(workspaceRoot, targetFile) || !snapshot.files.has(targetFile) || targetFile === normalizedSource) continue;
    edges.set(targetFile, { sourceFile: normalizedSource, targetFile, moduleSpecifier: imported.fileName });
  }
  const result = [...edges.values()].sort((a, b) => a.targetFile.localeCompare(b.targetFile));
  cache.set(normalizedSource, result);
  return result;
}

/** Module ownership: top-level named declarations and local named/default exports.
 * Nested declarations, methods, destructuring and re-exported ownership fail closed.
 */
export function fileDefinesSymbol(workspaceRoot: string, filePath: string, symbol: string): boolean {
  const source = parsedSource(authoritySnapshot(workspaceRoot), workspaceRoot, normalizeRepoPath(filePath));
  if (!source || !symbol.trim()) return false;
  const owned = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) || ts.isEnumDeclaration(statement)) {
      if (statement.name) owned.add(statement.name.text);
      if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) owned.add("default");
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) owned.add(declaration.name.text);
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) owned.add("default");
  }
  for (const statement of source.statements) {
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) if (owned.has((element.propertyName ?? element.name).text)) owned.add(element.name.text);
    }
  }
  return owned.has(symbol);
}
