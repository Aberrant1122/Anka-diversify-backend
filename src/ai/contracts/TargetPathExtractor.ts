import path from "path";

export type PathProvenance = "EXPLICIT_USER_PATH" | "REPOSITORY_GROUNDED" | "CLASSIFIER_HINT";

export interface ExtractedPathInfo {
  path: string;
  provenance: PathProvenance;
}

export interface PathExtractionOptions {
  repoFiles?: string[];
  taskType?: string;
  classifierTarget?: string;
}

export class TargetPathExtractor {
  // Known technology/framework tokens that end in .js or common extensions but are NOT file paths
  private static readonly NON_PATH_TECHNOLOGIES = new Set([
    "next.js",
    "node.js",
    "react.js",
    "vue.js",
    "nuxt.js",
    "three.js",
    "express.js",
    "nest.js",
    "ember.js",
    "angular.js",
    "alpine.js",
    "electron.js",
    "chart.js",
    "d3.js",
    "socket.io",
    "moment.js",
    "day.js",
    "redux.js",
    "svelte.js",
    "gatsby.js",
    "tailwind.css", // technology, not a path unless explicitly created/located
    "vanilla.js",
  ]);

  // Generic broad root directories that must not become hard target paths when merely guessed
  private static readonly BROAD_GENERIC_DIRS = new Set([
    "src",
    "app",
    "lib",
    "components",
    "pages",
    "styles",
    "public",
    "utils",
    "api",
    ".",
    "/",
  ]);

  /**
   * Extracts verified target paths from a user message with high confidence and provenance.
   */
  public static extract(
    message: string,
    options: PathExtractionOptions = {}
  ): string[] {
    const infos = this.extractWithProvenance(message, options);
    // Hard targets: only EXPLICIT_USER_PATH and REPOSITORY_GROUNDED
    return infos
      .filter((i) => i.provenance === "EXPLICIT_USER_PATH" || i.provenance === "REPOSITORY_GROUNDED")
      .map((i) => i.path);
  }

  /**
   * Extracts target paths along with their provenance classification.
   */
  public static extractWithProvenance(
    message: string,
    options: PathExtractionOptions = {}
  ): ExtractedPathInfo[] {
    const results: ExtractedPathInfo[] = [];
    const seenPaths = new Set<string>();
    const repoFiles = (options.repoFiles || []).map((f) => f.replace(/\\/g, "/").replace(/^\//, ""));

    const addPath = (p: string, provenance: PathProvenance) => {
      const clean = p.replace(/\\/g, "/").replace(/^\//, "").replace(/\/$/, "");
      if (
        clean.length > 0 &&
        !this.NON_PATH_TECHNOLOGIES.has(clean.toLowerCase()) &&
        !seenPaths.has(clean)
      ) {
        seenPaths.add(clean);
        results.push({ path: clean, provenance });
      }
    };

    // 1. Classifier Target Handling with Strict Provenance Rules
    if (options.classifierTarget && options.classifierTarget.trim()) {
      const ct = options.classifierTarget.trim().replace(/\\/g, "/").replace(/^\//, "").replace(/\/$/, "");
      const isExistingInRepo = repoFiles.includes(ct) || repoFiles.some((rf) => rf.startsWith(ct + "/"));
      const isExplicitInMessage = message.toLowerCase().includes(ct.toLowerCase());
      const isBroad = this.BROAD_GENERIC_DIRS.has(ct.toLowerCase());

      if (isExplicitInMessage && this.isValidPathCandidate(ct, repoFiles)) {
        addPath(ct, "EXPLICIT_USER_PATH");
      } else if (isExistingInRepo && !isBroad && this.isValidPathCandidate(ct, repoFiles)) {
        addPath(ct, "REPOSITORY_GROUNDED");
      } else {
        // Classifier guess that is either nonexistent or generic broad dir is a hint only
        // Does NOT get added as an authorized hard target
      }
    }

    // 2. Explicit Quoted/Backticked targets: 'app/page.tsx', "src/auth.ts", `components/Button.tsx`
    const quotedMatches = message.matchAll(/[`"']([\w\-./\\]+)[`"']/g);
    for (const m of quotedMatches) {
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").trim();
      if (this.isValidPathCandidate(candidate, repoFiles)) {
        addPath(candidate, "EXPLICIT_USER_PATH");
      }
    }

    // 3. Unquoted candidates with directory separators (e.g. app/page.tsx, src/components/Button.tsx, src/auth/)
    const dirSeparatedMatches = message.matchAll(/\b([\w\-.]+(?:\/[\w\-.]+)+)\b/g);
    for (const m of dirSeparatedMatches) {
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").trim();
      if (this.isValidPathCandidate(candidate, repoFiles)) {
        addPath(candidate, "EXPLICIT_USER_PATH");
      }
    }

    // 4. Bare filenames with explicit action phrasing: "create utils.ts", "edit config.ts", "in file Button.tsx"
    const actionPhraseMatches = message.matchAll(
      /\b(?:create|add|in|inside|modify|update|fix|edit|delete|remove|file)\s+([a-zA-Z0-9_\-]+\.(?:html|css|js|ts|tsx|jsx|json|py|md|rs|go|sql))\b/gi
    );
    for (const m of actionPhraseMatches) {
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").trim();
      if (!this.NON_PATH_TECHNOLOGIES.has(candidate.toLowerCase())) {
        const resolved = this.resolveAgainstRepo(candidate, repoFiles);
        addPath(resolved || candidate, "EXPLICIT_USER_PATH");
      }
    }

    // 5. Bare filenames that uniquely match an existing canonical repository file
    const bareExtensionMatches = message.matchAll(
      /\b([a-zA-Z0-9_\-]+\.(?:html|css|js|ts|tsx|jsx|json|py|md|rs|go|sql))\b/gi
    );
    for (const m of bareExtensionMatches) {
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").trim();
      if (this.NON_PATH_TECHNOLOGIES.has(candidate.toLowerCase())) {
        continue;
      }
      // If this bare filename exists uniquely in repo (e.g. "page.tsx" matching "app/page.tsx")
      const matchedRepoPath = this.resolveAgainstRepo(candidate, repoFiles);
      if (matchedRepoPath) {
        const wordRegex = new RegExp(`\\b(?:fix|edit|update|modify|change|in|file|inside)\\s+${candidate}`, "i");
        if (wordRegex.test(message) || seenPaths.size === 0) {
          addPath(matchedRepoPath, "EXPLICIT_USER_PATH");
        }
      }
    }

    return results;
  }

  /**
   * Deterministically resolves named entities in user messages to existing repository files.
   */
  public static extractGroundedEntities(message: string, repoFiles: string[]): string[] {
    if (!repoFiles || repoFiles.length === 0) return [];
    const normalizedRepo = repoFiles.map((f) => f.replace(/\\/g, "/").replace(/^\//, ""));
    const grounded: string[] = [];

    const entityTokens = new Set<string>();
    const actionEntityRegex = /\b(?:remove|delete|drop|prune|clean|fix|update|modify|edit|enhance|add|create|build)\s+(?:the\s+|a\s+|an\s+)?([a-zA-Z0-9_\-]+)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = actionEntityRegex.exec(message)) !== null) {
      const token = match[1].toLowerCase();
      if (token.length >= 3 && !this.NON_PATH_TECHNOLOGIES.has(token) && !this.BROAD_GENERIC_DIRS.has(token)) {
        entityTokens.add(token);
      }
    }

    for (const token of entityTokens) {
      for (const rf of normalizedRepo) {
        const baseName = path.basename(rf).toLowerCase();
        const stem = baseName.replace(/\.[^.]+$/, "");
        if (stem === token || stem.includes(token) || rf.toLowerCase().includes(`/${token}/`) || rf.toLowerCase().includes(`/${token}.`)) {
          grounded.push(rf);
        }
      }
    }

    return Array.from(new Set(grounded));
  }

  /**
   * Validates whether a candidate string is a plausible filesystem path.
   */
  private static isValidPathCandidate(candidate: string, repoFiles: string[]): boolean {
    if (!candidate || candidate.length < 2) return false;

    const lower = candidate.toLowerCase();
    if (this.NON_PATH_TECHNOLOGIES.has(lower)) return false;

    // Direct match against repo files or directory prefixes
    if (repoFiles.includes(candidate) || repoFiles.some((rf) => rf.startsWith(candidate + "/"))) {
      return true;
    }

    // Contains directory separator and valid extension or folder pattern
    const hasDirSep = candidate.includes("/");
    if (hasDirSep) {
      // Must not look like a URL or protocol
      if (candidate.startsWith("http:") || candidate.startsWith("https:")) return false;
      return true;
    }

    // Bare filename: must have known extension and not be a framework name
    const hasExtension = /\.(?:html|css|js|ts|tsx|jsx|json|py|md|rs|go|sql)$/i.test(candidate);
    return hasExtension && !this.NON_PATH_TECHNOLOGIES.has(lower);
  }

  /**
   * Resolves a bare filename against repo files if it uniquely matches.
   */
  private static resolveAgainstRepo(bareName: string, repoFiles: string[]): string | null {
    if (!repoFiles.length) return null;
    const matches = repoFiles.filter(
      (rf) => rf === bareName || rf.endsWith("/" + bareName)
    );
    if (matches.length === 1) {
      return matches[0];
    }
    return null;
  }
}
