import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeContext } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { getClientReportOverview, compareClientReport, daysBetween } from "../src/tools/report-overview.js";
import { fakeApi } from "./fake-api.js";

const cfg = loadConfig({ FEEDMOB_API_BASE: "https://api.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "a@feedmob.com" });
const rr = (cu: number, d: string, g: number, vendor = "V") => ({ click_url_id: cu, spend_date: d, gross_spend: g, vendor_name: vendor, campaign_name: `C${cu}`, created_at: `${d}T09:00:00Z` });
const REPORTS: Record<string, unknown[]> = {
  "Chime Agency Spend": [rr(1, "2026-11-01", 100), rr(1, "2026-11-03", 20), rr(2, "2026-10-20", 5, "LG")],
  "Empty One": [],
};
const DIRECT = [
  { click_url_id: 1, date: "2026-11-01", campaign_name: "C1", feedmob_net_spend: 70, feedmob_gross_spend: 100 },
  { click_url_id: 1, date: "2026-11-02", campaign_name: "C1", feedmob_net_spend: 35, feedmob_gross_spend: 50 },
  { click_url_id: 1, date: "2026-11-03", campaign_name: "C1", feedmob_net_spend: 20, feedmob_gross_spend: 25 },
  { click_url_id: 2, date: "2026-11-01", campaign_name: "C2", feedmob_net_spend: 20, feedmob_gross_spend: 30 },
];
const world = () => fakeApi({
  "GET /ai/api/client_report_spends/report_names": () => [200, { status: 200, data: Object.keys(REPORTS) }],
  "GET /ai/api/client_report_spends": (u) => [200, { status: 200, data: REPORTS[u.searchParams.get("report_name") ?? ""] ?? [] }],
  "GET /ai/api/direct_spends": () => [200, { status: 200, data: DIRECT }],
});
const ctx = () => makeContext(cfg, { fetchImpl: world().fetchImpl });

test("daysBetween is inclusive", () => assert.deepEqual(daysBetween("2026-10-31", "2026-11-02"), ["2026-10-31", "2026-11-01", "2026-11-02"]));

test("overview: missing days, status, admin name", async () => {
  const r = await invokeTool(getClientReportOverview, { start_date: "2026-11-01", end_date: "2026-11-03" }, ctx());
  const [chime, empty] = (r.data as any).reports;
  assert.equal(chime.status, "gaps"); assert.deepEqual(chime.missing_days, ["2026-11-02"]); assert.equal(chime.admin_name, "Chime Agency AF Daily Spend");
  assert.equal(chime.total_gross, 120); assert.equal(chime.latest_spend_date, "2026-11-03");
  assert.equal(empty.status, "empty");
  assert.match(r.summary, /有缺天 1 份，无数据 1 份/);
});

test("compare: match, diff, missing in report (incl. a click URL seen only in the lookback)", async () => {
  const r = await invokeTool(compareClientReport, { report_name: "Chime Agency Spend", start_date: "2026-11-01", end_date: "2026-11-03" }, ctx());
  const d = r.data as any;
  assert.deepEqual(d.rows.map((x: any) => [x.click_url_id, x.date, x.status, x.diff]), [
    [1, "2026-11-01", "match", 0], [2, "2026-11-01", "missing_in_report", null], [1, "2026-11-02", "missing_in_report", null], [1, "2026-11-03", "diff", -5]]);
  assert.deepEqual(d.counts, { match: 1, diff: 1, missing_in_report: 2, missing_in_direct: 0, outside_report_scope: 0 });
  assert.equal(d.totals.missing_in_report_gross, 80);
  const lg = d.by_click_url.find((x: any) => x.click_url_id === 2);
  assert.equal(lg.vendor_name, "LG"); assert.deepEqual(lg.missing_in_report, ["2026-11-01"]);
});

test("compare: a report with no data says so", async () => {
  const r = await invokeTool(compareClientReport, { report_name: "Empty One", start_date: "2026-11-01", end_date: "2026-11-03" }, ctx());
  assert.equal(r.ok, true); assert.match(r.summary, /没有任何数据/);
});

test("client reconciliation exposes unknown currency and rejects malformed or mixed data", async () => {
  const normal = await invokeTool(compareClientReport, { report_name: "Chime Agency Spend", start_date: "2026-11-01", end_date: "2026-11-03" }, ctx());
  assert.equal((normal.data as any).reconciliation_verified, false);
  assert.ok((normal.data as any).currency_info.unknown_currency_rows > 0);
  const api = fakeApi({ "GET /ai/api/client_report_spends": () => [200, { data: [{ ...rr(1, "2026-11-01", 5), currency: "USD" }, { ...rr(1, "2026-11-01", 5), currency: "EUR" }] }] });
  const mixed = await invokeTool(compareClientReport, { report_name: "X", start_date: "2026-11-01", end_date: "2026-11-03" }, makeContext(cfg, { fetchImpl: api.fetchImpl }));
  assert.equal(mixed.ok, false); assert.match(mixed.summary, /多种币种/);
});

test("explicit URL scope includes previously unseen URLs without asserting report membership", async () => {
  const api = fakeApi({
    "GET /ai/api/client_report_spends": () => [200, { data: [rr(1, "2026-11-01", 10)] }],
    "GET /ai/api/direct_spends": () => [200, { data: [
      { click_url_id: 1, date: "2026-11-01", campaign_name: "C1", feedmob_net_spend: 5, feedmob_gross_spend: 10 },
      { click_url_id: 3, date: "2026-11-01", campaign_name: "C3", feedmob_net_spend: 0, feedmob_gross_spend: 0 },
      { click_url_id: 4, date: "2026-11-01", campaign_name: "C4", feedmob_net_spend: 6, feedmob_gross_spend: 8 },
      { click_url_id: 99, date: "2026-11-01", campaign_name: "unrelated", feedmob_net_spend: 999, feedmob_gross_spend: 999 },
    ] }],
  });
  const r = await invokeTool(compareClientReport, { report_name: "X", start_date: "2026-11-01", end_date: "2026-11-01", click_url_ids: [3, 4] }, makeContext(cfg, { fetchImpl: api.fetchImpl }));
  const d = r.data as any;
  assert.equal(r.ok, true); assert.deepEqual(d.scope.outside_report_history_click_url_ids, [3, 4]);
  assert.equal(d.counts.outside_report_scope, 2); assert.equal(d.counts.missing_in_report, 0);
  assert.equal(d.rows.find((x: any) => x.click_url_id === 3).direct_gross, 0);
  assert.equal(d.rows.find((x: any) => x.click_url_id === 3).report_gross, null);
  assert.equal(d.rows.find((x: any) => x.click_url_id === 4).status, "outside_report_scope");
  assert.equal(d.totals.direct_gross, 18); assert.equal(d.totals.outside_report_scope_gross, 8);
  assert.equal(d.ignored_out_of_scope_rows, 1); assert.ok(d.currency_info.warning); assert.ok(d.completeness_warning);
  assert.match(r.summary, /不代表全部客户或渠道/);
});
test("empty report still compares explicitly selected URLs", async () => {
  const api = fakeApi({ "GET /ai/api/client_report_spends": () => [200, { data: [] }], "GET /ai/api/direct_spends": () => [200, { data: [{ click_url_id: 4, date: "2026-11-01", campaign_name: "C4", feedmob_net_spend: 1, feedmob_gross_spend: 2 }] }] });
  const r = await invokeTool(compareClientReport, { report_name: "Empty", start_date: "2026-11-01", end_date: "2026-11-01", click_url_ids: [4] }, makeContext(cfg, { fetchImpl: api.fetchImpl }));
  assert.equal(r.ok, true); assert.equal((r.data as any).rows[0].status, "outside_report_scope");
  assert.equal((r.data as any).rows[0].report_gross, null);
});

test("null direct amount fails closed instead of being treated as zero", async () => {
  const api = fakeApi({ "GET /ai/api/client_report_spends": () => [200, { data: [] }], "GET /ai/api/direct_spends": () => [200, { data: [{ click_url_id: 4, date: "2026-11-01", campaign_name: "C4", feedmob_net_spend: 0, feedmob_gross_spend: null }] }] });
  const r = await invokeTool(compareClientReport, { report_name: "Empty", start_date: "2026-11-01", end_date: "2026-11-01", click_url_ids: [4] }, makeContext(cfg, { fetchImpl: api.fetchImpl }));
  assert.equal(r.ok, false); assert.match(r.summary, /invalid_amount/);
});
