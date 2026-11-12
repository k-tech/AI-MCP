# Tally

A rewrite of the FeedMob AI MCP server (`feedmob-reporting`) with a human console.

- **MCP server** (stdio and Streamable HTTP) with read tools for clients, vendors, campaigns, direct spend, rates, client reports and the original partner / MMP reports, plus write tools for direct spend and click URL prices.
- **Auto-find spend**: `find_direct_spend` works out net / gross for a click URL and day from MMP events, rates and the backend job definitions; `create_direct_spend_from_sources` previews first and writes only with `confirm: true`.
- **Console** (`/dashboard/`): spend and rate lookup, client report overview and reconciliation with direct spend, usage statistics, personal MCP tokens, tool debugger.
- **Safety**: write tools are off unless `ENABLE_WRITE=true`; the read connection is GET-only; `/mcp` accepts personal tokens only so every call is attributed to a person; usage is logged to local SQLite.

## Run

```bash
npm install
cp .env.example .env        # FEEDMOB_API_BASE / KEY / SECRET / USER_EMAIL
npm test                    # mocked, no network
node scripts/mock-api.mjs   # optional fake FeedMob API on :4010

# HTTP entry: MCP at /mcp, console at /dashboard/
set -a; . ./.env; set +a
MCP_HTTP_TOKEN=<at least 16 chars> PORT=8899 USAGE_DB=data/usage.sqlite node dist/src/http-server.js

# stdio entry (Claude Desktop / Claude Code running it locally)
node dist/src/index.js
```

Environment variables: `FEEDMOB_API_BASE`, `FEEDMOB_KEY`, `FEEDMOB_SECRET`, `FEEDMOB_USER_EMAIL` (must be @feedmob.com); optional `FEEDMOB_READ_API_BASE` / `FEEDMOB_READ_KEY` / `FEEDMOB_READ_SECRET` to read from a different environment than the one writes go to; `ENABLE_WRITE`, `MCP_HTTP_TOKEN`, `USAGE_DB`, `PORT`.

Connecting an agent (Claude Code, Claude Desktop, Codex, OpenCode, Cursor, curl): generate a personal token in the console under "我的 MCP 令牌"; the page shows the exact config for each client.

## Layout

```
src/tools/     tool definitions (one registry shared by MCP and the console)
src/web/       HTTP app: /mcp, console API, login
src/usage.ts   usage log + personal tokens (node:sqlite)
web/           console pages
scripts/       mock FeedMob API
test/          node:test suites
docs/          per-stage notes
```

Needs Node.js 22+ (uses `node:sqlite`).
