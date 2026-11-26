export function ownerBootstrap(env: NodeJS.ProcessEnv = process.env) {
  const email = env.ADMIN_EMAIL?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 16) {
    throw new Error("Explicit ADMIN_EMAIL and ADMIN_PASSWORD (at least 16 characters) are required for manual bootstrap.");
  }
  return { email, password, name: env.ADMIN_NAME || "Owner" };
}
