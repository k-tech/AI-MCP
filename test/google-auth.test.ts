import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { OAuth2Client } from "google-auth-library";
import { spawnSync } from "node:child_process";
import { GoogleLogin } from "../src/web/google-auth.js";
import { loadConfig } from "../src/config.js";
import { createWebApp } from "../src/web/app.js";
import { UsageStore } from "../src/usage.js";
import { fakeApi } from "./fake-api.js";

const settings = { clientId: "synthetic-client", clientSecret: "synthetic-secret", callbackUrl: "https://tally.example/auth/google/callback" };
const cfg = loadConfig({ FEEDMOB_API_BASE: "https://fake.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "svc@feedmob.com" });
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const jwt = (claims: Record<string, unknown>, badSignature = false) => {
  const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const payload = `${b64({ alg: "RS256", kid: "test" })}.${b64(claims)}`;
  return `${payload}.${createSign("RSA-SHA256").update(payload).sign(badSignature ? other.privateKey : keys.privateKey).toString("base64url")}`;
};

test("team mode verifies signed provider identity, binds browser state and preserves MCP tokens", async () => {
  const client = new OAuth2Client(settings.clientId, settings.clientSecret, settings.callbackUrl);
  let token = "", expectedChallenge = "";
  (client as any).getFederatedSignonCertsAsync = async () => ({ certs: { test: publicKey }, format: "PEM" });
  (client as any).getToken = async (options: any) => {
    assert.equal(createHash("sha256").update(options.codeVerifier).digest("base64url"), expectedChallenge);
    assert.equal(options.redirect_uri, settings.callbackUrl);
    return { tokens: { id_token: token } };
  };
  const store = new UsageStore();
  let clock = Date.now();
  const old = store.issueToken("existing@feedmob.com", "existing").token;
  const api = fakeApi({ "GET /ai/api/clients": () => [200, []] });
  const server = createWebApp({ ...cfg, enableWrite: true }, { accessToken: "shared-local-token", googleLogin: new GoogleLogin(settings, client), usage: store, fetchImpl: api.fetchImpl, now: () => clock });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, data: unknown, origin = "https://tally.example", cookie = "") => fetch(base + path, { method: "POST", headers: { origin, cookie, "content-type": "application/json" }, body: JSON.stringify(data), redirect: "manual" });
  const start = async () => {
    const r = await post("/auth/google/start", {}); assert.equal(r.status, 302);
    const cookie = r.headers.get("set-cookie")!; assert.match(cookie, /HttpOnly/); assert.match(cookie, /Secure/); assert.match(cookie, /SameSite=Lax/);
    const url = new URL(r.headers.get("location")!); expectedChallenge = url.searchParams.get("code_challenge")!;
    assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("hd"), "feedmob.com");
    return { cookie: cookie.split(";")[0], state: url.searchParams.get("state")!, nonce: url.searchParams.get("nonce")! };
  };
  const callback = (state: string, cookie: string) => fetch(base + `/auth/google/callback?code=synthetic&state=${encodeURIComponent(state)}`, { headers: { cookie }, redirect: "manual" });
  const claims = (nonce: string) => ({ iss: "https://accounts.google.com", aud: settings.clientId, sub: "synthetic-sub", email: "person@feedmob.com", email_verified: true, hd: "feedmob.com", nonce, iat: Math.floor(Date.now() / 1000) - 1, exp: Math.floor(Date.now() / 1000) + 600 });
  try {
    assert.equal((await post("/auth/google/start", {}, "https://evil.example")).status, 403);
    assert.equal((await post("/auth/google/start", {}, "")).status, 403);
    assert.equal((await post("/api/login", { email: "person@feedmob.com", token: "shared-local-token" })).status, 403);
    let tx = await start(); token = jwt(claims(tx.nonce));
    assert.equal((await callback(tx.state, "")).status, 403);
    assert.equal((await callback("wrong", tx.cookie)).status, 403);
    assert.equal((await callback(tx.state, tx.cookie)).status, 403);
    tx = await start(); token = jwt(claims(tx.nonce)); clock += 300_001; assert.equal((await callback(tx.state, tx.cookie)).status, 403);
    for (const change of [{ iss: "https://evil.example" }, { aud: "other" }, { azp: "other" }, { exp: Math.floor(Date.now() / 1000) - 1 }, { nonce: "wrong" }, { hd: "other.com" }, { hd: undefined }, { email_verified: false }, { email: "person@other.com" }, { sub: undefined }]) {
      tx = await start(); token = jwt({ ...claims(tx.nonce), ...change }); assert.equal((await callback(tx.state, tx.cookie)).status, 403, JSON.stringify(change));
    }
    tx = await start(); token = jwt(claims(tx.nonce), true); assert.equal((await callback(tx.state, tx.cookie)).status, 403);
    tx = await start(); token = jwt(claims(tx.nonce));
    const ok = await callback(tx.state, tx.cookie); assert.equal(ok.status, 302); assert.equal(ok.headers.get("location"), "/dashboard/");
    const setCookie = ok.headers.get("set-cookie")!; assert.match(setCookie, /aimcp_sid=.*Secure/); assert.match(setCookie, /HttpOnly/);
    const sid = setCookie.match(/aimcp_sid=[^;,]+/)![0];
    const me = await (await fetch(base + "/api/me", { headers: { cookie: sid } })).json() as any; assert.equal(me.email, "person@feedmob.com");
    assert.equal((await post("/api/tools/call", { name: "get_clients" }, "https://evil.example", sid)).status, 403);
    assert.equal((await post("/api/tools/call", { name: "get_clients" }, "https://tally.example", sid)).status, 200);
    assert.equal(store.calls({ limit: 1 })[0].caller, "person@feedmob.com");
    const issued = await (await post("/api/tokens", { label: "verified user" }, "https://tally.example", sid)).json() as any;
    assert.equal(store.resolveToken(issued.token, true), "person@feedmob.com");
    assert.deepEqual(store.tokens("person@feedmob.com"), []); assert.equal(store.revokeToken("person@feedmob.com", issued.row.id), false);
    const seenBefore = api.seen.length;
    const callsBefore = store.calls().length;
    const mcp = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${old}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "create_direct_spend", arguments: {} } }) });
    assert.equal(mcp.status, 401); assert.match((await mcp.json() as any).hint, /重新签发/); assert.equal(api.seen.length, seenBefore); assert.equal(store.calls().length, callsBefore);
    const allowed = await fetch(base + "/mcp", { method: "POST", headers: { authorization: `Bearer ${issued.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "whoami", arguments: {} } }) });
    assert.equal(allowed.status, 200); assert.equal(store.calls({ limit: 1 })[0].caller, "person@feedmob.com");
    // Same email with a different verified subject cannot list or revoke this token.
    tx = await start(); token = jwt({ ...claims(tx.nonce), sub: "another-sub" });
    const otherLogin = await callback(tx.state, tx.cookie); const otherSid = otherLogin.headers.get("set-cookie")!.match(/aimcp_sid=[^;,]+/)![0];
    const listOther = await (await fetch(base + "/api/tokens", { headers: { cookie: otherSid } })).json() as any;
    assert.deepEqual(listOther.tokens, []);
    assert.equal((await post("/api/tokens/revoke", { id: issued.row.id }, "https://tally.example", otherSid)).status, 404);
    // The same verified subject retains ownership if its provider email changes.
    tx = await start(); token = jwt({ ...claims(tx.nonce), email: "renamed@feedmob.com" });
    const renamed = await callback(tx.state, tx.cookie); const renamedSid = renamed.headers.get("set-cookie")!.match(/aimcp_sid=[^;,]+/)![0];
    const listRenamed = await (await fetch(base + "/api/tokens", { headers: { cookie: renamedSid } })).json() as any;
    assert.equal(listRenamed.tokens.length, 1); assert.equal(listRenamed.tokens[0].id, issued.row.id); assert.equal(listRenamed.tokens[0].email, "person@feedmob.com");
    assert.equal((await post("/api/tokens/revoke", { id: issued.row.id }, "https://tally.example", renamedSid)).status, 200);
    assert.equal(store.resolveToken(issued.token, true), undefined);
    assert.equal((await callback(tx.state, tx.cookie)).status, 403);
  } finally { server.close(); store.close(); }
});

test("team mode rejects missing or unsafe callback configuration", () => {
  for (const callbackUrl of ["http://tally.example/auth/google/callback", "https://tally.example/other", "https://tally.example/auth/google/callback?x=1", "not-a-url"]) assert.throws(() => new GoogleLogin({ ...settings, callbackUrl }));
  assert.throws(() => new GoogleLogin({ ...settings, clientSecret: "" }));
  const env = { FEEDMOB_API_BASE: "https://fake.test", FEEDMOB_KEY: "k", FEEDMOB_SECRET: "s", FEEDMOB_USER_EMAIL: "svc@feedmob.com" };
  for (const extra of [{}, { TALLY_AUTH_MODE: "google" }, { TALLY_AUTH_MODE: "invalid" }]) {
    const p = spawnSync(process.execPath, [new URL("../src/http-server.js", import.meta.url).pathname], { env: { ...env, ...extra }, encoding: "utf8", timeout: 3000 });
    assert.equal(p.status, 1); assert.match(p.stderr, /TALLY_AUTH_MODE|Google client/);
  }
});
