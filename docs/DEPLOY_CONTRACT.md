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
| `ADMIN_EMAILS` | yes (staging + prod) | comma-separated emails of the instance admins (`GET /api/admin/stats`). **Set it before the first sign-up**: if it's unset, the first account ever created becomes the admin. |
| `LOG_LEVEL` | no | `debug` / `info` / `warn` / `error`; default `info` in production. Logs are one JSON object per line on stdout/stderr. |
| `TRUST_PROXY_HEADER` | yes (staging + prod) | `cf`: read the client IP from `CF-Connecting-IP` for rate limiting. **Only set this when the app port is reachable solely through cloudflared**; otherwise clients could forge their IP. Default off. |
| `ACCESS_TOKEN_TTL_S` | no | access-token lifetime; production clamps it to 60–3600 s (default 900). Leave unset. |
| `APNS_KEY_ID` / `APNS_TEAM_ID` / `APNS_BUNDLE_ID` / `APNS_PRIVATE_KEY` / `APNS_ENV` | for iOS push | APNs token auth (`.p8` key contents in `APNS_PRIVATE_KEY`; `APNS_ENV` = `production` or `sandbox`). Optional until the iOS app ships. |
| `FCM_SERVICE_ACCOUNT_JSON` | for Android push | Firebase service-account JSON (one line). Optional until the Android app ships. |

If email or push settings are missing, the app still starts and logs a warning; reminders through that channel are skipped.

## Hostnames
- Production: `notes.devswartz.com`
- Staging: `notes-staging.devswartz.com`
- Both go through a Cloudflare Tunnel. **The app's port must not be reachable any other way** (bind it to localhost or the Docker network only; no published host port on the LAN or internet), because rate limiting trusts `CF-Connecting-IP` when `TRUST_PROXY_HEADER=cf`.
- **Cloudflare Access must be off**, because the desktop and mobile apps call the API directly; the app does its own auth.

## Backups
- The SQLite DB is backed up with `sqlite3 .backup` or Litestream (never by copying the file while the app is running), together with `/data/files/`, to a destination off the box.
