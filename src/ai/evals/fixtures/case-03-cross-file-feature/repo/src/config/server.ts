export interface ServerConfig {
  port: number;
  rateLimitMs?: number;
}

export const config: ServerConfig = {
  port: 3000,
};
