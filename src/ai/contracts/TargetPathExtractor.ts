/**
 * TargetPathExtractor
 *
 * Deterministically extracts intended filesystem target paths from user messages.
 * Requires strong evidence (directory separators, canonical repository matches,
 * explicit quoted paths, or explicit action verbs) to prevent technology/framework
 * names (e.g. Next.js, Node.js, React.js) from being misidentified as file paths.
 */

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

  /**
   * Extracts verified target paths from a user message with high confidence.
   */
  public static extract(
    message: string,
    options: PathExtractionOptions = {}
  ): string[] {
    const rawPaths: string[] = [];
    const repoFiles = (options.repoFiles || []).map((f) => f.replace(/\\/g, "/").replace(/^\//, ""));

    // 1. If the classifier provided a concrete target path that looks like a real path or folder
    if (options.classifierTarget && options.classifierTarget.trim()) {
      const ct = options.classifierTarget.trim().replace(/\\/g, "/").replace(/^\//, "");
      const isExistingInRepo = repoFiles.includes(ct) || repoFiles.some((rf) => rf.startsWith(ct + "/"));
      const isExplicitInMessage = message.includes(ct);

      if (options.taskType !== "NEW_FEATURE" && options.taskType !== "FILE_CREATION") {
        if (this.isValidPathCandidate(ct, repoFiles)) {
          rawPaths.push(ct);
        }
      } else if (isExistingInRepo || isExplicitInMessage) {
        if (this.isValidPathCandidate(ct, repoFiles)) {
          rawPaths.push(ct);
        }
      }
    }

    // 2. Explicit Quoted/Backticked targets: 'app/page.tsx', "src/auth.ts", `components/Button.tsx`
    const quotedMatches = message.matchAll(/[`"']([\w\-./\\]+)[`"']/g);
    for (const m of quotedMatches) {
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").trim();
      if (this.isValidPathCandidate(candidate, repoFiles)) {
        rawPaths.push(candidate);
      }
    }

    // 3. Unquoted candidates with directory separators (e.g. app/page.tsx, src/components/Button.tsx, src/auth/)
    const dirSeparatedMatches = message.matchAll(/\b([\w\-.]+(?:\/[\w\-.]+)+)\b/g);
    for (const m of dirSeparatedMatches) {
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").trim();
      if (this.isValidPathCandidate(candidate, repoFiles)) {
        rawPaths.push(candidate);
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
        rawPaths.push(resolved || candidate);
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
        // Only include if the message has intent to touch this file (not just mentioning common words)
        const wordRegex = new RegExp(`\\b(?:fix|edit|update|modify|change|in|file|inside)\\s+${candidate}`, "i");
        if (wordRegex.test(message) || rawPaths.length === 0) {
          rawPaths.push(matchedRepoPath);
        }
      }
    }

    // Deduplicate and filter out any accidental empty strings
    const unique = Array.from(
      new Set(
        rawPaths
          .map((p) => p.replace(/\/$/, ""))
          .filter((p) => p.length > 0 && !this.NON_PATH_TECHNOLOGIES.has(p.toLowerCase()))
      )
    );

    return unique;
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
