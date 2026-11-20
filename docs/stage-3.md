# Stage 3 — Report statistics

## Chime Agency Spend preflight

Report 统计 → Chime Agency Spend 预检 links to the official report log filtered to report config 41. Select Report Time in that system to find a historical sent snapshot. After selecting one day, the page also constructs the official single-day ZIP export link; an export generated now may differ from the historical sent snapshot after data revisions. Both links open the official system and require its access. Tally does not fetch, upload, send or schedule either report.

The historic [report form](https://github.com/feed-mob/feedmob_client_reports/blob/5f3d5f665b836602e39ec77a15ac6f334b10f3a7/app/views/daily_reports/reports/_chime_agency_spend.html.erb), [controller](https://github.com/feed-mob/feedmob_client_reports/blob/5f3d5f665b836602e39ec77a15ac6f334b10f3a7/app/controllers/chime_agency_spend_reports_controller.rb) and [date parser](https://github.com/feed-mob/feedmob_client_reports/blob/5f3d5f665b836602e39ec77a15ac6f334b10f3a7/app/controllers/application_controller.rb) specify GET `export.zip` with `end_date` in `MM/DD/YYYY`; the live form was inspected, but an actual ZIP was not generated in this change. The [report command](https://github.com/feed-mob/feedmob_client_reports/blob/5f3d5f665b836602e39ec77a15ac6f334b10f3a7/app/commands/chime_agency_spend_report_command.rb) specifies the 11-column order.

Choose up to 10 decompressed UTF-8 CSVs, total at most 800,000 bytes. The browser sends their text to the current Tally service for in-memory validation only; it is not saved or written to the usage log. The preflight checks the exact header order, parseability, target date, currency shape, numeric limits, negative values, missing identifiers and duplicate rows; it reports exact decimal sums per currency. Issues are capped in display at 50, with a total count. Sums include parseable amounts even on flagged rows and are not proof of complete, correct or sendable data. Validate origin, data version, mapping, currency and business rules independently. The preflight neither extracts ZIPs nor creates replacement reports.

| Tool | What it adds on top of the API |
|---|---|
| get_vendors | counts by status and vendor type |
| get_campaigns | hides archived campaigns by default; counts by OS / status |
| get_client_report_spend_report_names | list of internal report sources (18 on staging) |
| get_client_report_spends | gross totals by vendor, campaign, day; raw logs dropped unless include_rows |

## Acceptance (staging, 2026-11-11)
- 541 vendors (running 86, paused 362, archived 55, onboarding 38); Upside has 52 active campaigns (3 archived hidden).
- Cross-check: "Upside Spend" report, Samsung, 11/01–11/09 gross = 1758; direct spend for click URL 19859 (Upside × Samsung) same period gross = 1758. Numbers match.

## Original report tools (added 2026-11-12)
39 read-only tools carried over 1:1 from the original feedmob-reporting MCP (`src/tools/raw-reports.ts`): MMP/attribution (AppsFlyer, Kochava, Singular, Adjust, agency conversions), partner reports (Samsung, YouAppi, Kayzen, Beeswax, Jampp, Remerge, Pubmatic, InMobi, Smadex, Liftoff), and internal data (spend jobs, spend requests, AdOps, apps, users, HubSpot tickets).
The MCP server now sends instructions at connect time describing how to work out a spend from these tools (the knowledge the original kept in the feedmob-reporting-skills skill). Formula check against staging: vendor_managed gross = net ÷ (1 − margin/100) (23505 on 11-09: 8101.42 ÷ 0.6 = 13502.37).
Staging run 2026-11-12 recorded 20 successes and 19 failures. The historical note attributed failures to missing gateway/partner/Singular configuration, but the repository has no individual failure logs or backend source. The mock test only demonstrates one Kayzen HTTP 200 error naming `FEEDMOB_DATA_GATEWAY_ENDPOINT`; it does not prove the cause of all 19 failures or production behavior. Endpoint paths and parameters are not independently verified against the original implementation. Do not treat production success as established.

## Client reports, step 1: statistics (2026-11-12)
Client reports = spend FeedMob prepares and uploads to clients (admin "Choose Client Report"; stored as client_report_spends). Not direct spend.
- `get_client_report_overview`: per report — days with data / missing days, latest data date, last upload, vendors, click URLs, gross. Default: 14 days ending yesterday.
- `compare_client_report_with_direct_spend`: per click URL and day — report gross vs direct gross, difference, days missing in the report. Click URLs = those in the report in the range or the 30 days before.
- Console: Report 统计 → 报表总览 (all reports) → 对账 (one report).
Staging, Chime Agency Spend 10-29..11-11: LG (23203) missing on 10 days; 24141 missing on 5; Samsung click URLs: report gross above direct gross on most days.
Steps 2 (generate upload files) and 3 (upload) need each report's file format and an upload API from the backend.


## Vendor report statistics and reconciliation

The mappings below follow Giter's review of `feedmob_admin` at commit `a07e89f`; this working copy does not include that backend and the implementation has not independently rechecked its source. All ten endpoints were reported to return `date`, `partner_net_spend`, and `click_url_id`. Amounts may be numeric strings; dates are normalized to the represented calendar date without timezone conversion. The source's timezone, currency and real response behavior still need operational verification.

| Partner | Campaign identifiers retained | Additional inputs |
|---|---|---|
| Samsung | `samsung_content_id` | — |
| YouAppi | `campaign_id`, `campaign_name`, `youappi_campaign_name`, `vendor_id`, `vendor_name` | — |
| Kayzen | `kayzen_report_id`, `kayzen_campaign_name` | — |
| Beeswax | `campaign_id`, `campaign_name`, `beeswax_campaign_id`, `beeswax_campaign_name`, `vendor_id`, `vendor_name` | — |
| Jampp | `campaign_id`, `jampp_campaign_id`, `jampp_campaign_name`, `vendor_id`, `client_id` | `client_id` |
| Remerge | `campaign_id`, `campaign_name`, `remerge_campaign_name`, `vendor_id`, `vendor_name`, `client_id` | `client_id`: 216 or 189 |
| Pubmatic | `campaign_id`, `campaign_name`, `pubmatic_campaign_id`, `pubmatic_campaign_name`, `vendor_id`, `vendor_name`, `client_id` | `client_id`: 189 |
| InMobi | `inmobi_campaign_name` | completed SKAN and non-SKAN report IDs |
| Smadex | `smadex_multi_campaign_id`, `smadex_campaign_name` | completed report ID |
| Liftoff | `liftoff_campaign_id`, `liftoff_campaign_name` | completed Possible Finance and Stash report IDs |

- `get_vendor_report_overview` queries one partner with `partner`, `start_date`, `end_date` and the inputs above. It returns net totals by day, campaign identifiers and click URL, plus missing days. Missing means no row returned, not necessarily a failed job. Null `click_url_id` or Beeswax `matched: false` is unmapped; unmatched rows, their total and totals grouped by date and campaign identifiers are exposed separately. Samsung reportedly skips unmatched records upstream. Pubmatic's upstream non-geo endpoint aggregates by date and click URL; multiple null-URL campaigns may already have been combined, so their individual identity cannot be recovered here.
- `compare_vendor_report_with_direct_spend` automatically reconciles every mapped report URL; optional `click_url_ids` adds URLs to discover report omissions for the selected dates. Amounts are summed by URL and day before comparing partner **net** with direct **net**. Unmapped rows are excluded from comparisons. Missing report rows outside the derived and explicitly added scope cannot be discovered. Tolerance is absolute (default 0.01), applied before displayed amounts are rounded to cents. Maximum combined scope: 500 URLs, queried sequentially in batches of 50.
- For InMobi, Smadex and Liftoff, use the raw ID and status tools first; pass completed IDs in `report_ids`. These tools only retrieve the final report; they do not submit jobs or poll. Smadex's endpoint receives only `report_id` and is filtered locally after normalizing each date. Other partners receive the requested date range. Each range is limited to 63 inclusive days. The raw tool's 300-row presentation limit is not used for aggregation. Recognized errors, partial results and unsupported response shapes fail closed.
- Console: Report 统计 → 渠道报表对账; it uses the authenticated `/api/tools/call` route and `invokeTool` audit. Example: `{"partner":"samsung","start_date":"2026-11-01","end_date":"2026-11-03","click_url_ids":[123]}`; the ID is illustrative. Field names and campaign mappings are no longer inputs.

### Configuration and verification boundary

Tally requires `FEEDMOB_API_BASE`, `FEEDMOB_KEY`, `FEEDMOB_SECRET`, `FEEDMOB_USER_EMAIL`; optional read overrides are `FEEDMOB_READ_API_BASE`, `FEEDMOB_READ_KEY`, `FEEDMOB_READ_SECRET`. `ENABLE_WRITE` is not required for these tools. `FEEDMOB_DATA_GATEWAY_ENDPOINT` appears in a mocked upstream error and is a **backend** setting, not read by this repository. Partner credentials and Singular configuration are mentioned historically, but their variable names and completeness cannot be determined from this repository. No staging/production calls were made for this change. Real report samples, pagination behavior, currency, timezone and operational mapping accuracy remain to be verified by the backend owners. The backend source review is reported by Giter and was not independently reproduced in this workspace.
