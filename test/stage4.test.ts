import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeContext } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { getClients } from "../src/tools/clients.js";
import { getUsageStats } from "../src/tools/usage.js";
import { UsageStore } from "../src/usage.js";
import { fakeApi } from "./fake-api.js";

const cfg = loadConfig({ FEEDMOB_API_BASE: "https://api.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "svc@feedmob.com" });

test("every tool call is logged with caller, source, duration and outcome", async () => {
  const usage = new UsageStore();
  const ok = fakeApi({ "GET /ai/api/clients": () => [200, [{ id: 1, name: "Uber" }]] });
  const bad = fakeApi({ "GET /ai/api/clients": () => [401, {}] });
  await invokeTool(getClients, { client_name: "Uber" }, makeContext(cfg, { fetchImpl: ok.fetchImpl, caller: "amy@feedmob.com", source: "dashboard", usage }));
  await invokeTool(getClients, {}, makeContext(cfg, { fetchImpl: ok.fetchImpl, caller: "bob@feedmob.com", source: "mcp-http", usage }));
  await invokeTool(getClients, {}, makeContext(cfg, { fetchImpl: bad.fetchImpl, caller: "bob@feedmob.com", source: "mcp-http", usage }));
  const calls = usage.calls();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].caller, "amy@feedmob.com"); assert.equal(calls[2].source, "dashboard"); assert.equal(calls[2].args, '{"client_name":"Uber"}');
  assert.equal(calls[0].ok, 0); assert.match(calls[0].error ?? "", /Unauthorized/);
  const s = usage.summary("2000-01-01");
  assert.equal(s.total, 3); assert.equal(s.failed, 1); assert.equal(s.users, 2);
  assert.deepEqual(s.byCaller.map((r) => [r.caller, r.n]), [["bob@feedmob.com", 2], ["amy@feedmob.com", 1]]);
});

test("get_usage_stats tool reports the numbers", async () => {
  const usage = new UsageStore();
  const ctx = makeContext(cfg, { fetchImpl: fakeApi({ "GET /ai/api/clients": () => [200, []] }).fetchImpl, caller: "amy@feedmob.com", usage });
  await invokeTool(getClients, {}, ctx); await invokeTool(getClients, {}, ctx);
  const r = await invokeTool(getUsageStats, { days: 1 }, ctx);
  assert.equal(r.ok, true); assert.match(r.summary, /2 次调用，1 人/);
});

test("personal tokens: issue, resolve, revoke; only hash stored", () => {
  const usage = new UsageStore();
  const { token, row } = usage.issueToken("amy@feedmob.com", "笔记本");
  assert.match(token, /^aimcp_[0-9a-f]{48}$/); assert.equal(row.prefix, token.slice(0, 12));
  assert.equal(usage.resolveToken(token), "amy@feedmob.com");
  assert.equal(usage.resolveToken(token + "x"), undefined);
  assert.equal(usage.revokeToken("bob@feedmob.com", row.id), false, "others cannot revoke");
  assert.equal(usage.revokeToken("amy@feedmob.com", row.id), true);
  assert.equal(usage.resolveToken(token), undefined);
  assert.ok(usage.tokens("amy@feedmob.com")[0].last_used_at);
});
