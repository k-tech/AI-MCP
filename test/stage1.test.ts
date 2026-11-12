import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { generateToken } from "../src/auth.js";
import { createServer } from "../src/server.js";

const env = { FEEDMOB_API_BASE: "https://api.test/", FEEDMOB_KEY: "k123456", FEEDMOB_SECRET: "s3cret", FEEDMOB_USER_EMAIL: "Leo@FeedMob.com" };

test("config: valid env is normalised", () => {
  const c = loadConfig(env);
  assert.equal(c.apiBase, "https://api.test");
  assert.equal(c.userEmail, "leo@feedmob.com");
});

test("config: rejects non-feedmob email and missing vars", () => {
  assert.throws(() => loadConfig({ ...env, FEEDMOB_USER_EMAIL: "x@gmail.com" }), /@feedmob\.com/);
  assert.throws(() => loadConfig({}), /FEEDMOB_KEY is required[\s\S]*FEEDMOB_SECRET is required/);
});

test("auth: JWT is HS256 with key and 7-day expiry", () => {
  const t = generateToken("k", "s", new Date("2026-11-11T00:00:00Z"));
  const [h, p, s] = t.split(".");
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url").toString()), { alg: "HS256", typ: "JWT" });
  assert.deepEqual(JSON.parse(Buffer.from(p, "base64url").toString()), { key: "k", expired_at: "2026-11-18" });
  assert.equal(s, createHmac("sha256", "s").update(`${h}.${p}`).digest("base64url"));
});

async function connect(fetchImpl: typeof fetch) {
  const server = createServer(loadConfig(env), { fetchImpl });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

test("tools: whoami returns caller and hides secret", async () => {
  const client = await connect(fetch);
  const r: any = await client.callTool({ name: "whoami", arguments: {} });
  const text = r.content[0].text as string;
  assert.match(text, /leo@feedmob\.com/);
  assert.doesNotMatch(text, /s3cret/);
});

test("tools: get_clients sends auth headers and query", async () => {
  let seen: { url?: string; headers?: Record<string, string> } = {};
  const fake: typeof fetch = async (url, init) => {
    seen = { url: String(url), headers: init?.headers as Record<string, string> };
    return new Response(JSON.stringify([{ id: 1, name: "Uber Technologies" }]), { status: 200 });
  };
  const client = await connect(fake);
  const r: any = await client.callTool({ name: "get_clients", arguments: { client_name: "Uber" } });
  assert.equal(seen.url, "https://api.test/ai/api/clients?client_name=Uber");
  assert.equal(seen.headers?.["FEEDMOB-KEY"], "k123456");
  assert.ok(seen.headers?.["FEEDMOB-TOKEN"].split(".").length === 3);
  assert.match(r.content[0].text, /Uber Technologies/);
  assert.notEqual(r.isError, true);
});

test("tools: get_clients surfaces 401 as tool error", async () => {
  const client = await connect(async () => new Response("{}", { status: 401 }));
  const r: any = await client.callTool({ name: "get_clients", arguments: {} });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Unauthorized/);
});
