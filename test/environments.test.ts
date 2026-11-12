import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeContext } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { getDirectSpends, createDirectSpend, updateDirectSpend } from "../src/tools/spend.js";
import { createDirectSpendFromSources, findDirectSpend } from "../src/tools/finder.js";
import { fakeApi } from "./fake-api.js";

const base = { FEEDMOB_API_BASE: "https://stage.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "a@feedmob.com", ENABLE_WRITE: "true" };
const split = loadConfig({ ...base, FEEDMOB_READ_API_BASE: "https://prod.test/" });
const ok = () => [200, { status: 200, data: [] }] as [number, unknown];

test("read environment defaults to the write one; can be set separately", () => {
  const same = loadConfig(base);
  assert.equal(same.readApiBase, "https://stage.test"); assert.equal(same.readKey, "k");
  assert.equal(split.readApiBase, "https://prod.test"); assert.equal(split.apiBase, "https://stage.test");
});

test("the read client refuses any non-GET request", async () => {
  const ctx = makeContext(split, { fetchImpl: fakeApi({}).fetchImpl });
  await assert.rejects(ctx.api.post("/ai/api/direct_spends", {}), /只读连接.*POST/);
  await assert.rejects(ctx.api.patch("/ai/api/direct_spends/1", {}), /只读连接.*PATCH/);
});

test("read tools go to the read environment, write tools to the write environment", async () => {
  const w = fakeApi({ "GET /ai/api/direct_spends": ok, "POST /ai/api/direct_spends": ok, "PATCH /ai/api/direct_spends/7": ok });
  const ctx = makeContext(split, { fetchImpl: w.fetchImpl });
  await invokeTool(getDirectSpends, { start_date: "2026-11-01", end_date: "2026-11-01", client_id: 1 }, ctx);
  await invokeTool(createDirectSpend, { click_url_id: 1, spend_date: "2026-11-01", net_spend: 1, gross_spend: 2 }, ctx);
  await invokeTool(updateDirectSpend, { id: 7, net_spend: 1 }, ctx);
  assert.deepEqual(w.seen.map((s) => `${s.method} ${s.origin}`), ["GET https://prod.test", "POST https://stage.test", "PATCH https://stage.test"]);
});

test("auto-create looks up AND writes in the write environment; find reads production", async () => {
  const w = fakeApi({
    "GET /ai/api/direct_spends": ok, "GET /ai/api/click_url_histories": ok, "GET /ai/api/direct_spend_job_stats": ok,
    "GET /ai/api/appsflyer_reports": ok, "GET /ai/api/kochava_reports": ok, "GET /ai/api/client_report_spends/report_names": ok,
  });
  const ctx = makeContext(split, { fetchImpl: w.fetchImpl });
  await invokeTool(createDirectSpendFromSources, { click_url_id: 1, spend_date: "2026-11-01" }, ctx);
  assert.ok(w.seen.length > 0 && w.seen.every((s) => s.origin === "https://stage.test"), "all lookups on the write environment");
  w.seen.length = 0;
  const r = await invokeTool(findDirectSpend, { click_url_id: 1, spend_date: "2026-11-01" }, ctx);
  assert.ok(w.seen.every((s) => s.origin === "https://prod.test")); assert.equal((r.data as any).environment, "https://prod.test");
});
