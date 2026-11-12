#!/usr/bin/env node
// HTTP entry: MCP endpoint (/mcp) + human console (/dashboard/) in one process.
import { loadConfig } from "./config.js";
import { createWebApp } from "./web/app.js";
import { UsageStore } from "./usage.js";

const cfg = (() => { try { return loadConfig(); } catch (e) { console.error((e as Error).message); process.exit(1); } })();
const accessToken = (process.env.MCP_HTTP_TOKEN ?? "").trim();
if (accessToken.length < 16) { console.error("MCP_HTTP_TOKEN is required (at least 16 characters)"); process.exit(1); }
const port = Number(process.env.PORT ?? 8787);
const usage = new UsageStore(process.env.USAGE_DB ?? "data/usage.sqlite");

createWebApp(cfg, { accessToken, usage }).listen(port, "127.0.0.1", () => {
  console.log(`Tally on http://127.0.0.1:${port}  (MCP: /mcp, console: /dashboard/)  write=${cfg.enableWrite}`);
});
