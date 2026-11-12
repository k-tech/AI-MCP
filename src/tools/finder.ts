// Stage 2+: find the spend for one click URL on one day from data Tally can read,
// so a new direct spend can be entered without a human typing the numbers.
//
// Sources, in order of trust:
//   1. existing direct spend record            → nothing to create
//   2. MMP events (AppsFlyer, then Kochava) × the day's CPI      (gross: client paid action × gross CPI,
//                                                                  net:   vendor paid action × net CPI)
//   3. internal client report (client_report_spends) gross; net derived from the day's rate
// The live backend job for the click URL (direct_spend_job_stats) says where each side *should* come from;
// when it names an outside source (vendor report, partner email, Google Sheet) Tally leaves that side empty
// instead of guessing.
import { z } from "zod";
import { defineTool, type ToolContext } from "./registry.js";
import { rowsOf } from "../http.js";
import { date, round2 } from "./schemas.js";
import type { RateRow } from "./spend.js";

/** Paid action → field name in the AppsFlyer / Kochava daily rows. */
const EVENT_FIELD: Record<string, string> = {
  first_install: "install", install: "install",
  first_registration: "registration", registration: "registration",
  first_purchase: "purchase", purchase: "purchase",
  open: "open", tutorial: "tutorial", level: "level", retained: "retained",
  first_event_a: "first_event_a", first_event_b: "first_event_b", all_event_a: "all_event_a", all_event_b: "all_event_b",
};
/**
 * How a backend job says one side (gross or net) is produced. Whitelist: Tally only computes a side when the job
 * names a source Tally can read (MMP events) or a derivation from the other side; anything else is "external".
 */
type Kind = "events" | "derive" | "external" | "none";
export function classifySource(src?: string): Kind {
  if (!src || !src.trim()) return "none";
  if (/calculated from (net|gross)|margin|(gross|net)_spend\s*\*/i.test(src)) return "derive";
  if (/appsflyer|\baf\b|kochava|in app events?|raw log/i.test(src)) return "events";
  return "external";
}

export interface Job { job: string; status: string; gross_spend_source: string; net_spend_source: string; schedule: string; pa_users: string[]; pm_users: string[]; notes: string; click_url_ids: number[] }
export interface Side { value: number | null; how: string; count?: number; event?: string; rate?: number }
export interface Finding {
  click_url_id: number; spend_date: string;
  status: "exists" | "ready" | "partial" | "not_found";
  existing?: Record<string, unknown>;
  proposal?: { click_url_id: number; spend_date: string; net_spend: number; gross_spend: number; client_paid_action_count?: number; partner_paid_action_count?: number; installs_count?: number };
  gross: Side; net: Side;
  rate?: { net_cpi: number; gross_cpi: number; margin: number | null; client_paid_action?: string; vendor_paid_action?: string; campaign_name?: string; vendor_name?: string };
  job?: { name: string; gross_source: string; net_source: string; schedule: string; pa_users: string[]; pm_users: string[] };
  sources_checked: string[];
  advice: string;
}

const isFixed = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function sumEvents(rows: Record<string, unknown>[], field: string): number {
  return rows.reduce((s, r) => s + (Number(r[field]) || 0), 0);
}

export async function findSpend(ctx: ToolContext, clickUrlId: number, day: string): Promise<Finding> {
  const { api } = ctx;
  const checked: string[] = [];
  const blank = (how: string): Side => ({ value: null, how });
  const f: Finding = { click_url_id: clickUrlId, spend_date: day, status: "not_found", gross: blank("未找到"), net: blank("未找到"), sources_checked: checked, advice: "" };

  // 1. existing record
  const existing = rowsOf<Record<string, unknown>>(await api.get("/ai/api/direct_spends", { start_date: day, end_date: day, "click_url_ids[]": [clickUrlId] }))
    .find((r) => r.date === day && Number(r.click_url_id) === clickUrlId);
  checked.push("direct_spends");

  // rate + job, needed in every case
  const [rateRows, jobRows] = await Promise.all([
    api.get("/ai/api/click_url_histories", { "click_url_ids[]": [clickUrlId], start_date: day, end_date: day }).then((d) => rowsOf<RateRow>(d)),
    api.get("/ai/api/direct_spend_job_stats").then((d) => rowsOf<Job>(d)).catch(() => [] as Job[]),
  ]);
  checked.push("click_url_histories", "direct_spend_job_stats");
  const rt = rateRows.find((r) => r.date === day) as (RateRow & { client_paid_action?: string; vendor_paid_action?: string }) | undefined;
  if (rt) f.rate = { net_cpi: rt.net_cpi, gross_cpi: rt.gross_cpi, margin: rt.margin, client_paid_action: rt.client_paid_action, vendor_paid_action: rt.vendor_paid_action, campaign_name: rt.campaign_name, vendor_name: rt.vendor_name };
  const job = jobRows.find((j) => (j.click_url_ids ?? []).includes(clickUrlId) && j.status === "live");
  if (job) f.job = { name: job.job, gross_source: job.gross_spend_source, net_source: job.net_spend_source, schedule: job.schedule, pa_users: job.pa_users ?? [], pm_users: job.pm_users ?? [] };
  const owner = job ? [...(job.pa_users ?? []), ...(job.pm_users ?? [])].join("、") : "";

  if (existing) {
    f.status = "exists"; f.existing = existing;
    f.advice = `这一天已经有记录（NetSpend #${existing.id}：net ${existing.feedmob_net_spend} / gross ${existing.feedmob_gross_spend}），不要再新增；要改请用 update_direct_spend。`;
    return f;
  }
  if (!rt) { f.advice = `找不到 click URL ${clickUrlId} 在 ${day} 的单价记录，可能 ID 不对或这天还没有单价。`; return f; }

  const gk = classifySource(job?.gross_spend_source), nk = classifySource(job?.net_spend_source);
  const grossByEvents = gk === "events" || gk === "none", netByEvents = nk === "events" || nk === "none";

  // 2. MMP events × rate
  const sideFromEvents = (rows: Record<string, unknown>[], mmp: string, action: string | undefined, rate: number, label: "gross" | "net"): Side | null => {
    const field = action ? EVENT_FIELD[action] : undefined;
    if (!field || !isFixed(rate)) return null;
    const count = sumEvents(rows, field);
    return { value: round2(count * rate), how: `${mmp} ${action} ${count} × ${label} CPI ${rate}`, count, event: action, rate };
  };
  let mmpRows: Record<string, unknown>[] = [], mmp = "";
  const af = rowsOf<Record<string, unknown>>(await api.get("/ai/api/appsflyer_reports", { start_date: day, end_date: day, "click_url_ids[]": [clickUrlId] }).catch(() => []))
    .filter((r) => Number(r.click_url_id) === clickUrlId && r.date === day);
  checked.push("appsflyer_reports");
  if (af.length) { mmpRows = af; mmp = "AppsFlyer"; }
  else {
    const ko = rowsOf<Record<string, unknown>>(await api.get("/ai/api/kochava_reports", { start_date: day, end_date: day, "click_url_ids[]": [clickUrlId] }).catch(() => []))
      .filter((r) => Number(r.click_url_id) === clickUrlId && r.date === day);
    checked.push("kochava_reports");
    if (new Set(ko.map((r) => r.report_type)).size === 1) { mmpRows = ko; mmp = "Kochava"; }
  }
  if (mmpRows.length) {
    const g = grossByEvents ? sideFromEvents(mmpRows, mmp, rt.client_paid_action, rt.gross_cpi, "gross") : null;
    const n = netByEvents ? sideFromEvents(mmpRows, mmp, rt.vendor_paid_action, rt.net_cpi, "net") : null;
    if (g) f.gross = g;
    if (n) f.net = n;
  }

  // 3. internal client report for gross (only if events gave nothing)
  if (f.gross.value === null && gk === "none") {
    const names = rowsOf<string>(await api.get("/ai/api/client_report_spends/report_names").catch(() => []));
    for (const name of names) {
      const rows = rowsOf<{ click_url_id: number; spend_date: string; gross_spend: number }>(await api.get("/ai/api/client_report_spends", { start_date: day, end_date: day, report_name: name }).catch(() => []))
        .filter((r) => Number(r.click_url_id) === clickUrlId && r.spend_date === day);
      if (rows.length) { f.gross = { value: round2(rows.reduce((s, r) => s + (Number(r.gross_spend) || 0), 0)), how: `客户报表 “${name}” gross` }; break; }
    }
    checked.push("client_report_spends");
  }

  // derive the other side from the day's rate when the job says so (or no job says otherwise)
  if (f.net.value === null && f.gross.value !== null && (nk === "derive" || (nk === "none" && rt.vendor_paid_action !== "vendor_managed"))) {
    if (isFixed(rt.net_cpi) && isFixed(rt.gross_cpi) && rt.gross_cpi > 0) f.net = { value: round2(f.gross.value * rt.net_cpi / rt.gross_cpi), how: `gross × net CPI ${rt.net_cpi} ÷ gross CPI ${rt.gross_cpi}` };
    else if (typeof rt.margin === "number") f.net = { value: round2(f.gross.value * (1 - rt.margin / 100)), how: `gross × (1 − margin ${rt.margin}%)` };
  }
  if (f.gross.value === null && f.net.value !== null && (gk === "derive" || (gk === "none" && rt.client_paid_action !== "vendor_managed"))) {
    if (isFixed(rt.net_cpi) && isFixed(rt.gross_cpi) && rt.net_cpi > 0) f.gross = { value: round2(f.net.value * rt.gross_cpi / rt.net_cpi), how: `net × gross CPI ${rt.gross_cpi} ÷ net CPI ${rt.net_cpi}` };
    else if (typeof rt.margin === "number" && rt.margin < 100) f.gross = { value: round2(f.net.value / (1 - rt.margin / 100)), how: `net ÷ (1 − margin ${rt.margin}%)` };
  }

  if (gk === "external" && f.gross.value === null) f.gross = blank(`后台任务写明 gross 来自“${job!.gross_spend_source}”，Tally 读不到这个来源`);
  if (nk === "external" && f.net.value === null) f.net = blank(`后台任务写明 net 来自“${job!.net_spend_source}”，Tally 读不到这个来源`);
  if (rt.client_paid_action === "vendor_managed" && f.gross.value === null && gk !== "external") f.gross = blank("计费方式是 vendor_managed，金额只能来自渠道报表");
  if (rt.vendor_paid_action === "vendor_managed" && f.net.value === null && nk !== "external") f.net = blank("计费方式是 vendor_managed，金额只能来自渠道报表");

  const who = owner ? `负责人：${owner}。` : "";
  const auto = job ? `这个 click URL 由后台任务 ${job.job}（cron ${job.schedule}）自动录入，等任务跑完可能就有了。` : "";
  if (f.gross.value !== null && f.net.value !== null) {
    f.status = "ready";
    const counts: Finding["proposal"] = { click_url_id: clickUrlId, spend_date: day, net_spend: f.net.value, gross_spend: f.gross.value };
    if (f.gross.count !== undefined) counts.client_paid_action_count = f.gross.count;
    if (f.net.count !== undefined) counts.partner_paid_action_count = f.net.count;
    if (mmpRows.length) counts.installs_count = sumEvents(mmpRows, "install");
    f.proposal = counts;
    const basis = job ? "计算口径和后台任务写明的来源一致。" : "这个 click URL 没有后台任务说明口径，按 Tally 默认规则（事件数 × 当天单价）计算，请人工核对。";
    f.advice = `可以新增：net ${f.net.value} / gross ${f.gross.value}。${basis}${auto ? `注意：${auto}手动录入可能和任务重复。` : ""}`;
  } else if (f.gross.value !== null || f.net.value !== null) {
    f.status = "partial";
    f.advice = `只找到${f.gross.value !== null ? ` gross ${f.gross.value}` : ` net ${f.net.value}`}，另一项需要人工提供。${auto}${who}`;
  } else {
    f.advice = `Tally 能读到的数据源里没有这一天的 spend。${auto}${who}需要人工提供 net 和 gross。`;
  }
  return f;
}

const inputs = { click_url_id: z.coerce.number().int().positive().describe("Click URL ID"), spend_date: date("Spend 日期") };

export const findDirectSpend = defineTool({
  name: "find_direct_spend", title: "自动查找 Spend", stage: 2, write: false,
  description: "Work out the direct spend (net and gross) for one click URL on one day from data Tally can read, so the user does not have to type the numbers. "
    + "Checks: an existing record; AppsFlyer/Kochava events × the day's CPI; internal client reports; and the live backend job that says where the spend should come from. "
    + "Returns status ready (both amounts, with how each was computed), partial, not_found (with who owns it), or exists. "
    + "CALL THIS FIRST whenever the user asks to create a direct spend without giving amounts. Read-only.",
  schema: inputs,
  async run({ click_url_id, spend_date }, ctx) {
    if (spend_date > new Date().toISOString().slice(0, 10)) throw new Error("不能查未来的日期");
    const f = await findSpend(ctx, click_url_id, spend_date);
    (f as Finding & { environment?: string }).environment = ctx.api.base;
    const label = { ready: "找到了", partial: "只找到一部分", not_found: "没找到", exists: "已存在" }[f.status];
    return { summary: `${label}：${f.advice}`, data: f };
  },
});

export const createDirectSpendFromSources = defineTool({
  name: "create_direct_spend_from_sources", title: "自动录入 Spend", stage: 2, write: true,
  description: "Create a direct spend whose net and gross are worked out automatically (same logic as find_direct_spend). "
    + "Without confirm: true it only returns a preview and saves NOTHING — show the amounts and how they were computed to the user, and resend with confirm: true only after they agree. "
    + "Refuses when a record already exists or when either amount cannot be determined (then ask the user for the missing number and use create_direct_spend).",
  schema: { ...inputs, confirm: z.boolean().optional().describe("true only after the user accepted the previewed amounts") },
  async run({ click_url_id, spend_date, confirm }, ctx) {
    // Look up AND write in the write environment, so the duplicate check and the record match where the spend lands.
    const f = await findSpend({ ...ctx, api: ctx.writeApi }, click_url_id, spend_date);
    if (f.status !== "ready" || !f.proposal) return { summary: `没有写入：${f.advice}`, data: f, isError: true };
    const p = f.proposal;
    if (!confirm) return { summary: `预览（尚未写入）：click URL ${click_url_id} 在 ${spend_date} → net ${p.net_spend}（${f.net.how}）/ gross ${p.gross_spend}（${f.gross.how}）。用户确认后用 confirm: true 再调用一次才会保存。`, data: { confirmation_required: true, ...f } };
    const audit = `[Tally · ${ctx.caller}] 自动录入：gross = ${f.gross.how}；net = ${f.net.how}`;
    const data = await ctx.writeApi.post("/ai/api/direct_spends", { ...p, audit_comment: audit });
    return { summary: `已新增 click URL ${click_url_id} 在 ${spend_date} 的 spend：net ${p.net_spend} / gross ${p.gross_spend}`, data: { created: data, finding: f } };
  },
});
