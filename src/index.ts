#!/usr/bin/env node
// stdio entry (Claude Desktop / Claude Code running the server locally).
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";
import { UsageStore } from "./usage.js";

try {
  const cfg = loadConfig();
  const usage = process.env.USAGE_DB ? new UsageStore(process.env.USAGE_DB) : undefined;
  await createServer(cfg, { source: "stdio", usage }).connect(new StdioServerTransport());
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}
