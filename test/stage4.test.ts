import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { makeContext } from "../src/server.js";
import { invokeTool } from "../src/tools/registry.js";
import { getClients } from "../src/tools/clients.js";
import { getUsageStats } from "../src/tools/usage.js";
import { UsageStore } from "../src/usage.js";
import { fakeApi } from "./fake-api.js";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createWebApp } from "../src/web/app.js";
import type { AddressInfo } from "node:net";

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

test("legacy database migrates idempotently without claiming tokens and local MCP remains valid", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tally-migration-")), path = join(dir, "usage.sqlite");
  const oldToken = "aimcp_legacy-test-token";
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, label TEXT NOT NULL, prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), last_used_at TEXT, revoked_at TEXT);
    CREATE TABLE tool_calls (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')), caller TEXT NOT NULL, source TEXT NOT NULL, tool TEXT NOT NULL, args TEXT NOT NULL, duration_ms INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT);`);
  db.prepare("INSERT INTO api_tokens (email,label,prefix,token_hash) VALUES (?,?,?,?)").run("person@feedmob.com", "legacy", "aimcp_legacy", createHash("sha256").update(oldToken).digest("hex"));
  db.prepare("INSERT INTO tool_calls (caller,source,tool,args,duration_ms,ok) VALUES (?,?,?,?,?,?)").run("person@feedmob.com", "dashboard", "whoami", "{}", 1, 1);
  db.close();
  try {
    for (let i = 0; i < 2; i++) {
      const store = new UsageStore(path);
      assert.ok(store.calls().some(row => row.source === "dashboard" && row.caller === "person@feedmob.com")); assert.equal(store.tokens("person@feedmob.com").length, 1);
      assert.equal(store.resolveToken(oldToken, true), undefined);
      assert.deepEqual(store.tokens({ issuer: "https://accounts.google.com", subject: "subject-A", email: "person@feedmob.com" }), []);
      assert.equal(store.resolveToken(oldToken), "person@feedmob.com");
      if (i === 0) {
        const server = createWebApp(cfg, { accessToken: "local-test-token-1234", usage: store });
        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        try {
          const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
          const r = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${oldToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }) });
          assert.equal(r.status, 200);
        } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
      }
      store.close();
    }
    const check = new DatabaseSync(path);
    const row = check.prepare("SELECT issuer,subject,revoked_at FROM api_tokens WHERE id=1").get() as any;
    assert.equal(row.issuer, null); assert.equal(row.subject, null); assert.equal(row.revoked_at, null); check.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
