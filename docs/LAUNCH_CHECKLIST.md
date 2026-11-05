# Launch checklist: v0.1.0

One ordered list from "code on `main`" to staging, production v0.1.0, and the desktop and mobile apps. Tick each step off. Details live in the linked docs; this page only says what to do and in which order.

Written 2026-11-05 against `main` at the docs merge (#65). Items marked **(open PR)** depend on PRs that weren't merged yet; skip or revisit them.

---

## 1. Repository settings (GitHub, ~5 min)

- [ ] **Default branch → `main`.** Settings → General → Default branch (it's still `claude/initial-app`). Without this, the *Desktop* workflow can't be run by hand. GitHub only offers "Run workflow" for dispatch-only workflows on the default branch.
- [ ] **Branch protection for `main`.** Settings → Branches (or Rules → Rulesets) → add a rule for `main`:
  - require a pull request before merging;
  - require status checks to pass: **`check`**, **`docker`**, **`e2e`** (all jobs of the *CI* workflow). Don't require `publish`: it only runs on pushes. Don't require *Mobile* or *Desktop* either: they only run for some PRs, or only on tags.
  - require branches to be up to date before merging (recommended: the merge queue already merges `main` in before merging);
  - block force pushes and deletion.
- [ ] Optional: delete the old `claude/initial-app` branch once nothing points at it.

## 2. Homelab: apply the deploy contract changes (~15 min)

The homelab agent was briefed with `docs/HOMELAB_BRIEF.md` at 03:18 UTC. Since then `docs/DEPLOY_CONTRACT.md` changed (commit `e758896`), and a few open PRs add optional variables.

**Message for the homelab agent** (copy it, or re-run the agent with the brief plus this list):

> The deploy contract changed. Please apply this to **both** staging and prod and report back:
>
> 1. **Port exposure rule (new, required):** the app port must be reachable **only through cloudflared**. No published host port on the LAN or internet; bind to `127.0.0.1` or the Docker network only. `deploy/compose.yaml` already binds `127.0.0.1:${HOST_PORT}`; confirm nothing else (firewall rules, a second compose file, a reverse proxy) exposes it.
> 2. **`TRUST_PROXY_HEADER=cf`** in both `.env` files. Rate limiting then reads the client IP from `CF-Connecting-IP`. Only safe because of rule 1. Harmless before the rate-limit PR (#43) lands.
> 3. **`ACCESS_TOKEN_TTL_S`:** leave **unset** (default 900 s; production clamps it to 60–3600).
> 4. **iOS push (when the iOS app ships):** `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID=com.devswartz.notivelo`, `APNS_PRIVATE_KEY` (the `.p8` contents, newlines as `\n`) and `APNS_ENV=production`. The values come from the user (see `docs/MOBILE.md` → *Server environment*).
> 5. **Android push (when the Android app ships):** `FCM_SERVICE_ACCOUNT_JSON` (the Firebase service-account JSON, one line or base64).
> 6. **App links (#57):** `ANDROID_CERT_SHA256` (comma-separated SHA-256 fingerprints of the Play app-signing and upload certs). `APNS_TEAM_ID` (or `APPLE_TEAM_ID`) is used for the iOS `apple-app-site-association`. Verify with `curl -i https://notes.devswartz.com/.well-known/assetlinks.json` and `…/apple-app-site-association` (200, `application/json`, no redirect).
> 7. **`ADMIN_EMAILS=<the user's email>` on staging AND prod, before anyone signs up** (#67). Without it, **the first account created becomes the instance admin** (who may call `GET /api/admin/stats`). Comma-separated if there's more than one admin. Admins can always sign up.
> 7b. **`SIGNUP_MODE`:** leave **unset**. In production it defaults to `invite`: only people with a pending invite, plus the addresses in `ADMIN_EMAILS`, can create accounts. Set `SIGNUP_MODE=open` only if you ever want public sign-up, and only after working through section 5b (open sign-up needs email confirmation, which needs SMTP). Logs also become one JSON object per line; `LOG_LEVEL` is optional (default `info`).
> 7c. **`MAIL_FROM` on prod (and staging) should say Notivelo**, e.g. `Notivelo <notes@devswartz.com>`. It is the sender name on invites and password resets and is set per environment in `.env`, so the rename alone doesn't change it. The address must stay one the SMTP provider has verified.
> 8. **Staging only, optional:** `DEMO_PASSWORD=<something>` so the `SEED_DEMO` accounts (`demo@example.com`, `sam@example.com`) have a known password instead of a random one printed once in the log. With #70, the *Demo Team* workspace shows off every feature (a notebook per area, every block type, subtasks, recurrence, links, comments, versions, a private notebook), which makes it a good tour for the team on staging.
> 9. Unchanged from the brief: `NODE_ENV`, `PUBLIC_URL`, `JWT_SECRET` (per env), the SES SMTP settings (`SMTP_HOST`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`), VAPID (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`), `SEED_DEMO=1` on staging only, backups (`sqlite3 .backup` or Litestream, plus `/data/files/`, off the box), Cloudflare Access **off**.
>
> `deploy/.env.example` lists all of these as commented lines.

- [ ] Homelab agent confirms: `ADMIN_EMAILS` set on both environments **before the first sign-up**, port only via cloudflared, `TRUST_PROXY_HEADER=cf` set, both stacks restarted, and backups running with one test restore done.
- [ ] **SES:** out of the sandbox, or your address verified, so invite emails arrive. If it's still in the sandbox, only verified addresses receive mail.

## 3. Verify staging (~15 min)

Staging follows `main` automatically: CI's `publish` job pushes `:staging`, and the homelab timer pulls it within about 5 minutes.

- [ ] **Health:** `curl -s https://notes-staging.devswartz.com/api/health` → `{"ok":true,"version":"<sha>"}`, where `<sha>` matches the latest `main` commit (`git rev-parse --short origin/main`).
- [ ] **Security headers:** `curl -sI https://notes-staging.devswartz.com/ | grep -iE "strict-transport|content-security"` shows both (#51).
- [ ] **Sign up** (only after `ADMIN_EMAILS` is set, section 2) with your real email in a private window, check that you land in your workspace, then sign out and back in.
- [ ] **Invite-only sign-up:** in a private window, try to create an account with an address that has **no** invite. It's refused.
- [ ] **Invite email (SES):** Settings → Members → invite a second address you own as *Member*. The email arrives (check spam), the link opens the invite page, and signing up with that address works and joins the workspace. If no email arrives, check the staging log for `mail:` warnings and the SES sending statistics.
- [ ] **Web push reminder:**
  1. Settings → Notifications → allow notifications in the browser.
  2. Create a task due today, with a reminder 2 minutes from now (task details → Reminders).
  3. Leave the tab in the background. A system notification appears within about 20 s of the time; *Snooze 10 min* works.
  4. If nothing comes, check that the VAPID variables are set (the log says "Web push is disabled" when they aren't).
- [ ] **Email reminder / digest (optional):** Settings → Notifications → turn on the daily digest for a time a few minutes away; the email arrives.
- [ ] **Real time:** open the same page in two browsers (two accounts in a shared notebook). Typing and cursors show live, and checking a task in one updates the other.
- [ ] **Offline:** open a page, go offline (DevTools → Network → Offline), and reload. The app still opens and the page is editable. Go back online and the edit syncs.
- [ ] **Run the e2e suite against staging** (optional, from a laptop): `E2E_BASE_URL=https://notes-staging.devswartz.com npx playwright test --project=chromium`. Note that it creates test accounts on staging.

## 4. Production v0.1.0 (~10 min)

- [ ] Staging has passed section 3 on the exact commit you're releasing.
- [ ] **Prod `.env`:** `SEED_DEMO` removed (or `0`), its own `JWT_SECRET` and VAPID keys (never staging's), and `ADMIN_EMAILS` set.
- [ ] **Tag it** (see `docs/RELEASING.md` → *Cut a production release*):
  ```sh
  git fetch origin main
  git tag -a v0.1.0 -m "v0.1.0" origin/main
  git push origin v0.1.0
  ```
  The tag starts three workflows:
  - **CI**: `check` → `docker` → `e2e` → `publish`, which pushes `:v0.1.0` and moves `:prod`;
  - **Desktop**: a draft GitHub Release with the macOS/Windows installers (section 5);
  - **Mobile**: the Android APK/AAB and the iOS build, uploaded to TestFlight if its secrets exist (section 5).
- [ ] Wait for the CI run's `publish` job to go green. Prod pulls `:prod` on its next timer run, or right away with `sudo systemctl start noteapp-update@prod.service`.
- [ ] `curl -s https://notes.devswartz.com/api/health` → `"version"` matches the tagged commit.
- [ ] Check that `ADMIN_EMAILS` is set in prod's `.env` (otherwise the first account to sign up becomes the instance admin). Then sign up with your real email, create the team workspace, and invite the team.
- [ ] Move `CHANGELOG.md`'s `v0.1.0 (unreleased)` heading to `v0.1.0 (2026-11-xx)` in a small PR.

Rollback: `docs/RELEASING.md` → *Roll back* (pin `NOTEAPP_TAG` to the previous tag; restore `/data` if a migration ran).

## 5. Desktop and mobile apps

**Desktop (macOS + Windows)**: [`docs/DESKTOP.md` → First signed Mac build: checklist](DESKTOP.md#first-signed-mac-build-checklist).
- [ ] Add the 7 secrets and 1 variable listed there:
  - Developer ID `.p12` and its password;
  - App Store Connect API key for notarisation;
  - Tauri updater key and its public key.
- [ ] The `v0.1.0` tag (section 4) builds them. Download `Notivelo_0.1.0_universal.dmg` from the draft release, then check `spctl -a -vv` and `xcrun stapler validate`.
- [ ] **Publish the draft release.** Installed apps only see updates from published releases.
- Without the secrets the tag still builds **unsigned** installers: right-click → Open on a Mac, SmartScreen on Windows, and no auto-update.

**Mobile (iPhone + Android)**: [`docs/MOBILE.md` → Secrets and accounts](MOBILE.md#secrets-and-accounts).
- [ ] Apple, one-time:
  - register the bundle ids and App Group;
  - create the app in App Store Connect;
  - create an **APNs key** (for the server, section 2) and an **App Store Connect API key** with the *Admin* role (for CI).
- [ ] GitHub secrets for TestFlight: `APPLE_TEAM_ID`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8`.
- [ ] Android:
  - create a Firebase project and add `FIREBASE_GOOGLE_SERVICES_JSON`;
  - add the upload keystore secrets: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`;
  - create the app in the Play Console and upload the first `.aab` by hand to internal testing.
- [ ] Server push variables on prod (section 2, items 4–6).
- [ ] Ship: the `v0.1.0` tag (or `mobile-v0.1.0`, or *Mobile* → Run workflow with TestFlight ticked) uploads to TestFlight. Add testers in App Store Connect.
- [ ] On a phone: sign in, get a push reminder, share text into the app, add the Today widget.

## 5b. Opening sign-up to the public (optional, later)

Production stays `SIGNUP_MODE=invite` (the default) until you decide otherwise. With `SIGNUP_MODE=open`, new accounts must **confirm their email address** before they can use the app, so open sign-up only works properly with working outgoing mail. In order:

- [ ] **Admin accounts exist first.** Sign up every address in `ADMIN_EMAILS` (they're auto-confirmed as bootstrap accounts) **before** switching to `open`, so nobody else can register one of those addresses first.
- [ ] **SMTP works.** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` are set on prod and SES is out of the sandbox (or the test recipients are verified). Check with an invite or a password reset to an address you own: it arrives.
- [ ] **`MAIL_FROM` is a verified sender**, named for the product (e.g. `Notivelo <notes@devswartz.com>`). If the provider rejects the sender, no confirmation email goes out and new people are stuck on "Check your email".
- [ ] **`PUBLIC_URL` is the real origin**, because the confirmation link is `$PUBLIC_URL/verify-email?token=…`.
- [ ] **Then set `SIGNUP_MODE=open`** and restart. Test in a private window: create an account with an address you own; you land on "Check your email"; the email arrives (check spam); the link opens the app; **Resend** works (one a minute); the app is unusable until the link is opened.
- [ ] **Without SMTP, do not set `open` in production**: with no `SMTP_HOST` the server cannot send mail, so it treats every new account as confirmed. Anyone could then register any address, including one that has a pending workspace invite, and read what that invite grants. (`invite` mode is unaffected: it needs an invite either way.)

- [ ] **Know the clean-up.** Accounts that are still unconfirmed after 7 days (`UNVERIFIED_ACCOUNT_DAYS`, optional) are deleted by the housekeeping job, which logs one `unverified account cleanup` line per run (counts only). A password reset also confirms the account. Admin addresses in `ADMIN_EMAILS` are never deleted. `legal/privacy.md` should say unconfirmed accounts are deleted after 7 days.

Existing accounts are all treated as confirmed by the upgrade (migration 012), so nobody is locked out.

## 6. Known limitations and follow-ups

As of 2026-11-05 ~11:55 UTC (`docs/STATUS.md`, open PRs).

**Security notes**
- **Sign-up is invite-only in production** (#67, `SIGNUP_MODE=invite` by default). Only invited emails and `ADMIN_EMAILS` can register. Local development stays open.
- **Auth endpoints are rate-limited** (#43): per IP and per account, with 429 + Retry-After. This relies on `TRUST_PROXY_HEADER=cf` and the port rule in section 2.

**In flight (open PRs, expected to land soon)**
- Hardening: input limits (#46); authorization audit with a route coverage check (#49).
- Activity feed (#33), follow a collaborator (#39), presence avatars (#23).
- Editor:
  - export to Markdown/PDF and Markdown import (#44);
  - table of contents and full-width pages (#53);
  - long-page performance (#58);
  - undo of convert-to-task (#60);
  - accessibility (#68).
- Web icon set and favicons (#73); editor E2E (#72).

**Known gaps (not planned for v0.1.0)**
- Desktop and mobile builds have **never run on real macOS/Windows/iOS hardware**. The first tag is their first real build, so watch those workflow runs.
- Desktop: no Windows code signing (SmartScreen warns), and no taskbar badge on Windows (the tray tooltip has the count).
- Mobile: the server is chosen on first launch (default `https://notes.devswartz.com`; **Change server…** in ⌘K), like the desktop app (#57).
- Tasks are read-only offline (notes are fully editable offline).
- Deferred by `PLAN.md`: freeform canvas pages, Google/Apple two-way calendar sync (a one-way `.ics` feed exists), public share links, page-level permissions, AI features.
- **Usage limits:** the agent team hit the account's 5-hour usage cap at 06:25 UTC and lost about 4 hours. Run fewer agents in parallel for follow-up work.
