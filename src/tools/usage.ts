// Stage 4: usage statistics as an MCP tool.
import { z } from "zod";
import { defineTool } from "./registry.js";

export const getUsageStats = defineTool({
  name: "get_usage_stats", title: "使用统计", stage: 4, write: false,
  description: "Usage statistics of this MCP server: calls per tool, per person and per day, failure counts, plus the most recent calls.",
  schema: {
    days: z.coerce.number().int().min(1).max(365).optional().describe("Look-back window in days (default 7)"),
    caller: z.string().optional().describe("Only this person's calls (email)"),
    tool: z.string().optional().describe("Only this tool"),
  },
  async run({ days = 7, caller, tool }, { usage }) {
    if (!usage) throw new Error("这个运行方式没有开启使用记录（设置 USAGE_DB 可开启）");
    const since = new Date(Date.now() - days * 86_400_000).toISOString();
    const s = usage.summary(since);
    const recent = usage.calls({ limit: 20, caller, tool, since }).map(({ ts, caller, source, tool, duration_ms, ok, error }) => ({ ts, caller, source, tool, duration_ms, ok: !!ok, error }));
    return { summary: `最近 ${days} 天：${s.total} 次调用，${s.users} 人，失败 ${s.failed} 次`, data: { ...s, recent } };
  },
});
