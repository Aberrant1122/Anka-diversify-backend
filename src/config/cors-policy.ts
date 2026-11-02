import { CorsOptions } from "cors";

export function createCorsOptions(env: NodeJS.ProcessEnv = process.env): CorsOptions {
  const allowedOrigins = new Set(
    (env.NODE_ENV === "production"
      ? [env.FRONTEND_URL]
      : [env.FRONTEND_URL, "http://localhost:3000", "http://127.0.0.1:3000",
          "http://localhost:3001", "http://127.0.0.1:3001"])
      .filter((value): value is string => Boolean(value)),
  );
  return {
    // Origin-less clients still require authentication; CORS is not authorization.
    origin: (origin, callback) => callback(null, !origin || allowedOrigins.has(origin)),
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // Existing clients send these legacy headers; identity still comes from JWT.
    allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization", "X-User-ID", "X-User-Name"],
  };
}
