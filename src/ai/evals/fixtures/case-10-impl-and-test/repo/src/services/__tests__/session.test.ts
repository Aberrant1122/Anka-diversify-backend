import { getSessionTtlSeconds } from "../session";

export function testSessionTtl(): boolean {
  return getSessionTtlSeconds() === 7200;
}
