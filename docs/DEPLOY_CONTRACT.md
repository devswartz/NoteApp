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
| `PUBLIC_URL` | yes | `https://notes.devswartz.com` (staging: `https://notes-staging.devswartz.com`) |
| `DATA_DIR` | no | default `/data` |
| `JWT_SECRET` | yes | 64+ random bytes, different per environment |
| `SMTP_HOST` | yes for email | `email-smtp.<region>.amazonaws.com` (AWS SES SMTP interface) |
| `SMTP_PORT` | no | `587` (STARTTLS) |
| `SMTP_USER` / `SMTP_PASS` | yes for email | SES SMTP credentials (from an IAM user limited to `ses:SendRawEmail`) |
| `MAIL_FROM` | yes for email | `NoteApp <notes@devswartz.com>` |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | yes for web push | generate once per environment: `npx web-push generate-vapid-keys` |
| `VAPID_SUBJECT` | yes for web push | `mailto:<admin address>` |
| `SEED_DEMO` | no | `1` on staging only: loads demo content on an empty DB |
| `SIGNUP_MODE` | no | `invite` (default in production): only people with a pending invite can create an account, plus bootstrap (the first account, or an email in `ADMIN_EMAILS`). `open`: anyone can sign up, and **needs working SMTP**: a new account must confirm its email (a link sent to `PUBLIC_URL/verify-email`) before it can use the app, and pending workspace invites for that address are applied only at confirmation. Bootstrap accounts are confirmed automatically. **Without `SMTP_HOST` nothing can be sent, so every new account is treated as confirmed**; don't run `open` in production without SMTP. Accounts that existed before email verification (migration 012) count as confirmed |
| `ADMIN_EMAILS` | yes (staging + prod) | comma-separated instance admins (`/api/admin/stats`); they can always sign up, even in `invite` mode. They also receive the in-app **Send feedback** emails (`POST /api/feedback`; needs SMTP, see below; with no SMTP or no admins the feedback is only logged as a JSON line with `"event":"feedback"`). **Set it before the first sign-up**: if it's unset, the first account ever created becomes the admin. |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`; default `info` in production. Logs are one JSON object per line on stdout/stderr. |
| `TRUST_PROXY_HEADER` | yes (staging + prod) | `cf`: read the client IP from `CF-Connecting-IP` for rate limiting. **Only set this when the app port is reachable solely through cloudflared**; otherwise clients could forge their IP. Default off. |
| `ACCESS_TOKEN_TTL_S` | no | access-token lifetime; production clamps it to 60–3600 s (default 900). Leave unset. |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY` / `APNS_ENV` | for iOS push | APNs token auth (`.p8` key contents in `APNS_PRIVATE_KEY`; `APNS_ENV` = `production` or `sandbox`). Optional until the iOS app ships. |
| `FCM_SERVICE_ACCOUNT_JSON` | for Android push | Firebase service-account JSON (one line). Optional until the Android app ships. |
| `ANDROID_CERT_SHA256` | for Android app links | SHA-256 fingerprint(s) of the Android signing certificate(s), comma-separated. Served in `/.well-known/assetlinks.json` (404 until set). `APNS_TEAM_ID` likewise drives `/.well-known/apple-app-site-association`. See `docs/MOBILE.md`. |

If email or push settings are missing, the app still starts and logs a warning; reminders through that channel are skipped. `MAIL_FROM` must be a sender the SMTP provider has verified: confirmation emails, invites and password resets all use it.

`E2E_TEST_HOOKS` is a test-only variable used by the e2e suite and is **ignored when `NODE_ENV=production`**. Never set it on a real environment.

## Hostnames
- Production: `notes.devswartz.com`
- Staging: `notes-staging.devswartz.com`
- Both go through a Cloudflare Tunnel. **The app's port must not be reachable any other way** (bind it to localhost or the Docker network only; no published host port on the LAN or internet), because rate limiting trusts `CF-Connecting-IP` when `TRUST_PROXY_HEADER=cf`.
- **Cloudflare Access must be off**, because the desktop and mobile apps call the API directly; the app does its own auth.

## Backups
- The SQLite DB is backed up with `sqlite3 .backup` or Litestream (never by copying the file while the app is running), together with `/data/files/`, to a destination off the box.
