import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { ALL_TOOLS, makeContext } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { compareVendorReport, getVendorReportOverview } from "../src/tools/vendor-reports.js";
import { fakeApi } from "./fake-api.js";

const cfg = loadConfig({ FEEDMOB_API_BASE: "https://api.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "a@feedmob.com" });
const base = { partner: "samsung", start_date: "2026-11-01", end_date: "2026-11-03" };
const report = [{ date: "2026-11-01", partner_net_spend: "10.01", samsung_content_id: "A", click_url_id: 1 }, { date: "2026-11-01", partner_net_spend: 2, samsung_content_id: "B", click_url_id: 1 }, { date: "2026-11-03", partner_net_spend: 3, samsung_content_id: "unknown", click_url_id: null }];
const direct = [{ click_url_id: 1, date: "2026-11-01", feedmob_net_spend: 7 }, { click_url_id: 1, date: "2026-11-01", feedmob_net_spend: 5 }, { click_url_id: 2, date: "2026-11-02", feedmob_net_spend: 8 }];
const setup = (partnerRows: unknown = report, directRows: unknown = direct, path = "/ai/api/samsung_reports") => {
  const w = fakeApi({ [`GET ${path}`]: () => [200, partnerRows], "GET /ai/api/direct_spends": () => [200, directRows] });
  return { ...w, ctx: makeContext(cfg, { fetchImpl: w.fetchImpl }) };
};
const cases = [
  ["samsung", "/ai/api/samsung_reports", "samsung_content_id", {}],
  ["youappi", "/ai/api/youappi_reports", "youappi_campaign_name", {}],
  ["kayzen", "/ai/api/kayzen_reports", "kayzen_campaign_name", {}],
  ["beeswax", "/ai/api/beeswax_reports", "beeswax_campaign_id", {}],
  ["jampp", "/ai/api/jampp_reports", "jampp_campaign_id", { client_id: 17 }],
  ["remerge", "/ai/api/remerge_reports", "remerge_campaign_name", { client_id: 216 }],
  ["pubmatic", "/ai/api/pubmatic_reports", "pubmatic_campaign_id", { client_id: 189 }],
  ["inmobi", "/ai/api/inmobi_api_reports", "inmobi_campaign_name", { report_ids: { skan_report_id: "s", non_skan_report_id: "n" } }],
  ["smadex", "/ai/api/smadex_reports", "smadex_multi_campaign_id", { report_ids: { report_id: "x" } }],
  ["liftoff", "/ai/api/liftoff_reports", "liftoff_campaign_id", { report_ids: { possible_finance_report_id: "p", stash_report_id: "s" } }],
] as const;

test("vendor tools are registered read-only", () => assert.ok([getVendorReportOverview, compareVendorReport].every((t) => !t.write && ALL_TOOLS.includes(t))));
test("all ten partner schemas extract native date, amount, URL and campaign identifier", async () => {
  for (const [partner, path, field, extra] of cases) {
    const w = setup([{ date: "2026-11-01T23:30:00-08:00", partner_net_spend: "12.50", click_url_id: null, [field]: "campaign-X" }], [], path);
    const r = await invokeTool(getVendorReportOverview, { ...base, partner, ...extra }, w.ctx); assert.equal(r.ok, true, `${partner}: ${r.summary}`);
    const d = r.data as any; assert.equal(d.total_net, 12.5); assert.equal(d.unmapped_rows[0].campaign[field], "campaign-X"); assert.equal(d.unmapped_rows[0].date, "2026-11-01");
    assert.equal(w.seen[0].path, path);
  }
});
test("overview sums and identifies missing days and campaign groups", async () => {
  const w = setup(); const r = await invokeTool(getVendorReportOverview, base, w.ctx); const d = r.data as any;
  assert.equal(r.ok, true); assert.equal(d.total_net, 15.01); assert.equal(d.status, "gaps"); assert.deepEqual(d.missing_days, ["2026-11-02"]);
  assert.deepEqual(d.by_campaign.map((x: any) => x.campaign.samsung_content_id), ["A", "B", "unknown"]); assert.equal(d.unmapped_net, 3);
});
test("empty report and optional comparison scope do not query all direct spends", async () => {
  const w = setup([]); const r = await invokeTool(compareVendorReport, base, w.ctx); assert.equal(r.ok, true); assert.equal((r.data as any).status, "empty"); assert.equal((r.data as any).missing_days.length, 3); assert.equal(w.seen.length, 1);
});
test("comparison sums duplicate report and direct records; extra URL detects missing report", async () => {
  const w = setup(); const r = await invokeTool(compareVendorReport, { ...base, click_url_ids: [2] }, w.ctx); const d = r.data as any;
  assert.equal(r.ok, true); assert.deepEqual(d.counts, { match: 1, diff: 0, missing_in_report: 1, missing_in_direct: 0 }); assert.equal(d.rows[0].diff, 0.01);
  assert.equal(d.unmapped_rows.length, 1); assert.equal(d.unmapped_net, 3); assert.deepEqual(w.seen[1].query.getAll("click_url_ids[]"), ["1", "2"]);
});
test("comparison detects missing direct and just outside tolerance", async () => {
  const w = setup([{ date: "2026-11-01", partner_net_spend: 12.011, click_url_id: 1 }, { date: "2026-11-03", partner_net_spend: 4, click_url_id: 1 }]);
  const r = await invokeTool(compareVendorReport, { ...base, click_url_ids: [2] }, w.ctx); assert.deepEqual((r.data as any).rows.map((x: any) => x.status), ["diff", "missing_in_report", "missing_in_direct"]);
});
test("Beeswax matched false stays unmapped even if it has an ID; group unmapped campaigns", async () => {
  const rows = [{ date: "2026-11-01", partner_net_spend: "1.25", click_url_id: 9, matched: false, beeswax_campaign_name: "A" }, { date: "2026-11-01", partner_net_spend: 2, click_url_id: null, matched: false, beeswax_campaign_name: "A" }];
  const w = setup(rows, [], "/ai/api/beeswax_reports"); const r = await invokeTool(compareVendorReport, { ...base, partner: "beeswax" }, w.ctx); const d = r.data as any;
  assert.equal(d.unmapped_net, 3.25); assert.equal(d.unmapped_by_day_campaign[0].rows, 2); assert.equal(d.unmapped_by_day_campaign[0].campaign.beeswax_campaign_name, "A"); assert.equal(w.seen.length, 1);
});
test("invalid values fail closed instead of becoming zero or unmapped", async () => {
  for (const bad of [{ date: "2026-02-30", partner_net_spend: 1, click_url_id: 1 }, { date: "2026-11-01T25:00:00Z", partner_net_spend: 1, click_url_id: 1 }, { date: "2026-11-01", partner_net_spend: "", click_url_id: 1 }, { date: "2026-11-01", partner_net_spend: "NaN", click_url_id: 1 }, { date: "2026-11-01", partner_net_spend: 1 }, { date: "2026-11-01", partner_net_spend: 1, click_url_id: 0 }]) {
    const r = await invokeTool(getVendorReportOverview, base, setup([bad]).ctx); assert.equal(r.ok, false, JSON.stringify(bad));
  }
});
test("client restrictions are validated before requesting the API", async () => {
  for (const [partner, path, good, bad] of [["jampp", "/ai/api/jampp_reports", 17, undefined], ["remerge", "/ai/api/remerge_reports", 216, 1], ["pubmatic", "/ai/api/pubmatic_reports", 189, 216]] as const) {
    const w = setup([], [], path); assert.equal((await invokeTool(getVendorReportOverview, { ...base, partner, client_id: bad }, w.ctx)).ok, false); assert.equal(w.seen.length, 0);
    assert.equal((await invokeTool(getVendorReportOverview, { ...base, partner, client_id: good }, w.ctx)).ok, true); assert.equal(w.seen[0].query.get("client_id"), String(good));
  }
});
test("async reports require ready IDs and Smadex filters dates locally", async () => {
  for (const [partner, path, , extra] of cases.slice(7)) {
    const w = setup([{ date: "2026-10-31 20:00:00 UTC", partner_net_spend: "4.5", click_url_id: 1 }, { date: "2026-11-01 01:00:00 UTC", partner_net_spend: "5.5", click_url_id: 1 }], [], path);
    assert.equal((await invokeTool(getVendorReportOverview, { ...base, partner }, w.ctx)).ok, false); assert.equal(w.seen.length, 0);
    const r = await invokeTool(getVendorReportOverview, { ...base, partner, ...extra }, w.ctx); assert.equal(r.ok, true, r.summary); assert.equal((r.data as any).total_net, 5.5);
    assert.equal(w.seen[0].query.has("start_date"), partner !== "smadex");
    for (const [k, v] of Object.entries((extra as any).report_ids)) assert.equal(w.seen[0].query.get(k), v);
  }
});
test("upstream errors, unexpected shapes and partial data fail closed", async () => {
  for (const value of [{ error: "bad", data: [] }, { status: "pending" }, { data: [], next_page: 2 }, { data: [], total_rows: 3 }]) assert.equal((await invokeTool(getVendorReportOverview, base, setup(value).ctx)).ok, false);
  assert.equal((await invokeTool(compareVendorReport, base, setup(report, { data: [], truncated: true }).ctx)).ok, false);
});
test("range and obsolete field arguments fail validation", async () => {
  const w = setup(); for (const args of [{ ...base, end_date: "2026-01-01" }, { ...base, fields: { date: "date" } }, { ...base, campaign_mapping: [] }]) assert.equal((await invokeTool(getVendorReportOverview, args, w.ctx)).ok, false); assert.equal(w.seen.length, 0);
});
test("invokeTool records successful and failed calls", async () => {
  const w = setup([]); const records: any[] = []; const ctx = { ...w.ctx, usage: { record: (x: unknown) => records.push(x) } as any };
  await invokeTool(getVendorReportOverview, base, ctx); await invokeTool(getVendorReportOverview, { ...base, partner: "jampp" }, ctx);
  assert.deepEqual(records.map((r) => [r.tool, r.ok]), [["get_vendor_report_overview", true], ["get_vendor_report_overview", false]]);
});
test("aggregates beyond raw display limit and batches direct scope", async () => {
  const many = Array.from({ length: 301 }, () => ({ date: "2026-11-01", partner_net_spend: 1, click_url_id: 1, samsung_content_id: "A" }));
  const w = setup(many, []); const ids = Array.from({ length: 51 }, (_, i) => i + 1);
  const r = await invokeTool(compareVendorReport, { ...base, click_url_ids: ids }, w.ctx); assert.equal(r.ok, true); assert.equal((r.data as any).total_net, 301); assert.deepEqual(w.seen.slice(1).map((x) => x.query.getAll("click_url_ids[]").length), [50, 1]);
});
