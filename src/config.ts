export interface Config {
  /** Write environment (create / update tools). */
  apiBase: string;
  key: string;
  secret: string;
  /** Read environment (all read-only tools). Defaults to the write environment. */
  readApiBase: string;
  readKey: string;
  readSecret: string;
  userEmail: string;
  /** Write tools (create/update spend, update prices) are only registered when true. */
  enableWrite: boolean;
}

export const ALLOWED_EMAIL_DOMAIN = "feedmob.com";

export function isFeedmobEmail(email: string): boolean {
  return /^[^\s@]+@feedmob\.com$/i.test(email.trim());
}

/** Validate env vars; throws a readable error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const apiBase = (env.FEEDMOB_API_BASE ?? "").trim().replace(/\/+$/, "");
  const key = (env.FEEDMOB_KEY ?? "").trim();
  const secret = (env.FEEDMOB_SECRET ?? "").trim();
  const userEmail = (env.FEEDMOB_USER_EMAIL ?? "").trim().toLowerCase();

  if (!apiBase) problems.push("FEEDMOB_API_BASE is required");
  else if (!/^https?:\/\//.test(apiBase)) problems.push("FEEDMOB_API_BASE must start with http:// or https://");
  if (!key) problems.push("FEEDMOB_KEY is required");
  if (!secret) problems.push("FEEDMOB_SECRET is required");
  if (!userEmail) problems.push("FEEDMOB_USER_EMAIL is required");
  else if (!isFeedmobEmail(userEmail)) problems.push(`FEEDMOB_USER_EMAIL must be a @${ALLOWED_EMAIL_DOMAIN} address`);

  if (problems.length) throw new Error(`Invalid configuration:\n- ${problems.join("\n- ")}`);
  const readApiBase = (env.FEEDMOB_READ_API_BASE ?? "").trim().replace(/\/+$/, "") || apiBase;
  if (readApiBase && !/^https?:\/\//.test(readApiBase)) throw new Error("Invalid configuration:\n- FEEDMOB_READ_API_BASE must start with http:// or https://");
  const readKey = (env.FEEDMOB_READ_KEY ?? "").trim() || key;
  const readSecret = (env.FEEDMOB_READ_SECRET ?? "").trim() || secret;
  const enableWrite = (env.ENABLE_WRITE ?? "").trim().toLowerCase() === "true";
  return { apiBase, key, secret, readApiBase, readKey, readSecret, userEmail, enableWrite };
}
