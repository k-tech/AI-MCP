import { test } from "node:test";
import assert from "node:assert/strict";
import { completeRows, validateRows, currencyInfo } from "../src/tools/report-safety.js";
import { yesterday } from "../src/tools/report-overview.js";

test("business yesterday uses configurable IANA timezone across UTC midnight", () => {
  const now = Date.parse("2026-11-17T01:00:00Z");
  assert.equal(yesterday(now, "Asia/Shanghai"), "2026-11-16");
  assert.equal(yesterday(now, "America/Los_Angeles"), "2026-11-15");
});
test("known partial pagination fails closed and arrays remain usable", () => {
  assert.throws(() => completeRows({ data: [1], meta: { total: 2 } }, "report"), /分页/);
  assert.throws(() => completeRows({ data: [], pagination: { has_more: true } }, "report"), /分页/);
  assert.deepEqual(completeRows([1], "report"), [1]);
});
test("invalid date, id and null amount are counted and stop aggregation", () => {
  assert.throws(() => validateRows([{ date: null, click_url_id: null, amount: null }, { date: "2026-02-30", click_url_id: 0, amount: 2 }], "direct", "date", ["amount"]), /"invalid_date":2,"invalid_id":2,"invalid_amount":1/);
});
test("currency is not assumed, mixed currencies fail, and missing currency is visible", () => {
  assert.throws(() => currencyInfo([{ currency: "USD" }, { currency: "EUR" }]), /多种币种/);
  assert.equal(currencyInfo([{ currency: "USD" }, {}]).currency, null);
  assert.equal(currencyInfo([{ currency: "usd" }]).currency, "USD");
});
