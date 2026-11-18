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
      assert.match(d.warnings.join(" "), existingNet === null ? /未返回已有/ : existingNet === 10 ? /一致/ : /不一致/);
      assert.deepEqual(api.seen.map(x => x.method), ["GET"]);
    }
  }
});
