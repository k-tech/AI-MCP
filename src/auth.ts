import { createHmac } from "node:crypto";

const b64url = (input: Buffer | string) =>
  Buffer.from(input).toString("base64url");

/**
 * HS256 JWT identical in shape to the original server:
 * payload { key, expired_at: YYYY-MM-DD (now + 7 days) }.
 * Implemented with node:crypto so no jsonwebtoken dependency is needed.
 */
export function generateToken(key: string, secret: string, now: Date = new Date()): string {
  const exp = new Date(now);
  exp.setUTCDate(exp.getUTCDate() + 7);
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64url(JSON.stringify({ key, expired_at: exp.toISOString().split("T")[0] }));
  const sig = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  return `${header}.${payload}.${sig}`;
}
