export interface ValidationEnvOptions {
  framework?: string;
  customEnv?: Record<string, string>;
  isProductionBuild?: boolean;
}

export class ValidationEnvironmentPolicy {
  // Essential system environment keys required for process execution, shell, and package managers
  private static readonly ALLOWED_SYSTEM_KEYS = new Set([
    // Path resolution
    "PATH",
    "Path",
    "path",
    "PATHEXT",

    // Windows system locations
    "SYSTEMROOT",
    "SystemRoot",
    "WINDIR",
    "windir",
    "APPDATA",
    "LOCALAPPDATA",
    "COMSPEC",
    "ComSpec",
    "PROGRAMFILES",
    "ProgramFiles",
    "PROGRAMFILES(X86)",
    "ProgramFiles(x86)",
    "PROGRAMDATA",
    "ProgramData",
    "ALLUSERSPROFILE",
    "PUBLIC",

    // User home & temp locations
    "USERPROFILE",
    "HOME",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
    "TMPDIR",

    // Shell & locale
    "SHELL",
    "TERM",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",

    // Node & npm runtime execution
    "NODE_PATH",
    "NVM_DIR",
    "npm_config_cache",
    "npm_config_prefix",
    "npm_config_user_agent",
    "npm_execpath",
    "npm_node_execpath",
  ]);

  // Sensitive application variables that must NEVER be passed to repository scripts
  private static readonly DISALLOWED_SECRET_PATTERNS = [
    /SECRET/i,
    /KEY/i,
    /PASSWORD/i,
    /DATABASE_URL/i,
    /TOKEN/i,
    /AUTH/i,
    /ENCRYPTION/i,
    /ANKA_/i,
    /PRISMA/i,
  ];

  /**
   * Builds a sanitized environment object for executing validation commands.
   * Isolates target repository from ANKA backend secrets and non-standard NODE_ENV values.
   */
  public static getSanitizedEnv(
    command: string,
    options: ValidationEnvOptions = {}
  ): NodeJS.ProcessEnv {
    const sanitized: NodeJS.ProcessEnv = {};

    // 1. Copy only allowed system and tool execution variables
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;

      // Check if key is explicitly in allowed list (case-insensitive for Windows)
      const isAllowedKey = Array.from(this.ALLOWED_SYSTEM_KEYS).some(
        (k) => k.toLowerCase() === key.toLowerCase()
      );

      if (!isAllowedKey) continue;

      // Double check it doesn't match secret patterns
      const isSecret = this.DISALLOWED_SECRET_PATTERNS.some((p) => p.test(key));
      if (isSecret) continue;

      sanitized[key] = value;
    }

    // 2. Set deterministic, framework-safe NODE_ENV based on command type
    const lowerCmd = command.toLowerCase().trim();
    const isBuild =
      options.isProductionBuild ||
      /\b(build|next build|vite build|tsc|nuxt build|ng build|dist)\b/i.test(lowerCmd) ||
      lowerCmd.startsWith("npm run build") ||
      lowerCmd.startsWith("yarn build") ||
      lowerCmd.startsWith("pnpm build");

    const isTest =
      /\b(test|jest|vitest|pytest|mocha|playwright|cypress)\b/i.test(lowerCmd) ||
      lowerCmd.startsWith("npm test") ||
      lowerCmd.startsWith("yarn test") ||
      lowerCmd.startsWith("pnpm test");

    if (isBuild) {
      // Force production NODE_ENV for production builds (e.g. Next.js, Vite, Webpack)
      sanitized.NODE_ENV = "production";
    } else if (isTest) {
      sanitized.NODE_ENV = "test";
    } else {
      // For typecheck/lint, default to production or omit custom ANKA development env
      sanitized.NODE_ENV = "production";
    }

    // 3. Apply trusted explicit customEnv if supplied
    if (options.customEnv) {
      for (const [k, v] of Object.entries(options.customEnv)) {
        sanitized[k] = v;
      }
    }

    return sanitized;
  }
}
