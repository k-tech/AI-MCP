import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeContext } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { getVendors, getCampaigns, getReportNames, getClientReportSpends } from "../src/tools/reports.js";
import { fakeApi } from "./fake-api.js";

const cfg = loadConfig({ FEEDMOB_API_BASE: "https://api.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "leo@feedmob.com" });

test("get_vendors: counts by status and type", async () => {
  const api = fakeApi({ "GET /ai/api/vendors": () => [200, { status: 200, data: [
    { id: 1, vendor_name: "A", status: "running", vendor_type: "dsp" }, { id: 2, vendor_name: "B", status: "paused", vendor_type: "dsp" }, { id: 3, vendor_name: "C", status: "running", vendor_type: "network" } ] }] });
  const r = await invokeTool(getVendors, {}, makeContext(cfg, { fetchImpl: api.fetchImpl }));
  assert.deepEqual((r.data as any).by_status, { running: 2, paused: 1 });
  assert.deepEqual((r.data as any).by_type, { dsp: 2, network: 1 });
});

test("get_campaigns: hides archived by default", async () => {
  const api = fakeApi({ "GET /ai/api/campaigns": () => [200, { status: 200, data: [
    { id: 1, name: "Uber_Android_IN", os: "Android", status: "normal" }, { id: 2, name: "Uber_Android_IN_archived_2021-12-13", os: "Android", status: "normal" } ] }] });
  const ctx = makeContext(cfg, { fetchImpl: api.fetchImpl });
  assert.equal((await invokeTool(getCampaigns, { client_id: 6 }, ctx)).data && ((await invokeTool(getCampaigns, { client_id: 6 }, ctx)).data as any).rows.length, 1);
  assert.equal(((await invokeTool(getCampaigns, { client_id: 6, include_archived: true }, ctx)).data as any).rows.length, 2);
  assert.equal(api.seen[0].query.get("client_id"), "6");
});

test("get_client_report_spends: totals by vendor, campaign and day; raw logs dropped", async () => {
  const row = (vendor: string, campaign: string, day: string, gross: number) => ({ click_url_id: 1, client_name: "Upside", vendor_name: vendor, campaign_name: campaign, spend_date: day, gross_spend: gross, raw_log_rows: [{ big: true }] });
  const api = fakeApi({ "GET /ai/api/client_report_spends": () => [200, { status: 200, data: [row("Samsung", "C1", "2026-11-01", 100), row("Samsung", "C1", "2026-11-02", 44.5), row("Liftoff", "C2", "2026-11-01", 200)] }] });
  const r = await invokeTool(getClientReportSpends, { report_name: "Upside Spend", start_date: "2026-11-01", end_date: "2026-11-02", include_rows: true }, makeContext(cfg, { fetchImpl: api.fetchImpl }));
  const d = r.data as any;
  assert.equal(d.total_gross, 344.5);
  assert.deepEqual(d.by_vendor, [{ key: "Liftoff", gross: 200, rows: 1 }, { key: "Samsung", gross: 144.5, rows: 2 }]);
  assert.deepEqual(d.by_day.map((x: any) => [x.key, x.gross]), [["2026-11-01", 300], ["2026-11-02", 44.5]]);
  assert.equal(d.detail.length, 3); assert.equal("raw_log_rows" in d.detail[0], false);
  assert.equal(api.seen[0].query.get("report_name"), "Upside Spend");
});

test("get_client_report_spend_report_names: returns names", async () => {
  const api = fakeApi({ "GET /ai/api/client_report_spends/report_names": () => [200, { status: 200, data: ["Chime Agency Spend", "Upside Spend", "Scrabble Go"] }] });
  const r = await invokeTool(getReportNames, {}, makeContext(cfg, { fetchImpl: api.fetchImpl }));
  assert.deepEqual(r.data, [
    { name: "Chime Agency Spend", admin_name: "Chime Agency AF Daily Spend", admin_name_confirmed: true },
    { name: "Upside Spend", admin_name: "Upside Spend", admin_name_confirmed: true },
    { name: "Scrabble Go", admin_name: null, admin_name_confirmed: false }]);
});
