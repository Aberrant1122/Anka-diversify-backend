// Focused authority/security checks use synthetic settings and isolated databases.
const { spawnSync } = require("node:child_process");
const environment = {
  ...process.env,
  NODE_ENV: "test",
  JWT_SECRET: "synthetic-workspace-test-key",
  ENCRYPTION_KEY: "00000000000000000000000000000000",
  DATABASE_URL:
    "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic?connect_timeout=1",
  ANKA_WORKSPACE_AI_ENABLED: "false",
};
for (const name of Object.keys(environment)) {
  if (
    /(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE|DEEPSEEK|OPENROUTER|MISTRAL|GROQ).*API_KEY/i.test(
      name,
    )
  )
    environment[name] = "";
}
const result = spawnSync(
  process.execPath,
  [
    "--experimental-vm-modules",
    "node_modules/jest/bin/jest.js",
    "--config",
    "jest.config.json",
    "--runInBand",
    "--testPathPatterns=workspace/|owner-session-security|foundation-security|terminal-session-manager|terminal-sse-lifecycle|health-controller",
    ...process.argv.slice(2),
  ],
  { stdio: "inherit", env: environment },
);
process.exitCode = result.status ?? 1;
