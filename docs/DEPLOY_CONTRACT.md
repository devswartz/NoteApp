# Deploy contract (app ⇄ homelab)

This is the fixed interface between the code in this repo and the homelab that runs it. Either side can change independently as long as this file holds. **Changing anything here needs a note in `docs/STATUS.md`, and the homelab owner must be told.**

## Images
- Registry: `ghcr.io/devswartz/noteapp`
- `:staging` (and `:sha-<shortsha>`) is published by CI on every merge to `main`.
- `:vX.Y.Z` and `:prod` are published by CI when a `vX.Y.Z` git tag is pushed.
- The package may be private; the homelab pulls using a GitHub token that has `read:packages`.
- Single image, `linux/amd64`. One container runs everything: the API, the real-time collaboration server, the static web app and the reminder worker.

## Runtime
| Item | Value |
|---|---|
| Listen port | `PORT`, default **3001** inside the container |
| Health check | `GET /api/health` → `200 {"ok":true,"version":"<git sha or tag>"}` |
| Persistent volume | **`/data`** — SQLite DB at `/data/noteapp.db`, attachments in `/data/files/` |
| WebSockets | Same origin and port: `/collab/*` (Yjs) and `/api/events` (live updates). The proxy/tunnel must allow WebSocket upgrade. |
| Run as | non-root user, UID 1000 |
| Shutdown | Handles SIGTERM: flushes open documents, then exits within 10 s |

## Environment variables
| Var | Required | Example / notes |
|---|---|---|
| `NODE_ENV` | yes | `production` |
| `PUBLIC_URL` | yes | `https://app.notiveloapp.com` (staging: `https://staging.notiveloapp.com`) |
| `REDIRECT_HOSTS` | no | Old host names of this server, comma-separated (no scheme). A browser page load (GET/HEAD of an app page) arriving on one gets a `301` to the same path on `PUBLIC_URL`; `/api`, the WebSockets, `/uploads`, `/mcp`, `/oauth`, `/.well-known` and static files keep working there, for app builds that still call the old host. Use after a domain move (`docs/DOMAIN_MOVE.md`). |
| `DATA_DIR` | no | default `/data` |
| `JWT_SECRET` | yes | 64+ random bytes, different per environment |
| `SMTP_HOST` | yes for email | `email-smtp.<region>.amazonaws.com` (AWS SES SMTP interface) |
| `SMTP_PORT` | no | `587` (STARTTLS) |
| `SMTP_USER` / `SMTP_PASS` | yes for email | SES SMTP credentials (from an IAM user limited to `ses:SendRawEmail`) |
| `MAIL_FROM` | yes for email | `Notivelo <no-reply@notiveloapp.com>` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | yes for web push | generate once per environment: `npx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | yes for web push | `mailto:<admin address>` |
| `SEED_DEMO` | no | `1` on staging only: loads demo content on an empty DB |
| `SIGNUP_MODE` | no | `invite` (default in production): only people with a pending invite can create an account, plus bootstrap (the first account, or an email in `ADMIN_EMAILS`). `open`: anyone can sign up, and **needs working SMTP**: a new account must confirm its email (a link sent to `PUBLIC_URL/verify-email`) before it can use the app, and pending workspace invites for that address are applied only at confirmation. Bootstrap accounts are confirmed automatically. **Without `SMTP_HOST` nothing can be sent, so every new account is treated as confirmed**; don't run `open` in production without SMTP. Accounts that existed before email verification (migration 012) count as confirmed |
| `ADMIN_EMAILS` | yes (staging + prod) | comma-separated instance admins (`/api/admin/stats`); they can always sign up, even in `invite` mode. They also receive the in-app **Send feedback** emails (`POST /api/feedback`; needs SMTP, see below; with no SMTP or no admins the feedback is only logged as a JSON line with `"event":"feedback"`). **Set it before the first sign-up**: if it's unset, the first account ever created becomes the admin. |
| `UNVERIFIED_ACCOUNT_DAYS` | no | days an account may stay unconfirmed before the housekeeping job deletes it (default `7`, minimum `1`). Accounts in `ADMIN_EMAILS` and every confirmed account are never deleted |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`; default `info` in production. Logs are one JSON object per line on stdout/stderr. Browser error reports appear as `warn` lines with `"event":"client_error"` (stderr); see ARCHITECTURE.md. |
| `TRUST_PROXY_HEADER` | yes (staging + prod) | `cf`: read the client IP from `CF-Connecting-IP` for rate limiting. **Only set this when the app port is reachable solely through cloudflared**; otherwise clients could forge their IP. Default off. |
| `ACCESS_TOKEN_TTL_S` | no | access-token lifetime; production clamps it to 60–3600 s (default 900). Leave unset. |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY` / `APNS_ENV` | for iOS push | APNs token auth (`.p8` key contents in `APNS_PRIVATE_KEY`; `APNS_ENV` = `production` or `sandbox`). Optional until the iOS app ships. |
| `FCM_SERVICE_ACCOUNT_JSON` | for Android push | Firebase service-account JSON (one line). Optional until the Android app ships. |
| `ANDROID_CERT_SHA256` | for Android app links | SHA-256 fingerprint(s) of the Android signing certificate(s), comma-separated. Served in `/.well-known/assetlinks.json` (404 until set). `APNS_TEAM_ID` likewise drives `/.well-known/apple-app-site-association`. See `docs/MOBILE.md`. |
| `MS_CLIENT_ID` / `MS_CLIENT_SECRET` | for OneNote import | Application (client) ID and a client secret of the Microsoft Entra app registration used by **Import from OneNote** (#117). Supported accounts: personal **and** work/school (the app uses the `common` authority). Redirect URI (platform *Web*), exactly **`${PUBLIC_URL}/api/import/onenote/callback`**: `https://app.notiveloapp.com/api/import/onenote/callback` and `https://staging.notiveloapp.com/api/import/onenote/callback`. Delegated Microsoft Graph permissions: `Notes.Read`, `offline_access`, `User.Read`. **If either is unset the feature is hidden** (no UI; every `/api/import/onenote/*` route answers 404). The secret is a credential: keep it in the homelab `.env` only, and renew it in Entra before it expires. |

If email or push settings are missing, the app still starts and logs a warning; reminders through that channel are skipped. `MAIL_FROM` must be a sender the SMTP provider has verified: confirmation emails, invites and password resets all use it.

`E2E_TEST_HOOKS` is a test-only variable used by the e2e suite and is **ignored when `NODE_ENV=production`**. Never set it on a real environment.

## Hostnames
- Production: `app.notiveloapp.com`
- Staging: `staging.notiveloapp.com`
- Both go through a Cloudflare Tunnel. **The app's port must not be reachable any other way** (bind it to localhost or the Docker network, or publish it only to the cloudflared host behind a host firewall; never open to the LAN or internet), because rate limiting trusts `CF-Connecting-IP` when `TRUST_PROXY_HEADER=cf`.
- **Cloudflare Access must be off**, because the desktop and mobile apps call the API directly; the app does its own auth.

## Request size and rate limits
- **Uploads through the tunnel:** Cloudflare's free plan rejects request bodies over **100 MB**, so the app's own largest body (workspace import, `POST /api/workspaces/import`) is capped at exactly that; a larger `Content-Length` gets 413 before the body is read. Attachments are capped at 25 MB and JSON bodies at 512 KB.
- **Workspace import/export** hold a whole archive in memory (import: the upload plus up to **300 MB** unpacked). To keep a small box safe with open sign-up: **one import at a time** server-wide, **3 imports an hour per user** and **10 an hour** server-wide, **6 exports an hour per user**. Refused requests get 429 with `Retry-After`. Plan for ~500 MB of headroom over normal use for a running import.
- **OneNote import** runs as a background job with **its own slot: one OneNote import at a time** server-wide (so it never blocks a workspace import, and the other way round), and counts toward the same hourly limits (3 an hour per user, 10 server-wide). A job stops after **30 minutes** (keeping what it imported) and can be cancelled. Files: 25 MB each, **300 MB per job**, **1 GB per user per 24 hours**; at most 5 000 pages and 500 sections a job; each page's HTML at most 1 MB. Plan for ~300 MB of extra disk per running import, as for workspace import. It calls `login.microsoftonline.com` and `graph.microsoft.com` over HTTPS (30 s timeout per request), so outbound access to both is needed.
- These and the auth rate limits (`server/ratelimit.ts`) are in-memory, per process, and reset on restart. `RATE_LIMIT=off` disables them all: **for local testing only, never on a real environment**.

## Backups
- The SQLite DB is backed up with `sqlite3 .backup` or Litestream (never by copying the file while the app is running), together with `/data/files/`, to a destination off the box.
