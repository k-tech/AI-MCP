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
test("supplied CSV: sums only explicit date and URL, proposes normal create arguments, never writes", async () => {
  const r = await run(csv); const d = r.data as any;
  assert.equal(r.ok, true); assert.equal(d.matched_rows, 2); assert.equal(d.currency, "USD");
  assert.deepEqual(d.suggested_create, { click_url_id: 23203, spend_date: "2026-11-05", net_spend: 15, gross_spend: 22 });
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
