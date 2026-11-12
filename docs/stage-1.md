# Stage 1 — Skeleton & auth

## Delivered
- `config.ts`: env validation (FEEDMOB_API_BASE / KEY / SECRET / USER_EMAIL); email must be @feedmob.com
- `auth.ts`: HS256 JWT `{key, expired_at}` (+7d), same shape as the original server, no jsonwebtoken dep
- `http.ts`: authenticated API client (FEEDMOB-KEY / FEEDMOB-TOKEN headers), 30s timeout, readable errors
- Tools: `whoami` (caller identity, no secrets), `get_clients` (read-only, GET /ai/api/clients)
- Tests: 6 mocked tests (`npm test`)

## Acceptance
1. `npm test` passes.
2. Without env vars the server refuses to start and lists every missing/invalid var.
3. With real staging creds: register in Claude Code and call `whoami`, then `get_clients`.

   claude mcp add tally -e FEEDMOB_API_BASE=... -e FEEDMOB_KEY=... -e FEEDMOB_SECRET=... -e FEEDMOB_USER_EMAIL=you@feedmob.com -- node /home/ubuntu/ai_projects/ai-mcp-rewrite/dist/src/index.js

## Testing without real credentials
1. `node scripts/mock-api.mjs` (fake API on http://localhost:4010; accepts key `mock-key` / secret `mock-secret` and verifies the JWT signature)
2. `claude mcp add tally-mock -e FEEDMOB_API_BASE=http://localhost:4010 -e FEEDMOB_KEY=mock-key -e FEEDMOB_SECRET=mock-secret -e FEEDMOB_USER_EMAIL=you@feedmob.com -- node /home/ubuntu/ai_projects/ai-mcp-rewrite/dist/src/index.js`
3. Restart Claude Code, then ask it to call `whoami` and `get_clients` for "uber".

## Known limits
- Caller identity is self-declared (env var). Verified identity (Femini get_current_user or Google login) is a later option.


## Acceptance result (2026-11-11, staging https://admin-stage.feedmob.info)
- whoami: OK, caller and masked key shown, secret not exposed
- get_clients "Uber": 4 rows (Uber, Uber Affiliate, Uber Eats, Uber Technologies), ~340 ms
- get_clients (all): 212 clients, 16 flagged for_test
- Wrong secret: API returns 401, tool reports Unauthorized
- Credentials live in .env (chmod 600, gitignored); never in web/ or docs/
