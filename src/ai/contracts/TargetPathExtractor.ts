import path from "path";

export type PathProvenance =
  | "EXPLICIT_USER_PATH"
  | "UNIQUE_NAMED_ENTITY"
  | "DETERMINISTIC_ARCHITECTURE_DEPENDENCY"
  | "BASELINE_DIAGNOSTIC"
  | "ACTIVE_ENTRY"
  | "REPOSITORY_GROUNDED"
  | "CLASSIFIER_HINT";

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

  // Descriptive modifiers that qualify an entity but should not independently become target entity names
  public static readonly DESCRIPTIVE_MODIFIERS = new Set([
    "deprecated",
    "legacy",
    "old",
    "obsolete",
    "unused",
    "outdated",
    "former",
    "existing",
    "default",
  ]);

  // Vague target nouns that do not form concrete repository entities
  public static readonly VAGUE_TARGET_WORDS = new Set([
    "stuff",
    "things",
    "code",
    "files",
    "folders",
    "everything",
    "all",
    "items",
    "junk",
    "garbage",
    "leftovers",
    "content",
    "starter",
    "functionality",
    "working",
    "operation",
    "feature",
    "features",
    "up",
    "down",
    "out",
    "away",
  ]);



  /**
   * Deterministically breaks a symbol, filename stem, or entity phrase into normalized lexical tokens.
   * Examples:
   *   "LegacyActivityWidget" -> ["legacy", "activity", "widget"]
   *   "legacy-activity-widget" -> ["legacy", "activity", "widget"]
   *   "legacy_activity_widget" -> ["legacy", "activity", "widget"]
   *   "ActivityWidget" -> ["activity", "widget"]
   *   "activity widget" -> ["activity", "widget"]
   */
  public static tokenizeEntity(name: string): string[] {
    if (!name) return [];
    return name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s\-_./\\]+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 0 && !["tsx", "ts", "jsx", "js", "css", "json", "html"].includes(t));
  }

  /**
   * Deterministically normalizes an entity or filename stem into a canonical comparison key.
   * Supports: PascalCase, camelCase, kebab-case, snake_case, spaces.
   * Examples:
   *   "TaskFilter" -> "taskfilter"
   *   "taskFilter" -> "taskfilter"
   *   "task-filter" -> "taskfilter"
   *   "task_filter" -> "taskfilter"
   *   "task filter" -> "taskfilter"
   */
  public static normalizeEntityKey(name: string): string {
    if (!name) return "";
    return name
      .trim()
      .toLowerCase()
      .replace(/[-_\s.]/g, "");
  }

  /**
   * Deterministically determines if a candidate string represents an HTTP route, API endpoint,
   * URL, or runtime route parameter rather than a concrete repository filesystem path.
   * Route identifiers (e.g. "/health/details", "GET /health/details", "/api/users", "/users/:id",
   * "/items/item-1", "/users/123", "/settings/profile", "https://example.com/items/item-1")
   * must NEVER become filesystem target paths.
   */
  public static isHttpRouteIdentifier(
    candidate: string,
    fullMessage?: string,
    repoFiles: string[] = []
  ): boolean {
    if (!candidate || candidate.trim().length === 0) return false;
    const clean = candidate.trim().replace(/[.,;:!?]+$/, "");
    const cleanLower = clean.toLowerCase();

    // 1. URLs and Protocol strings are always runtime routes/URLs (e.g. "https://example.com/items/item-1")
    if (/^(?:https?:\/\/|\/\/)/i.test(clean)) {
      return true;
    }

    // 2. File extension check:
    // Genuine code / config / markup files have a recognized extension (e.g. "src/services/user.ts", "app/items/[id]/page.tsx")
    const hasCodeExtension = /\.(?:ts|tsx|js|jsx|json|css|scss|sass|less|html|py|go|rs|md|sql|yaml|yml|mjs|cjs|env|toml|xml|sh|bash)$/i.test(clean);
    if (hasCodeExtension) {
      return false;
    }

    // 3. Starts with an explicit HTTP verb (e.g. "GET /health/details", "POST /users")
    if (/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+/i.test(clean)) {
      return true;
    }

    // 4. Preceded by an HTTP verb or inside a URL in fullMessage
    if (fullMessage) {
      const stripped = clean.replace(/^[\\/]/, "");
      const escaped = stripped.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");

      // Check if candidate is part of a URL in the message
      const urlMatch = new RegExp(`https?:\\/\\/[^\\s/]+(?:\\/[^\\s]*)*${escaped}`, "i");
      if (urlMatch.test(fullMessage)) {
        return true;
      }

      // Check if preceded by an HTTP verb in fullMessage (e.g. "GET /users/123", "POST /api/tasks")
      const verbBeforeRegex = new RegExp(`\\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\\s+[/]?${escaped}\\b`, "i");
      if (verbBeforeRegex.test(fullMessage)) {
        return true;
      }
    }

    const normalizedRepoFiles = (repoFiles || []).map((f) => f.replace(/\\/g, "/").replace(/^\//, ""));
    const cleanWithoutSlash = clean.replace(/\\/g, "/").replace(/^\//, "");
    const existsInRepo = normalizedRepoFiles.includes(cleanWithoutSlash) || normalizedRepoFiles.some((rf) => rf.startsWith(cleanWithoutSlash + "/"));

    // If it exists in repoFiles as a real file/dir and does not contain route parameter syntax
    if (existsInRepo && !/[:{}<>]/.test(clean)) {
      return false;
    }

    // 5. Contains HTTP route parameter syntax: e.g. "/:id", ":userId", "{id}", "<id>"
    if (/[:{}<>]/.test(clean) || /\/:[a-zA-Z0-9_]+/.test(clean)) {
      return true;
    }

    // 6. Starts with a leading slash in user message or candidate: e.g. "/items/item-1", "/users/123", "/settings/profile", "/api/orders/17"
    if (clean.startsWith("/")) {
      return true;
    }

    // 7. Preceded by a leading slash in fullMessage (e.g. "at /items/item-1", "opening /settings/profile")
    if (fullMessage) {
      const stripped = clean.replace(/^[\\/]/, "");
      const escaped = stripped.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
      const leadingSlashInMsg = new RegExp(`(?:^|[\\s"'\`(\\[])\\/${escaped}\\b`, "i");
      if (leadingSlashInMsg.test(fullMessage)) {
        return true;
      }
    }

    // 8. REST / route slug or ID patterns without file extension (e.g. "items/item-1", "users/123", "orders/42")
    if (clean.includes("/")) {
      const segments = clean.split("/").filter(Boolean);
      const lastSegment = segments[segments.length - 1];
      const hasIdSlug = /^[0-9]+$/.test(lastSegment) || /^[a-zA-Z]+-[0-9]+$/i.test(lastSegment) || /^:[a-zA-Z_]+/.test(lastSegment);
      if (hasIdSlug) {
        return true;
      }
    }

    // 9. Generic API route prefix syntax without file extension (e.g. "api/v1/...", "api/users")
    if (/^(?:api\/|v[0-9]+\/)/i.test(clean)) {
      return true;
    }

    // 10. Route/endpoint context words in message combined with leading slash or known route roots
    if (fullMessage) {
      const routeKeywords = /\b(?:endpoint|route|api|rest|handler|uri|url)\b/i;
      if (routeKeywords.test(fullMessage)) {
        if (/^(?:api|v[0-9]+|health|users|auth|items|tasks|projects|webhooks|payments|admin|settings|dashboard)\//i.test(clean)) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Extracts verified target paths from a user message with high confidence and provenance.
   */
  public static extract(
    message: string,
    options: PathExtractionOptions = {}
  ): string[] {
    const infos = this.extractWithProvenance(message, options);
    // Hard targets: only EXPLICIT_USER_PATH and UNIQUE_NAMED_ENTITY
    // CLASSIFIER_HINT carries ZERO write authority
    return infos
      .filter((i) => i.provenance === "EXPLICIT_USER_PATH" || i.provenance === "UNIQUE_NAMED_ENTITY")
      .map((i) => i.path);
  }

  /**
   * Deterministically extracts ONLY explicit paths from user prompt.
   * Model outputs or hints are strictly excluded.
   */
  public static extractExplicitUserPaths(
    message: string,
    repoFiles: string[] = []
  ): string[] {
    const infos = this.extractWithProvenance(message, { repoFiles });
    return infos
      .filter((i) => i.provenance === "EXPLICIT_USER_PATH")
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
      const clean = p.replace(/\\/g, "/").replace(/^\//, "").replace(/[.,;:!?]+$/, "").replace(/\/$/, "");
      if (
        clean.length > 0 &&
        !this.NON_PATH_TECHNOLOGIES.has(clean.toLowerCase()) &&
        !this.isHttpRouteIdentifier(clean, message, repoFiles) &&
        !seenPaths.has(clean)
      ) {
        seenPaths.add(clean);
        results.push({ path: clean, provenance });
      }
    };

    // 1. Explicit Quoted/Backticked targets: 'app/page.tsx', "src/auth.ts", `components/Button.tsx`
    const quotedMatches = message.matchAll(/[`"']([\w\-./\\]+)[`"']/g);
    for (const m of quotedMatches) {
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").replace(/[.,;:!?]+$/, "").trim();
      if (this.isValidPathCandidate(candidate, repoFiles, message)) {
        addPath(candidate, "EXPLICIT_USER_PATH");
      }
    }

    // 2. Unquoted candidates with directory separators (e.g. app/page.tsx, src/components/Button.tsx, src/auth/)
    const dirSeparatedMatches = message.matchAll(/\b([\w\-.]+(?:[\/\\][\w\-.]+)+)\b/g);
    for (const m of dirSeparatedMatches) {
      if (m.index !== undefined && m.index > 0) {
        const prefix = message.slice(0, m.index);
        if (/https?:\/\/[^\s]*$/i.test(prefix) || /:\/\/[^\s]*$/i.test(prefix)) {
          continue;
        }
      }
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").replace(/[.,;:!?]+$/, "").trim();
      if (this.isValidPathCandidate(candidate, repoFiles, message)) {
        addPath(candidate, "EXPLICIT_USER_PATH");
      }
    }

    // 3. Bare filenames with explicit action phrasing: "create utils.ts", "edit config.ts", "in file Button.tsx"
    const actionPhraseMatches = message.matchAll(
      /\b(?:create|add|in|inside|modify|update|fix|edit|delete|remove|file)\s+([a-zA-Z0-9_\-]+(?:\.[a-zA-Z0-9_\-]+)*\.(?:html|css|js|ts|tsx|jsx|json|py|md|rs|go|sql|yaml|yml|mjs|cjs))\b/gi
    );
    for (const m of actionPhraseMatches) {
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").replace(/[.,;:!?]+$/, "").trim();
      if (!this.NON_PATH_TECHNOLOGIES.has(candidate.toLowerCase()) && !this.isHttpRouteIdentifier(candidate, message, repoFiles)) {
        const resolved = this.resolveAgainstRepo(candidate, repoFiles);
        addPath(resolved || candidate, "EXPLICIT_USER_PATH");
      }
    }

    // 4. Bare filenames that uniquely match an existing canonical repository file
    const bareExtensionMatches = message.matchAll(
      /\b([a-zA-Z0-9_\-]+(?:\.[a-zA-Z0-9_\-]+)*\.(?:html|css|js|ts|tsx|jsx|json|py|md|rs|go|sql|yaml|yml|mjs|cjs))\b/gi
    );
    for (const m of bareExtensionMatches) {
      const candidate = m[1].replace(/\\/g, "/").replace(/^\//, "").replace(/[.,;:!?]+$/, "").trim();
      if (this.NON_PATH_TECHNOLOGIES.has(candidate.toLowerCase()) || this.isHttpRouteIdentifier(candidate, message, repoFiles)) {
        continue;
      }
      // If this bare filename exists uniquely in repo (e.g. "page.tsx" matching "app/page.tsx")
      const matchedRepoPath = this.resolveAgainstRepo(candidate, repoFiles);
      if (matchedRepoPath) {
        const escaped = candidate.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, "\\$1");
        const wordRegex = new RegExp(`\\b(?:fix|edit|update|modify|change|in|file|inside)\\s+${escaped}`, "i");
        if (wordRegex.test(message) || seenPaths.size === 0) {
          addPath(matchedRepoPath, "EXPLICIT_USER_PATH");
        }
      }
    }

    // 5. Classifier Target Handling with Strict Provenance Rules:
    // Classifier outputs are strictly advisory hints; NEVER granted EXPLICIT_USER_PATH or REPOSITORY_GROUNDED write authority.
    if (options.classifierTarget && options.classifierTarget.trim()) {
      const ct = options.classifierTarget
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\//, "")
        .replace(/[.,;:!?]+$/, "")
        .replace(/\/$/, "");
      if (!this.isHttpRouteIdentifier(ct, message, repoFiles)) {
        if (!seenPaths.has(ct) && this.isValidPathCandidate(ct, repoFiles, message)) {
          addPath(ct, "CLASSIFIER_HINT");
        }
      }
    }

    return results;
  }

  /**
   * Deterministically resolves named entities in user messages to existing repository files
   * with unique entity promotion semantics.
   *
   * Rules:
   * 1. Entity name must be present in user request.
   * 2. Matching is deterministic through normalizeEntityKey (PascalCase, camelCase, kebab-case, snake_case).
   * 3. Must match EXACTLY ONE repository file (unique resolution).
   * 4. Ambiguous matches (multiple matching files) are NOT authorized.
   * 5. Nonexistent matches produce no authority.
   */
  public static extractGroundedEntitiesWithProvenance(
    message: string,
    repoFiles: string[]
  ): ExtractedPathInfo[] {
    if (!repoFiles || repoFiles.length === 0) return [];
    const normalizedRepo = repoFiles
      .map((f) => f.replace(/\\/g, "/").replace(/^\//, ""))
      .filter((f) => !f.startsWith("node_modules/") && !f.startsWith(".git/") && !f.startsWith(".next/") && !f.startsWith("dist/"));

    const entityTokens = this.extractNamedEntityTokens(message);
    const grounded: ExtractedPathInfo[] = [];
    const seenPaths = new Set<string>();

    for (const token of entityTokens) {
      const targetKey = this.normalizeEntityKey(token);
      if (targetKey.length < 3) continue;

      const matchedPaths: string[] = [];
      const tokenWords = this.tokenizeEntity(token).filter(
        (w) => !this.DESCRIPTIVE_MODIFIERS.has(w) && !this.VAGUE_TARGET_WORDS.has(w)
      );

      for (const rf of normalizedRepo) {
        const baseName = path.basename(rf);
        const stem = baseName.replace(/\.[^.]+$/, "");
        const stemKey = this.normalizeEntityKey(stem);

        const isExactMatch = stemKey === targetKey;
        const isSuffixMatch = ["page", "view", "component", "screen"].some((s) => stemKey === targetKey + s);

        if (isExactMatch || isSuffixMatch) {
          matchedPaths.push(rf);
        } else if (tokenWords.length >= 2) {
          // Token phrase matching: e.g. "activity widget" -> tokens ["activity", "widget"]
          const stemTokens = this.tokenizeEntity(stem);
          if (tokenWords.every((tw) => stemTokens.includes(tw))) {
            matchedPaths.push(rf);
          }
        } else {
          // Check if parent directory matches exactly: e.g. components/TaskFilter/index.tsx
          const parts = rf.split("/");
          if (parts.length > 1) {
            const parentDir = parts[parts.length - 2];
            const parentDirKey = this.normalizeEntityKey(parentDir);
            if (parentDirKey === targetKey && (baseName.startsWith("index.") || baseName.startsWith(stem))) {
              matchedPaths.push(rf);
            }
          }
        }
      }

      // Check for true ambiguity across implementation code files
      let codeFiles = matchedPaths.filter((p) => /\.(?:tsx|ts|jsx|js|py|go|rs)$/i.test(p));

      // Separate UI component/page candidates from type/schema candidates
      if (codeFiles.length > 1) {
        const uiCodeFiles = codeFiles.filter(
          (p) => /(?:pages|components|views|screens|app)\//i.test(p) && /\.(?:tsx|jsx)$/i.test(p)
        );
        const typeFiles = codeFiles.filter(
          (p) => /(?:types|models?|interfaces?|dtos?|schemas?)\/|\.types?\.[a-z]+$/i.test(p)
        );
        if (uiCodeFiles.length > 0 && typeFiles.length > 0) {
          const isExplicitType = /\b(?:type|types|schema|model|interface|dto)\b/i.test(message);
          codeFiles = isExplicitType ? typeFiles : uiCodeFiles;
        }
      }

      if (codeFiles.length > 1) {
        // Truly ambiguous entity across multiple implementation files:
        // e.g. components/admin/TaskFilter.tsx vs components/tasks/TaskFilter.tsx
        console.warn(
          `[TargetPathExtractor] Ambiguous entity "${token}" matches multiple implementation files: ${codeFiles.join(", ")}. Omitting automatic promotion.`
        );
      } else if (codeFiles.length === 1) {
        // Exactly one matching implementation file
        const uniquePath = codeFiles[0];
        if (!seenPaths.has(uniquePath)) {
          seenPaths.add(uniquePath);
          grounded.push({ path: uniquePath, provenance: "UNIQUE_NAMED_ENTITY" });
        }
      } else if (matchedPaths.length === 1) {
        const uniquePath = matchedPaths[0];
        if (!seenPaths.has(uniquePath)) {
          seenPaths.add(uniquePath);
          grounded.push({ path: uniquePath, provenance: "UNIQUE_NAMED_ENTITY" });
        }
      }
      // If 0 matches: Nonexistent entity (Part R): Nothing added.
    }

    return grounded;
  }

  /**
   * Deterministically resolves named entities in user messages to existing repository files.
   * Returns list of file paths.
   */
  public static extractGroundedEntities(message: string, repoFiles: string[]): string[] {
    return this.extractGroundedEntitiesWithProvenance(message, repoFiles).map((i) => i.path);
  }

  /**
   * Extracts candidate entity tokens from a user message.
   */
  public static extractNamedEntityTokens(message: string): string[] {
    const tokens = new Set<string>();

    // 1. PascalCase words: e.g. TaskFilter, ProjectCard, MemberCard, HealthRoutes, LegacyActivityWidget
    const pascalMatches = message.matchAll(/\b([A-Z][a-zA-Z0-9]{2,})\b/g);
    for (const m of pascalMatches) {
      const tok = m[1];
      if (!this.NON_PATH_TECHNOLOGIES.has(tok.toLowerCase()) && !this.BROAD_GENERIC_DIRS.has(tok.toLowerCase())) {
        tokens.add(tok);
      }
    }

    // 2. Descriptive Modifier + Entity phrasing:
    // e.g. "remove the deprecated activity widget", "delete old calculator", "replace the deprecated activity widget with"
    const descriptiveRegex = /\b(?:remove|delete|drop|prune|clean|fix|update|modify|edit|enhance|improve|add|create|build|replace|redesign|style|implement|change)\s+(?:the\s+|a\s+|an\s+)?(?:deprecated|legacy|old|obsolete|unused|outdated|former)\s+([a-zA-Z0-9_\-]+(?:\s+[a-zA-Z0-9_\-]+)?)\b/gi;
    let dMatch: RegExpExecArray | null;
    while ((dMatch = descriptiveRegex.exec(message)) !== null) {
      const tok = dMatch[1].trim();
      const words = tok.toLowerCase().split(/\s+/);
      const isAllVague = words.every((w) => this.VAGUE_TARGET_WORDS.has(w));
      if (!isAllVague && tok.length >= 3 && !this.NON_PATH_TECHNOLOGIES.has(tok.toLowerCase()) && !this.BROAD_GENERIC_DIRS.has(tok.toLowerCase())) {
        tokens.add(tok);
      }
    }

    // 3. Action + Entity phrasing: "remove the calculator", "fix the task-filter", "update user_service", "improve the dashboard"
    const actionEntityRegex = /\b(?:remove|delete|drop|prune|clean|fix|update|modify|edit|enhance|improve|add|create|build|redesign|change)\s+(?:the\s+|a\s+|an\s+)?([a-zA-Z0-9_\-]+)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = actionEntityRegex.exec(message)) !== null) {
      const tok = match[1].trim();
      if (
        tok.length >= 3 &&
        !this.DESCRIPTIVE_MODIFIERS.has(tok.toLowerCase()) &&
        !this.VAGUE_TARGET_WORDS.has(tok.toLowerCase()) &&
        !this.NON_PATH_TECHNOLOGIES.has(tok.toLowerCase()) &&
        !this.BROAD_GENERIC_DIRS.has(tok.toLowerCase())
      ) {
        tokens.add(tok);
      }
    }

    // 4. Two-word entity phrasing: "edit task filter", "fix project card"
    const actionTwoWordRegex = /\b(?:remove|delete|drop|prune|clean|fix|update|modify|edit|enhance|improve|add|create|build|redesign|change)\s+(?:the\s+|a\s+|an\s+)?([a-zA-Z0-9_\-]+\s+[a-zA-Z0-9_\-]+)\b/gi;
    while ((match = actionTwoWordRegex.exec(message)) !== null) {
      const tok = match[1].trim();
      const words = tok.toLowerCase().split(/\s+/);
      const hasModifier = words.some((w) => this.DESCRIPTIVE_MODIFIERS.has(w));
      const hasVague = words.every((w) => this.VAGUE_TARGET_WORDS.has(w));
      if (!hasModifier && !hasVague && tok.length >= 3 && !this.NON_PATH_TECHNOLOGIES.has(tok.toLowerCase()) && !this.BROAD_GENERIC_DIRS.has(tok.toLowerCase())) {
        tokens.add(tok);
        for (const w of words) {
          if (w.length >= 3 && !this.DESCRIPTIVE_MODIFIERS.has(w) && !this.VAGUE_TARGET_WORDS.has(w) && !this.NON_PATH_TECHNOLOGIES.has(w) && !this.BROAD_GENERIC_DIRS.has(w)) {
            tokens.add(w);
          }
        }
      }
    }

    // 5. Entity followed by component/widget/service/controller keyword: "activity widget", "TaskFilter component", "user service"
    const keywordMatches = message.matchAll(
      /\b([a-zA-Z0-9_\-]+(?:\s+[a-zA-Z0-9_\-]+)?)\s+(component|widget|card|modal|dialog|sidebar|header|filter|view|button|service|controller|route|repository)\b/gi
    );
    for (const m of keywordMatches) {
      const entityPrefix = m[1].trim();
      const keyword = m[2].trim();
      const words = entityPrefix.toLowerCase().split(/\s+/);
      const concreteWords = words.filter((w) => !this.DESCRIPTIVE_MODIFIERS.has(w) && !this.VAGUE_TARGET_WORDS.has(w));
      if (concreteWords.length > 0) {
        const cleanPrefix = concreteWords.join(" ");
        if (cleanPrefix.length >= 3 && !this.NON_PATH_TECHNOLOGIES.has(cleanPrefix.toLowerCase()) && !this.BROAD_GENERIC_DIRS.has(cleanPrefix.toLowerCase())) {
          tokens.add(cleanPrefix);
          tokens.add(`${cleanPrefix} ${keyword}`);
          for (const w of concreteWords) {
            if (w.length >= 3 && !this.NON_PATH_TECHNOLOGIES.has(w) && !this.BROAD_GENERIC_DIRS.has(w)) {
              tokens.add(w);
            }
          }
        }
      }
      if (keyword.length >= 3 && !this.NON_PATH_TECHNOLOGIES.has(keyword.toLowerCase()) && !this.BROAD_GENERIC_DIRS.has(keyword.toLowerCase())) {
        tokens.add(keyword);
      }
    }

    return Array.from(tokens);
  }

  /**
   * Validates whether a candidate string is a plausible filesystem path.
   */
  public static isValidPathCandidate(candidate: string, repoFiles: string[] = [], fullMessage?: string): boolean {
    if (!candidate || candidate.length < 2) return false;

    // Reject OS absolute paths (e.g. "C:\Users\...", "C:/...") from becoming repo-relative targets
    if (/^[a-zA-Z]:/i.test(candidate)) return false;

    const lower = candidate.toLowerCase();
    if (this.NON_PATH_TECHNOLOGIES.has(lower)) return false;

    // Reject HTTP / API route identifiers (e.g. "GET /health/details", "/health/details", "/items/item-1")
    if (this.isHttpRouteIdentifier(candidate, fullMessage, repoFiles)) {
      return false;
    }

    const normCandidate = candidate.replace(/\\/g, "/").replace(/^\//, "").replace(/\/$/, "");
    const normalizedRepoFiles = (repoFiles || []).map((f) => f.replace(/\\/g, "/").replace(/^\//, ""));

    // Direct match against repo files or directory prefixes
    if (normalizedRepoFiles.includes(normCandidate) || normalizedRepoFiles.some((rf) => rf.startsWith(normCandidate + "/"))) {
      return true;
    }

    // Check code/file extension
    const hasExtension = /\.(?:html|css|js|ts|tsx|jsx|json|py|md|rs|go|sql|yaml|yml|mjs|cjs|env|toml|xml|sh|bash)$/i.test(normCandidate);

    // If candidate has directory separators:
    const hasDirSep = normCandidate.includes("/");
    if (hasDirSep) {
      // Must not look like a URL or protocol
      if (normCandidate.startsWith("http:") || normCandidate.startsWith("https:")) return false;

      // Deterministic requirement: an extensionless string with directory separators that does NOT exist
      // in repoFiles cannot be assumed to be a repository path (it is a runtime route, slug, or identifier).
      if (!hasExtension) {
        return false;
      }

      return true;
    }

    // Bare filename: must have known extension and not be a framework name
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

