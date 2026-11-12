# Stage 4 — Usage records

- Every tool call (MCP over HTTP, console, stdio when USAGE_DB is set) goes through `invokeTool`, which logs: time, caller, source, tool, args (≤2 KB), duration, ok/error → SQLite `data/usage.sqlite` (`tool_calls`).
- Caller identity: console → logged-in email; MCP over HTTP → owner of the personal `aimcp_` token (the shared access token is rejected on /mcp since 2026-11-12, so every call has a person); stdio → FEEDMOB_USER_EMAIL.
- Personal tokens: generated in the console ("我的 MCP 令牌"), shown once, stored as SHA-256 hash, revocable.
- `get_usage_stats` MCP tool + console page: totals, failure rate, by tool / person / day / source, filterable call list.
- Limitation: console login email is self-declared until Google login replaces the shared access token.
