import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadConfig } from "../src/config.js";
import { createWebApp } from "../src/web/app.js";
import { UsageStore } from "../src/usage.js";
import { fakeApi } from "./fake-api.js";

const TOKEN = "t".repeat(32);
const cfg = loadConfig({ FEEDMOB_API_BASE: "http://localhost:4010", FEEDMOB_KEY: "mock-key", FEEDMOB_SECRET: "s3cret", FEEDMOB_USER_EMAIL: "svc@feedmob.com" });
const api = fakeApi({ "GET /ai/api/clients": (u) => {
  const q = u.searchParams.get("client_name")?.toLowerCase() ?? "";
  return [200, [{ id: 1, name: "Uber Technologies" }, { id: 2, name: "Lyft" }].filter((c) => c.name.toLowerCase().includes(q))];
}, "GET /ai/api/samsung_reports": () => [200, [{ date: "2026-11-01", partner_net_spend: 5, click_url_id: 1, samsung_content_id: "A" }]],
  "GET /ai/api/direct_spends": () => [200, [{ click_url_id: 1, date: "2026-11-01", feedmob_net_spend: 5, feedmob_gross_spend: 5 }]]
});
const usage = new UsageStore();
let server: Server, base = "";
before(async () => {
  server = createWebApp(cfg, { accessToken: TOKEN, fetchImpl: api.fetchImpl, usage });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const post = (path: string, body: unknown, cookie = "") =>
  fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", cookie }, body: JSON.stringify(body), redirect: "manual" });
const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie } }).then((r) => r.json());
async function login(email = "leo@feedmob.com") {
  const r = await post("/api/login", { email, token: TOKEN });
  assert.equal(r.status, 200);
  return (r.headers.get("set-cookie") ?? "").split(";")[0];
}
const mcpCall = (bearer: string, name: string, args: unknown = {}) => fetch(base + "/mcp", {
  method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
});

test("web: console requires login", async () => {
  const r = await fetch(base + "/dashboard/", { redirect: "manual" });
  assert.equal(r.status, 302); assert.equal(r.headers.get("location"), "/login");
  assert.equal((await fetch(base + "/api/status")).status, 401);
});

test("web: login rejects non-feedmob email and wrong token", async () => {
  assert.equal((await post("/api/login", { email: "a@gmail.com", token: TOKEN })).status, 403);
  assert.equal((await post("/api/login", { email: "a@feedmob.com", token: "wrong" })).status, 401);
});

test("web: status, tool list and tool calls for a logged-in user", async () => {
  const cookie = await login();
  const page = await fetch(base + "/dashboard/", { headers: { cookie } });
  assert.equal(page.status, 200); assert.match(await page.text(), /Tally 控制台/);
  const st = await get("/api/status", cookie);
  assert.equal(st.mockApi, true); assert.equal(st.writeEnabled, false); assert.equal(st.toolCount, 54); assert.equal(st.hiddenWriteTools, 4);
  assert.doesNotMatch(JSON.stringify(st), /s3cret/);
  const { tools } = await get("/api/tools", cookie);
  assert.ok(tools.some((t: any) => t.name === "get_vendor_report_overview" && t.enabled && !t.write));
  assert.ok(tools.some((t: any) => t.name === "compare_vendor_report_with_direct_spend" && t.enabled && !t.write));
  const create = tools.find((t: any) => t.name === "create_direct_spend");
  assert.equal(create.enabled, false); assert.equal(create.write, true); assert.ok(create.inputSchema.properties.net_spend);
  const call = await (await post("/api/tools/call", { name: "get_clients", arguments: { client_name: "lyft" } }, cookie)).json();
  assert.equal(call.ok, true); assert.deepEqual(call.data, [{ id: 2, name: "Lyft" }]);
  const denied = await post("/api/tools/call", { name: "create_direct_spend", arguments: {} }, cookie);
  assert.equal(denied.status, 404); assert.match((await denied.json()).error, /ENABLE_WRITE/);
});

test("web: dashboard and MCP calls are attributed to the right person", async () => {
  const cookie = await login("amy@feedmob.com");
  await post("/api/tools/call", { name: "get_clients", arguments: {} }, cookie);
  const { token } = await (await post("/api/tokens", { label: "laptop" }, cookie)).json();
  assert.equal((await mcpCall(token, "get_clients", { client_name: "uber" })).status, 200);
  const shared = await mcpCall(TOKEN, "whoami");                       // shared token no longer works on /mcp
  assert.equal(shared.status, 401); assert.match((await shared.json()).hint, /个人令牌/);
  assert.equal((await mcpCall("aimcp_bogus", "whoami")).status, 401);
  const { calls } = await get("/api/usage/calls?limit=3", cookie);
  assert.deepEqual(calls.map((c: any) => [c.caller, c.source, c.tool]), [
    ["amy@feedmob.com", "mcp-http", "get_clients"], ["amy@feedmob.com", "dashboard", "get_clients"]].concat(calls.slice(2).map((c: any) => [c.caller, c.source, c.tool])));
  assert.ok(calls.every((c: any) => c.caller.endsWith("@feedmob.com")), "no anonymous caller is ever recorded");
  const sum = await get("/api/usage/summary?days=1", cookie);
  assert.ok(sum.total >= 3);
  const { tokens } = await get("/api/tokens", cookie);
  assert.equal(tokens.length, 1); assert.equal(JSON.stringify(tokens).includes(token), false, "plaintext token never listed");
  assert.equal((await post("/api/tokens/revoke", { id: tokens[0].id }, cookie)).status, 200);
  assert.equal((await mcpCall(token, "whoami")).status, 401);
});

test("web: vendor reconciliation uses the audited tool route", async () => {
  const cookie = await login("vendor@feedmob.com");
  const args = { partner: "samsung", start_date: "2026-11-01", end_date: "2026-11-01" };
  const r = await (await post("/api/tools/call", { name: "compare_vendor_report_with_direct_spend", arguments: args }, cookie)).json();
  assert.equal(r.ok, true); assert.equal(r.data.counts.match, 1);
  const { calls } = await get("/api/usage/calls?limit=1", cookie);
  assert.equal(calls[0].caller, "vendor@feedmob.com"); assert.equal(calls[0].tool, "compare_vendor_report_with_direct_spend");
});

test("web: supplied report console route accepts multi-value filters", async () => {
  const cookie = await login();
  const page = await (await fetch(base + "/dashboard/", { headers: { cookie } })).text();
  assert.match(page, /values/);
  const args = { click_url_id: 23505, spend_date: "2026-11-05", source_name: "synthetic", csv_text: "day,campaign,tag,ccy,net\n2026-11-05,A,T1,USD,10\n2026-11-05,A,T2,USD,20\n2026-11-05,A,T3,USD,50", columns: { date: "day", currency: "ccy", net: "net" }, mapping: { basis: "synthetic", filters: [{ column: "campaign", value: "A" }, { column: "tag", values: ["T1", "T2"] }] }, check_existing: true };
  const r = await (await post("/api/tools/call", { name: "preview_supplied_spend_report", arguments: args }, cookie)).json();
  assert.equal(r.ok, true, r.summary); assert.equal(r.data.matched_rows, 2); assert.equal(r.data.net, 30); assert.equal(r.data.suggested_create, null);
});

test("web: Vizio-shaped preview route accepts explicit date format and no currency column", async () => {
  const cookie = await login();
  const page = await (await fetch(base + "/dashboard/", { headers: { cookie } })).text();
  assert.match(page, /id="supDateFormat"/); assert.match(page, /mm\/dd\/yyyy hh:mm/);
  const args = { click_url_id: 1, spend_date: "2026-11-01", source_name: "synthetic", date_format: "mm/dd/yyyy hh:mm", csv_text: "Date,tag,Revenue\n11/01/2026 00:00,T1,5\n11/01/2026 00:00,T2,6\n11/02/2026 00:00,T1,50", columns: { date: "Date", net: "Revenue" }, mapping: { basis: "synthetic", filters: [{ column: "tag", values: ["T1", "T2"] }] }, check_existing: true };
  const r = await (await post("/api/tools/call", { name: "preview_supplied_spend_report", arguments: args }, cookie)).json();
  assert.equal(r.ok, true, r.summary); assert.equal(r.data.net, 11); assert.equal(r.data.currency, null); assert.equal(r.data.existing.length, 1); assert.equal(r.data.suggested_create, null); assert.match(r.summary, /币种 未知/);
});

test("web: source currency evidence passes through console route", async () => {
  const cookie = await login();
  const page = await (await fetch(base + "/dashboard/", { headers: { cookie } })).text();
  assert.match(page, /id="supSourceCurrency"/); assert.match(page, /id="supSourceCurrencyBasis"/); assert.match(page, /id="supNoCurrencyColumn"/);
  const args = { click_url_id: 1, spend_date: "2026-11-01", source_name: "synthetic", csv_text: "day,url,net\n2026-11-01,1,5", columns: { date: "day", click_url_id: "url", net: "net" }, source_currency: { currency: "USD", basis: "synthetic report proof", no_currency_column: true }, ledger: { currency: "USD", basis: "synthetic ledger" }, billing_rule: { type: "margin_on_gross", margin_percent: 0, currency: "USD", effective_from: "2026-11-01", effective_to: "2026-11-01", basis: "synthetic rule" }, check_existing: true };
  const r = await (await post("/api/tools/call", { name: "preview_supplied_spend_report", arguments: args }, cookie)).json();
  assert.equal(r.ok, true, r.summary); assert.equal(r.data.currency, "USD"); assert.equal(r.data.gross, 5); assert.equal(r.data.source_currency_basis, "synthetic report proof"); assert.equal(r.data.suggested_create, null);
});

test("web: Chime preflight is authenticated and makes no upstream request or usage log", async () => {
  const args = { target_date: "2026-11-03", files: [{ name: "synthetic.csv", csv_text: "date,app-id,agency,media-source,campaign-id,campaign,geo,currency,spend,adset,ad\n2026-11-03,app,agency,media,id,campaign,US,USD,1.25,set,ad" }] };
  assert.equal((await post("/api/chime/preflight", args)).status, 401);
  const cookie = await login(); const seen = api.seen.length, calls = usage.calls().length;
  const page = await (await fetch(base + "/dashboard/", { headers: { cookie } })).text();
  assert.match(page, /r-chime/); assert.match(page, /daily_report_logs\?report_config_id=41/);
  const r = await post("/api/chime/preflight", args, cookie); assert.equal(r.status, 200);
  const data = await r.json(); assert.equal(data.rows, 1); assert.equal(data.issue_count, 0); assert.deepEqual(data.totals, [{ currency: "USD", spend: "1.25" }]);
  assert.equal(api.seen.length, seen); assert.equal(usage.calls().length, calls);
});

test("web: Chime preflight accepts near-limit quoted CSV and rejects oversized decoded CSV", async () => {
  const cookie = await login();
  const header = "date,app-id,agency,media-source,campaign-id,campaign,geo,currency,spend,adset,ad";
  const quoted = `"${'""'.repeat(64)}"`;
  const csv_text = `${header}\n${Array.from({ length: 4000 }, (_, i) => `2026-11-03,app,agency,media,id${i},campaign,US,USD,1,set,${quoted}`).join("\n")}`;
  const args = { target_date: "2026-11-03", files: [{ name: "synthetic.csv", csv_text }] };
  assert.ok(Buffer.byteLength(csv_text) > 740000 && Buffer.byteLength(csv_text) <= 800000);
  assert.ok(Buffer.byteLength(JSON.stringify(args)) > 1_000_000);
  const seen = api.seen.length, calls = usage.calls().length;
  const r = await post("/api/chime/preflight", args, cookie);
  assert.equal(r.status, 200, await r.clone().text());
  const data = await r.json(); assert.equal(data.rows, 4000); assert.equal(data.issue_count, 0); assert.deepEqual(data.totals, [{ currency: "USD", spend: "4000" }]);
  const exact = csv_text.slice(0, -1) + "a".repeat(800000 - Buffer.byteLength(csv_text)) + '"';
  assert.equal(Buffer.byteLength(exact), 800000);
  const atLimit = await post("/api/chime/preflight", { ...args, files: [{ name: "exact.csv", csv_text: exact }] }, cookie);
  assert.equal(atLimit.status, 200, await atLimit.clone().text()); assert.equal((await atLimit.json()).rows, 4000);
  const oversized = { target_date: "2026-11-03", files: [{ name: "one.csv", csv_text: "a".repeat(400001) }, { name: "two.csv", csv_text: "a".repeat(400000) }] };
  const rejected = await post("/api/chime/preflight", oversized, cookie);
  assert.equal(rejected.status, 400); assert.match((await rejected.json()).error, /800,000/);
  const otherRoute = await post("/api/tools/call", { name: "get_clients", arguments: { padding: "x".repeat(1_000_001) } }, cookie);
  assert.equal(otherRoute.status, 400); assert.match((await otherRoute.json()).error, /请求体过大/);
  assert.equal(api.seen.length, seen); assert.equal(usage.calls().length, calls);
});

test("web: logout ends the session", async () => {
  const cookie = await login();
  await post("/api/logout", {}, cookie);
  assert.equal((await fetch(base + "/api/me", { headers: { cookie } })).status, 401);
});

test("any standard MCP client can connect over Streamable HTTP with a personal token", async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const cookie = await login("amy@feedmob.com");
  const { token } = await (await post("/api/tokens", { label: "sdk-client" }, cookie)).json();
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: "generic-agent", version: "1" });
  await client.connect(transport);                       // initialize + initialized notification
  const { tools } = await client.listTools();
  assert.ok(tools.length >= 49 && tools.every((t) => t.inputSchema.type === "object"));
  assert.match(JSON.stringify(tools.find(t => t.name === "preview_supplied_spend_report")?.inputSchema), /values/);
  const preview: any = await client.callTool({ name: "preview_supplied_spend_report", arguments: { click_url_id: 23505, spend_date: "2026-11-05", source_name: "synthetic", csv_text: "day,tag,ccy,net\n2026-11-05,T1,USD,10\n2026-11-05,T2,USD,20", columns: { date: "day", currency: "ccy", net: "net" }, mapping: { basis: "synthetic", filters: [{ column: "tag", values: ["T1", "T2"] }] }, check_existing: true } });
  assert.notEqual(preview.isError, true); assert.match(preview.content[0].text, /匹配 2 行/);
  const unknown: any = await client.callTool({ name: "preview_supplied_spend_report", arguments: { click_url_id: 1, spend_date: "2026-11-01", source_name: "synthetic", date_format: "mm/dd/yyyy hh:mm", csv_text: "day,url,net\n11/01/2026 00:00,1,5", columns: { date: "day", click_url_id: "url", net: "net" }, check_existing: true } });
  assert.notEqual(unknown.isError, true); assert.match(unknown.content[0].text, /币种 未知/);
  const evidenced: any = await client.callTool({ name: "preview_supplied_spend_report", arguments: { click_url_id: 1, spend_date: "2026-11-01", source_name: "synthetic", csv_text: "day,url,net\n2026-11-01,1,5", columns: { date: "day", click_url_id: "url", net: "net" }, source_currency: { currency: "USD", basis: "synthetic report proof", no_currency_column: true }, check_existing: true } });
  assert.notEqual(evidenced.isError, true); assert.match(evidenced.content[0].text, /synthetic report proof/);
  const r: any = await client.callTool({ name: "whoami", arguments: {} });
  assert.match(r.content[0].text, /amy@feedmob\.com/);
  await client.close();
  // wrong token is rejected at connect time
  const bad = new Client({ name: "x", version: "1" });
  await assert.rejects(bad.connect(new StreamableHTTPClientTransport(new URL(base + "/mcp"), { requestInit: { headers: { Authorization: "Bearer aimcp_nope" } } })));
});
