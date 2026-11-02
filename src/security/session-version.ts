import { createHmac } from "crypto";
import { JWT_SECRET } from "../config/env";

// Changing a password invalidates every previously issued token. The password
// hash is never placed in a token; legacy unversioned tokens require re-login.
export function sessionVersion(user: { id: string; password: string }): string {
  return createHmac("sha256", JWT_SECRET)
    .update(JSON.stringify([user.id, user.password]))
    .digest("hex");
}
