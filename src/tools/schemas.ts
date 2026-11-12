import { z } from "zod";

export const date = (what = "日期") => z.string().date().describe(`${what}，格式 YYYY-MM-DD`);
/** Amount >= 0: number or numeric string (e.g. "125.50"). */
export const amount = z.union([
  z.number().finite().nonnegative(),
  z.string().trim().regex(/^\+?(?:\d+(?:\.\d*)?|\.\d+)$/, "必须是 >= 0 的数字"),
]);
/** Integer >= 0: number or integer string. */
export const count = z.union([z.number().int().nonnegative(), z.string().trim().regex(/^\+?\d+$/, "必须是 >= 0 的整数")]);
/** Rate (net/gross CPI): >= 0 or "N/A" for dynamic. */
export const rate = z.union([amount, z.literal("N/A")]);
/** Margin %: any finite number (may be negative) or "N/A". */
export const margin = z.union([z.number().finite(), z.string().trim().regex(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/, "必须是数字"), z.literal("N/A")]);

export function assertRange(start: string, end: string, maxDays = 366) {
  const days = (Date.parse(end) - Date.parse(start)) / 86_400_000;
  if (days < 0) throw new Error("结束日期不能早于开始日期");
  if (days > maxDays) throw new Error(`日期范围不能超过 ${maxDays} 天`);
}
export const round2 = (n: number) => Math.round(n * 100) / 100;
