import { defineTool } from "./registry.js";
import { VERSION } from "../version.js";

export const whoami = defineTool({
  name: "whoami", title: "我是谁", stage: 1, write: false, schema: {},
  description: "Show the caller identity, API environment and whether write tools are enabled (no secrets).",
  async run(_args, ctx) {
    return {
      summary: `当前调用人 ${ctx.caller}（来源 ${ctx.source}）`,
      data: { server: "tally", version: VERSION, caller: ctx.caller, source: ctx.source, readApiBase: ctx.cfg.readApiBase, writeApiBase: ctx.cfg.apiBase, apiKey: `${ctx.cfg.key.slice(0, 4)}***`, writeEnabled: ctx.cfg.enableWrite },
    };
  },
});
