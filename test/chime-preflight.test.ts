import { test } from "node:test";
import assert from "node:assert/strict";
import { preflightChime } from "../src/web/chime-preflight.js";

const header = "date,app-id,agency,media-source,campaign-id,campaign,geo,currency,spend,adset,ad";
const row = "2026-11-03,app,agency,media,id,campaign,US,USD,0.10,set,ad";
const run = (csv_text: string, target_date = "2026-11-03") => preflightChime({ target_date, files: [{ name: "synthetic.csv", csv_text }] });

test("preflight counts and sums exact decimal values by currency across CSV files", () => {
  const other = row.replace("USD,0.10", "EUR,0.20");
  const r = preflightChime({ target_date: "2026-11-03", files: [{ name: "one.csv", csv_text: `\ufeff${header}\n${row}\n${row.replace("0.10", "0.20")}` }, { name: "two.csv", csv_text: `${header}\n${other}` }] });
  assert.equal(r.rows, 3); assert.equal(r.issue_count, 0); assert.deepEqual(r.totals, [{ currency: "USD", spend: "0.3" }, { currency: "EUR", spend: "0.2" }]);
  assert.match(r.notice, /不能证明/);
});

test("preflight flags mismatches, invalid values, duplicates and empty identifiers", () => {
  const data = [row, row, row.replace("2026-11-03", "2026-11-04"), row.replace("2026-11-03", "2026-02-30"), row.replace("USD,0.10", "usd,NaN"), row.replace("USD,0.10", "USD,-1"), row.replace(",app,", ",,")];
  const r = run(`${header}\n${data.join("\n")}`);
  assert.equal(r.rows, 7); assert.ok(r.issue_count >= 7); assert.match(r.issues.join(" "), /重复行/); assert.match(r.issues.join(" "), /目标日期不一致/); assert.match(r.issues.join(" "), /日期无效/); assert.match(r.issues.join(" "), /币种/); assert.match(r.issues.join(" "), /数值无效/); assert.match(r.issues.join(" "), /负数/); assert.match(r.issues.join(" "), /空的标识/);
});

test("preflight rejects wrong headers, malformed CSV, empty data and invalid input", () => {
  assert.match(run(`${header.replace("date,app-id", "app-id,date")}\n${row}`).issues.join(" "), /表头/);
  assert.match(run(`${header}\n"broken`).issues.join(" "), /CSV 格式/);
  assert.match(run(header).issues.join(" "), /没有数据/);
  assert.throws(() => run(`${header}\n${row}`, "2026-02-30"));
  assert.throws(() => preflightChime({ target_date: "2026-11-03", files: [] }));
  assert.throws(() => preflightChime({ target_date: "2026-11-03", files: [{ name: "a", csv_text: "a".repeat(800001) }] }));
});
