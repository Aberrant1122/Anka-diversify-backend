const { execSync } = require("child_process");

function runDatabaseStartup() {
  console.log("Checking and applying database migrations...");

  try {
    // 1. Try standard migration deployment (executes unapplied migrations, skips applied ones)
    execSync("npx prisma migrate deploy", { stdio: "inherit" });
    console.log("Migrations checked and deployed successfully.");
  } catch (error) {
    console.warn("Migration deploy encountered a schema drift error. Falling back to automatic schema sync (db push)...");
    try {
      // 2. If migrate deploy encounters drift or column collision, fallback to db push
      execSync("npx prisma db push", { stdio: "inherit" });
      console.log("Database schema synchronized successfully via db push.");
    } catch (pushErr) {
      console.error("Database sync failed:", pushErr.message);
    }
  }

  try {
    // 3. Run database seed (idempotent - safely skips existing admin)
    console.log("Ensuring database seed data...");
    execSync("npx prisma db seed", { stdio: "inherit" });
  } catch (seedErr) {
    console.warn("Database seed warning:", seedErr.message);
  }
}

runDatabaseStartup();
