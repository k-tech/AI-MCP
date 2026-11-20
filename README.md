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
npm run build              # required before either entry point
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

## Report workflow and delivery status

For production reads and Staging writes, configure `FEEDMOB_READ_API_BASE` / `FEEDMOB_READ_KEY` / `FEEDMOB_READ_SECRET` for the production read-only connection and `FEEDMOB_API_BASE` / `FEEDMOB_KEY` / `FEEDMOB_SECRET` for Staging. Read overrides otherwise fall back individually to the write environment; verify all three explicitly. `ENABLE_WRITE=true` enables writes to the configured write environment, not automatically to Staging.

1. Locate ownership and sources with `get_direct_spend_job_stats` (`click_url_id`, optionally `client_id` / `vendor_id`).
2. For client reports, use `get_client_report_spend_report_names`, `get_client_report_overview`, and `compare_client_report_with_direct_spend` (`report_name`, dates). For vendor reports use `get_vendor_report_overview` and `compare_vendor_report_with_direct_spend` (`partner`, `start_date`, `end_date`; optional `click_url_ids` extends comparison scope). Jampp, Remerge and Pubmatic require `client_id`; Remerge accepts 216 or 189, Pubmatic 189. InMobi, Smadex and Liftoff require completed `report_ids`: first use their `get_*_report_ids` and `check_*_report_status` tools.
3. Investigate differences, missing days and unmapped rows against the source. `find_direct_spend` takes `click_url_id` and `spend_date`; `create_direct_spend_from_sources` previews in the write environment and only writes after the user approves and `confirm: true` is supplied. Check the destination and existing record before writing. Client report file generation/upload is not implemented.

Client overview/comparison API defaults to the previous 14 days ending yesterday in `Asia/Shanghai`; set `REPORT_TIME_ZONE` to an IANA timezone to change the default. Console date fields use the browser local calendar and are sent explicitly; verify them for the business timezone. Explicit dates are calendar dates, not converted between source timezones. Source timezone alignment must be verified. Currency is never converted: mixed known currencies fail; missing currency is unknown and numerical matches are not proof of reconciliation. Known pagination/truncation indicators fail closed, while bare arrays or unknown metadata cannot prove completeness. Check source coverage before treating results as final. Invalid dates, IDs or amounts stop aggregation with an error. Vendor null click URLs remain unmapped; upstream may already omit unmatched rows.

| Stage | Evidence and outstanding work |
|---|---|
| 1: reads | Implemented; historical Staging evidence in `docs/stage-1.md`; automated tests use mocks. |
| 2: spend and rates | Implemented; historical finder backtest in `docs/stage-2.md`; writes require real Staging integration validation. |
| 3: reports | Client overview and comparison have historical Staging evidence; Vendor overview/comparison have mock tests only, real partner responses, mappings, currency, timezone and pagination need integration validation. See `docs/stage-3.md`. |
| 4: usage/console | Implemented and mock tested; console identity is not independently verified and requires stronger authentication before team rollout. |

After identifying the old test host and its callers, rotate the previously exposed test token and retire the old process. Do not treat the historical 19 failed original report calls as independently diagnosed. Daily Report purchase/cohort changes are outside this workflow.


## Supplied partner report preview

When a partner has no accessible API, `preview_supplied_spend_report` accepts caller-provided CSV text (header plus up to 1,000 rows), an explicit mapping for date, click URL, currency and net and/or gross columns, and the target `click_url_id` / `spend_date`. It returns matching rows, sums, currency, missing and duplicate warnings and never produces `suggested_create` arguments because the target ledger currency is not confirmed and the create API has no currency field. It does not fetch email, Sheets, files or URLs, verify source completeness, infer a margin, or write spend. CSV is redacted from Tally usage logs. Validate report identity, duplicates, source completeness, currency and destination before approving a write.

The Spend console also supports source-identifier filters (for example LG creative or Vizio campaign and demand tag) with a caller-supplied mapping basis. It checks existing direct spend for the target date and URL before the preview. The caller can provide a sourced, date-bounded gross-margin rule and ledger currency evidence; when the mapping is in date and other inputs are complete, the console previews gross as net / (1 − margin / 100). All such assertions require independent verification; no write arguments are produced. The synthetic tests do not establish either vendor’s actual format or mapping.

Each filter accepts either a single `value` or a non-empty `values` array of exact alternatives, for example `[{"column":"Campaign","value":"A"},{"column":"Tag","values":["T1","T2"]}]`. Alternatives within one column are OR; different columns are AND. The same column cannot be mapped twice. These identifiers and their date ranges must be independently verified for the URL.

After `update_direct_spend` by URL and date, Tally reads back from the write environment and compares the requested net/gross fields when possible. A failed/ambiguous readback is reported as unverified and must be investigated before retrying. ID-only updates or other changed fields cannot be confirmed by that lookup. The console refreshes its existing query only when read and write environments match. The external Admin page may still need a manual refresh.

The client report total is the sum of returned `client_report_spends.gross_spend` rows, not Femini Total Spend including overcap release or excluding client make-good. It cannot by itself establish equality with that different metric. Verify environment, date, scope, adjustments, source currency and completeness before comparison.

Client report comparison defaults to URLs seen in that report in the requested range or prior 30 days, a partial scope. To include separately verified Click URLs, pass `click_url_ids`; URLs not seen in report history are marked `outside_report_scope` with membership unconfirmed, not declared missing from the report. Totals include the selected scope and separate the report-history portion from the outside portion. The caller must determine which URLs and report memberships are appropriate.
