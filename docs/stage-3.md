# Stage 3 — Report statistics

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
Staging run 2026-11-12: 20 tools OK; 19 fail on staging configuration (missing FEEDMOB_DATA_GATEWAY_ENDPOINT, partner credentials, Singular config) — expected to work on production.

## Client reports, step 1: statistics (2026-11-12)
Client reports = spend FeedMob prepares and uploads to clients (admin "Choose Client Report"; stored as client_report_spends). Not direct spend.
- `get_client_report_overview`: per report — days with data / missing days, latest data date, last upload, vendors, click URLs, gross. Default: 14 days ending yesterday.
- `compare_client_report_with_direct_spend`: per click URL and day — report gross vs direct gross, difference, days missing in the report. Click URLs = those in the report in the range or the 30 days before.
- Console: Report 统计 → 报表总览 (all reports) → 对账 (one report).
Staging, Chime Agency Spend 10-29..11-11: LG (23203) missing on 10 days; 24141 missing on 5; Samsung click URLs: report gross above direct gross on most days.
Steps 2 (generate upload files) and 3 (upload) need each report's file format and an upload API from the backend.
