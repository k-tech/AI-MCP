import { parse } from "csv-parse/sync";
import { z } from "zod";

const HEADERS = ["date", "app-id", "agency", "media-source", "campaign-id", "campaign", "geo", "currency", "spend", "adset", "ad"];
const SCALE = 10n ** 12n;
const day = (s: string) => z.string().date().safeParse(s).success;
const amount = (s: string): bigint | null => {
  const m = /^(-?)(\d{1,20})(?:\.(\d{1,12}))?$/.exec(s);
  if (!m) return null;
  return (m[1] ? -1n : 1n) * (BigInt(m[2]) * SCALE + BigInt((m[3] ?? "").padEnd(12, "0")));
};
const formatted = (v: bigint) => {
  const sign = v < 0n ? "-" : "", n = v < 0n ? -v : v;
  const fraction = (n % SCALE).toString().padStart(12, "0").replace(/0+$/, "");
  return `${sign}${n / SCALE}${fraction ? "." + fraction : ""}`;
};

/** Only validates supplied text; does not read files, call an API, save, upload or send. */
export function preflightChime(input: unknown) {
  const schema = z.object({ target_date: z.string().date(), files: z.array(z.object({ name: z.string().min(1).max(200), csv_text: z.string().min(1).max(800_000) }).strict()).min(1).max(10) }).strict();
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new Error("请选择有效日期和 1 到 10 个非空 CSV 文件");
  const { target_date, files } = parsed.data;
  if (files.reduce((n, f) => n + Buffer.byteLength(f.csv_text, "utf8"), 0) > 800_000) throw new Error("CSV 总大小超过 800,000 字节");
  const totals = new Map<string, bigint>();
  let rowCount = 0, issueCount = 0;
  const issues: string[] = [], seen = new Set<string>();
  const issue = (s: string) => { issueCount++; if (issues.length < 50) issues.push(s); };
  const results = files.map((file, fileIndex) => {
    if (file.csv_text.includes("\uFFFD")) issue(`文件 ${fileIndex + 1}：文本可能不是有效 UTF-8，请核实编码`);
    let records: string[][];
    try { records = parse(file.csv_text, { bom: true, skip_empty_lines: true, relax_column_count: false, max_record_size: 100_000 }); }
    catch { issue(`文件 ${fileIndex + 1}：CSV 格式或列数无效`); return { name: file.name, rows: 0 }; }
    if (!records.length || records[0].length !== HEADERS.length || HEADERS.some((h, i) => records[0][i] !== h)) {
      issue(`文件 ${fileIndex + 1}：表头必须为指定的 11 列且顺序一致`); return { name: file.name, rows: 0 };
    }
    if (records.length === 1) issue(`文件 ${fileIndex + 1}：没有数据行`);
    for (const [index, row] of records.slice(1).entries()) {
      rowCount++;
      const at = `文件 ${fileIndex + 1} 第 ${index + 2} 行`;
      const date = row[0].trim(), currency = row[7].trim(), spend = amount(row[8].trim());
      if (!day(date)) issue(`${at}：日期无效，需 YYYY-MM-DD`);
      else if (date !== target_date) issue(`${at}：日期与目标日期不一致`);
      if (!/^[A-Z]{3}$/.test(currency)) issue(`${at}：币种需为三位大写字母，仍须核实实际币种`);
      if (spend === null) issue(`${at}：spend 数值无效或超出检查范围`);
      else if (spend < 0n) issue(`${at}：spend 为负数，请核实调整`);
      if (row.some((v, i) => ![0, 7, 8].includes(i) && !v.trim())) issue(`${at}：存在空的标识字段，请核实`);
      const key = JSON.stringify(row);
      if (seen.has(key)) issue(`${at}：存在完全重复行，请核实`); else seen.add(key);
      if (/^[A-Z]{3}$/.test(currency) && spend !== null) totals.set(currency, (totals.get(currency) ?? 0n) + spend);
    }
    return { name: file.name, rows: records.length - 1 };
  });
  return { target_date, files: results, rows: rowCount, totals: [...totals].map(([currency, value]) => ({ currency, spend: formatted(value) })), issue_count: issueCount, issues, notice: "仅按所提供文件做结构检查；币种合计含有效金额，问题行可能被计入或排除。不能证明来源完整、口径正确、金额匹配或可发送。" };
}
