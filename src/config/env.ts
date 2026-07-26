function required(name: string, minLength = 0): string {
  const value = process.env[name];
  if (!value || value.length < minLength) {
    throw new Error(
      `Missing required environment variable: ${name}` +
        (minLength ? ` (must be at least ${minLength} characters)` : ""),
    );
  }
  return value;
}

export const JWT_SECRET = required("JWT_SECRET");
export const ENCRYPTION_KEY = required("ENCRYPTION_KEY", 32);
