import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { ApiClient, type FetchLike } from "./http.js";
import { invokeTool, toMcpContent, type ToolContext, type ToolDef } from "./tools/registry.js";
import { whoami } from "./tools/meta.js";
import { getClients } from "./tools/clients.js";
import { getDirectSpends, getClickUrlHistories, createDirectSpend, updateDirectSpend, updateClickUrlPrices } from "./tools/spend.js";
import { getVendors, getCampaigns, getReportNames, getClientReportSpends } from "./tools/reports.js";
import { getUsageStats } from "./tools/usage.js";
import { findDirectSpend, createDirectSpendFromSources } from "./tools/finder.js";
import { RAW_REPORT_TOOLS } from "./tools/raw-reports.js";
import { getClientReportOverview, compareClientReport } from "./tools/report-overview.js";
import type { Source, UsageStore } from "./usage.js";
import { VERSION } from "./version.js";

export { VERSION };

export const ALL_TOOLS: ToolDef[] = [
  whoami, getClients,
  getDirectSpends, getClickUrlHistories, findDirectSpend, createDirectSpend, createDirectSpendFromSources, updateDirectSpend, updateClickUrlPrices,
  getVendors, getCampaigns, getReportNames, getClientReportSpends, getClientReportOverview, compareClientReport,
  getUsageStats,
  ...RAW_REPORT_TOOLS,
];

/** Sent to every MCP client at connect time: how to find a spend the way the original skill + agent did. */
export const SERVER_INSTRUCTIONS = `Tally: FeedMob spend, rate and report tools.
Environments (see whoami): read-only tools read the READ environment; write tools (create/update) write to the WRITE environment and do their own lookups there. When they differ (e.g. read = production, write = staging), a record or ID seen with a read tool may not exist where writes go — let the write tools look it up themselves.

Entering a direct spend when the user did NOT give amounts — do not ask first, look it up:
1. find_direct_spend(click_url_id, spend_date). If status is ready, show the amounts and how each was computed, then create after the user agrees (create_direct_spend_from_sources with confirm: true).
2. If partial / not_found: get_direct_spend_job_stats(click_url_id) tells where gross and net come from, and get_click_url_histories gives that day's net/gross CPI, margin and paid actions.
   - MMP source (AppsFlyer, Kochava, Singular, Adjust, conversion records): gross = count of client_paid_action × gross CPI; net = count of vendor_paid_action × net CPI.
   - Partner report (Samsung, YouAppi, Kayzen, Jampp, Remerge, Pubmatic, Beeswax, InMobi, Smadex, Liftoff): net = partner net spend for that click URL/day.
   - vendor_managed with a margin: gross = net ÷ (1 − margin/100); "Calculated from net" means the same.
   - A source Tally has no tool for (Google Sheet, partner email, an API not listed): say so and name the job owner (pa_users); do not guess.
3. Show raw rows → the calculation → the result before writing. Never invent numbers. Check get_direct_spends first so you do not create a duplicate.`;

/** Tools available under this config: write tools only when ENABLE_WRITE=true. */
export const toolsFor = (cfg: Config) => ALL_TOOLS.filter((t) => cfg.enableWrite || !t.write);

export interface ServerOptions { fetchImpl?: FetchLike; caller?: string; source?: Source; usage?: UsageStore }

export function makeContext(cfg: Config, opts: ServerOptions = {}): ToolContext {
  const read = new ApiClient({ apiBase: cfg.readApiBase, key: cfg.readKey, secret: cfg.readSecret }, opts.fetchImpl, true);
  const write = new ApiClient(cfg, opts.fetchImpl);
  return { cfg, api: read, writeApi: write, caller: opts.caller ?? cfg.userEmail, source: opts.source ?? "stdio", usage: opts.usage };
}

export function createServer(cfg: Config, opts: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "tally", version: VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const ctx = makeContext(cfg, opts);
  for (const def of toolsFor(cfg)) {
    server.tool(def.name, def.description, def.schema, async (args: unknown) => toMcpContent(await invokeTool(def, args, ctx)));
  }
  return server;
}
