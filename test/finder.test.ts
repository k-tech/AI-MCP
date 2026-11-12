import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeContext, toolsFor } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { findDirectSpend, createDirectSpendFromSources, classifySource } from "../src/tools/finder.js";
import { fakeApi } from "./fake-api.js";

const cfg = loadConfig({ FEEDMOB_API_BASE: "https://api.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "svc@feedmob.com", ENABLE_WRITE: "true" });
const D = "2026-11-09", ID = 100;
const rate = { click_url_id: ID, campaign_name: "C", vendor_name: "V", date: D, net_cpi: 1.5, gross_cpi: 2.5, margin: 40, client_paid_action: "first_install", vendor_paid_action: "first_install" };
const job = (g: string, n: string) => ({ job: "CreateXJob", status: "live", gross_spend_source: g, net_spend_source: n, schedule: "0 6 * * *", pa_users: ["pa@feedmob.com"], pm_users: [], notes: "", click_url_ids: [ID] });
function world(o: { spends?: unknown[]; rate?: unknown; jobs?: unknown[]; af?: unknown[]; reports?: Record<string, unknown[]> } = {}) {
  return fakeApi({
    "GET /ai/api/direct_spends": () => [200, { status: 200, data: o.spends ?? [] }],
    "GET /ai/api/click_url_histories": () => [200, { status: 200, data: [o.rate ?? rate] }],
    "GET /ai/api/direct_spend_job_stats": () => [200, { status: 200, data: o.jobs ?? [] }],
    "GET /ai/api/appsflyer_reports": () => [200, { status: 200, data: o.af ?? [] }],
    "GET /ai/api/kochava_reports": () => [200, { status: 200, data: [] }],
    "GET /ai/api/client_report_spends/report_names": () => [200, { status: 200, data: Object.keys(o.reports ?? {}) }],
    "GET /ai/api/client_report_spends": (u) => [200, { status: 200, data: (o.reports ?? {})[u.searchParams.get("report_name") ?? ""] ?? [] }],
    "POST /ai/api/direct_spends": (_u, b) => [200, { status: 200, data: { id: 9, ...b } }],
  });
}
const af = [{ date: D, click_url_id: ID, install: 10, registration: 0, purchase: 0 }];
const run = (tool: any, w: ReturnType<typeof world>, args: object = {}) => invokeTool(tool, { click_url_id: ID, spend_date: D, ...args }, makeContext(cfg, { fetchImpl: w.fetchImpl, caller: "amy@feedmob.com" }));

test("classifySource: only readable sources are computed", () => {
  assert.equal(classifySource("appsflyer_raw_log_install_reports"), "events");
  assert.equal(classifySource("AF, click URL"), "events");
  assert.equal(classifySource("gross_spend * (1 - margin / 100)"), "derive");
  assert.equal(classifySource("Calculated from net"), "derive");
  for (const ext of ["vendor report", "kayzen api", "partner email report", "manualy， from samsung reports", "=gross rate * 1st REG"]) assert.equal(classifySource(ext), "external", ext);
  assert.equal(classifySource(""), "none");
});

test("find: AppsFlyer events × CPI → ready, with counts and explanation", async () => {
  const r = await run(findDirectSpend, world({ af, jobs: [job("appsflyer raw log install", "AF, click URL")] }));
  const f = r.data as any;
  assert.equal(f.status, "ready");
  assert.deepEqual(f.proposal, { click_url_id: ID, spend_date: D, net_spend: 15, gross_spend: 25, client_paid_action_count: 10, partner_paid_action_count: 10, installs_count: 10 });
  assert.match(f.gross.how, /AppsFlyer first_install 10 × gross CPI 2.5/);
});

test("find: existing record short-circuits", async () => {
  const r = await run(findDirectSpend, world({ spends: [{ id: 5, click_url_id: ID, date: D, feedmob_net_spend: 1, feedmob_gross_spend: 2 }], af }));
  assert.equal((r.data as any).status, "exists"); assert.match(r.summary, /update_direct_spend/);
});

test("find: job says net comes from an API Tally cannot read → partial, never guessed", async () => {
  const r = await run(findDirectSpend, world({ af, jobs: [job("appsflyer_raw_log_install_reports", "kayzen api")] }));
  const f = r.data as any;
  assert.equal(f.status, "partial"); assert.equal(f.gross.value, 25); assert.equal(f.net.value, null); assert.match(f.net.how, /kayzen api/);
});

test("find: vendor-report job → not_found with owner", async () => {
  const r = await run(findDirectSpend, world({ af, rate: { ...rate, client_paid_action: "vendor_managed", vendor_paid_action: "vendor_managed" }, jobs: [job("vendor report", "vendor report")] }));
  assert.equal((r.data as any).status, "not_found"); assert.match(r.summary, /pa@feedmob\.com/);
});

test("find: no job, internal client report gross + derived net", async () => {
  const r = await run(findDirectSpend, world({ reports: { "Some Report": [{ click_url_id: ID, spend_date: D, gross_spend: 100 }] } }));
  const f = r.data as any;
  assert.equal(f.status, "ready"); assert.equal(f.gross.value, 100); assert.equal(f.net.value, 60); assert.match(f.advice, /请人工核对/);
});

test("create_from_sources: preview saves nothing; confirm writes with an explanatory audit comment", async () => {
  const w = world({ af, jobs: [job("appsflyer raw log install", "AF, click URL")] });
  const preview = await run(createDirectSpendFromSources, w);
  assert.equal(preview.ok, true); assert.match(preview.summary, /尚未写入/); assert.equal(w.seen.filter((s) => s.method === "POST").length, 0);
  const done = await run(createDirectSpendFromSources, w, { confirm: true });
  assert.equal(done.ok, true);
  const post = w.seen.find((s) => s.method === "POST")!;
  assert.equal(post.body.net_spend, 15); assert.equal(post.body.gross_spend, 25);
  assert.match(post.body.audit_comment, /^\[Tally · amy@feedmob\.com\] 自动录入：gross = AppsFlyer first_install 10 × gross CPI 2\.5/);
});

test("create_from_sources: refuses when an amount is unknown", async () => {
  const w = world({ af, jobs: [job("appsflyer_raw_log_install_reports", "kayzen api")] });
  const r = await run(createDirectSpendFromSources, w, { confirm: true });
  assert.equal(r.ok, false); assert.match(r.summary, /没有写入/); assert.equal(w.seen.filter((s) => s.method === "POST").length, 0);
});

test("finder tools are registered; the writing one only with ENABLE_WRITE", () => {
  assert.ok(toolsFor(cfg).some((t) => t.name === "create_direct_spend_from_sources"));
  const ro = toolsFor(loadConfig({ FEEDMOB_API_BASE: "https://a.b", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "a@feedmob.com" })).map((t) => t.name);
  assert.ok(ro.includes("find_direct_spend") && !ro.includes("create_direct_spend_from_sources"));
});
