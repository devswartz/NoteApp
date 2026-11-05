# deploy/ — homelab templates

Templates for running NoteApp on the homelab, built to `docs/DEPLOY_CONTRACT.md`.
The homelab agent (`docs/HOMELAB_BRIEF.md`) copies these onto the box; nothing
here contains secrets.

| File | Goes to | Purpose |
|---|---|---|
| `compose.yaml` | `/opt/noteapp/<env>/compose.yaml` | One environment. Same file for staging and prod. |
| `.env.example` | `/opt/noteapp/<env>/.env` (mode 600) | Every contract variable plus `NOTEAPP_ENV`, `NOTEAPP_TAG`, `HOST_PORT`. |
| `systemd/noteapp-update@.service` | `/etc/systemd/system/` | `docker compose pull && docker compose up -d` for `/opt/noteapp/<env>`. |
| `systemd/noteapp-update@.timer` | `/etc/systemd/system/` | Runs the service every 5 minutes. |

## Set up one environment

```sh
sudo mkdir -p /opt/noteapp/staging && cd /opt/noteapp/staging
sudo cp <repo>/deploy/compose.yaml .
sudo cp <repo>/deploy/.env.example .env && sudo chmod 600 .env
sudoedit .env        # NOTEAPP_ENV, NOTEAPP_TAG, HOST_PORT, PUBLIC_URL, JWT_SECRET, SMTP_*, VAPID_*
docker login ghcr.io # token with read:packages only (the package may be private)
docker compose pull && docker compose up -d
docker compose ps    # wait for "healthy"
```

| | staging | prod |
|---|---|---|
| `NOTEAPP_ENV` | `staging` | `prod` |
| `NOTEAPP_TAG` | `staging` | `prod` |
| `HOST_PORT` (cloudflared → `http://127.0.0.1:<port>`) | `3002` | `3001` |
| `PUBLIC_URL` | `https://notes-staging.devswartz.com` | `https://notes.devswartz.com` |
| `SEED_DEMO` | `1` | remove |

Each environment gets its own compose project (`noteapp-staging` / `noteapp-prod`)
and so its own named volume for `/data`.

## Auto-update

```sh
sudo cp <repo>/deploy/systemd/noteapp-update@.* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now noteapp-update@staging.timer
# prod: enable the timer too (it only changes when a vX.Y.Z tag moves :prod),
# or update by hand:  sudo systemctl start noteapp-update@prod.service
```

`docker compose up -d` only recreates the container when the pulled image is
new, so an idle timer run does nothing.

## Notes
- **Cloudflare Tunnel** must allow WebSocket upgrade (`/collab/*`, `/api/events`) and **Access must be off**.
- **Backups:** the DB is `/data/noteapp.db` (WAL mode) and attachments are in `/data/files/`. Use `sqlite3 .backup` or Litestream, never a plain file copy while running.
  One way to take a consistent copy from the host: `docker compose exec app node -e "new (require('better-sqlite3'))('/data/noteapp.db').backup('/data/backup.db').then(()=>console.log('ok'))"`, then copy `backup.db` off the volume.
- **Rollback / releases:** see `docs/RELEASING.md`.
