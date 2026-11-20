#!/usr/bin/env node
// HTTP entry: MCP endpoint (/mcp) + human console (/dashboard/) in one process.
import { loadConfig } from "./config.js";
import { createWebApp } from "./web/app.js";
import { UsageStore } from "./usage.js";
import { GoogleLogin } from "./web/google-auth.js";

const cfg = (() => { try { return loadConfig(); } catch (e) { console.error((e as Error).message); process.exit(1); } })();
const authMode = (process.env.TALLY_AUTH_MODE ?? "").trim();
if (authMode !== "local" && authMode !== "google") { console.error("TALLY_AUTH_MODE must be local or google"); process.exit(1); }
const accessToken = (process.env.MCP_HTTP_TOKEN ?? "").trim();
if (authMode === "local" && accessToken.length < 16) { console.error("MCP_HTTP_TOKEN is required (at least 16 characters) in local mode"); process.exit(1); }
const googleLogin = authMode === "google" ? (() => { try { return new GoogleLogin({ clientId: (process.env.GOOGLE_CLIENT_ID ?? "").trim(), clientSecret: (process.env.GOOGLE_CLIENT_SECRET ?? "").trim(), callbackUrl: (process.env.GOOGLE_CALLBACK_URL ?? "").trim() }); } catch (e) { console.error((e as Error).message); process.exit(1); } })() : undefined;
const port = Number(process.env.PORT ?? 8787);
const usage = new UsageStore(process.env.USAGE_DB ?? "data/usage.sqlite");

createWebApp(cfg, { accessToken, usage, googleLogin }).listen(port, "127.0.0.1", () => {
  console.log(`Tally on http://127.0.0.1:${port}  (MCP: /mcp, console: /dashboard/)  write=${cfg.enableWrite}`);
});
