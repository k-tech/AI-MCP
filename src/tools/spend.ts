// Stage 2: Spend & Rate — read history, create/update direct spend, update historical prices.
import { z } from "zod";
import { defineTool, type ToolContext } from "./registry.js";
import { ApiError, rowsOf } from "../http.js";
import { amount, count, date, rate, margin, assertRange, round2 } from "./schemas.js";

export interface SpendRow { click_url_id: number; campaign_name: string; date: string; feedmob_net_spend: number; feedmob_gross_spend: number }
export interface RateRow { click_url_id: number; campaign_name: string; vendor_name: string; date: string; gross_cpi: number; net_cpi: number; margin: number | null; client_paid_action?: string; vendor_paid_action?: string }

const auditTag = (ctx: ToolContext, comment?: string) => `[Tally · ${ctx.caller}]${comment ? " " + comment : ""}`;
const metricFields = {
  impression: count.optional().describe("Impressions, integer >= 0"),
  clicks_count: count.optional().describe("Clicks, integer >= 0"),
  installs_count: count.optional().describe("Installs, integer >= 0"),
  client_paid_action_count: count.optional().describe("Client paid actions, integer >= 0"),
  partner_paid_action_count: count.optional().describe("Partner paid actions, integer >= 0"),
  creative: z.string().optional().describe("Creative name; blank is ignored by the API"),
  audit_comment: z.string().max(500).optional().describe("Reason for the change; the caller's email is added automatically"),
};

export const getDirectSpends = defineTool({
  name: "get_direct_spends", title: "查询 Spend", stage: 2, write: false,
  description: "Daily FeedMob net/gross spend per click URL for a date range. Filter by click_url_ids and/or client_id (at least one is needed to get rows). Returns rows plus totals per click URL.",
  schema: {
    start_date: date("开始日期"), end_date: date("结束日期"),
    click_url_ids: z.array(z.coerce.number().int().positive()).optional().describe("Click URL IDs"),
    client_id: z.coerce.number().int().positive().optional().describe("Client ID"),
  },
  async run({ start_date, end_date, click_url_ids, client_id }, { api }) {
    assertRange(start_date, end_date);
    if (!click_url_ids?.length && client_id === undefined) throw new Error("请至少提供 click_url_ids 或 client_id");
    const rows = rowsOf<SpendRow>(await api.get("/ai/api/direct_spends", { start_date, end_date, "click_url_ids[]": click_url_ids, client_id }));
    const byClickUrl = new Map<number, { click_url_id: number; campaign_name: string; days: number; net: number; gross: number }>();
    for (const r of rows) {
      const g = byClickUrl.get(r.click_url_id) ?? { click_url_id: r.click_url_id, campaign_name: r.campaign_name, days: 0, net: 0, gross: 0 };
      g.days++; g.net += Number(r.feedmob_net_spend) || 0; g.gross += Number(r.feedmob_gross_spend) || 0; byClickUrl.set(r.click_url_id, g);
    }
    const totals = [...byClickUrl.values()].map((g) => ({ ...g, net: round2(g.net), gross: round2(g.gross), margin_pct: g.gross ? round2((1 - g.net / g.gross) * 100) : null }))
      .sort((a, b) => b.gross - a.gross);
    const net = round2(totals.reduce((s, t) => s + t.net, 0)), gross = round2(totals.reduce((s, t) => s + t.gross, 0));
    return { summary: `${rows.length} 行，${totals.length} 个 click URL，合计 net ${net} / gross ${gross}`, data: { totals: { net, gross, rows: rows.length }, by_click_url: totals, rows } };
  },
});

export const getClickUrlHistories = defineTool({
  name: "get_click_url_histories", title: "查询单价历史", stage: 2, write: false,
  description: "Daily historical rates (net CPI, gross CPI, margin %, paid actions) for click URLs. Needed to check or change rates and to compute expected gross spend.",
  schema: {
    click_url_ids: z.array(z.coerce.number().int().positive()).min(1).max(50).describe("Click URL IDs"),
    start_date: date("开始日期"), end_date: date("结束日期"),
  },
  async run({ click_url_ids, start_date, end_date }, { api }) {
    assertRange(start_date, end_date);
    const rows = rowsOf<RateRow>(await api.get("/ai/api/click_url_histories", { "click_url_ids[]": click_url_ids, start_date, end_date }));
    // Collapse consecutive identical rates into periods for a readable summary.
    const periods: Array<{ click_url_id: number; from: string; to: string; net_cpi: number; gross_cpi: number; margin: number | null }> = [];
    for (const r of [...rows].sort((a, b) => a.click_url_id - b.click_url_id || a.date.localeCompare(b.date))) {
      const last = periods[periods.length - 1];
      if (last && last.click_url_id === r.click_url_id && last.net_cpi === r.net_cpi && last.gross_cpi === r.gross_cpi && last.margin === r.margin) last.to = r.date;
      else periods.push({ click_url_id: r.click_url_id, from: r.date, to: r.date, net_cpi: r.net_cpi, gross_cpi: r.gross_cpi, margin: r.margin });
    }
    return { summary: `${rows.length} 天的单价记录，共 ${periods.length} 个价格区间`, data: { periods, rows } };
  },
});

export const createDirectSpend = defineTool({
  name: "create_direct_spend", title: "新增 Spend", stage: 2, write: true,
  description: "Create a NEW direct spend record (POST /ai/api/direct_spends) with amounts the user GAVE. If the user did not give net/gross, do not ask first: call find_direct_spend (or create_direct_spend_from_sources) to work them out. Requires click_url_id, spend_date, net_spend, gross_spend. Campaign, vendor and paid action come from the click URL. Use update_direct_spend to change an existing record.",
  schema: { click_url_id: z.coerce.number().int().positive().describe("Click URL ID"), spend_date: date("Spend 日期"), net_spend: amount.describe("Net spend >= 0"), gross_spend: amount.describe("Gross spend >= 0"), ...metricFields },
  async run(args, ctx) {
    const body = Object.fromEntries(Object.entries({ ...args, audit_comment: auditTag(ctx, args.audit_comment) }).filter(([, v]) => v !== undefined));
    const data = await ctx.writeApi.post("/ai/api/direct_spends", body);
    return { summary: `已新增 click URL ${args.click_url_id} 在 ${args.spend_date} 的 spend`, data };
  },
});

export const updateDirectSpend = defineTool({
  name: "update_direct_spend", title: "修改 Spend", stage: 2, write: true,
  description: "Update an EXISTING direct spend, located either by id (NetSpend ID) or by click_url_id + spend_date (not both). Omitted fields are kept. Spend date and associations cannot change; gross spend cannot change in an invoiced month.",
  schema: {
    id: z.coerce.number().int().positive().optional().describe("NetSpend ID (omit when using click_url_id + spend_date)"),
    click_url_id: z.coerce.number().int().positive().optional().describe("Click URL ID, used with spend_date to find the record"),
    spend_date: date("Spend 日期（仅用于定位记录）").optional(),
    net_spend: amount.optional().describe("New net spend >= 0"),
    gross_spend: amount.optional().describe("New gross spend >= 0"),
    ...metricFields,
  },
  async run({ id, click_url_id, spend_date, ...fields }, ctx) {
    const byId = id !== undefined;
    if (byId && (click_url_id !== undefined || spend_date !== undefined)) throw new Error("请只用 id，或只用 click_url_id + spend_date 定位记录，不能同时提供");
    if (!byId && (click_url_id === undefined || spend_date === undefined)) throw new Error("请提供 id，或同时提供 click_url_id 和 spend_date");
    const changes = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v !== undefined && k !== "audit_comment"));
    if (!Object.keys(changes).length) throw new Error("没有要修改的字段");
    const body = { ...changes, audit_comment: auditTag(ctx, fields.audit_comment), ...(byId ? {} : { click_url_id, spend_date }) };
    const data = await ctx.writeApi.patch(`/ai/api/direct_spends/${byId ? id : "by_click_url"}`, body);
    return { summary: `已修改 ${byId ? `NetSpend #${id}` : `click URL ${click_url_id} 在 ${spend_date}`} 的 ${Object.keys(changes).join("、")}`, data };
  },
});

export const updateClickUrlPrices = defineTool({
  name: "update_click_url_prices", title: "修改历史单价", stage: 2, write: true,
  description: 'Change historical daily net CPI, gross CPI and margin for one click URL in one transaction (PATCH /ai/api/click_urls/:id/prices). Dates must be before today; invoiced months are locked. If the API answers confirmation_required, NOTHING was saved: show the warnings to the user and only resend with confirm: true after they explicitly accept. Never auto-confirm.',
  schema: {
    click_url_id: z.coerce.number().int().positive().describe("Click URL ID"),
    prices: z.array(z.object({ spend_date: date("日期"), net_cpi: rate.describe('Net CPI >= 0 or "N/A"'), gross_cpi: rate.describe('Gross CPI >= 0 or "N/A"'), margin: margin.describe('Margin % or "N/A"') }).strict())
      .min(1).max(370).refine((rows) => new Set(rows.map((r) => r.spend_date)).size === rows.length, "日期不能重复").describe("Daily prices to set"),
    confirm: z.boolean().optional().describe("true only after the user explicitly accepted the returned warnings"),
    on_behalf_of_user_id: z.coerce.number().int().positive().optional().describe("FeedMob user ID of the requester, recorded in the audit"),
  },
  async run({ click_url_id, prices, confirm = false, on_behalf_of_user_id }, { writeApi: api }) {
    const today = new Date().toISOString().slice(0, 10);
    const future = prices.filter((p) => p.spend_date >= today).map((p) => p.spend_date);
    if (future.length) throw new Error(`只能修改今天之前的单价：${future.join(", ")}`);
    try {
      const data = await api.patch(`/ai/api/click_urls/${click_url_id}/prices`, { prices, confirm, ...(on_behalf_of_user_id ? { on_behalf_of_user_id } : {}) });
      return { summary: `已更新 click URL ${click_url_id} 的 ${prices.length} 天单价`, data };
    } catch (e) {
      const body = e instanceof ApiError ? (e.body as { confirmation_required?: boolean } | undefined) : undefined;
      if (e instanceof ApiError && e.status === 422 && body?.confirmation_required) {
        return { summary: "需要确认：API 返回了警告，本次没有保存任何修改。请把警告给用户看，用户明确同意后再用 confirm: true 重新提交。", data: body, isError: true };
      }
      throw e;
    }
  },
});
