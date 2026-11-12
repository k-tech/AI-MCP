# Stage 2 — Spend & Rate

## Tools
| Tool | Type | API |
|---|---|---|
| get_direct_spends | read | GET /ai/api/direct_spends (click_url_ids[] / client_id) — adds totals per click URL |
| get_click_url_histories | read | GET /ai/api/click_url_histories — adds collapsed price periods |
| create_direct_spend | write | POST /ai/api/direct_spends |
| update_direct_spend | write | PATCH /ai/api/direct_spends/:id or /by_click_url |
| update_click_url_prices | write | PATCH /ai/api/click_urls/:id/prices (422 confirmation_required → returned, never auto-confirmed) |

Write tools are only registered when `ENABLE_WRITE=true`. Every write tags `audit_comment` with `[Tally · <caller email>]`.
Input is validated before any API call (amounts >= 0, integer counts, one selector for updates, no duplicate / future price dates).

## Acceptance
- Read tools verified on staging 2026-11-11: Upside (client 171) 11/01–11/10 → 18 rows, 2 click URLs, net 8043.9 / gross 15593; click URL 19859 rates net 1.1 / gross 3 / margin 63.
- Write tools: covered by mocked tests (payload, selectors, 400 details, 422 confirmation). **Real staging write pending** — needs ENABLE_WRITE=true, a key with write permission, and an agreed test click URL.

## Auto-find spend (find_direct_spend / create_direct_spend_from_sources)
Agents no longer need the user to type net/gross. For one click URL + day Tally checks, in order:
1. existing direct spend → "exists" (use update_direct_spend instead)
2. the live backend job for the click URL (direct_spend_job_stats) → which source each side must come from
3. AppsFlyer, then Kochava daily events × that day's CPI (gross = client paid action × gross CPI, net = vendor paid action × net CPI)
4. internal client reports (gross), net derived from the rate — only when no job says otherwise
Whitelist rule: a side is computed only when the job names MMP events or a derivation (margin / "calculated from"); vendor reports, partner emails, Google Sheets, vendor APIs → left empty with the job owner named. `create_direct_spend_from_sources` previews first and writes only with `confirm: true`; the audit comment records how each amount was computed.

Backtest (staging, 11-08 + 11-09, 280 real records): 6 fully computed — all equal to the real record; 4 partially computed — the computed side correct; 270 declined (vendor-managed sources Tally cannot read); 0 wrong.
