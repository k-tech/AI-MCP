// Client reports, step 1 (statistics): health of every client report, and a report-vs-direct-spend reconciliation.
// Client reports = spend FeedMob prepares and uploads to clients (admin "Choose Client Report"), stored as client_report_spends.
import { z } from "zod";
import { defineTool, type ToolContext } from "./registry.js";
import { rowsOf } from "../http.js";
import { completeRows, validateRows, currencyInfo, completenessWarning } from "./report-safety.js";
import { date, assertRange, round2 } from "./schemas.js";
import { adminName, type ReportSpendRow } from "./reports.js";
import type { SpendRow } from "./spend.js";

const DAY = 86_400_000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
export const daysBetween = (start: string, end: string) => { const out: string[] = []; for (let t = Date.parse(start); t <= Date.parse(end); t += DAY) out.push(iso(t)); return out; };
export const yesterday = (now = Date.now(), timeZone = process.env.REPORT_TIME_ZONE || "Asia/Shanghai") => {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return iso(Date.parse(day) - DAY);
};
const defaultRange = (start?: string, end?: string) => { const e = end ?? yesterday(); return { start: start ?? iso(Date.parse(e) - 13 * DAY), end: e }; };

async function reportRows(ctx: ToolContext, name: string, start: string, end: string) {
  const rows = completeRows<ReportSpendRow & { created_at?: string }>(await ctx.api.get("/ai/api/client_report_spends", { start_date: start, end_date: end, report_name: name }), "client report");
  validateRows(rows, "client report", "spend_date", ["gross_spend"]);
  currencyInfo(rows);
  return rows.filter((r) => r.spend_date >= start && r.spend_date <= end);
}

export interface ReportHealth {
  name: string; admin_name: string | null; status: "ok" | "gaps" | "empty";
  currency_info: ReturnType<typeof currencyInfo>; completeness_warning: string;
  days_with_data: number; days_in_range: number; missing_days: string[];
  latest_spend_date: string | null; last_upload: string | null;
  vendors: string[]; click_urls: number[]; total_gross: number; rows: number;
}

export async function reportHealth(ctx: ToolContext, name: string, start: string, end: string): Promise<ReportHealth> {
  const rows = await reportRows(ctx, name, start, end);
  const days = daysBetween(start, end), have = new Set(rows.map((r) => r.spend_date));
  return {
    name, admin_name: adminName(name).admin_name, currency_info: currencyInfo(rows), completeness_warning: completenessWarning,
    status: rows.length === 0 ? "empty" : days.every((d) => have.has(d)) ? "ok" : "gaps",
    days_with_data: have.size, days_in_range: days.length, missing_days: rows.length ? days.filter((d) => !have.has(d)) : [],
    latest_spend_date: rows.length ? [...have].sort().at(-1)! : null,
    last_upload: rows.map((r) => r.created_at ?? "").filter(Boolean).sort().at(-1) ?? null,
    vendors: [...new Set(rows.map((r) => r.vendor_name).filter(Boolean))].sort(),
    click_urls: [...new Set(rows.map((r) => r.click_url_id))].sort((a, b) => a - b),
    total_gross: round2(rows.reduce((s, r) => s + (Number(r.gross_spend) || 0), 0)), rows: rows.length,
  };
}

export const getClientReportOverview = defineTool({
  name: "get_client_report_overview", title: "客户报表总览", stage: 3, write: false,
  description: "Health of every client report (the spend FeedMob uploads to clients) over a date range: which days have data and which are missing, latest data date, last upload time, vendors and click URLs included, total gross. "
    + "Default range: the 14 days ending yesterday. Use compare_client_report_with_direct_spend to see amount differences for one report.",
  schema: {
    start_date: date("开始日期").optional(), end_date: date("结束日期").optional(),
    report_names: z.array(z.string().min(1)).optional().describe("Only these reports (API names); default all"),
  },
  async run({ start_date, end_date, report_names }, ctx) {
    const { start, end } = defaultRange(start_date, end_date);
    assertRange(start, end, 62);
    const names = report_names?.length ? report_names : rowsOf<string>(await ctx.api.get("/ai/api/client_report_spends/report_names"));
    const reports: ReportHealth[] = [];
    for (const n of names) reports.push(await reportHealth(ctx, n, start, end));   // sequential: some reports are large
    const order = { gaps: 0, empty: 1, ok: 2 };
    reports.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
    const c = (s: string) => reports.filter((r) => r.status === s).length;
    return { summary: `${start} ~ ${end}：${reports.length} 份客户报表，完整 ${c("ok")} 份，有缺天 ${c("gaps")} 份，无数据 ${c("empty")} 份`, data: { start_date: start, end_date: end, reports } };
  },
});

export interface CompareRow { click_url_id: number; campaign_name: string; vendor_name: string; date: string; report_gross: number | null; direct_gross: number | null; direct_net: number | null; diff: number | null; status: "match" | "diff" | "missing_in_report" | "missing_in_direct" }

export const compareClientReport = defineTool({
  name: "compare_client_report_with_direct_spend", title: "客户报表对账", stage: 3, write: false,
  description: "Reconcile one client report with FeedMob direct spend, per click URL and day: gross in the report vs gross in direct spend, the difference, and days where a click URL has direct spend but is missing from the report (e.g. a vendor that stopped being uploaded). "
    + "Click URLs are those that appeared in the report in the range or the 30 days before it. Default range: the 14 days ending yesterday.",
  schema: {
    report_name: z.string().trim().min(1).describe("Report API name from get_client_report_spend_report_names"),
    start_date: date("开始日期").optional(), end_date: date("结束日期").optional(),
    tolerance: z.number().nonnegative().optional().describe("Differences up to this amount count as a match (default 0.01)"),
  },
  async run({ report_name, start_date, end_date, tolerance = 0.01 }, ctx) {
    const { start, end } = defaultRange(start_date, end_date);
    assertRange(start, end, 62);
    const lookback = iso(Date.parse(start) - 30 * DAY);
    const all = await reportRows(ctx, report_name, lookback, end);
    const inRange = all.filter((r) => r.spend_date >= start);
    const ids = [...new Set(all.map((r) => r.click_url_id))];
    if (!ids.length) return { summary: `${report_name}：${lookback} ~ ${end} 没有任何数据，无法对账`, data: { report_name, start_date: start, end_date: end, rows: [] } };

    const direct: Array<SpendRow & { vendor_name?: string }> = [];
    for (let i = 0; i < ids.length; i += 50) direct.push(...completeRows<SpendRow & { vendor_name?: string }>(await ctx.api.get("/ai/api/direct_spends", { start_date: start, end_date: end, "click_url_ids[]": ids.slice(i, i + 50) }), "direct spend"));

    validateRows(direct, "direct spend", "date", ["feedmob_gross_spend", "feedmob_net_spend"]);
    const currency_info = currencyInfo([...all, ...direct]);
    const rep = new Map<string, number>(), meta = new Map<number, { campaign_name: string; vendor_name: string }>();
    for (const r of all) meta.set(r.click_url_id, { campaign_name: r.campaign_name, vendor_name: r.vendor_name });
    for (const r of inRange) rep.set(`${r.click_url_id}|${r.spend_date}`, (rep.get(`${r.click_url_id}|${r.spend_date}`) ?? 0) + (Number(r.gross_spend) || 0));
    const dir = new Map<string, SpendRow & { vendor_name?: string }>();
    for (const d of direct) { const key = `${d.click_url_id}|${d.date}`, prev = dir.get(key); dir.set(key, prev ? { ...d, feedmob_gross_spend: Number(prev.feedmob_gross_spend) + Number(d.feedmob_gross_spend), feedmob_net_spend: Number(prev.feedmob_net_spend) + Number(d.feedmob_net_spend) } : d); if (!meta.has(d.click_url_id)) meta.set(d.click_url_id, { campaign_name: d.campaign_name, vendor_name: d.vendor_name ?? "" }); }

    const rows: CompareRow[] = [];
    for (const id of ids) for (const day of daysBetween(start, end)) {
      const k = `${id}|${day}`, rg = rep.get(k), d = dir.get(k);
      const dg = d ? Number(d.feedmob_gross_spend) || 0 : undefined;
      if (rg === undefined && (dg === undefined || dg === 0)) continue;           // nothing on either side
      const m = meta.get(id) ?? { campaign_name: "", vendor_name: "" };
      const base = { click_url_id: id, campaign_name: m.campaign_name, vendor_name: m.vendor_name, date: day };
      if (rg === undefined) rows.push({ ...base, report_gross: null, direct_gross: round2(dg!), direct_net: round2(Number(d!.feedmob_net_spend) || 0), diff: null, status: "missing_in_report" });
      else if (dg === undefined) rows.push({ ...base, report_gross: round2(rg), direct_gross: null, direct_net: null, diff: null, status: "missing_in_direct" });
      else { const diff = round2(rg - dg); rows.push({ ...base, report_gross: round2(rg), direct_gross: round2(dg), direct_net: round2(Number(d!.feedmob_net_spend) || 0), diff, status: Math.abs(diff) <= tolerance ? "match" : "diff" }); }
    }
    rows.sort((a, b) => a.date.localeCompare(b.date) || a.click_url_id - b.click_url_id);

    const count = (s: CompareRow["status"]) => rows.filter((r) => r.status === s).length;
    const byClickUrl = ids.map((id) => {
      const rs = rows.filter((r) => r.click_url_id === id), m = meta.get(id)!;
      return {
        click_url_id: id, campaign_name: m.campaign_name, vendor_name: m.vendor_name,
        report_gross: round2(rs.reduce((s, r) => s + (r.report_gross ?? 0), 0)), direct_gross: round2(rs.reduce((s, r) => s + (r.direct_gross ?? 0), 0)),
        missing_in_report: rs.filter((r) => r.status === "missing_in_report").map((r) => r.date),
        diff_days: rs.filter((r) => r.status === "diff").length,
      };
    }).filter((c) => c.report_gross || c.direct_gross).sort((a, b) => b.direct_gross - a.direct_gross);
    const missingGross = round2(rows.filter((r) => r.status === "missing_in_report").reduce((s, r) => s + (r.direct_gross ?? 0), 0));
    return {
      summary: `${report_name} vs direct spend（${start} ~ ${end}）：一致 ${count("match")}，金额不同 ${count("diff")}，报表缺失 ${count("missing_in_report")}（direct gross 共 ${missingGross}），direct 缺失 ${count("missing_in_direct")}；${currency_info.warning ?? ""} ${completenessWarning}`,
      data: {
        report_name, ...adminName(report_name), start_date: start, end_date: end, currency_info, completeness_warning: completenessWarning, reconciliation_verified: false,
        totals: { report_gross: round2(rows.reduce((s, r) => s + (r.report_gross ?? 0), 0)), direct_gross: round2(rows.reduce((s, r) => s + (r.direct_gross ?? 0), 0)), missing_in_report_gross: missingGross },
        counts: { match: count("match"), diff: count("diff"), missing_in_report: count("missing_in_report"), missing_in_direct: count("missing_in_direct") },
        by_click_url: byClickUrl, rows,
      },
    };
  },
});
