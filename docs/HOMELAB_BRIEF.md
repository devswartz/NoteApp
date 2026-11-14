# Starting prompt for the homelab agent

Paste everything below the line into the homelab agent's session.

---

You're setting up hosting on my homelab for **NoteApp**, a collaborative notes and tasks web app (repo: `github.com/devswartz/NoteApp`). Other agents are building the app right now. Your job is the infrastructure side only. **Don't change the app code.**

The interface between the app and the homelab is fixed in the repo at `docs/DEPLOY_CONTRACT.md` (on the `main` branch). Read it first and follow it exactly: image names, port, `/data` volume, environment variables, health check and hostnames. If something in it won't work on the homelab, write the problem in your summary and tell me, rather than working around it on your own.

## Decisions already made
- Hosting: a dedicated **Proxmox LXC** running **Docker Compose**.
- Two environments on that box: **staging** (`staging.notiveloapp.com`, follows the `:staging` image) and **production** (`app.notiveloapp.com`, follows the `:prod` image). Each gets its own `/data` volume and its own secrets.
- Ingress: **Cloudflare Tunnel** to the container port. WebSockets must work. **Cloudflare Access must be off** for these two hostnames.
- Deploys are **pull-based**: CI pushes images to GHCR, and the homelab pulls them itself. No inbound access to my network, and no homelab secrets stored in GitHub. Auto-update staging (e.g. a systemd timer every 5 minutes running `docker compose pull && docker compose up -d`, or Watchtower limited to these containers). Production updates when the `:prod` tag changes, on the **same timer** (not by hand): the apps update themselves on release, so prod must follow. CI checks this after each release (the `verify deploy` job).
- Email: **AWS SES**, through its SMTP interface.

## Tasks
1. **LXC + Docker:** create the container (pick a sensible CTID/host and tell me which) with Docker + Compose, set to start on boot. Put the compose files in something like `/opt/noteapp/{staging,prod}/`.
2. **GHCR access:** configure `docker login ghcr.io` with a token that has only `read:packages`. Ask me for the token if you don't have one, and never print it in logs or summaries.
3. **Compose stacks:** one per environment, following the contract: volume mounted at `/data`, restart `unless-stopped`, a healthcheck on `/api/health`, and secrets in a `.env` file with mode 600 that is never committed anywhere. Generate `JWT_SECRET` and the VAPID keys per environment. Set `SEED_DEMO=1` on staging only.
   - The image may not be published yet when you start. If `ghcr.io/devswartz/noteapp:staging` doesn't exist, run a placeholder container on the same port so you can finish the tunnel and health check setup, then switch once the image appears. Tell me if it still hasn't appeared after setup.
4. **Cloudflare Tunnel:** add `app.notiveloapp.com` and `staging.notiveloapp.com`, check that WebSocket upgrade works through them, and confirm Access is not enforced.
5. **AWS SES:**
   - Verify the `notiveloapp.com` domain, with DKIM records in Cloudflare DNS, plus SPF and DMARC records if they aren't already present. Don't break any existing mail records; check them first.
   - Create an IAM user limited to `ses:SendRawEmail`, generate SMTP credentials for it, and put them in both `.env` files (`SMTP_HOST`, `SMTP_PORT=587`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM=NoteApp <no-reply@notiveloapp.com>`).
   - Request production access to leave the SES sandbox. If that's pending, note that sandbox mode only delivers to verified addresses, and verify mine for now.
6. **Backups:** for each environment, a consistent SQLite backup (`sqlite3 .backup` or Litestream; never a plain copy of the file while it's running) plus `/data/files/`, kept somewhere off the box. Ask me where if you don't know. Keep 14 daily and 8 weekly copies. **Do one test restore** into a scratch directory and confirm the DB opens.
7. **Monitoring (light):** an uptime check on both `/api/health` URLs, alerting however my other homelab services already alert.

## When you're done
Write a summary for me (and the NoteApp manager agent) with:
- the host/CTID and paths
- how updates are deployed, and the one command to force an update or roll back
- how to read logs
- where backups go, and the restore steps
- SES status (verified? in the sandbox?)
- anything in `docs/DEPLOY_CONTRACT.md` you needed changed

No secret values in the summary. If you have push access to the NoteApp repo, open a PR adding this summary as `docs/HOMELAB.md`, with no secrets and no internal IPs unless I say that's fine. Otherwise give me the text and I'll pass it on.
