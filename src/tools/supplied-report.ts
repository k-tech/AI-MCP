// Only parses text supplied by the caller; no filesystem, URL or email access.
import { parse } from "csv-parse/sync";
import { z } from "zod";
import { defineTool } from "./registry.js";
import { date, round2 } from "./schemas.js";
import { validAmount } from "./report-safety.js";

export const previewSuppliedSpendReport = defineTool({
  name: "preview_supplied_spend_report", title: "预览自带报表", stage: 2, write: false,
  description: "Preview caller-supplied CSV for one click URL and date. Explicit column mapping and currency are required. Never fetches files or URLs and never writes. Review the source, matched rows, currency and amounts; It does not generate create arguments until the target ledger currency can be established. No rate or margin is guessed.",
  schema: {
    click_url_id: z.coerce.number().int().positive(), spend_date: date("Spend 日期"),
    source_name: z.string().trim().min(1).max(120).describe("Human-readable source, not a URL to fetch"),
    csv_text: z.string().min(1).max(100_000).describe("CSV text including header"),
    columns: z.object({ date: z.string().min(1), click_url_id: z.string().min(1), currency: z.string().min(1), net: z.string().min(1).optional(), gross: z.string().min(1).optional() }).strict(),
  },
  async run({ click_url_id, spend_date, source_name, csv_text, columns }) {
    if (!columns.net && !columns.gross) throw new Error("请明确指定 net 或 gross 列");
    const mapped = Object.values(columns) as string[];
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
      const day = row[index(columns.date)], id = row[index(columns.click_url_id)];
      if (!z.string().date().safeParse(day).success || !/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error(`CSV 第 ${i + 2} 行日期或 Click URL ID 无效，无法确认筛选范围`);
      if (day === spend_date && Number(id) === click_url_id) selected.push(row);
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
    const net = total(columns.net), gross = total(columns.gross);
    const duplicate_rows = selected.length - new Set(selected.map((r) => JSON.stringify(r))).size;
    const warnings = ["来源由调用者提供，无法验证完整性、口径或重复；请核对原报表与写入环境。", ...(duplicate_rows ? [`存在 ${duplicate_rows} 行完全重复，请核实后重新预览。`] : []), ...((net === null || gross === null) ? ["net 或 gross 缺失；不推算缺失金额。"] : [])];
    // The create API has no currency field; the target ledger currency is not established.
    warnings.push("目标账本币种未确认，禁止生成录入参数；核实账本币种及金额口径后再处理。");
    const suggested_create = null;
    return { summary: `匹配 ${selected.length} 行；币种 ${[...currencies][0]}；${warnings.join(" ")}`, data: { source_name, click_url_id, spend_date, currency: [...currencies][0], matched_rows: selected.length, total_rows: rows.length, duplicate_rows, net, gross, warnings, detail: selected.map(r => ({ date: r[index(columns.date)], click_url_id: Number(r[index(columns.click_url_id)]), currency: r[index(columns.currency)], net: columns.net ? r[index(columns.net)] : null, gross: columns.gross ? r[index(columns.gross)] : null })), suggested_create } };
  },
});
