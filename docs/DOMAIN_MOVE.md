# Moving to notiveloapp.com

Checklist for the move from the old production host to `notiveloapp.com`. The code
side is in place (apps locked to `https://app.notiveloapp.com`, `REDIRECT_HOSTS`);
everything below is infrastructure and store work. **Merge and release the branch only
after steps 1–3 are done**, because new app builds talk only to the new host.

## 1. DNS (Cloudflare)
- [ ] `app.notiveloapp.com` → the production tunnel (proxied).
- [ ] `staging.notiveloapp.com` → the staging tunnel (proxied).
- [ ] Apex `notiveloapp.com` (and `www`) → a redirect to `https://app.notiveloapp.com` (Cloudflare redirect rule, 301, keep path and query). Not handled by the app.
- [ ] Keep the old production and staging records as they are until step 9.

## 2. TLS and reverse proxy / tunnel
- [ ] Cloudflare Tunnel ingress for `app.notiveloapp.com` → prod container, `staging.notiveloapp.com` → staging container. WebSocket upgrades work through both (`/api/events`, `/collab/…`).
- [ ] Keep the old hosts' ingress pointing at the same containers (old app builds still call them).
- [ ] Certificates cover both new names (Cloudflare edge certificate; Full (strict) to the origin if used). Cloudflare Access stays **off** on all of them.
- [ ] Check: `curl -s https://app.notiveloapp.com/api/health` and the same for staging.

## 3. Server environment (`/opt/noteapp/{prod,staging}/.env`)
- [ ] `PUBLIC_URL=https://app.notiveloapp.com` (staging: `https://staging.notiveloapp.com`). Links in emails, invites, calendar feeds, OAuth issuer and OneNote callback all come from it.
- [ ] `MAIL_FROM=Notivelo <no-reply@notiveloapp.com>`.
- [ ] `REDIRECT_HOSTS=<the old production host>` on prod (staging: the old staging host). Browser page loads there get a 301 to the new host; API, sockets, uploads, `/mcp`, `/oauth` and `/.well-known` keep working there.
- [ ] Optional: `LEGAL_CONTACT_EMAIL` / `LEGAL_OPERATOR_NAME` only if they should differ from `support@notiveloapp.com` / `Notivelo`.
- [ ] Restart (`docker compose up -d`) and check: `curl -sI https://<old production host>/` → `301` to `https://app.notiveloapp.com/`; `curl -s https://<old production host>/api/health` → `200`.

## 4. Email
- [ ] Verify `notiveloapp.com` in SES (or the SMTP provider): DKIM CNAMEs in Cloudflare DNS.
- [ ] SPF (`v=spf1 include:amazonses.com ~all`, merged with any existing record) and, if using a custom MAIL FROM domain, its MX/SPF.
- [ ] DMARC (`_dmarc.notiveloapp.com`, start with `p=none; rua=…`, tighten later).
- [ ] Create the `support@notiveloapp.com` mailbox (or forward) and check someone reads it. `no-reply@` needs no inbox.
- [ ] Send a password reset on staging and prod; check it arrives and passes DKIM/SPF.

## 5. Microsoft (OneNote import)
- [ ] Entra app registration → Authentication → Web redirect URIs: add `https://app.notiveloapp.com/api/import/onenote/callback` and `https://staging.notiveloapp.com/api/import/onenote/callback`. Remove the old ones in step 9.

## 6. CI
- [ ] Repository variable **`LEGACY_PROD_HOSTS`** = the old production host name (no scheme), so app builds keep existing sign-ins on upgrade (`docs/RELEASING.md`). Without it everyone signs in once after updating.
- [ ] The deploy check in `ci.yml` now waits on the new hosts: they must answer before the next merge/tag.

## 7. Stores
- [ ] App Store Connect: Support URL `https://app.notiveloapp.com/support`, Privacy Policy URL `https://app.notiveloapp.com/privacy`, marketing URL if set; App Privacy unchanged.
- [ ] Review notes: the reviewer account signs in on `https://app.notiveloapp.com` (re-run `scripts/seed-review-account.ts` with `BASE_URL=https://app.notiveloapp.com` if needed); mention there is no server choice any more.
- [ ] Play Console: store listing website, email `support@notiveloapp.com`, privacy policy URL; Data safety unchanged.
- [ ] Associated domains / app links: once the new build is out, check `https://app.notiveloapp.com/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` return `200` JSON, and that a `/w/…` link opens the app on a device.

## 8. People
- [ ] AI connector users (ChatGPT, Claude, …) must remove and re-add the connector with `https://app.notiveloapp.com/mcp`: the token's resource is tied to the server URL. Say so in the release notes.
- [ ] Update bookmarks / docs you control; the README and in-app links already point to the new host.

## 9. Retiring the old host
Keep the old production host (redirect + API) until nearly everyone runs an app version
from this release: at least one full release cycle after it is live in the stores and the
desktop auto-update has shipped it, and until the server logs show little or no `/api`
traffic on the old host. Then:
- [ ] Remove `REDIRECT_HOSTS`, the old tunnel ingress and DNS (or leave a plain Cloudflare redirect to the new host).
- [ ] Remove the old OneNote redirect URIs and the old domain's mail records if no longer used.
- [ ] Clear `LEGACY_PROD_HOSTS` once no supported app version can still have it saved.
