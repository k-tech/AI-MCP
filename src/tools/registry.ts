// One definition per tool, used by both the MCP server and the human console.
import { z, type ZodRawShape } from "zod";
import type { Config } from "../config.js";
import type { ApiClient } from "../http.js";
import type { Source, UsageStore } from "../usage.js";

export interface ToolContext {
  cfg: Config;
  /** Read environment, GET only. */
  api: ApiClient;
  /** Write environment: write tools use it for their writes AND their lookups, so IDs match. */
  writeApi: ApiClient;
  caller: string; source: Source; usage?: UsageStore;
}
export interface ToolResult { summary: string; data?: unknown; isError?: boolean }
export interface ToolDef<S extends ZodRawShape = ZodRawShape> {
  name: string;
  title: string;          // short Chinese label for the console
  description: string;    // for the model
  write: boolean;         // writes data → only registered when ENABLE_WRITE=true
  stage: 1 | 2 | 3 | 4;
  schema: S;
  run(args: z.infer<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolResult>;
}
export const defineTool = <S extends ZodRawShape>(def: ToolDef<S>) => def as unknown as ToolDef;

export interface Invocation extends ToolResult { ok: boolean; ms: number; tool: string }

/** Validate, run, time and log one tool call. Never throws. */
export async function invokeTool(def: ToolDef, rawArgs: unknown, ctx: ToolContext): Promise<Invocation> {
  const t0 = performance.now();
  let out: ToolResult;
  const parsed = z.object(def.schema).strict().safeParse(rawArgs ?? {});
  if (!parsed.success) {
    out = { summary: `参数错误：${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}`, isError: true };
  } else {
    try { out = await def.run(parsed.data, ctx); }
    catch (e) { out = { summary: (e as Error).message || "未知错误", isError: true }; }
  }
  const ms = Math.round(performance.now() - t0);
  const loggedArgs = def.name === "preview_supplied_spend_report" && rawArgs && typeof rawArgs === "object" ? { ...rawArgs, csv_text: "[redacted]" } : rawArgs;
  try { ctx.usage?.record({ caller: ctx.caller, source: ctx.source, tool: def.name, args: loggedArgs, durationMs: ms, ok: !out.isError, error: out.isError ? out.summary : undefined }); }
  catch (e) { console.error("usage log failed:", (e as Error).message); }
  return { ...out, ok: !out.isError, ms, tool: def.name };
}

/** Text rendering for MCP clients: summary line + JSON block. */
export function toMcpContent(r: Invocation) {
  const text = r.data === undefined ? r.summary : `${r.summary}\n\`\`\`json\n${JSON.stringify(r.data, null, 2)}\n\`\`\``;
  return { content: [{ type: "text" as const, text }], ...(r.isError ? { isError: true } : {}) };
}
