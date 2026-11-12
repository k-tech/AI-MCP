import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeContext, toolsFor } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { getDirectSpends, getClickUrlHistories, createDirectSpend, updateDirectSpend, updateClickUrlPrices } from "../src/tools/spend.js";
import { fakeApi } from "./fake-api.js";

const env = { FEEDMOB_API_BASE: "https://api.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "leo@feedmob.com" };
const cfgW = loadConfig({ ...env, ENABLE_WRITE: "true" });

test("write tools are hidden unless ENABLE_WRITE=true", () => {
  const ro = toolsFor(loadConfig(env)).map((t) => t.name);
  assert.ok(!ro.includes("create_direct_spend") && !ro.includes("update_direct_spend") && !ro.includes("update_click_url_prices"));
  assert.ok(toolsFor(cfgW).some((t) => t.name === "create_direct_spend"));
});

test("get_direct_spends: sends array filter and totals per click URL", async () => {
  const api = fakeApi({ "GET /ai/api/direct_spends": () => [200, { status: 200, data: [
    { click_url_id: 1, campaign_name: "A", date: "2026-11-01", feedmob_net_spend: 10, feedmob_gross_spend: 20 },
    { click_url_id: 1, campaign_name: "A", date: "2026-11-02", feedmob_net_spend: 5.5, feedmob_gross_spend: 10 },
    { click_url_id: 2, campaign_name: "B", date: "2026-11-01", feedmob_net_spend: 1, feedmob_gross_spend: 4 } ] }] });
  const r = await invokeTool(getDirectSpends, { start_date: "2026-11-01", end_date: "2026-11-02", click_url_ids: [1, 2] }, makeContext(cfgW, { fetchImpl: api.fetchImpl }));
  assert.equal(r.ok, true);
  assert.deepEqual(api.seen[0].query.getAll("click_url_ids[]"), ["1", "2"]);
  const d = r.data as any;
  assert.deepEqual(d.totals, { net: 16.5, gross: 34, rows: 3 });
  assert.deepEqual(d.by_click_url[0], { click_url_id: 1, campaign_name: "A", days: 2, net: 15.5, gross: 30, margin_pct: 48.33 });
});

test("get_direct_spends: requires a filter and a sane range", async () => {
  const ctx = makeContext(cfgW, { fetchImpl: fakeApi({}).fetchImpl });
  assert.match((await invokeTool(getDirectSpends, { start_date: "2026-11-01", end_date: "2026-11-02" }, ctx)).summary, /click_url_ids 或 client_id/);
  assert.match((await invokeTool(getDirectSpends, { start_date: "2026-11-05", end_date: "2026-11-01", client_id: 1 }, ctx)).summary, /结束日期/);
});

test("get_click_url_histories: collapses identical days into periods", async () => {
  const row = (date: string, net: number) => ({ click_url_id: 9, campaign_name: "C", vendor_name: "V", date, gross_cpi: 3, net_cpi: net, margin: 50 });
  const api = fakeApi({ "GET /ai/api/click_url_histories": () => [200, { status: 200, data: [row("2026-11-01", 1.1), row("2026-11-02", 1.1), row("2026-11-03", 1.5)] }] });
  const r = await invokeTool(getClickUrlHistories, { click_url_ids: [9], start_date: "2026-11-01", end_date: "2026-11-03" }, makeContext(cfgW, { fetchImpl: api.fetchImpl }));
  assert.deepEqual((r.data as any).periods.map((p: any) => [p.from, p.to, p.net_cpi]), [["2026-11-01", "2026-11-02", 1.1], ["2026-11-03", "2026-11-03", 1.5]]);
});

test("create_direct_spend: POSTs body and tags audit comment with caller", async () => {
  const api = fakeApi({ "POST /ai/api/direct_spends": (_u, b) => [200, { status: 200, data: { id: 77, ...b } }] });
  const r = await invokeTool(createDirectSpend, { click_url_id: 5, spend_date: "2026-11-05", net_spend: "125.50", gross_spend: 150, installs_count: 10, audit_comment: "import" },
    makeContext(cfgW, { fetchImpl: api.fetchImpl, caller: "amy@feedmob.com" }));
  assert.equal(r.ok, true);
  assert.deepEqual(api.seen[0].body, { click_url_id: 5, spend_date: "2026-11-05", net_spend: "125.50", gross_spend: 150, installs_count: 10, audit_comment: "[Tally · amy@feedmob.com] import" });
});

test("create_direct_spend: rejects negative and blank amounts before calling the API", async () => {
  const api = fakeApi({});
  const ctx = makeContext(cfgW, { fetchImpl: api.fetchImpl });
  assert.equal((await invokeTool(createDirectSpend, { click_url_id: 5, spend_date: "2026-11-05", net_spend: -1, gross_spend: 1 }, ctx)).ok, false);
  assert.equal((await invokeTool(createDirectSpend, { click_url_id: 5, spend_date: "2026-11-05", net_spend: " ", gross_spend: 1 }, ctx)).ok, false);
  assert.equal(api.seen.length, 0);
});

test("create_direct_spend: API 400 details are surfaced", async () => {
  const api = fakeApi({ "POST /ai/api/direct_spends": () => [400, { status: 400, errors: { spend_date: ["already exists"] } }] });
  const r = await invokeTool(createDirectSpend, { click_url_id: 5, spend_date: "2026-11-05", net_spend: 1, gross_spend: 1 }, makeContext(cfgW, { fetchImpl: api.fetchImpl }));
  assert.equal(r.ok, false); assert.match(r.summary, /Bad Request.*already exists/);
});

test("update_direct_spend: by id → PATCH /:id; by click URL → PATCH by_click_url with selectors", async () => {
  const api = fakeApi({ "PATCH /ai/api/direct_spends/42": () => [200, { status: 200 }], "PATCH /ai/api/direct_spends/by_click_url": () => [200, { status: 200 }] });
  const ctx = makeContext(cfgW, { fetchImpl: api.fetchImpl });
  assert.equal((await invokeTool(updateDirectSpend, { id: 42, net_spend: 0 }, ctx)).ok, true);
  assert.deepEqual(api.seen[0].body, { net_spend: 0, audit_comment: "[Tally · leo@feedmob.com]" });
  assert.equal((await invokeTool(updateDirectSpend, { click_url_id: 5, spend_date: "2026-11-05", clicks_count: "0" }, ctx)).ok, true);
  assert.equal(api.seen[1].path, "/ai/api/direct_spends/by_click_url");
  assert.deepEqual(api.seen[1].body, { clicks_count: "0", audit_comment: "[Tally · leo@feedmob.com]", click_url_id: 5, spend_date: "2026-11-05" });
});

test("update_direct_spend: selector and empty-change validation", async () => {
  const ctx = makeContext(cfgW, { fetchImpl: fakeApi({}).fetchImpl });
  assert.match((await invokeTool(updateDirectSpend, { id: 1, click_url_id: 2, net_spend: 1 }, ctx)).summary, /不能同时提供/);
  assert.match((await invokeTool(updateDirectSpend, { click_url_id: 2, net_spend: 1 }, ctx)).summary, /同时提供 click_url_id 和 spend_date/);
  assert.match((await invokeTool(updateDirectSpend, { id: 1, audit_comment: "x" }, ctx)).summary, /没有要修改的字段/);
});

test("update_click_url_prices: 422 confirmation is returned, never auto-confirmed", async () => {
  const warn = { status: 422, confirmation_required: true, warnings: [{ title: "Margin changed" }] };
  const api = fakeApi({ "PATCH /ai/api/click_urls/9/prices": () => [422, warn] });
  const r = await invokeTool(updateClickUrlPrices, { click_url_id: 9, prices: [{ spend_date: "2026-11-01", net_cpi: "1.1", gross_cpi: 3, margin: "N/A" }] }, makeContext(cfgW, { fetchImpl: api.fetchImpl }));
  assert.equal(r.ok, false); assert.match(r.summary, /没有保存/); assert.deepEqual(r.data, warn);
  assert.equal(api.seen.length, 1); assert.equal(api.seen[0].body.confirm, false);
});

test("update_click_url_prices: rejects duplicate and non-past dates", async () => {
  const api = fakeApi({});
  const ctx = makeContext(cfgW, { fetchImpl: api.fetchImpl });
  const p = { net_cpi: 1, gross_cpi: 2, margin: 50 };
  assert.match((await invokeTool(updateClickUrlPrices, { click_url_id: 9, prices: [{ spend_date: "2026-11-01", ...p }, { spend_date: "2026-11-01", ...p }] }, ctx)).summary, /日期不能重复/);
  assert.match((await invokeTool(updateClickUrlPrices, { click_url_id: 9, prices: [{ spend_date: "2999-01-01", ...p }] }, ctx)).summary, /今天之前/);
  assert.equal(api.seen.length, 0);
});

test("update_direct_spend: a redirect (e.g. to SSO) is reported clearly instead of 'fetch failed'", async () => {
  const fetchImpl: typeof fetch = async () => new Response(null, { status: 302, headers: { location: "https://sso-stage.example?return_to=x" } });
  const r = await invokeTool(updateDirectSpend, { click_url_id: 5, spend_date: "2026-11-05", net_spend: 1 }, makeContext(cfgW, { fetchImpl }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /重定向.*SSO.*PATCH \/ai\/api\/direct_spends\/by_click_url/);
  assert.doesNotMatch(r.summary, /fetch failed/);
});
