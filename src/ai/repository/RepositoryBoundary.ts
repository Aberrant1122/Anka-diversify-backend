import fs from "fs";
import path from "path";

/** One boundary for observations, resolution and prospective writes. */
function resolveBoundary(root: string, candidate: string, prospective = false): { absolutePath: string; canonicalPath: string } | null {
  try {
    if (!candidate || candidate.includes("\0") || candidate.includes(":")) return null;
    const realRoot = fs.realpathSync(root);
    const absolute = path.resolve(root, candidate);
    const inside = (base: string, target: string): boolean => {
      const relative = path.relative(base, target);
      return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    };
    if (!inside(path.resolve(root), absolute) || absolute === path.resolve(root)) return null;
    let ancestor = absolute;
    while (!fs.existsSync(ancestor)) {
      // A dangling symlink is not a prospective directory.
      try { if (fs.lstatSync(ancestor).isSymbolicLink()) return null; } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
      if (!prospective) return null;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
    const realAncestor = fs.realpathSync(ancestor);
    const realTarget = path.resolve(realAncestor, path.relative(ancestor, absolute));
    if (!inside(realRoot, realTarget)) return null;
    return { absolutePath: absolute, canonicalPath: realTarget };
  } catch { return null; }
}

export function repositoryPath(root: string, candidate: string, prospective = false): string | null {
  return resolveBoundary(root, candidate, prospective)?.absolutePath ?? null;
}

export function canonicalRepositoryPath(root: string, candidate: string, prospective = false): string | null {
  return resolveBoundary(root, candidate, prospective)?.canonicalPath ?? null;
}
