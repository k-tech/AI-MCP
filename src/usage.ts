// Stage 4: local usage log (who called which tool, how long, success or not) + personal MCP tokens.
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Source = "stdio" | "mcp-http" | "dashboard";
export interface CallRecord { caller: string; source: Source; tool: string; args: unknown; durationMs: number; ok: boolean; error?: string }
export interface CallRow { id: number; ts: string; caller: string; source: Source; tool: string; args: string; duration_ms: number; ok: number; error: string | null }
export interface TokenRow { id: number; email: string; label: string; prefix: string; created_at: string; last_used_at: string | null; revoked_at: string | null }
export interface VerifiedTokenOwner { issuer: string; subject: string; email: string }

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_ARGS = 2000;

export class UsageStore {
  private db: DatabaseSync;
  constructor(path = ":memory:") {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS tool_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        caller TEXT NOT NULL, source TEXT NOT NULL, tool TEXT NOT NULL,
        args TEXT NOT NULL, duration_ms INTEGER NOT NULL, ok INTEGER NOT NULL, error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_calls_ts ON tool_calls(ts);
      CREATE TABLE IF NOT EXISTS api_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, label TEXT NOT NULL,
        prefix TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        last_used_at TEXT, revoked_at TEXT
      );`);
    // Add nullable identity fields without assigning old self-declared tokens to anyone.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const columns = this.db.prepare("PRAGMA table_info(api_tokens)").all() as unknown as { name: string }[];
      if (!columns.some(c => c.name === "issuer")) this.db.exec("ALTER TABLE api_tokens ADD COLUMN issuer TEXT");
      if (!columns.some(c => c.name === "subject")) this.db.exec("ALTER TABLE api_tokens ADD COLUMN subject TEXT");
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }

  record(r: CallRecord): void {
    let args = JSON.stringify(r.args ?? {});
    if (args.length > MAX_ARGS) args = args.slice(0, MAX_ARGS) + "…";
    this.db.prepare("INSERT INTO tool_calls (caller, source, tool, args, duration_ms, ok, error) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(r.caller, r.source, r.tool, args, Math.round(r.durationMs), r.ok ? 1 : 0, r.error ? r.error.slice(0, 1000) : null);
  }

  calls(f: { limit?: number; caller?: string; tool?: string; since?: string } = {}): CallRow[] {
    const where: string[] = [], params: (string | number)[] = [];
    if (f.caller) { where.push("caller = ?"); params.push(f.caller); }
    if (f.tool) { where.push("tool = ?"); params.push(f.tool); }
    if (f.since) { where.push("ts >= ?"); params.push(f.since); }
    params.push(Math.min(Math.max(f.limit ?? 100, 1), 1000));
    return this.db.prepare(`SELECT * FROM tool_calls ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`).all(...params) as unknown as CallRow[];
  }

  summary(since: string) {
    const q = (sql: string) => this.db.prepare(sql).all(since) as unknown as Record<string, number | string>[];
    const total = q("SELECT COUNT(*) n, SUM(1 - ok) failed, COUNT(DISTINCT caller) users, ROUND(AVG(duration_ms)) avg_ms FROM tool_calls WHERE ts >= ?")[0];
    return {
      since,
      total: Number(total.n), failed: Number(total.failed ?? 0), users: Number(total.users), avgMs: Number(total.avg_ms ?? 0),
      byTool: q("SELECT tool, COUNT(*) n, SUM(1 - ok) failed, ROUND(AVG(duration_ms)) avg_ms FROM tool_calls WHERE ts >= ? GROUP BY tool ORDER BY n DESC"),
      byCaller: q("SELECT caller, COUNT(*) n, SUM(1 - ok) failed, MAX(ts) last_ts FROM tool_calls WHERE ts >= ? GROUP BY caller ORDER BY n DESC"),
      bySource: q("SELECT source, COUNT(*) n FROM tool_calls WHERE ts >= ? GROUP BY source ORDER BY n DESC"),
      byDay: q("SELECT substr(ts, 1, 10) day, COUNT(*) n, SUM(1 - ok) failed FROM tool_calls WHERE ts >= ? GROUP BY day ORDER BY day"),
    };
  }

  /** Issue a personal MCP token; the plaintext is returned once and only its hash is stored. */
  issueToken(owner: string | VerifiedTokenOwner, label: string): { token: string; row: TokenRow } {
    const email = typeof owner === "string" ? owner : owner.email;
    if (typeof owner !== "string" && (!owner.issuer || !owner.subject)) throw new Error("Verified issuer and subject are required");
    const token = "aimcp_" + randomBytes(24).toString("hex");
    const info = this.db.prepare("INSERT INTO api_tokens (email, label, prefix, token_hash, issuer, subject) VALUES (?, ?, ?, ?, ?, ?)")
      .run(email, label.slice(0, 60) || "未命名", token.slice(0, 12), sha256(token), typeof owner === "string" ? null : owner.issuer, typeof owner === "string" ? null : owner.subject);
    return { token, row: this.db.prepare("SELECT id, email, label, prefix, created_at, last_used_at, revoked_at FROM api_tokens WHERE id = ?").get(info.lastInsertRowid) as unknown as TokenRow };
  }
  tokens(owner: string | VerifiedTokenOwner): TokenRow[] {
    const sql = "SELECT id, email, label, prefix, created_at, last_used_at, revoked_at FROM api_tokens WHERE ";
    return (typeof owner === "string" ? this.db.prepare(sql + "email = ? AND issuer IS NULL AND subject IS NULL ORDER BY id DESC").all(owner) : this.db.prepare(sql + "issuer = ? AND subject = ? ORDER BY id DESC").all(owner.issuer, owner.subject)) as unknown as TokenRow[];
  }
  revokeToken(owner: string | VerifiedTokenOwner, id: number): boolean {
    const sql = "UPDATE api_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ? AND revoked_at IS NULL AND ";
    return Number((typeof owner === "string" ? this.db.prepare(sql + "email = ? AND issuer IS NULL AND subject IS NULL").run(id, owner) : this.db.prepare(sql + "issuer = ? AND subject = ?").run(id, owner.issuer, owner.subject)).changes) > 0;
  }
  /** Returns the owner's email for a valid, unrevoked personal token. */
  resolveToken(token: string, verifiedOnly = false): string | undefined {
    if (!token.startsWith("aimcp_")) return undefined;
    const row = this.db.prepare(`SELECT id, email FROM api_tokens WHERE token_hash = ? AND revoked_at IS NULL${verifiedOnly ? " AND issuer = 'https://accounts.google.com' AND subject IS NOT NULL AND length(subject) > 0" : ""}`).get(sha256(token)) as { id: number; email: string } | undefined;
    if (!row) return undefined;
    this.db.prepare("UPDATE api_tokens SET last_used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(row.id);
    return row.email;
  }
  close() { this.db.close(); }
}
