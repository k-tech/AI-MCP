// Partner report schemas follow the feedmob_admin a07e89f source review.
import { z } from "zod";
import { completeRows, validateRows, currencyInfo, completenessWarning } from "./report-safety.js";
import { defineTool, type ToolContext } from "./registry.js";
import { date, assertRange, round2 } from "./schemas.js";
import { daysBetween } from "./report-overview.js";
import type { SpendRow } from "./spend.js";

const partners = ["samsung", "youappi", "kayzen", "beeswax", "jampp", "remerge", "pubmatic", "inmobi", "smadex", "liftoff"] as const;
type Partner = typeof partners[number];
const paths: Record<Partner, string> = {
  samsung: "/ai/api/samsung_reports", youappi: "/ai/api/youappi_reports", kayzen: "/ai/api/kayzen_reports", beeswax: "/ai/api/beeswax_reports",
  jampp: "/ai/api/jampp_reports", remerge: "/ai/api/remerge_reports", pubmatic: "/ai/api/pubmatic_reports",
  inmobi: "/ai/api/inmobi_api_reports", smadex: "/ai/api/smadex_reports", liftoff: "/ai/api/liftoff_reports",
};
// Keep partner identifiers even when Admin could not resolve a click URL.
const campaignFields: Record<Partner, string[]> = {
  samsung: ["samsung_content_id"], youappi: ["campaign_id", "campaign_name", "youappi_campaign_name", "vendor_id", "vendor_name"],
  kayzen: ["kayzen_report_id", "kayzen_campaign_name"], beeswax: ["campaign_id", "campaign_name", "beeswax_campaign_id", "beeswax_campaign_name", "vendor_id", "vendor_name"],
  jampp: ["campaign_id", "jampp_campaign_id", "jampp_campaign_name", "vendor_id", "client_id"],
  remerge: ["campaign_id", "campaign_name", "remerge_campaign_name", "vendor_id", "vendor_name", "client_id"],
  pubmatic: ["campaign_id", "campaign_name", "pubmatic_campaign_id", "pubmatic_campaign_name", "vendor_id", "vendor_name", "client_id"],
  inmobi: ["inmobi_campaign_name"], smadex: ["smadex_multi_campaign_id", "smadex_campaign_name"], liftoff: ["liftoff_campaign_id", "liftoff_campaign_name"],
};
const schema = {
  partner: z.enum(partners), start_date: date("开始日期"), end_date: date("结束日期"),
  client_id: z.coerce.number().int().positive().optional().describe("Required for Jampp, Remerge (216 or 189), Pubmatic (189)"),
  report_ids: z.object({ report_id: z.string().trim().min(1).optional(), skan_report_id: z.string().trim().min(1).optional(), non_skan_report_id: z.string().trim().min(1).optional(), possible_finance_report_id: z.string().trim().min(1).optional(), stash_report_id: z.string().trim().min(1).optional() }).strict().optional(),
};
type Args = z.infer<z.ZodObject<typeof schema>>;
type VendorRow = { date: string; net: number; click_url_id: number | null; matched: boolean; campaign: Record<string, string | number>; currency?: unknown };

// Preserve the calendar day represented in the report, rather than shifting it to UTC.
function reportDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim(), day = s.slice(0, 10);
  if (!z.string().date().safeParse(day).success) return null;
  if (s === day) return day;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}| UTC)?$/.test(s)) return null;
  const match = s.match(/[T ](\d{2}):(\d{2}):(\d{2})/)!;
  if (+match[1] > 23 || +match[2] > 59 || +match[3] > 59 || !Number.isFinite(Date.parse(s.replace(" UTC", "Z").replace(" ", "T")))) return null;
  return day;
}
function numberAmount(value: unknown): number | null {
  if (typeof value !== "number" && (typeof value !== "string" || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
async function fetchReport(a: Args, ctx: ToolContext): Promise<VendorRow[]> {
  assertRange(a.start_date, a.end_date, 62);
  const clientPartners: Partner[] = ["jampp", "remerge", "pubmatic"];
  if (clientPartners.includes(a.partner) && !a.client_id) throw new Error(`${a.partner} 需要 client_id`);
  if (!clientPartners.includes(a.partner) && a.client_id !== undefined) throw new Error(`${a.partner} 不支持 client_id 筛选`);
  if (a.partner === "remerge" && a.client_id !== 216 && a.client_id !== 189) throw new Error("remerge 目前只支持 client_id 216 或 189");
  if (a.partner === "pubmatic" && a.client_id !== 189) throw new Error("pubmatic 目前只支持 client_id 189");
  const required: Partial<Record<Partner, Array<keyof NonNullable<Args["report_ids"]>>>> = {
    inmobi: ["skan_report_id", "non_skan_report_id"], smadex: ["report_id"], liftoff: ["possible_finance_report_id", "stash_report_id"],
  };
  const keys = required[a.partner] ?? [];
  if (keys.some((k) => !a.report_ids?.[k])) throw new Error(`${a.partner} 需要已完成的报表 ID：${keys.join(", ")}；先使用原始工具申请并检查状态`);
  if (Object.keys(a.report_ids ?? {}).some((k) => !keys.includes(k as typeof keys[number]))) throw new Error("report_ids 包含此渠道不支持的字段");
  const q: Record<string, string | number | undefined> = a.partner === "smadex" ? {} : { start_date: a.start_date, end_date: a.end_date };
  if (a.client_id) q.client_id = a.client_id;
  for (const k of keys) q[k] = a.report_ids![k];
  const result: unknown = await ctx.api.get(paths[a.partner], q);
  const obj = result && typeof result === "object" && !Array.isArray(result) ? result as Record<string, unknown> : null;
  if (obj?.error) throw new Error(`报表返回错误：${String(obj.error)}`);
  const rows = completeRows<any>(result, "vendor report");
  currencyInfo(rows);
  const invalid = { invalid_date: 0, invalid_id: 0, invalid_amount: 0 };
  for (const row of rows) {
    if (!row || !reportDate(row.date)) invalid.invalid_date++;
    const id = row?.click_url_id;
    if (id === undefined || (id !== null && (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0))) invalid.invalid_id++;
    if (!row || numberAmount(row.partner_net_spend) === null) invalid.invalid_amount++;
  }
  if (Object.values(invalid).some(Boolean)) throw new Error(`vendor report 异常行计数 ${JSON.stringify(invalid)}；停止统计，请检查原始数据`);
  return rows.map((item, index): VendorRow => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`报表第 ${index + 1} 行不是对象`);
    const row = item as Record<string, unknown>, day = reportDate(row.date), net = numberAmount(row.partner_net_spend), id = row.click_url_id;
    if (!day) throw new Error(`报表第 ${index + 1} 行 date 无效`);
    if (net === null) throw new Error(`报表第 ${index + 1} 行 partner_net_spend 无效`);
    if (id === undefined || (id !== null && (!/^\d+$/.test(String(id)) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0))) throw new Error(`报表第 ${index + 1} 行 click_url_id 无效`);
    if (a.partner === "beeswax" && row.matched !== undefined && typeof row.matched !== "boolean") throw new Error(`报表第 ${index + 1} 行 matched 无效`);
    const campaign: Record<string, string | number> = {};
    for (const key of campaignFields[a.partner]) if (typeof row[key] === "string" || typeof row[key] === "number") campaign[key] = row[key] as string | number;
    return { date: day, net, click_url_id: id === null ? null : Number(id), matched: id !== null && row.matched !== false, campaign, currency: row.currency };
  }).filter((r) => r.date >= a.start_date && r.date <= a.end_date);
}
function overview(rows: VendorRow[], a: Args) {
  const days = daysBetween(a.start_date, a.end_date), have = new Set(rows.map((r) => r.date));
  const group = (key: (r: VendorRow) => string) => {
    const m = new Map<string, number>(); for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.net);
    return [...m].map(([name, net]) => ({ name, net: round2(net) })).sort((x, y) => x.name.localeCompare(y.name));
  };
  const campaigns = new Map<string, { campaign: VendorRow["campaign"]; net: number; rows: number }>();
  for (const r of rows) { const key = JSON.stringify(r.campaign), v = campaigns.get(key) ?? { campaign: r.campaign, net: 0, rows: 0 }; v.net += r.net; v.rows++; campaigns.set(key, v); }
  const unmapped = rows.filter((r) => !r.matched);
  const unmappedGroups = new Map<string, { date: string; campaign: VendorRow["campaign"]; net: number; rows: number }>();
  for (const r of unmapped) { const key = JSON.stringify([r.date, r.campaign]), v = unmappedGroups.get(key) ?? { date: r.date, campaign: r.campaign, net: 0, rows: 0 }; v.net += r.net; v.rows++; unmappedGroups.set(key, v); }
  return { currency_info: currencyInfo(rows), completeness_warning: completenessWarning, partner: a.partner, start_date: a.start_date, end_date: a.end_date, status: !rows.length ? "empty" : days.every((d) => have.has(d)) ? "ok" : "gaps", missing_days: days.filter((d) => !have.has(d)), latest_date: [...have].sort().at(-1) ?? null, rows: rows.length, total_net: round2(rows.reduce((n, r) => n + r.net, 0)), by_day: group((r) => r.date), by_campaign: [...campaigns.values()].map((v) => ({ ...v, net: round2(v.net) })), by_click_url: group((r) => !r.matched ? "(unmapped)" : String(r.click_url_id)), unmapped_rows: unmapped, unmapped_by_day_campaign: [...unmappedGroups.values()].map((v) => ({ ...v, net: round2(v.net) })), unmapped_net: round2(unmapped.reduce((n, r) => n + r.net, 0)) };
}
export const getVendorReportOverview = defineTool({
  name: "get_vendor_report_overview", title: "渠道报表统计", stage: 3, write: false,
  description: "Summarize one partner's net spend, campaign identifiers, missing dates and unmapped rows. Jampp/Remerge/Pubmatic require client_id; InMobi/Smadex/Liftoff require completed report IDs. Does not start or poll reports.",
  schema,
  async run(args, ctx) { const data = overview(await fetchReport(args, ctx), args); return { summary: `${args.partner}：${data.rows} 行，net ${data.total_net}，状态 ${data.status}，未映射 ${data.unmapped_rows.length} 行`, data }; },
});
export const compareVendorReport = defineTool({
  name: "compare_vendor_report_with_direct_spend", title: "渠道报表对账", stage: 3, write: false,
  description: "Compare partner net with direct net per day and click URL. Report-mapped URLs are included automatically; optionally add click_url_ids to detect missing report rows for those URLs. Unmapped rows are shown separately. Missing report rows outside this scope cannot be detected.",
  schema: { ...schema, click_url_ids: z.array(z.coerce.number().int().positive()).max(500).optional(), tolerance: z.number().finite().nonnegative().optional() },
  async run(args, ctx) {
    const report = await fetchReport(args, ctx), rep = new Map<string, number>();
    const ids = [...new Set([...report.filter((r) => r.matched).map((r) => r.click_url_id!), ...(args.click_url_ids ?? [])])];
    if (ids.length > 500) throw new Error("报表及额外范围合计超过 500 个 click URL；请缩小范围");
    const scope = new Set(ids);
    for (const r of report) if (r.matched) { const k = `${r.click_url_id}|${r.date}`; rep.set(k, (rep.get(k) ?? 0) + r.net); }
    const direct = new Map<string, number>();
    const directRows: SpendRow[] = [];
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50), batchScope = new Set(batch);
      const response: unknown = await ctx.api.get("/ai/api/direct_spends", { start_date: args.start_date, end_date: args.end_date, "click_url_ids[]": batch });
      const values = completeRows<SpendRow>(response, "direct spend");
      validateRows(values, "direct spend", "date", ["feedmob_net_spend"]);
      directRows.push(...values);
      for (const d of values as SpendRow[]) {
        if (!batchScope.has(Number(d.click_url_id)) || d.date < args.start_date || d.date > args.end_date) continue;
        const net = numberAmount(d.feedmob_net_spend); if (net === null) throw new Error("direct spend 的 net 金额无效");
        const k = `${d.click_url_id}|${d.date}`; direct.set(k, (direct.get(k) ?? 0) + net);
      }
    }
    const currency_info = currencyInfo([...report, ...directRows]);
    const rows: Array<{date: string; click_url_id: number; report_net: number | null; direct_net: number | null; diff: number | null; status: string}> = [];
    for (const day of daysBetween(args.start_date, args.end_date)) for (const id of ids) {
      const k = `${id}|${day}`, r = rep.get(k), d = direct.get(k); if (r === undefined && d === undefined) continue;
      const delta = r === undefined || d === undefined ? null : r - d;
      rows.push({ date: day, click_url_id: id, report_net: r === undefined ? null : round2(r), direct_net: d === undefined ? null : round2(d), diff: delta === null ? null : round2(delta), status: r === undefined ? "missing_in_report" : d === undefined ? "missing_in_direct" : Math.abs(delta!) <= (args.tolerance ?? 0.01) + 1e-9 ? "match" : "diff" });
    }
    const counts = Object.fromEntries(["match", "diff", "missing_in_report", "missing_in_direct"].map((s) => [s, rows.filter((r) => r.status === s).length]));
    const data = overview(report, args);
    return { summary: `${args.partner}：一致 ${counts.match}，金额不同 ${counts.diff}，报表缺失 ${counts.missing_in_report}，direct 缺失 ${counts.missing_in_direct}，未映射 ${data.unmapped_rows.length} 行；${currency_info.warning ?? ""} ${completenessWarning}`, data: { ...data, currency_info, reconciliation_verified: false, scope_click_url_ids: [...scope], counts, rows, totals: { matched_scope_report_net: round2([...rep.values()].reduce((a, b) => a + b, 0)), direct_net: round2([...direct.values()].reduce((a, b) => a + b, 0)) } } };
  },
});
