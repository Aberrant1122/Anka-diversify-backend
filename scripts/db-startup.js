const { execSync } = require("child_process");

// Migration failure must stop startup. Schema repair and account bootstrap
// require explicit operator action, never an automatic fallback on restart.
function runDatabaseStartup(run = execSync) {
  run("npx prisma migrate deploy", { stdio: "inherit" });
}
if (require.main === module) {
  try { runDatabaseStartup(); }
  catch {
    console.error("Database migration failed; server startup aborted.");
    process.exitCode = 1;
  }
}
module.exports = { runDatabaseStartup };
