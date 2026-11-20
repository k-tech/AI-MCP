// Only parses text supplied by the caller; no filesystem, URL or email access.
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { defineTool } from "./registry.js";
import { date, round2 } from "./schemas.js";
import { validAmount, completeRows, validateRows } from "./report-safety.js";

export const previewSuppliedSpendReport = defineTool({
  name: "preview_supplied_spend_report", title: "预览自带报表", stage: 2, write: false,
  description: "Preview caller-supplied CSV for one click URL and date. Explicit column mapping and currency are required. Never fetches files or URLs and never writes. Review the source, matched rows, currency and amounts; It does not generate create arguments until the target ledger currency can be established. No rate or margin is guessed.",
  schema: {
    click_url_id: z.coerce.number().int().positive(), spend_date: date("Spend 日期"),
    source_name: z.string().trim().min(1).max(120).describe("Human-readable source, not a URL to fetch"),
    csv_text: z.string().min(1).max(100_000).describe("CSV text including header"),
    columns: z.object({ date: z.string().min(1), click_url_id: z.string().min(1).optional(), currency: z.string().min(1), net: z.string().min(1).optional(), gross: z.string().min(1).optional() }).strict(),
    mapping: z.object({ basis: z.string().trim().min(1), effective_from: date().optional(), effective_to: date().optional(), filters: z.array(z.union([z.object({ column: z.string().min(1), value: z.string().min(1) }).strict(), z.object({ column: z.string().min(1), values: z.array(z.string().min(1)).min(1).max(100) }).strict()])).min(1).max(4) }).strict().optional().describe("Explicit source identifiers mapped to this URL; each filter uses value or values (alternatives); different columns intersect. Basis must be independently verified"),
    ledger: z.object({ currency: z.string().regex(/^[A-Za-z]{3}$/), basis: z.string().trim().min(1) }).strict().optional(),
    billing_rule: z.object({ type: z.literal("margin_on_gross"), margin_percent: z.number().finite().lt(100), currency: z.string().regex(/^[A-Za-z]{3}$/), effective_from: date(), effective_to: date(), basis: z.string().trim().min(1) }).strict().optional(),
    check_existing: z.boolean().optional().describe("Check the target date and URL in direct spend before previewing"),
  },
  async run({ click_url_id, spend_date, source_name, csv_text, columns, mapping, ledger, billing_rule, check_existing }, ctx) {
    if (!columns.click_url_id && !mapping) throw new Error("请提供 Click URL 列或经核实的来源映射");
    if (mapping && !check_existing) throw new Error("渠道原始报表预览必须先检查已有 Spend");
    let existing: Record<string, unknown>[] | null = null;
    if (check_existing) {
      existing = completeRows<Record<string, unknown>>(await ctx.api.get("/ai/api/direct_spends", { start_date: spend_date, end_date: spend_date, "click_url_ids[]": [click_url_id] }), "direct spend");
      validateRows(existing, "direct spend", "date", ["feedmob_net_spend", "feedmob_gross_spend"]);
      existing = existing.filter(r => r.date === spend_date && Number(r.click_url_id) === click_url_id);
    }
    if (!columns.net && !columns.gross) throw new Error("请明确指定 net 或 gross 列");
    const mapped = [...Object.values(columns), ...(mapping?.filters.map(f => f.column) ?? [])] as string[];
    if (new Set(mapped).size !== mapped.length) throw new Error("不同字段不能映射到同一列");
    let records: string[][];
    try { records = parse(csv_text, { bom: true, skip_empty_lines: true, relax_column_count: false, trim: true, max_record_size: 100_000 }); }
    catch { throw new Error("CSV 格式无效，请检查引号及列数"); }
    if (records.length < 2 || records.length > 1001) throw new Error("CSV 需要 1 到 1000 行数据");
    const header = records[0];
    if (new Set(header).size !== header.length || mapped.some((c) => !header.includes(c))) throw new Error("CSV 表头重复或映射列不存在");
    const index = (name: string) => header.indexOf(name);
    const rows = records.slice(1), selected: string[][] = [];
    for (const [i, row] of rows.entries()) {
      const day = row[index(columns.date)], id = columns.click_url_id ? row[index(columns.click_url_id)] : null;
      if (!z.string().date().safeParse(day).success || (id !== null && (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0))) throw new Error(`CSV 第 ${i + 2} 行日期或 Click URL ID 无效，无法确认筛选范围`);
      if (day === spend_date && (id === null || Number(id) === click_url_id) && (!mapping || mapping.filters.every(f => "value" in f ? row[index(f.column)] === f.value : f.values.includes(row[index(f.column)])))) selected.push(row);
    }
    if (!selected.length) return { summary: "没有匹配日期和 Click URL 的行，未生成录入金额", data: { source_name, click_url_id, spend_date, matched_rows: 0, total_rows: rows.length } };
    const currencies = new Set(selected.map((r) => r[index(columns.currency)].toUpperCase()));
    if (currencies.size !== 1 || !/^[A-Z]{3}$/.test([...currencies][0])) throw new Error("匹配行币种缺失、无效或不一致，停止预览");
    const total = (column?: string) => {
      if (!column) return null;
      const values = selected.map((r) => r[index(column)]);
      if (values.some((v) => v !== "" && (!validAmount(v) || Number(v) < 0))) throw new Error(`匹配行 ${column} 金额无效`);
      if (values.some((v) => v === "")) return null;
      return round2(values.reduce((sum, v) => sum + Number(v), 0));
    };
    const net = total(columns.net), sourceGross = total(columns.gross);
    const currency = [...currencies][0];
    let gross = sourceGross, calculation: string | null = null;
    const blockers: string[] = [];
    if (!ledger || ledger.currency.toUpperCase() !== currency) blockers.push("目标账本币种及依据缺失或与报表币种不一致");
    if (!mapping && !columns.click_url_id) blockers.push("缺少 URL 映射");
    if (mapping && (!mapping.effective_from || !mapping.effective_to || mapping.effective_from > mapping.effective_to || spend_date < mapping.effective_from || spend_date > mapping.effective_to)) blockers.push("来源映射有效期未覆盖目标日期");
    if (existing?.some(r => r.currency != null && String(r.currency).toUpperCase() !== currency)) blockers.push("已有记录币种与报表币种不一致或无效");
    if (!check_existing) blockers.push("尚未检查已有 Spend");
    if (net === null) blockers.push("Net 金额缺失");
    if (billing_rule) {
      if (billing_rule.effective_from > billing_rule.effective_to || spend_date < billing_rule.effective_from || spend_date > billing_rule.effective_to) blockers.push("计费规则未覆盖目标日期");
      if (billing_rule.currency.toUpperCase() !== currency) blockers.push("计费规则币种与报表币种不一致");
    }

    const duplicate_rows = selected.length - new Set(selected.map((r) => JSON.stringify(r))).size;
    if (duplicate_rows) blockers.push("存在重复行，需核实原报表");
    if (billing_rule && !blockers.length && net !== null && sourceGross === null) {
      const computed = net / (1 - billing_rule.margin_percent / 100);
      if (!Number.isFinite(computed) || computed > Number.MAX_SAFE_INTEGER / 100) throw new Error("按计费规则计算的金额无效或超出安全范围");
      gross = round2(computed);
      calculation = `net ${net} ÷ (1 − margin ${billing_rule.margin_percent}%) = gross ${gross}；依据：${billing_rule.basis}；有效期 ${billing_rule.effective_from} 至 ${billing_rule.effective_to}；币种 ${currency}。依据由调用者提供，需独立核实。`;
    }
    const warnings = ["来源由调用者提供，无法验证完整性、口径或重复；请核对原报表与写入环境。", ...(duplicate_rows ? [`存在 ${duplicate_rows} 行完全重复，请核实后重新预览。`] : []), ...((net === null || gross === null) ? ["net 或 gross 缺失；需提供覆盖目标日的计费规则和币种依据。"] : [])];
    if (mapping) warnings.push(`映射依据由调用者提供：${mapping.basis}；必须独立核实映射和生效日期。`);
    if (calculation) warnings.push(calculation);
    if (blockers.length) warnings.push(`无法计算或比较录入预览：${blockers.join("；")}。`);
    if (existing === null) warnings.push("尚未查询已有 Spend，不能录入。");
    else if (existing.length) {
      if (!ledger || ledger.currency.toUpperCase() !== currency || existing.some(r => r.currency != null && String(r.currency).toUpperCase() !== currency)) warnings.push("目标账本或已有记录币种未确认或不一致，已有金额不可比较，不要覆盖。");
      else if (existing.length > 1) warnings.push("已有多条 Spend，需人工核查，不能判定一致或覆盖。");
      else if (blockers.length) warnings.push("来源映射、计费依据或金额待核实，已有金额不能判定一致，不要覆盖。");
      else {
        const existingNet = round2(existing.reduce((sum, r) => sum + Number(r.feedmob_net_spend), 0));
        const existingGross = round2(existing.reduce((sum, r) => sum + Number(r.feedmob_gross_spend), 0));
        const conflict = (net !== null && net !== existingNet) || (gross !== null && gross !== existingGross);
        warnings.push(conflict ? "已有 Spend 与预览不一致，不要覆盖，需人工核查。" : net !== null && gross !== null ? "已有 Spend 的 net 和 gross 与预览一致，不要重复新增。" : "已知金额一致，但 net 或 gross 缺失，不能判定完全一致，不要覆盖。");
      }
    } else warnings.push("目标日期和 URL 未返回已有 Spend；上游完整性仍需核实。");
    warnings.push("只读预览；账本币种、映射及计费依据由调用者提供，必须独立核实；不生成写入参数。");
    const suggested_create = null;
    return { summary: `匹配 ${selected.length} 行；币种 ${[...currencies][0]}；${warnings.join(" ")}`, data: { source_name, click_url_id, spend_date, currency: [...currencies][0], matched_rows: selected.length, total_rows: rows.length, duplicate_rows, net, gross, calculation, blockers, ledger_basis: ledger?.basis ?? null, existing, mapping_basis: mapping?.basis ?? null, warnings, detail: selected.map(r => ({ date: r[index(columns.date)], click_url_id, currency: r[index(columns.currency)], net: columns.net ? r[index(columns.net)] : null, gross: columns.gross ? r[index(columns.gross)] : null })), suggested_create } };
  },
});
