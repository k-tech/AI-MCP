import { z } from "zod";

// Only recognize pagination signals; do not infer a pagination protocol.
export function completeRows<T>(value: unknown, source: string): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!value || typeof value !== "object") throw new Error(`${source} 返回格式无效`);
  const o = value as Record<string, any>, rows = o.data;
  if (!Array.isArray(rows)) throw new Error(`${source} 返回格式无效`);
  const meta = [o, o.meta, o.pagination].filter(x => x && typeof x === "object");
  if (o.error || meta.some(m => m.truncated === true || m.has_more === true || m.has_next_page === true || m.next_page || m.next || m.next_cursor || (typeof m.total_rows === "number" && m.total_rows > rows.length) || (typeof m.total === "number" && m.total > rows.length))) throw new Error(`${source} 返回错误或已知分页/截断，无法安全统计`);
  return rows as T[];
}
export const completenessWarning = "上游裸数组或未识别的分页元数据无法证明结果完整，请核实上游。";
export function validAmount(v: unknown): boolean { return (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(v.trim()) && Number.isFinite(Number(v))); }
export function validateRows(rows: any[], source: string, dayField: string, amountFields: string[]) {
  const counts = { invalid_date: 0, invalid_id: 0, invalid_amount: 0 };
  for (const r of rows) {
    if (!r || typeof r !== "object" || !z.string().date().safeParse(r[dayField]).success) counts.invalid_date++;
    if (!r || !/^\d+$/.test(String(r.click_url_id)) || !Number.isSafeInteger(Number(r.click_url_id)) || Number(r.click_url_id) <= 0) counts.invalid_id++;
    if (!r || amountFields.some(f => !validAmount(r[f]))) counts.invalid_amount++;
  }
  if (Object.values(counts).some(Boolean)) throw new Error(`${source} 异常行计数 ${JSON.stringify(counts)}；停止统计，请检查原始数据`);
}
export function currencyInfo(rows: any[]) {
  const currencies = new Set<string>(); let unknown = 0;
  for (const r of rows) { const c = r?.currency; if (typeof c === "string" && /^[A-Za-z]{3}$/.test(c.trim())) currencies.add(c.trim().toUpperCase()); else unknown++; }
  if (currencies.size > 1) throw new Error(`发现多种币种 ${[...currencies].join(", ")}，停止聚合；不进行自动换算`);
  return { currency: currencies.size === 1 && unknown === 0 ? [...currencies][0] : null, unknown_currency_rows: unknown, warning: unknown ? "部分或全部行币种未知；金额比较仅供参考，不能确认对账通过。" : null };
}
