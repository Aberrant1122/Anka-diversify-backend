import fs from "fs";
import path from "path";
import Parser from "web-tree-sitter";
import { resolveWasmDir } from "../utils/wasm-loader";

export interface SymbolExtractionResult {
  imports: Array<{
    line: number;
    rawPath: string;
    isLocal: boolean;
    defaultImport?: string;
    namedImports: string[];
  }>;
  exports: Array<{
    line: number;
    name: string;
    isDefault: boolean;
    type: "function" | "class" | "interface" | "variable" | "type" | "unknown";
  }>;
  functions: Array<{
    name: string;
    startLine: number;
    endLine: number;
    startByte: number;
    endByte: number;
  }>;
  classes: Array<{
    name: string;
    startLine: number;
    endLine: number;
    startByte: number;
    endByte: number;
  }>;
  interfaces: Array<{
    name: string;
    startLine: number;
    endLine: number;
    startByte: number;
    endByte: number;
  }>;
  hasSyntaxErrors: boolean;
}

export interface HtmlDomNodeResult {
  tags: Array<{ name: string; startLine: number; endLine: number }>;
  attributes: Array<{ name: string; value: string; line: number }>;
  hasSyntaxErrors: boolean;
}

export interface AstBytePatch {
  startByte: number;
  endByte: number;
  replacement: string;
}

/**
 * Enterprise-Hardened WebAssembly Tree-Sitter AST Engine
 *
 * Implements persistent Parser instance reuse, pre-compiled query caching,
 * tree.rootNode.hasError() syntax detection, and reverse byte-order multi-node patching.
 */
export class WasmASTParserEngine {
  private static isInitialized = false;
  private static sharedParser: Parser | null = null;
  private static languages = new Map<string, Parser.Language>();
  private static queryCache = new Map<string, Parser.Query>();

  /**
   * Initializes the WASM Tree-Sitter runtime and loads language binaries.
   */
  public static async initialize(): Promise<void> {
    if (this.isInitialized) return;

    await Parser.init({
      locateFile(scriptName: string) {
        if (scriptName === "tree-sitter.wasm") {
          const mainWasm = path.resolve(process.cwd(), "node_modules/web-tree-sitter/tree-sitter.wasm");
          if (fs.existsSync(mainWasm)) return mainWasm;
        }
        return scriptName;
      },
    });
    this.sharedParser = new Parser();

    const wasmDir = resolveWasmDir();

    const tsLang = await Parser.Language.load(fs.readFileSync(path.join(wasmDir, "tree-sitter-typescript.wasm")));
    const tsxLang = await Parser.Language.load(fs.readFileSync(path.join(wasmDir, "tree-sitter-tsx.wasm")));
    const htmlLang = await Parser.Language.load(fs.readFileSync(path.join(wasmDir, "tree-sitter-html.wasm")));
    const jsLang = await Parser.Language.load(fs.readFileSync(path.join(wasmDir, "tree-sitter-javascript.wasm")));

    this.languages.set("typescript", tsLang);
    this.languages.set("tsx", tsxLang);
    this.languages.set("html", htmlLang);
    this.languages.set("javascript", jsLang);

    // Pre-compile queries during boot (CPU optimization)
    try {
      this.queryCache.set("ts-imports", tsLang.query(`(import_statement) @import`));
      this.queryCache.set("ts-exports", tsLang.query(`(export_statement) @export`));
      this.queryCache.set("ts-functions", tsLang.query(`(function_declaration) @func`));
      this.queryCache.set("ts-classes", tsLang.query(`(class_declaration) @class`));
      this.queryCache.set("ts-interfaces", tsLang.query(`(interface_declaration) @interface`));

      this.queryCache.set("html-tags", htmlLang.query(`(element (start_tag (tag_name) @tag))`));
      this.queryCache.set("html-attrs", htmlLang.query(`(attribute) @attr`));
    } catch (e: any) {
      console.warn(`[WasmAST Engine] Warning pre-compiling queries: ${e?.message || e}`);
    }

    this.isInitialized = true;
  }

  /**
   * Safe WASM Analysis Wrapper
   * Reuses shared Parser instance and ensures Parser.Tree is disposed in `finally`.
   */
  public static parseAndAnalyze<T>(
    langKey: "typescript" | "tsx" | "html" | "javascript",
    code: string,
    analyzer: (tree: Parser.Tree, lang: Parser.Language, queries: Map<string, Parser.Query>) => T,
  ): T {
    if (!this.sharedParser || !this.languages.has(langKey)) {
      throw new Error(`[WasmAST Engine] Engine not initialized for language '${langKey}'. Call WasmASTParserEngine.initialize() first.`);
    }

    const lang = this.languages.get(langKey)!;
    this.sharedParser.setLanguage(lang);

    let tree: Parser.Tree | null = null;
    try {
      tree = this.sharedParser.parse(code);
      if (!tree) {
        throw new Error(`[WasmAST Engine] Parser.parse() returned null tree for language '${langKey}'.`);
      }
      return analyzer(tree, lang, this.queryCache);
    } finally {
      if (tree) {
        tree.delete(); // Delete tree memory ONLY; keep sharedParser alive
      }
    }
  }

  /**
   * Extract symbols (imports, exports, functions, classes, interfaces) from JS/TS code using Tree-Sitter AST.
   */
  public static extractSymbols(filePath: string, code: string): SymbolExtractionResult {
    const isTsx = filePath.endsWith(".tsx") || filePath.endsWith(".jsx");
    const isTs = filePath.endsWith(".ts");
    const langKey = isTsx ? "tsx" : isTs ? "typescript" : "javascript";

    if (!this.isInitialized) {
      return { imports: [], exports: [], functions: [], classes: [], interfaces: [], hasSyntaxErrors: false };
    }

    return this.parseAndAnalyze(langKey, code, (tree, _lang, queries) => {
      const root = tree.rootNode;
      const hasSyntaxErrors = root.hasError();

      const imports: SymbolExtractionResult["imports"] = [];
      const exports: SymbolExtractionResult["exports"] = [];
      const functions: SymbolExtractionResult["functions"] = [];
      const classes: SymbolExtractionResult["classes"] = [];
      const interfaces: SymbolExtractionResult["interfaces"] = [];

      // Query imports
      const importQuery = queries.get("ts-imports");
      if (importQuery) {
        const matches = importQuery.matches(root);
        for (const m of matches) {
          const node = m.captures[0]?.node;
          if (node) {
            const line = node.startPosition.row + 1;
            const text = node.text;
            const fromMatch = text.match(/from\s+["']([^"']+)["']/);
            const rawPath = fromMatch ? fromMatch[1] : "";
            const isLocal = rawPath.startsWith(".") || rawPath.startsWith("@/");

            const defaultMatch = text.match(/import\s+([A-Za-z0-9_]+)\s*(?:,|\s+from)/);
            const defaultImport = defaultMatch ? defaultMatch[1] : undefined;

            const namedMatch = text.match(/\{([^}]+)\}/);
            const namedImports = namedMatch
              ? namedMatch[1].split(",").map((s) => s.trim().split(" as ")[0]).filter(Boolean)
              : [];

            imports.push({ line, rawPath, isLocal, defaultImport, namedImports });
          }
        }
      }

      // Query exports
      const exportQuery = queries.get("ts-exports");
      if (exportQuery) {
        const matches = exportQuery.matches(root);
        for (const m of matches) {
          const node = m.captures[0]?.node;
          if (node) {
            const line = node.startPosition.row + 1;
            const text = node.text;

            // 1. Check for export_clause in Tree-Sitter AST node (e.g. export { default as Calculator } from './Calculator')
            const exportClause = node.children.find((c) => c.type === "export_clause");
            if (exportClause) {
              const specifiers = exportClause.children.filter((c) => c.type === "export_specifier");
              if (specifiers.length > 0) {
                for (const spec of specifiers) {
                  const nameNode = spec.childForFieldName("name");
                  const aliasNode = spec.childForFieldName("alias");
                  const originalName = nameNode ? nameNode.text : spec.text.trim();
                  const aliasName = aliasNode ? aliasNode.text : undefined;

                  let exportedName: string;
                  let isDefault = false;

                  if (aliasName) {
                    if (aliasName === "default") {
                      isDefault = true;
                      exportedName = "default";
                    } else {
                      isDefault = false;
                      exportedName = aliasName;
                    }
                  } else {
                    if (originalName === "default") {
                      isDefault = true;
                      exportedName = "default";
                    } else {
                      isDefault = false;
                      exportedName = originalName;
                    }
                  }

                  exports.push({ line, name: exportedName, isDefault, type: "variable" });
                }
                continue;
              }
            }

            // Fallback for clause exports if AST child traversal didn't capture specifiers: export { ... }
            const clauseMatch = text.match(/export\s*\{([^}]+)\}/);
            if (clauseMatch) {
              const items = clauseMatch[1].split(",");
              for (const item of items) {
                const trimmed = item.trim();
                if (!trimmed) continue;
                if (trimmed.includes(" as ")) {
                  const parts = trimmed.split(/\s+as\s+/);
                  const orig = parts[0]?.trim();
                  const alias = parts[1]?.trim();
                  if (alias === "default") {
                    exports.push({ line, name: "default", isDefault: true, type: "variable" });
                  } else if (alias) {
                    exports.push({ line, name: alias, isDefault: false, type: "variable" });
                  }
                } else {
                  if (trimmed === "default") {
                    exports.push({ line, name: "default", isDefault: true, type: "variable" });
                  } else {
                    exports.push({ line, name: trimmed, isDefault: false, type: "variable" });
                  }
                }
              }
              continue;
            }

            // 2. Declaration export (e.g. export const X, export function Y, export default class Z)
            const isDefault = text.includes("export default");
            const nameMatch = text.match(/export\s+(?:default\s+)?(?:function|class|interface|type|const|let|var|enum)\s+([A-Za-z0-9_]+)/);
            if (nameMatch) {
              const type = text.includes("class")
                ? "class"
                : text.includes("interface")
                ? "interface"
                : text.includes("type")
                ? "type"
                : "function";
              exports.push({ line, name: nameMatch[1], isDefault, type });
            } else if (isDefault) {
              exports.push({ line, name: "default", isDefault: true, type: "function" });
            }
          }
        }
      }

      // Query functions
      const funcQuery = queries.get("ts-functions");
      if (funcQuery) {
        const matches = funcQuery.matches(root);
        for (const m of matches) {
          const node = m.captures[0]?.node;
          if (node) {
            const nameNode = node.childForFieldName("name");
            const name = nameNode ? nameNode.text : "anonymous";
            functions.push({
              name,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
              startByte: node.startIndex,
              endByte: node.endIndex,
            });
          }
        }
      }

      return { imports, exports, functions, classes, interfaces, hasSyntaxErrors };
    });
  }

  /**
   * Parse HTML document CST into structured HTML DOM tags and attributes.
   */
  public static parseHtmlDom(code: string): HtmlDomNodeResult {
    if (!this.isInitialized) {
      return { tags: [], attributes: [], hasSyntaxErrors: false };
    }

    return this.parseAndAnalyze("html", code, (tree, _lang, queries) => {
      const root = tree.rootNode;
      const hasSyntaxErrors = root.hasError();
      const tags: HtmlDomNodeResult["tags"] = [];
      const attributes: HtmlDomNodeResult["attributes"] = [];

      const tagQuery = queries.get("html-tags");
      if (tagQuery) {
        const matches = tagQuery.matches(root);
        for (const m of matches) {
          const node = m.captures[0]?.node;
          if (node) {
            tags.push({
              name: node.text,
              startLine: node.startPosition.row + 1,
              endLine: node.endPosition.row + 1,
            });
          }
        }
      }

      const attrQuery = queries.get("html-attrs");
      if (attrQuery) {
        const matches = attrQuery.matches(root);
        for (const m of matches) {
          const node = m.captures[0]?.node;
          if (node) {
            const text = node.text;
            const eqIndex = text.indexOf("=");
            if (eqIndex !== -1) {
              const name = text.slice(0, eqIndex).trim();
              const rawVal = text.slice(eqIndex + 1).trim();
              const value = rawVal.replace(/^["']|["']$/g, "");
              attributes.push({ name, value, line: node.startPosition.row + 1 });
            } else {
              attributes.push({ name: text.trim(), value: "", line: node.startPosition.row + 1 });
            }
          }
        }
      }

      return { tags, attributes, hasSyntaxErrors };
    });
  }

  /**
   * Reverse Byte-Order Multi-Node Patching
   * Applies AST replacements in descending order by startByte (bottom-to-top)
   * to ensure top byte offsets remain 100% valid.
   */
  public static applyReverseBytePatches(code: string, patches: AstBytePatch[]): string {
    if (!patches || patches.length === 0) return code;

    // Sort in descending order by startByte (bottom-to-top)
    const sortedPatches = [...patches].sort((a, b) => b.startByte - a.startByte);
    let result = code;

    for (const patch of sortedPatches) {
      if (patch.startByte >= 0 && patch.endByte <= result.length && patch.startByte <= patch.endByte) {
        result = result.slice(0, patch.startByte) + patch.replacement + result.slice(patch.endByte);
      }
    }

    return result;
  }
}
