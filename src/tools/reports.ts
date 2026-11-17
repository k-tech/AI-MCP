// Stage 3: Report statistics — vendors, campaigns, internal client report spends.
import { z } from "zod";
import { defineTool } from "./registry.js";
import { rowsOf } from "../http.js";
import { completeRows, validateRows, currencyInfo, completenessWarning } from "./report-safety.js";
import { date, assertRange, round2 } from "./schemas.js";

export interface VendorRow { id: number; vendor_name: string; status: string; vendor_type: string; for_test: boolean; created_at: string }
export interface CampaignRow { id: number; name: string; client_id: number; status: string; os: string; agency: boolean; created_at: string }
export interface ReportSpendRow { id: number; client_id: number; client_name: string; campaign_id: number; campaign_name: string; vendor_id: number; vendor_name: string; click_url_id: number; report_name: string; pa: string; spend_date: string; gross_spend: number; raw_log_rows?: unknown }

const countBy = <T>(rows: T[], key: (r: T) => string) => {
  const m: Record<string, number> = {};
  for (const r of rows) { const k = key(r) || "未知"; m[k] = (m[k] ?? 0) + 1; }
  return Object.fromEntries(Object.entries(m).sort((a, b) => b[1] - a[1]));
};

export const getVendors = defineTool({
  name: "get_vendors", title: "查询渠道", stage: 3, write: false,
  description: "List FeedMob vendors (partners) with status and type. Optional vendor_name filter. Includes counts by status and by type.",
  schema: { vendor_name: z.string().trim().min(1).optional().describe("Vendor name to search for (optional)") },
  async run({ vendor_name }, { api }) {
    const rows = rowsOf<VendorRow>(await api.get("/ai/api/vendors", { vendor_name }));
    return { summary: `找到 ${rows.length} 个渠道`, data: { by_status: countBy(rows, (r) => r.status), by_type: countBy(rows, (r) => r.vendor_type), rows } };
  },
});

export const getCampaigns = defineTool({
  name: "get_campaigns", title: "查询 Campaign", stage: 3, write: false,
  description: "List campaigns, optionally for one client_id. Archived campaigns are hidden unless include_archived is true. Includes counts by OS and status.",
  schema: {
    client_id: z.coerce.number().int().positive().optional().describe("Client ID (optional)"),
    include_archived: z.boolean().optional().describe("Include campaigns whose name contains _archived_ (default false)"),
  },
  async run({ client_id, include_archived }, { api }) {
    const all = rowsOf<CampaignRow>(await api.get("/ai/api/campaigns", { client_id }));
    const rows = (include_archived ? all : all.filter((r) => !/_archived_/.test(r.name)))
      .map(({ id, name, client_id, status, os, agency, created_at }) => ({ id, name, client_id, status, os, agency, created_at }));
    return { summary: `${rows.length} 个 campaign${include_archived ? "" : `（已隐藏 ${all.length - rows.length} 个归档）`}`, data: { by_os: countBy(rows, (r) => r.os), by_status: countBy(rows, (r) => r.status), rows } };
  },
});

/**
 * Admin "Choose Client Report" page shows display names that can differ from the API's report_name.
 * Only confirmed mappings are listed (2026-11-12, from the admin page and its upload banner).
 */
const ADMIN_NAME: Record<string, string> = { "Chime Agency Spend": "Chime Agency AF Daily Spend" };
const SAME_IN_ADMIN = new Set(["Binance AppsFlyer Spend", "Binance US Appsflyer Spend", "Capital One", "Exmox AppsFlyer Spend", "Mistplay AppsFlyer Spend",
  "Novig AppsFlyer Spend", "Possible Finance", "Realtor", "Realtor Agency", "Realtor AppsFlyer Spend Email", "Stash", "Stash AppsFlyer Spend", "Upside Spend"]);
export function adminName(name: string): { admin_name: string | null; admin_name_confirmed: boolean } {
  if (ADMIN_NAME[name]) return { admin_name: ADMIN_NAME[name], admin_name_confirmed: true };
  if (SAME_IN_ADMIN.has(name)) return { admin_name: name, admin_name_confirmed: true };
  return { admin_name: null, admin_name_confirmed: false };
}
const SOURCE_NOTE = "客户报表：后台“Choose Client Report”页面整理并上传给客户的 spend（client_report_spends），不是 FeedMob 的 direct spend，和 Femini 的 Daily Campaign Spends 不是同一份数据。";

export const getReportNames = defineTool({
  name: "get_client_report_spend_report_names", title: "客户报表列表", stage: 3, write: false,
  description: "List client reports — the spend reports FeedMob prepares and uploads TO clients from the admin 'Choose Client Report' page (not FeedMob's direct spend). "
    + "Returns the API name (use it with get_client_report_spends) and, where confirmed, the name shown in the admin page.",
  schema: {},
  async run(_args, { api }) {
    const names = rowsOf<string>(await api.get("/ai/api/client_report_spends/report_names"));
    return { summary: `${names.length} 个客户报表`, data: names.map((name) => ({ name, ...adminName(name) })) };
  },
});

export const getClientReportSpends = defineTool({
  name: "get_client_report_spends", title: "客户报表统计", stage: 3, write: false,
  description: "Gross spend in one client report (the spend FeedMob uploaded to the client, NOT direct spend) for a date range, summarised by vendor, campaign and day. "
    + "To compare with FeedMob's own spend (what Femini's Daily Campaign Spends shows) use get_direct_spends. Set include_rows for per-row data (raw logs are always dropped).",
  schema: {
    report_name: z.string().trim().min(1).describe("Report name from get_client_report_spend_report_names"),
    start_date: date("开始日期"), end_date: date("结束日期"),
    include_rows: z.boolean().optional().describe("Also return individual rows (default false)"),
  },
  async run({ report_name, start_date, end_date, include_rows }, { api }) {
    assertRange(start_date, end_date);
    const rows = completeRows<ReportSpendRow>(await api.get("/ai/api/client_report_spends", { start_date, end_date, report_name }), "client report");
    validateRows(rows, "client report", "spend_date", ["gross_spend"]);
    const currency_info = currencyInfo(rows);
    const sum = <K extends string>(key: (r: ReportSpendRow) => K) => {
      const m = new Map<K, { gross: number; rows: number }>();
      for (const r of rows) { const g = m.get(key(r)) ?? { gross: 0, rows: 0 }; g.gross += Number(r.gross_spend) || 0; g.rows++; m.set(key(r), g); }
      return [...m.entries()].map(([k, v]) => ({ key: k, gross: round2(v.gross), rows: v.rows }));
    };
    const total = round2(rows.reduce((s, r) => s + (Number(r.gross_spend) || 0), 0));
    const byVendor = sum((r) => r.vendor_name).sort((a, b) => b.gross - a.gross);
    const byCampaign = sum((r) => r.campaign_name).sort((a, b) => b.gross - a.gross);
    const byDay = sum((r) => r.spend_date).sort((a, b) => a.key.localeCompare(b.key));
    const clients = [...new Set(rows.map((r) => r.client_name))];
    return {
      summary: `${report_name}：${start_date} ~ ${end_date} 返回 ${rows.length} 行，客户报表 gross 小计 ${total}，${byVendor.length} 个渠道；不是 Femini Total Spend，币种及上游完整性需核实。`,
      data: {
        report_name, ...adminName(report_name), currency_info, completeness_warning: completenessWarning, source_note: SOURCE_NOTE, start_date, end_date, clients, total_gross: total, rows: rows.length,
        by_vendor: byVendor, by_campaign: byCampaign, by_day: byDay,
        ...(include_rows ? { detail: rows.map(({ raw_log_rows, ...r }) => r) } : {}),
      },
    };
  },
});
