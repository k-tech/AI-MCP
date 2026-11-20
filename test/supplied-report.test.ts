import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeContext } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { previewSuppliedSpendReport } from "../src/tools/supplied-report.js";
import { UsageStore } from "../src/usage.js";
const cfg = loadConfig({ FEEDMOB_API_BASE: "https://fake.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "a@feedmob.com" });
const base = { click_url_id: 23203, spend_date: "2026-11-05", source_name: "example CSV", columns: { date: "day", click_url_id: "url", currency: "ccy", net: "net", gross: "gross" } };
const csv = "day,url,ccy,net,gross\n2026-11-05,23203,USD,10,15\n2026-11-05,23203,USD,5,7\n2026-11-06,23203,USD,100,200";
const run = (csv_text: string) => invokeTool(previewSuppliedSpendReport, { ...base, csv_text }, makeContext(cfg));
test("synthetic Vizio-shaped CSV: explicit date format and unknown currency remain read-only", async () => {
  const { fakeApi } = await import("./fake-api.js");
  const api = fakeApi({ "GET /ai/api/direct_spends": () => [200, { data: [{ click_url_id: 1, date: "2026-11-18", currency: "USD", feedmob_net_spend: 30, feedmob_gross_spend: 40 }] }] });
  const args = { click_url_id: 1, spend_date: "2026-11-18", source_name: "synthetic", date_format: "mm/dd/yyyy hh:mm", csv_text: "Date,Campaign ID,Campaign,Demand Tag ID,Demand Tag,Impressions,Revenue\n11/18/2026 00:00,A,Example,T1,One,100,10\n11/18/2026 23:59,A,Example,T2,Two,200,20\n11/18/2026 00:00,A,Example,T3,Other,300,80\n11/19/2026 00:00,A,Example,T1,One,400,90", columns: { date: "Date", net: "Revenue" }, mapping: { basis: "synthetic", effective_from: "2026-11-01", effective_to: "2026-11-30", filters: [{ column: "Campaign ID", value: "A" }, { column: "Demand Tag ID", values: ["T1", "T2"] }] }, ledger: { currency: "USD", basis: "synthetic ledger" }, billing_rule: { type: "margin_on_gross", margin_percent: 20, currency: "USD", effective_from: "2026-11-01", effective_to: "2026-11-30", basis: "synthetic rule" }, check_existing: true };
  const invoke = (a: unknown) => invokeTool(previewSuppliedSpendReport, a, makeContext(cfg, { fetchImpl: api.fetchImpl }));
  const r = await invoke(args); assert.equal(r.ok, true, r.summary); const d = r.data as any;
  assert.equal(d.matched_rows, 2); assert.equal(d.net, 30); assert.equal(d.currency, null); assert.equal(d.gross, null); assert.equal(d.calculation, null); assert.equal(d.suggested_create, null);
  assert.equal(d.existing.length, 1); assert.match(r.summary, /币种 未知/); assert.match(d.warnings.join(" "), /不可比较/); assert.doesNotMatch(d.warnings.join(" "), /与预览一致|与预览不一致/);
  assert.equal(d.detail[0].currency, null);
  for (const bad of ["02/29/2025 00:00", "11/31/2026 00:00", "11/18/2026 24:00", "11/18/2026 12:60", "11/18/2026 0:00", "2026-11-18", "11/18/2026 00:00:00"]) {
    const invalid = await invoke({ ...args, csv_text: args.csv_text.replace("11/18/2026 00:00", bad) });
    assert.equal(invalid.ok, false, bad);
  }
  assert.equal((await invoke({ ...args, date_format: undefined })).ok, false);
  assert.equal((await invoke({ ...args, date_format: "guessed" })).ok, false);
  const leap = await invoke({ ...args, spend_date: "2024-02-29", csv_text: "Date,Campaign ID,Demand Tag ID,Revenue\n02/29/2024 23:59,A,T1,3" });
  assert.equal(leap.ok, true, leap.summary); assert.equal((leap.data as any).net, 3);
  assert.ok(api.seen.every(x => x.method === "GET"));
});
test("specified currency columns remain mandatory and consistent in selected rows", async () => {
  for (const currencies of [["USD", ""], ["USD", "EUR"], ["USD", "US"]]) {
    const result = await run(`day,url,ccy,net,gross\n2026-11-05,23203,${currencies[0]},5,8\n2026-11-05,23203,${currencies[1]},6,9`);
    assert.equal(result.ok, false); assert.match(result.summary, /币种/);
  }
});
test("synthetic multi-tag mapping selects alternatives within campaign and preserves single values", async () => {
  const { fakeApi } = await import("./fake-api.js");
  const api = fakeApi({ "GET /ai/api/direct_spends": () => [200, { data: [] }] });
  const args = { click_url_id: 23505, spend_date: "2026-11-05", source_name: "synthetic", csv_text: "day,campaign,tag,ccy,net\n2026-11-05,A,T1,USD,10\n2026-11-05,A,T2,USD,20\n2026-11-05,A,OTHER,USD,100\n2026-11-05,B,T1,USD,200\n2026-11-06,A,T1,USD,300", columns: { date: "day", currency: "ccy", net: "net" }, mapping: { basis: "synthetic", filters: [{ column: "campaign", value: "A" }, { column: "tag", values: ["T1", "T2"] }] }, check_existing: true };
  const invoke = (a: unknown) => invokeTool(previewSuppliedSpendReport, a, makeContext(cfg, { fetchImpl: api.fetchImpl }));
  const multi = await invoke(args); assert.equal(multi.ok, true, multi.summary); assert.equal((multi.data as any).matched_rows, 2); assert.equal((multi.data as any).net, 30); assert.equal((multi.data as any).suggested_create, null);
  const single = await invoke({ ...args, mapping: { ...args.mapping, filters: [{ column: "campaign", value: "A" }, { column: "tag", value: "T1" }] } });
  assert.equal(single.ok, true); assert.equal((single.data as any).net, 10);
  for (const filter of [{ column: "tag", values: [] }, { column: "tag", values: [""] }, { column: "tag", value: "T1", values: ["T2"] }, { column: "tag" }]) {
    assert.equal((await invoke({ ...args, mapping: { ...args.mapping, filters: [filter] } })).ok, false);
  }
  assert.ok(api.seen.every(x => x.method === "GET"));
});
test("supplied CSV: sums only explicit date and URL, blocks create without ledger currency", async () => {
  const r = await run(csv); const d = r.data as any;
  assert.equal(r.ok, true); assert.equal(d.matched_rows, 2); assert.equal(d.currency, "USD");
  assert.equal(d.net, 15); assert.equal(d.gross, 22); assert.equal(d.suggested_create, null);
  const eur = await run(csv.replaceAll("USD", "EUR")); assert.equal((eur.data as any).suggested_create, null);
});
test("supplied CSV: missing amounts, duplicate rows and currency ambiguity do not create a proposal", async () => {
  assert.equal(((await run("day,url,ccy,net,gross\n2026-11-05,23203,USD,5,")).data as any).suggested_create, null);
  assert.equal(((await run("day,url,ccy,net,gross\n2026-11-05,23203,USD,5,8\n2026-11-05,23203,USD,5,8")).data as any).suggested_create, null);
  assert.equal((await run("day,url,ccy,net,gross\n2026-11-05,23203,USD,5,8\n2026-11-05,23203,EUR,5,8")).ok, false);
  assert.equal((await run("day,url,ccy,net,gross\ninvalid,23203,USD,5,8")).ok, false);
});
test("supplied CSV contents are redacted from usage logs", async () => {
  const usage = new UsageStore(); await invokeTool(previewSuppliedSpendReport, { ...base, csv_text: csv }, makeContext(cfg, { usage }));
  assert.doesNotMatch(usage.calls()[0].args, /2026-11-05,23203,USD/); assert.match(usage.calls()[0].args, /redacted/); usage.close();
});

test("synthetic LG and Vizio source identifiers filter rows and check existing spend without writing", async () => {
  const { fakeApi } = await import("./fake-api.js");
  for (const sample of [
    { id: 23203, filters: [{ column: "creative", value: "creative-A" }], csv: "day,creative,ccy,net\n2026-11-05,creative-A,USD,10\n2026-11-05,creative-B,USD,80\n2026-11-06,creative-A,USD,90" },
    { id: 23505, filters: [{ column: "campaign", value: "campaign-A" }, { column: "tag", value: "tag-A" }], csv: "day,campaign,tag,ccy,net\n2026-11-05,campaign-A,tag-A,USD,10\n2026-11-05,campaign-A,tag-B,USD,80\n2026-11-06,campaign-A,tag-A,USD,90" },
  ]) {
    for (const existingNet of [null, 10, 12]) {
      const api = fakeApi({ "GET /ai/api/direct_spends": () => [200, { data: existingNet === null ? [] : [{ click_url_id: sample.id, date: "2026-11-05", feedmob_net_spend: existingNet, feedmob_gross_spend: 20 }] }] });
      const r = await invokeTool(previewSuppliedSpendReport, { click_url_id: sample.id, spend_date: "2026-11-05", source_name: "synthetic", csv_text: sample.csv, columns: { date: "day", currency: "ccy", net: "net" }, mapping: { basis: "synthetic mapping", filters: sample.filters }, check_existing: true }, makeContext(cfg, { fetchImpl: api.fetchImpl }));
      assert.equal(r.ok, true); const d = r.data as any;
      assert.equal(d.matched_rows, 1); assert.equal(d.net, 10); assert.equal(d.gross, null); assert.equal(d.suggested_create, null);
      assert.match(d.warnings.join(" "), existingNet === null ? /未返回已有/ : /币种未确认/);
      assert.deepEqual(api.seen.map(x => x.method), ["GET"]);
    }
  }
});


test("synthetic channel previews require effective, sourced mapping, ledger and billing rule; conflicts never pass as matches", async () => {
  const { fakeApi } = await import("./fake-api.js");
  for (const sample of [
    { id: 23203, filter: [{ column: "creative", value: "A" }], csv: "day,creative,ccy,net\n2026-11-05,A,USD,80" },
    { id: 23505, filter: [{ column: "campaign", value: "B" }, { column: "tag", value: "C" }], csv: "day,campaign,tag,ccy,net\n2026-11-05,B,C,USD,80" },
  ]) {
    const api = fakeApi({ "GET /ai/api/direct_spends": () => [200, { data: [{ click_url_id: sample.id, date: "2026-11-05", feedmob_net_spend: 80, feedmob_gross_spend: 101 }] }] });
    const args = { click_url_id: sample.id, spend_date: "2026-11-05", source_name: "synthetic", csv_text: sample.csv, columns: { date: "day", currency: "ccy", net: "net" }, mapping: { basis: "synthetic mapping", effective_from: "2026-11-01", effective_to: "2026-11-30", filters: sample.filter }, ledger: { currency: "USD", basis: "synthetic ledger evidence" }, billing_rule: { type: "margin_on_gross", margin_percent: 20, currency: "USD", effective_from: "2026-11-01", effective_to: "2026-11-30", basis: "synthetic rule evidence" }, check_existing: true };
    const invoke = (a: unknown) => invokeTool(previewSuppliedSpendReport, a, makeContext(cfg, { fetchImpl: api.fetchImpl }));
    const good = (await invoke(args)).data as any; assert.equal(good.net, 80); assert.equal(good.gross, 100); assert.match(good.calculation, /synthetic rule evidence/); assert.match(good.warnings.join(" "), /不一致/); assert.equal(good.suggested_create, null);
    const missing = (await invoke({ ...args, billing_rule: undefined })).data as any; assert.equal(missing.gross, null); assert.match(missing.warnings.join(" "), /不能判定完全一致/);
    const expired = (await invoke({ ...args, billing_rule: { ...args.billing_rule, effective_to: "2026-11-04" } })).data as any; assert.equal(expired.gross, null); assert.match(expired.blockers.join(" "), /未覆盖/);
    const unknown = (await invoke({ ...args, ledger: undefined })).data as any; assert.equal(unknown.gross, null); assert.match(unknown.warnings.join(" "), /不可比较/);
    assert.ok(api.seen.every(x => x.method === "GET"));
  }
});
