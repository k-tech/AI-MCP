import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { makeContext, createServer, toolsFor } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { RAW_REPORT_TOOLS } from "../src/tools/raw-reports.js";
import { fakeApi } from "./fake-api.js";

const cfg = loadConfig({ FEEDMOB_API_BASE: "https://api.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "svc@feedmob.com" });
const tool = (n: string) => RAW_REPORT_TOOLS.find((t) => t.name === n)!;
const call = (n: string, args: object, routes: Parameters<typeof fakeApi>[0]) => { const w = fakeApi(routes); return invokeTool(tool(n), args, makeContext(cfg, { fetchImpl: w.fetchImpl })).then((r) => ({ r, w })); };

test("all 39 original read-only report tools are present, read-only, and names are unique", () => {
  const original = ["get_agency_conversion_metrics", "get_inmobi_report_ids", "check_inmobi_report_status", "get_inmobi_reports", "get_appsflyer_reports", "get_kochava_reports", "get_appsflyer_in_app_events_retarget_reports", "get_adops_reports", "get_possible_finance_singular_reports", "get_user_infos", "search_user_infos", "get_direct_spend_requests", "get_hubspot_tickets", "get_privacy_hawk_singular_reports", "get_koho_financial_singular_reports", "get_textnow_adjust_reports", "get_jampp_reports", "get_jampp_reports_geo", "get_direct_spend_job_stats", "get_apps", "get_adops_spend_check_reports", "get_agency_conversion_records", "get_smadex_report_ids", "check_smadex_report_status", "get_smadex_reports", "get_youappi_reports", "get_youappi_reports_geo", "get_kayzen_reports", "get_liftoff_report_ids", "check_liftoff_report_status", "get_liftoff_reports", "get_samsung_reports", "get_beeswax_reports", "get_remerge_reports", "get_remerge_reports_geo", "get_pubmatic_reports", "get_pubmatic_reports_geo", "get_appsflyer_cohort_revenues", "get_appsflyer_cohort_revenues_geo"];
  assert.deepEqual(RAW_REPORT_TOOLS.map((t) => t.name).sort(), [...original].sort());
  assert.ok(RAW_REPORT_TOOLS.every((t) => !t.write));
  const all = toolsFor(cfg).map((t) => t.name);
  assert.equal(new Set(all).size, all.length, "no duplicate tool names");
});

test("arrays go out as key[] and the path matches the original", async () => {
  const { r, w } = await call("get_appsflyer_reports", { start_date: "2026-11-09", end_date: "2026-11-09", click_url_ids: [1, 2] },
    { "GET /ai/api/appsflyer_reports": () => [200, { status: 200, data: [{ click_url_id: 1, install: 3 }] }] });
  assert.equal(r.ok, true);
  assert.deepEqual(w.seen[0].query.getAll("click_url_ids[]"), ["1", "2"]);
  assert.equal(w.seen[0].query.get("start_date"), "2026-11-09");
});

test("required and at-least-one params are enforced before calling the API", async () => {
  const a = await call("get_jampp_reports", { start_date: "2026-11-09", end_date: "2026-11-09" }, {});
  assert.equal(a.r.ok, false); assert.equal(a.w.seen.length, 0);
  const b = await call("get_direct_spend_requests", {}, {});
  assert.match(b.r.summary, /至少提供/); assert.equal(b.w.seen.length, 0);
});

test("HTTP 200 with {error} is reported as an error, not as empty data", async () => {
  const { r } = await call("get_kayzen_reports", { start_date: "2026-11-09", end_date: "2026-11-09" },
    { "GET /ai/api/kayzen_reports": () => [200, { error: 'key not found: "FEEDMOB_DATA_GATEWAY_ENDPOINT"' }] });
  assert.equal(r.ok, false); assert.match(r.summary, /FEEDMOB_DATA_GATEWAY_ENDPOINT/);
});

test("large results are truncated with a note", async () => {
  const rows = Array.from({ length: 450 }, (_, i) => ({ i }));
  const { r } = await call("get_user_infos", {}, { "GET /ai/api/user_infos": () => [200, rows] });
  assert.match(r.summary, /450 行.*只返回前 300 行/); assert.equal((r.data as any).rows.length, 300);
});

test("MCP clients receive the spend-finding instructions at connect time", async () => {
  const server = createServer(cfg);
  const client = new Client({ name: "agent", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const ins = client.getInstructions() ?? "";
  assert.match(ins, /find_direct_spend/); assert.match(ins, /gross = net ÷ \(1 − margin\/100\)/);
  await client.close();
});
