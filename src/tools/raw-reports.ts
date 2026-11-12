// Read-only report tools carried over 1:1 from the original feedmob-reporting MCP (same endpoints and params),
// so an agent can look up partner / MMP / internal data itself — e.g. to work out a spend before entering it.
import { z, type ZodRawShape } from "zod";
import { defineTool, type ToolDef } from "./registry.js";
import type { QueryValue } from "../http.js";
import { date } from "./schemas.js";

const MAX_ROWS = 300;
const SPEND_HINT = " Combine with get_click_url_histories (CPI, margin, paid action) to work out a click URL's spend for one day.";
const ids = (what: string) => z.array(z.coerce.number().int().positive()).min(1).describe(what);
const range = { start_date: date("开始日期"), end_date: date("结束日期") };
const clientRange = { client_id: z.coerce.number().int().positive().describe("Client ID (required by this partner)"), ...range };
const month = z.string().regex(/^\d{4}-\d{2}$/, "格式 YYYY-MM").describe("Month, YYYY-MM");

interface Spec {
  name: string; title: string; path: string; description: string; schema: ZodRawShape;
  /** param → query key; arrays default to "<name>[]" */
  query?: (args: Record<string, unknown>) => Record<string, QueryValue>;
  atLeastOne?: string[];
}

const SPECS: Spec[] = [
  // ---- MMP / attribution reports (event counts → gross) ----
  { name: "get_appsflyer_reports", title: "AppsFlyer 报表", path: "/ai/api/appsflyer_reports",
    description: "AppsFlyer daily events per click URL (install, registration, purchase, …) with that day's CPI. Gross spend = count of the click URL's client_paid_action × gross CPI." + SPEND_HINT,
    schema: { ...range, click_url_ids: ids("Click URL IDs").optional(), af_app_ids: z.array(z.string()).optional().describe("AppsFlyer app IDs"), client_ids: ids("Client IDs").optional(), campaign_ids: ids("Campaign IDs").optional() } },
  { name: "get_kochava_reports", title: "Kochava 报表", path: "/ai/api/kochava_reports",
    description: "Kochava agency and non-agency daily events per click URL. Click URL IDs take precedence over client IDs." + SPEND_HINT,
    schema: { ...range, click_url_ids: ids("Click URL IDs").optional(), client_ids: ids("Client IDs").optional() } },
  { name: "get_appsflyer_in_app_events_retarget_reports", title: "AppsFlyer 重定向事件", path: "/ai/api/appsflyer_in_app_events_retarget_reports",
    description: "AppsFlyer in-app events retarget reports by date range. Requires client_id.", schema: clientRange },
  { name: "get_appsflyer_cohort_revenues", title: "AppsFlyer 同期收入", path: "/ai/api/appsflyer_cohort_revenues", description: "AppsFlyer cohort revenue by date range. Requires client_id.", schema: clientRange },
  { name: "get_appsflyer_cohort_revenues_geo", title: "AppsFlyer 同期收入（国家）", path: "/ai/api/appsflyer_cohort_revenues/geo", description: "AppsFlyer cohort revenue by country. Requires client_id.", schema: clientRange },
  { name: "get_possible_finance_singular_reports", title: "Possible Finance（Singular）", path: "/ai/api/possible_finance_singular_api_reports",
    description: "Possible Finance Singular daily events per click URL." + SPEND_HINT, schema: range },
  { name: "get_koho_financial_singular_reports", title: "Koho Financial（Singular）", path: "/ai/api/koho_financial_singular_api_reports", description: "Koho Financial Singular daily events per click URL." + SPEND_HINT, schema: range },
  { name: "get_privacy_hawk_singular_reports", title: "Privacy Hawk（Singular）", path: "/ai/api/privacy_hawk_singular_api_reports", description: "Privacy Hawk Singular daily events per click URL." + SPEND_HINT, schema: range },
  { name: "get_textnow_adjust_reports", title: "TextNow（Adjust）", path: "/ai/api/textnow_adjust_reports", description: "TextNow Adjust daily events per click URL." + SPEND_HINT, schema: range },
  { name: "get_agency_conversion_records", title: "Agency 转化记录", path: "/ai/api/agency_conversion_records",
    description: "Agency conversion records (used e.g. for Uber and 'reg counts in conversion records' jobs). Filter by client_id and/or click_url_ids." + SPEND_HINT,
    schema: { ...range, client_id: z.coerce.number().int().positive().optional().describe("Client ID"), click_url_ids: ids("Click URL IDs").optional() } },
  { name: "get_agency_conversion_metrics", title: "Agency 转化指标", path: "/ai/api/agency_conversion_metrics",
    description: "Agency conversion metrics for click URLs, optionally for one date.", schema: { click_url_ids: ids("Click URL IDs"), date: date("日期").optional() } },

  // ---- partner (vendor) reports (partner net spend → net) ----
  { name: "get_samsung_reports", title: "Samsung 报表", path: "/ai/api/samsung_reports", description: "Samsung partner report (net spend by campaign)." + SPEND_HINT, schema: range },
  { name: "get_youappi_reports", title: "YouAppi 报表", path: "/ai/api/youappi_reports", description: "YouAppi partner report (net spend)." + SPEND_HINT, schema: range },
  { name: "get_youappi_reports_geo", title: "YouAppi 报表（国家）", path: "/ai/api/youappi_reports/geo", description: "YouAppi by country: impressions, clicks, spend.", schema: range },
  { name: "get_kayzen_reports", title: "Kayzen 报表", path: "/ai/api/kayzen_reports", description: "Kayzen partner report (net spend)." + SPEND_HINT, schema: range },
  { name: "get_beeswax_reports", title: "Beeswax 报表", path: "/ai/api/beeswax_reports", description: "Beeswax spend by date, compared with FeedMob direct net spend." + SPEND_HINT, schema: range },
  { name: "get_jampp_reports", title: "Jampp 报表", path: "/ai/api/jampp_reports", description: "Jampp partner report. Requires a client with a Jampp campaign mapping." + SPEND_HINT, schema: clientRange },
  { name: "get_jampp_reports_geo", title: "Jampp 报表（国家）", path: "/ai/api/jampp_reports/geo", description: "Jampp by country: impressions, clicks, installs, spend. Requires client_id.", schema: clientRange },
  { name: "get_remerge_reports", title: "Remerge 报表", path: "/ai/api/remerge_reports", description: "Remerge spend with partner net spend and mapped FeedMob click URL when available. Requires client_id." + SPEND_HINT, schema: clientRange },
  { name: "get_remerge_reports_geo", title: "Remerge 报表（国家）", path: "/ai/api/remerge_reports/geo", description: "Remerge spend by country. Requires client_id.", schema: clientRange },
  { name: "get_pubmatic_reports", title: "Pubmatic 报表", path: "/ai/api/pubmatic_reports", description: "Pubmatic partner report. Requires client_id." + SPEND_HINT, schema: clientRange },
  { name: "get_pubmatic_reports_geo", title: "Pubmatic 报表（国家）", path: "/ai/api/pubmatic_reports/geo", description: "Pubmatic by country. Requires client_id.", schema: clientRange },
  { name: "get_inmobi_report_ids", title: "InMobi 报表 ID", path: "/ai/api/inmobi_api_reports/get_inmobi_report_ids", description: "Step 1 of InMobi: request report IDs for a date range. Next: check_inmobi_report_status, then get_inmobi_reports.", schema: range },
  { name: "check_inmobi_report_status", title: "InMobi 报表状态", path: "/ai/api/inmobi_api_reports/check_inmobi_report_id_status", description: "Step 2 of InMobi: check whether a report is ready.", schema: { ...range, report_id: z.string().min(1).describe("Report ID") } },
  { name: "get_inmobi_reports", title: "InMobi 报表", path: "/ai/api/inmobi_api_reports", description: "Step 3 of InMobi: get report data (needs both report IDs)." + SPEND_HINT,
    schema: { ...range, skan_report_id: z.string().min(1).describe("SKAN report ID"), non_skan_report_id: z.string().min(1).describe("Non-SKAN report ID") } },
  { name: "get_smadex_report_ids", title: "Smadex 报表 ID", path: "/ai/api/smadex_reports/get_smadex_report_ids", description: "Step 1 of Smadex: request a report ID. Next: check_smadex_report_status, then get_smadex_reports.", schema: range },
  { name: "check_smadex_report_status", title: "Smadex 报表状态", path: "/ai/api/smadex_reports/check_smadex_report_id_status", description: "Step 2 of Smadex: check whether a report is ready.", schema: { report_id: z.string().min(1).describe("Report ID") } },
  { name: "get_smadex_reports", title: "Smadex 报表", path: "/ai/api/smadex_reports", description: "Step 3 of Smadex: get report data." + SPEND_HINT, schema: { report_id: z.string().min(1).describe("Report ID") } },
  { name: "get_liftoff_report_ids", title: "Liftoff 报表 ID", path: "/ai/api/liftoff_reports/get_liftoff_report_ids", description: "Step 1 of Liftoff: request report IDs. Next: check_liftoff_report_status, then get_liftoff_reports.", schema: range },
  { name: "check_liftoff_report_status", title: "Liftoff 报表状态", path: "/ai/api/liftoff_reports/check_liftoff_report_status", description: "Step 2 of Liftoff: check whether reports are ready.",
    schema: { possible_finance_report_id: z.string().min(1).describe("Possible Finance report ID"), stash_report_id: z.string().min(1).describe("Stash report ID") } },
  { name: "get_liftoff_reports", title: "Liftoff 报表", path: "/ai/api/liftoff_reports", description: "Step 3 of Liftoff: get report data." + SPEND_HINT,
    schema: { ...range, possible_finance_report_id: z.string().min(1).describe("Possible Finance report ID"), stash_report_id: z.string().min(1).describe("Stash report ID") } },

  // ---- internal data ----
  { name: "get_direct_spend_job_stats", title: "Spend 自动任务", path: "/ai/api/direct_spend_job_stats",
    description: "Backend jobs that enter direct spend automatically: which click URLs, where gross and net come from (e.g. 'vendor report', 'AF raw log install', 'Calculated from net'), schedule and owners (PA/PM). Check this first to know which report holds a click URL's spend.",
    schema: { client_id: z.coerce.number().int().positive().optional().describe("Client ID"), vendor_id: z.coerce.number().int().positive().optional().describe("Vendor ID"), click_url_id: z.coerce.number().int().positive().optional().describe("Click URL ID") } },
  { name: "get_direct_spend_requests", title: "Spend 申请", path: "/ai/api/direct_spend_requests",
    description: "Direct spend requests. Provide at least one of feedmob_user_id, client_id, vendor_id, click_url_id.",
    schema: { feedmob_user_id: z.coerce.number().int().positive().optional(), client_id: z.coerce.number().int().positive().optional(), vendor_id: z.coerce.number().int().positive().optional(), click_url_id: z.coerce.number().int().positive().optional(), start_date: date("开始日期").optional() },
    atLeastOne: ["feedmob_user_id", "client_id", "vendor_id", "click_url_id"] },
  { name: "get_adops_reports", title: "AdOps 报表", path: "/ai/api/adops_reports", description: "AdOps reports for a month.", schema: { month } },
  { name: "get_adops_spend_check_reports", title: "AdOps Spend 检查", path: "/ai/api/adops_reports/spend_check_reports", description: "AdOps spend check reports for a month, optionally one client.",
    schema: { month, client_id: z.coerce.number().int().positive().optional().describe("Client ID") } },
  { name: "get_apps", title: "App 列表", path: "/ai/api/apps", description: "Apps of one client.", schema: { client_id: z.coerce.number().int().positive().describe("Client ID") } },
  { name: "get_user_infos", title: "用户列表", path: "/ai/api/user_infos", description: "All FeedMob users: email, feedmob_user_id, HubSpot / GitHub / Slack identities.", schema: {} },
  { name: "search_user_infos", title: "搜索用户", path: "/ai/api/user_infos/search", description: "Search FeedMob users by username.", schema: { username: z.string().trim().min(1).describe("Username") } },
  { name: "get_hubspot_tickets", title: "HubSpot 工单", path: "/ai/api/hubspot_tickets", description: "HubSpot tickets. Provide hubspot_user_id and/or createdate_start.",
    schema: { hubspot_user_id: z.coerce.number().int().positive().optional(), createdate_start: date("创建起始日期").optional() }, atLeastOne: ["hubspot_user_id", "createdate_start"] },
];

function defaultQuery(args: Record<string, unknown>): Record<string, QueryValue> {
  const q: Record<string, QueryValue> = {};
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) q[`${k}[]`] = v as Array<string | number>;
    else q[k] = v as string | number;
  }
  return q;
}

export const RAW_REPORT_TOOLS: ToolDef[] = SPECS.map((s) => defineTool({
  name: s.name, title: s.title, stage: 3, write: false, schema: s.schema, description: s.description,
  async run(args, { api }) {
    const a = args as Record<string, unknown>;
    if (s.atLeastOne && !s.atLeastOne.some((k) => a[k] !== undefined)) throw new Error(`请至少提供其中一个参数：${s.atLeastOne.join("、")}`);
    const data = await api.get(s.path, (s.query ?? defaultQuery)(a));
    const rows = Array.isArray(data) ? data : Array.isArray(data?.data) ? data.data : null;
    if (!rows) return { summary: `${s.title}：已返回`, data };
    const truncated = rows.length > MAX_ROWS;
    return {
      summary: `${s.title}：${rows.length} 行${truncated ? `（只返回前 ${MAX_ROWS} 行，请缩小日期或加筛选）` : ""}`,
      data: truncated ? { total_rows: rows.length, rows: rows.slice(0, MAX_ROWS), truncated: true } : rows,
    };
  },
}));
