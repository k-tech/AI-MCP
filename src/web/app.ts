// One HTTP app serving both entry points of the project:
//   /mcp          Streamable HTTP MCP endpoint (Bearer: personal aimcp_ token ONLY; every call is attributed to a person)
//   /dashboard/   human console (Google team login or isolated local login, cookie session)
//   /api/*        JSON API used by the console
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isFeedmobEmail, type Config } from "../config.js";
import type { FetchLike } from "../http.js";
import { createServer as createMcpServer, makeContext, toolsFor, ALL_TOOLS, VERSION } from "../server.js";
import { invokeTool } from "../tools/registry.js";
import type { UsageStore, VerifiedTokenOwner } from "../usage.js";
import { GoogleLogin, type GoogleTransaction } from "./google-auth.js";
import { preflightChime } from "./chime-preflight.js";

const WEB_DIR = fileURLToPath(new URL("../../../web/", import.meta.url));
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE = "aimcp_sid";
// JSON.stringify can expand a CSV byte to six bytes (e.g. a control character),
// plus up to ten escaped 200-character filenames and JSON envelope overhead.
const CHIME_JSON_LIMIT = 4_820_000;

const PUBLIC_ASSETS: Record<string, [string, string]> = {
  "/assets/style.css": ["style.css", "text/css; charset=utf-8"],
  "/assets/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/assets/login.js": ["login.js", "text/javascript; charset=utf-8"],
};

export interface WebAppOptions { accessToken: string; fetchImpl?: FetchLike; usage?: UsageStore; now?: () => number; googleLogin?: GoogleLogin }
interface Session { email: string; expires: number; identity?: VerifiedTokenOwner }

export function createWebApp(cfg: Config, opts: WebAppOptions): Server {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const sessions = new Map<string, Session>();
  const transactions = new Map<string, GoogleTransaction>();
  const google = opts.googleLogin;
  const origin = google ? new URL(google.settings.callbackUrl).origin : null;
  const { usage } = opts;
  const available = toolsFor(cfg);

  // JSON schemas of the tools, produced by the MCP SDK (same thing Claude sees).
  // Built with writes on so disabled write tools can still be previewed; calls are still gated by `available`.
  const schemasReady = (async () => {
    const server = createMcpServer({ ...cfg, enableWrite: true }, { fetchImpl: opts.fetchImpl });
    const client = new Client({ name: "dashboard", version: VERSION });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const { tools } = await client.listTools();
    await client.close();
    return new Map(tools.map((t) => [t.name, t.inputSchema]));
  })();

  const sharedTokenOk = (given: string) => {
    const g = Buffer.from(given), w = Buffer.from(opts.accessToken);
    return g.length === w.length && timingSafeEqual(g, w);
  };
  /** Who is calling /mcp: only the owner of a valid personal token. The shared access token is for console login only. */
  const mcpCaller = (req: IncomingMessage): { caller?: string; hint?: string } => {
    const token = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
    if (!token) return {};
    if (sharedTokenOk(token)) return { hint: "共享访问令牌不能再用于 MCP。请在控制台“我的 MCP 令牌”页生成个人令牌。" };
    const caller = usage?.resolveToken(token, !!google);
    return caller ? { caller } : { hint: google ? "令牌无效、已吊销或未绑定已验证身份；请通过 Google 登录后重新签发个人令牌。" : undefined };
  };
  const session = (req: IncomingMessage): Session | undefined => {
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    const s = sid ? sessions.get(sid) : undefined;
    if (s && s.expires > now()) return s;
    if (sid) sessions.delete(sid);
    return undefined;
  };

  return createHttpServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    try {
      if (path === "/health") return json(res, 200, { ok: true });
      if (path === "/favicon.ico") { res.writeHead(204); return res.end(); }
      if (path === "/") return redirect(res, "/dashboard/");

      // ---- MCP endpoint ----
      if (path === "/mcp") {
        const { caller, hint } = mcpCaller(req);
        if (!caller) return json(res, 401, { error: "Unauthorized", ...(hint ? { hint } : {}) });
        if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }); return res.end(); }
        const body = await readJson(req);
        const server = createMcpServer(cfg, { fetchImpl: opts.fetchImpl, caller, source: "mcp-http", usage });
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        return await transport.handleRequest(req, res, body);
      }

      // ---- public pages / assets ----
      if (path in PUBLIC_ASSETS) return file(res, ...PUBLIC_ASSETS[path]);
      if (path === "/login") return session(req) ? redirect(res, "/dashboard/") : file(res, google ? "login-team.html" : "login.html", "text/html; charset=utf-8");

      if (google && req.method === "POST" && path !== "/mcp" && req.headers.origin !== origin) return json(res, 403, { error: "请求来源无效" });
      if (google && path === "/auth/google/start" && req.method === "POST") {
        for (const [key, value] of transactions) if (value.expires <= now()) transactions.delete(key);
        const { transaction, url: authUrl } = google.start(now());
        const id = randomBytes(32).toString("base64url");
        transactions.set(id, transaction);
        res.setHeader("Set-Cookie", `aimcp_login=${id}; HttpOnly; Secure; SameSite=Lax; Path=/auth/google/callback; Max-Age=300`);
        return redirect(res, authUrl);
      }
      if (google && path === "/auth/google/callback" && req.method === "GET") {
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Cache-Control", "no-store");
        const id = parseCookies(req.headers.cookie).aimcp_login;
        const tx = id ? transactions.get(id) : undefined;
        if (id) transactions.delete(id);
        res.setHeader("Set-Cookie", "aimcp_login=; HttpOnly; Secure; SameSite=Lax; Path=/auth/google/callback; Max-Age=0");
        if (!tx || tx.expires <= now() || url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== tx.state || url.searchParams.getAll("code").length !== 1 || !url.searchParams.get("code") || url.searchParams.has("error")) return json(res, 403, { error: "登录验证失败，请重新登录" });
        try {
          const identity = await google.finish(url.searchParams.get("code")!, tx);
          const sid = randomBytes(32).toString("hex");
          sessions.set(sid, { email: identity.email, identity, expires: now() + SESSION_TTL_MS });
          res.setHeader("Set-Cookie", ["aimcp_login=; HttpOnly; Secure; SameSite=Lax; Path=/auth/google/callback; Max-Age=0", `${COOKIE}=${sid}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`]);
          res.setHeader("Referrer-Policy", "no-referrer");
          return redirect(res, "/dashboard/");
        } catch { return json(res, 403, { error: "登录验证失败，请重新登录" }); }
      }

      if (path === "/api/login" && req.method === "POST") {
        if (google) return json(res, 403, { error: "团队模式仅支持 Google 登录" });
        const { email = "", token = "" } = (await readJson(req)) as { email?: string; token?: string };
        const mail = String(email).trim().toLowerCase();
        if (!isFeedmobEmail(mail)) return json(res, 403, { error: "只允许 @feedmob.com 邮箱登录" });
        if (!sharedTokenOk(String(token).trim())) return json(res, 401, { error: "访问令牌不正确" });
        const sid = randomBytes(24).toString("hex");
        sessions.set(sid, { email: mail, expires: now() + SESSION_TTL_MS });
        const secure = req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
        res.setHeader("Set-Cookie", `${COOKIE}=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure}`);
        return json(res, 200, { email: mail });
      }

      // ---- everything below requires a session ----
      const s = session(req);
      if (path === "/dashboard") return redirect(res, "/dashboard/");
      if (path === "/dashboard/") return s ? file(res, "dashboard.html", "text/html; charset=utf-8") : redirect(res, "/login");
      if (!path.startsWith("/api/")) return json(res, 404, { error: "Not Found" });
      if (!s) return json(res, 401, { error: "请先登录" });
      const ctx = makeContext(cfg, { fetchImpl: opts.fetchImpl, caller: s.email, source: "dashboard", usage });

      if (path === "/api/chime/preflight" && req.method === "POST") return json(res, 200, preflightChime(await readJson(req, CHIME_JSON_LIMIT)));

      if (path === "/api/logout" && req.method === "POST") {
        const sid = parseCookies(req.headers.cookie)[COOKIE]; if (sid) sessions.delete(sid);
        res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${google ? "; Secure" : ""}`);
        return json(res, 200, { ok: true });
      }
      if (path === "/api/me") return json(res, 200, { email: s.email, expiresAt: new Date(s.expires).toISOString() });
      if (path === "/api/status") {
        return json(res, 200, {
          version: VERSION, startedAt: new Date(startedAt).toISOString(), uptimeSec: Math.round((now() - startedAt) / 1000),
          serverIdentity: cfg.userEmail, apiBase: cfg.readApiBase, readApiBase: cfg.readApiBase, writeApiBase: cfg.apiBase, apiKey: `${cfg.readKey.slice(0, 4)}***`,
          mockApi: /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(cfg.readApiBase),
          writeEnabled: cfg.enableWrite, usageEnabled: !!usage,
          toolCount: available.length, hiddenWriteTools: ALL_TOOLS.length - available.length,
          activeSessions: [...sessions.values()].filter((x) => x.expires > now()).length,
        });
      }
      if (path === "/api/upstream-check") {
        const t0 = now();
        const r = await invokeTool(available.find((t) => t.name === "get_clients")!, { client_name: "__health_check__" }, { ...ctx, usage: undefined });
        return json(res, 200, { ok: r.ok, ms: now() - t0, error: r.ok ? undefined : r.summary });
      }
      if (path === "/api/tools" && req.method === "GET") {
        const schemas = await schemasReady;
        return json(res, 200, {
          tools: ALL_TOOLS.map((t) => ({ name: t.name, title: t.title, description: t.description, stage: t.stage, write: t.write,
            enabled: available.includes(t), inputSchema: schemas.get(t.name) ?? null })),
        });
      }
      if (path === "/api/tools/call" && req.method === "POST") {
        const { name, arguments: args = {} } = (await readJson(req)) as { name?: string; arguments?: Record<string, unknown> };
        const def = available.find((t) => t.name === name);
        if (!def) return json(res, 404, { error: ALL_TOOLS.some((t) => t.name === name) ? "写入工具未开启（需要 ENABLE_WRITE=true）" : `没有这个工具：${name}` });
        return json(res, 200, await invokeTool(def, args, ctx));
      }

      // ---- usage (stage 4) ----
      if (path.startsWith("/api/usage") || path.startsWith("/api/tokens")) {
        if (!usage) return json(res, 503, { error: "使用记录未开启" });
        if (google && !s.identity) return json(res, 403, { error: "需要已验证的身份" });
        const owner = google ? s.identity! : s.email;
        const days = Math.min(Math.max(Number(url.searchParams.get("days")) || 7, 1), 365);
        const since = new Date(now() - days * 86_400_000).toISOString();
        if (path === "/api/usage/summary") return json(res, 200, { days, ...usage.summary(since) });
        if (path === "/api/usage/calls") {
          return json(res, 200, { calls: usage.calls({ since, limit: Number(url.searchParams.get("limit")) || 100,
            caller: url.searchParams.get("caller") || undefined, tool: url.searchParams.get("tool") || undefined }) });
        }
        if (path === "/api/tokens" && req.method === "GET") return json(res, 200, { tokens: usage.tokens(owner) });
        if (path === "/api/tokens" && req.method === "POST") {
          const { label = "" } = (await readJson(req)) as { label?: string };
          const { token, row } = usage.issueToken(owner, String(label).trim());
          return json(res, 200, { token, row });
        }
        if (path === "/api/tokens/revoke" && req.method === "POST") {
          const { id } = (await readJson(req)) as { id?: number };
          return usage.revokeToken(owner, Number(id)) ? json(res, 200, { ok: true }) : json(res, 404, { error: "令牌不存在或已吊销" });
        }
      }
      return json(res, 404, { error: "Not Found" });
    } catch (e) {
      console.error("web error:", (e as Error).message);
      if (!res.headersSent) json(res, 400, { error: (e as Error).message });
    }
  });
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return out;
}
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
function redirect(res: ServerResponse, to: string) { res.writeHead(302, { Location: to }); res.end(); }
async function file(res: ServerResponse, name: string, type: string) {
  const body = await readFile(join(WEB_DIR, name));
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", "X-Frame-Options": "DENY", "X-Content-Type-Options": "nosniff" });
  res.end(body);
}
async function readJson(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > maxBytes) throw new Error("请求体过大"); chunks.push(c as Buffer); }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new Error("请求体不是合法 JSON"); }
}
