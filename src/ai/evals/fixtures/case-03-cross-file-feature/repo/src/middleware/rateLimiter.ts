import { config } from "../config/server";

export function getRateLimitMs(): number {
  return config.rateLimitMs ?? 1000;
}
