import path from "path";
import { ExtendedKnowledgeGraph, ComponentKnowledgeNode } from "../shared/types";

export class RepositoryKnowledgeGraph {
  static skeletonizeDependencyFile(content: string): string {
    const lines = content.split("\n");
    const skeletonLines: string[] = [];
    let braceDepth = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed.startsWith("import ") ||
        trimmed.startsWith("export interface ") ||
        trimmed.startsWith("interface ") ||
        trimmed.startsWith("export type ") ||
        trimmed.startsWith("type ") ||
        trimmed.startsWith("export enum ") ||
        trimmed.startsWith("enum ")
      ) {
        skeletonLines.push(line);
        continue;
      }

      if (trimmed.startsWith("export class ") || trimmed.startsWith("class ")) {
        skeletonLines.push(line);
        continue;
      }

      if (trimmed.startsWith("export declare ") || trimmed.startsWith("declare ")) {
        skeletonLines.push(line);
        continue;
      }

      if (
        (trimmed.startsWith("export function ") ||
          trimmed.startsWith("public ") ||
          trimmed.startsWith("private ") ||
          trimmed.startsWith("protected ")) &&
        trimmed.includes("{")
      ) {
        const signature = line.substring(0, line.indexOf("{")).trim() + " { /* skeletonized body */ }";
        skeletonLines.push(signature);
        continue;
      }

      if (braceDepth === 0) {
        skeletonLines.push(line);
      }

      braceDepth += (line.match(/\{/g) || []).length;
      braceDepth -= (line.match(/\}/g) || []).length;
      if (braceDepth < 0) braceDepth = 0;
    }

    return skeletonLines.slice(0, 150).join("\n");
  }

  static async buildKnowledgeGraph(snapshot: any): Promise<ExtendedKnowledgeGraph> {
    const keyFiles: Array<{ path: string; content?: string }> = snapshot?.keyFiles || [];
    const dependencyGraph: Record<string, string[]> = {};
    const exports: Array<{ file: string; kind: string; symbol: string }> = [];
    const imports: Array<{ file: string; source: string; importedSymbols: string[] }> = [];
    const componentNodes: Record<string, ComponentKnowledgeNode> = {};

    for (const file of keyFiles) {
      const pathStr = file.path;
      const content = file.content || "";
      const fileImports: string[] = [];

      const importMatches = content.matchAll(/import\s+(?:\{([^}]+)\}|([A-Za-z0-9_]+))\s+from\s+["']([^"']+)["']/g);
      for (const match of importMatches) {
        const namedSymbols = match[1] ? match[1].split(",").map((s) => s.trim().split(" as ")[0]) : [];
        const defaultSymbol = match[2] ? [match[2].trim()] : [];
        const importedSymbols = [...defaultSymbol, ...namedSymbols].filter(Boolean);
        const source = match[3];

        fileImports.push(source);
        imports.push({ file: pathStr, source, importedSymbols });
      }
      dependencyGraph[pathStr] = fileImports;

      const exportMatches = content.matchAll(/export\s+(default\s+)?(interface|class|function|type|const)\s+([A-Za-z0-9_]+)/g);
      for (const match of exportMatches) {
        const isDefault = Boolean(match[1]);
        const kind = match[2];
        const symbol = match[3];
        exports.push({ file: pathStr, kind, symbol });

        const isPascalCase = /^[A-Z][A-Za-z0-9]*$/.test(symbol);
        const isComponentFile =
          pathStr.includes("components") ||
          pathStr.endsWith(".tsx") ||
          pathStr.endsWith(".jsx") ||
          pathStr.includes("app/") ||
          pathStr.includes("pages/");

        if (isPascalCase && isComponentFile && (kind === "function" || kind === "const" || kind === "class")) {
          componentNodes[symbol] = {
            component: symbol,
            file: pathStr,
            exportKind: isDefault ? "default" : "named",
            whoImportsIt: [],
            whoRendersIt: [],
            whichRouteOwnsIt: null,
            isReachable: false,
            reachabilityReason: "",
            canUserNavigateToIt: false,
            navigationTriggers: [],
          };
        }
      }
    }

    for (const [compName, node] of Object.entries(componentNodes)) {
      const compFile = node.file;
      const compBase = path.basename(compFile, path.extname(compFile));

      for (const file of keyFiles) {
        if (file.path === compFile) continue;
        const content = file.content || "";

        const referencesComp = content.includes(compBase) || content.includes(compName);
        if (referencesComp) {
          const importSymbolMatch = new RegExp(`import\\s+[^"']*\\b${compName}\\b[^"']*from`, "g").test(content);
          if (importSymbolMatch || content.includes(`from "${compBase}"`) || content.includes(`from '${compBase}'`)) {
            node.whoImportsIt.push({
              file: file.path,
              importedSymbols: [compName],
            });
          }

          const jsxRegex = new RegExp(`<${compName}(\\s|>|\\/)`, "g");
          if (jsxRegex.test(content)) {
            const parentMatch =
              content.match(/(?:export\s+(?:default\s+)?)?function\s+([A-Za-z0-9_]+)/) ||
              content.match(/const\s+([A-Za-z0-9_]+)\s*=\s*(?:\([^)]*\)|[A-Za-z0-9_]+)\s*=>/);
            const parentComponent = parentMatch ? parentMatch[1] : path.basename(file.path, path.extname(file.path));

            node.whoRendersIt.push({
              file: file.path,
              parentComponent,
              jsxTag: `<${compName}>`,
            });
          }
        }
      }
    }

    const routeFileMap: Array<{ file: string; routePath: string }> = [];
    for (const file of keyFiles) {
      const p = file.path.replace(/\\/g, "/");
      if (p.includes("app/") && (p.endsWith("page.tsx") || p.endsWith("page.jsx") || p.endsWith("page.js"))) {
        let routePath = p.split("app/")[1].replace(/\/page\.(tsx|jsx|js)$/, "");
        routePath = routePath ? `/${routePath}` : "/";
        routeFileMap.push({ file: file.path, routePath });
      } else if (p.includes("pages/") && !p.includes("pages/api/") && !p.includes("_app") && !p.includes("_document")) {
        let routePath = p.split("pages/")[1].replace(/\.(tsx|jsx|js)$/, "");
        routePath = routePath === "index" ? "/" : `/${routePath}`;
        routeFileMap.push({ file: file.path, routePath });
      }
    }

    for (const node of Object.values(componentNodes)) {
      const directRoute = routeFileMap.find((r) => r.file === node.file);
      if (directRoute) {
        node.whichRouteOwnsIt = { routeFile: directRoute.file, routePath: directRoute.routePath };
      } else {
        for (const renderRef of node.whoRendersIt) {
          const parentRoute = routeFileMap.find((r) => r.file === renderRef.file);
          if (parentRoute) {
            node.whichRouteOwnsIt = { routeFile: parentRoute.file, routePath: parentRoute.routePath };
            break;
          }
        }
        if (!node.whichRouteOwnsIt) {
          for (const importRef of node.whoImportsIt) {
            const parentRoute = routeFileMap.find((r) => r.file === importRef.file);
            if (parentRoute) {
              node.whichRouteOwnsIt = { routeFile: parentRoute.file, routePath: parentRoute.routePath };
              break;
            }
          }
        }
      }
    }

    for (const node of Object.values(componentNodes)) {
      if (node.whichRouteOwnsIt) {
        node.isReachable = true;
        node.reachabilityReason = `Reachable via active route "${node.whichRouteOwnsIt.routePath}" (${path.basename(node.whichRouteOwnsIt.routeFile)})`;
      } else if (node.whoRendersIt.length > 0) {
        node.isReachable = true;
        node.reachabilityReason = `Rendered by ${node.whoRendersIt.map((r) => r.parentComponent).join(", ")}`;
      } else if (node.whoImportsIt.length > 0) {
        node.isReachable = true;
        node.reachabilityReason = `Imported by ${node.whoImportsIt.map((i) => path.basename(i.file)).join(", ")}`;
      } else {
        node.isReachable = false;
        node.reachabilityReason = `Orphaned / Unused component (no active route or parent component imports/renders it)`;
      }
    }

    const navigationElements: Array<{ file: string; type: "Link" | "router.push" | "nav_item" | "anchor"; targetHref: string }> = [];
    for (const file of keyFiles) {
      const content = file.content || "";
      const linkMatches = content.matchAll(/href=["'`](\/[^"'`\s]*)["'`]/g);
      for (const m of linkMatches) {
        navigationElements.push({ file: file.path, type: "Link", targetHref: m[1] });
      }
      const routerMatches = content.matchAll(/router\.(?:push|replace)\(["'`](\/[^"'`\s]*)["'`]\)/g);
      for (const m of routerMatches) {
        navigationElements.push({ file: file.path, type: "router.push", targetHref: m[1] });
      }
    }

    for (const node of Object.values(componentNodes)) {
      if (node.whichRouteOwnsIt) {
        const routePath = node.whichRouteOwnsIt.routePath;
        const routePrefix = routePath.split("[")[0].replace(/\/$/, "");

        const matchingTriggers = navigationElements.filter((nav) => {
          if (nav.targetHref === routePath) return true;
          if (routePrefix && routePrefix !== "/" && nav.targetHref.startsWith(routePrefix)) return true;
          return false;
        });

        if (matchingTriggers.length > 0) {
          node.canUserNavigateToIt = true;
          node.navigationTriggers = matchingTriggers;
        } else if (routePath === "/") {
          node.canUserNavigateToIt = true;
          node.navigationTriggers = [{ file: "app/page.tsx", type: "Link", targetHref: "/" }];
        } else {
          node.canUserNavigateToIt = false;
        }
      }
    }

    return { exports, imports, dependencyGraph, componentNodes };
  }
}
