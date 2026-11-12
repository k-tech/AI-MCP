import { generateToken } from "./auth.js";
import type { Config } from "./config.js";

export type FetchLike = typeof fetch;
export type QueryValue = string | number | undefined | Array<string | number>;

export class ApiError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
  }
}

const STATUS_TEXT: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized (invalid API key or token)",
  403: "Forbidden (missing permission)",
  404: "Not Found",
  422: "Unprocessable Entity",
};

export class ApiClient {
  constructor(private cfg: Pick<Config, "apiBase" | "key" | "secret">, private fetchImpl: FetchLike = fetch, private readOnly = false) {}

  get base() { return this.cfg.apiBase; }

  async request(method: string, path: string, opts: { query?: Record<string, QueryValue>; body?: unknown } = {}): Promise<any> {
    if (this.readOnly && method !== "GET") throw new Error(`只读连接（${this.cfg.apiBase}）不允许 ${method} 请求`);
    const url = new URL(`${this.cfg.apiBase}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, String(item)));
      else url.searchParams.set(k, String(v));
    }

    const res = await this.fetchImpl(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "FEEDMOB-KEY": this.cfg.key,
        "FEEDMOB-TOKEN": generateToken(this.cfg.key, this.cfg.secret),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: AbortSignal.timeout(30_000),
      redirect: "manual", // never follow: API calls must not be silently bounced to a login page
    });

    if (res.status >= 300 && res.status < 400) {
      const to = res.headers.get("location") ?? "";
      const sso = /sso/i.test(to) ? "（跳到了 SSO 登录页）" : "";
      throw new ApiError(res.status, `FeedMob API 把请求重定向了${sso}：${method} ${path} → ${to.slice(0, 120)}。没有收到成功响应。常见原因：这个环境上没有该接口（路由未部署）、找不到记录、或该 key 没有权限。请到后台核对这条数据是否已被修改。`);
    }

    const text = await res.text();
    let data: unknown = text;
    try { data = text ? JSON.parse(text) : null; } catch { /* keep raw text */ }

    if (!res.ok) {
      const detail = typeof data === "string" ? data : JSON.stringify(data);
      throw new ApiError(res.status, `FeedMob API request failed: ${STATUS_TEXT[res.status] ?? res.status}${detail && detail !== "null" ? ` - ${detail}` : ""}`, data);
    }
    // Some endpoints report failures in a 200 body.
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const d = data as { status?: unknown; errors?: unknown };
      if (typeof d.status === "number" && d.status >= 400) throw new ApiError(d.status, `FeedMob API request failed: ${JSON.stringify(data)}`, data);
      if (hasErrors(d.errors)) throw new ApiError(res.status, `FeedMob API request failed: ${JSON.stringify(d.errors)}`, data);
      // Several report endpoints answer HTTP 200 with {"error": "..."} (e.g. missing partner credentials on staging).
      const e = (data as { error?: unknown; data?: unknown }).error;
      if (typeof e === "string" && e && !Array.isArray((data as { data?: unknown }).data)) throw new ApiError(res.status, `FeedMob API 返回错误：${e}`, data);
    }
    return data;
  }

  get(path: string, query?: Record<string, QueryValue>) { return this.request("GET", path, { query }); }
  post(path: string, body: unknown) { return this.request("POST", path, { body }); }
  patch(path: string, body: unknown) { return this.request("PATCH", path, { body }); }
}

export function hasErrors(errors: unknown): boolean {
  if (Array.isArray(errors)) return errors.length > 0;
  if (errors !== null && typeof errors === "object") return Object.keys(errors).length > 0;
  return Boolean(errors);
}

/** Normalise `[...]` or `{ data: [...] }` responses to an array. */
export function rowsOf<T = Record<string, unknown>>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  const d = (data as { data?: unknown })?.data;
  return Array.isArray(d) ? (d as T[]) : [];
}
