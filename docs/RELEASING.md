# Releasing NoteApp

Images live at `ghcr.io/devswartz/noteapp` and are built by
`.github/workflows/publish.yml`. The homelab pulls them itself (see `deploy/README.md`).

| Event | Tags pushed | Who runs it |
|---|---|---|
| Merge to `main` | `:staging`, `:sha-<7-char sha>` | staging (auto, within ~5 min) |
| Push tag `vX.Y.Z` | `:vX.Y.Z`, `:prod` | prod |
| Push tag `vX.Y.Z-rc.N` | `:vX.Y.Z-rc.N` only (never `:prod`) | nobody, unless pinned |

`GET /api/health` reports the git SHA the running image was built from.

## Staging
Merge a PR into `main`. CI publishes `:staging`, and the homelab timer
(`noteapp-update@staging.timer`) pulls it within about 5 minutes.
Check: `curl -s https://notes-staging.devswartz.com/api/health`.

## Cut a production release
1. Check that staging is healthy and the build you want is on it. `version` in `/api/health` should match the `main` commit.
2. Tag that commit and push the tag:
   ```sh
   git fetch origin main
   git tag -a v1.2.3 -m "v1.2.3" <sha>    # usually origin/main
   git push origin v1.2.3
   ```
3. Wait for the **Publish image** workflow to finish (Actions tab). It pushes `:v1.2.3` and moves `:prod`.
4. Prod picks it up on the next timer run, or right away with:
   `sudo systemctl start noteapp-update@prod.service`
5. Check: `curl -s https://notes.devswartz.com/api/health`.

Versions follow semver: `vMAJOR.MINOR.PATCH`. Never re-push an existing tag.

## Roll back
On the homelab, pin the previous good tag for that environment:
```sh
cd /opt/noteapp/prod                       # or staging
sudoedit .env                              # NOTEAPP_TAG=v1.2.2  (staging: e.g. sha-abc1234)
docker compose pull && docker compose up -d
```
While a tag is pinned, the timer keeps the environment on it. To resume
tracking, set `NOTEAPP_TAG` back to `prod` / `staging` once the fix is released.

Rollback restores the code only. If the bad release ran a DB migration,
restore `/data` from the backup taken before it (see the homelab docs). New
migrations should stay backward compatible for one release so that a code
rollback alone is safe.

## Run the image locally
```sh
docker run --rm -p 3001:3001 -v noteapp-dev:/data \
  -e JWT_SECRET=dev-only -e PUBLIC_URL=http://localhost:3001 -e SEED_DEMO=1 \
  ghcr.io/devswartz/noteapp:staging
# open http://localhost:3001
```
Build it from source instead:
```sh
docker build --build-arg GIT_SHA=$(git rev-parse --short HEAD) -t noteapp:local .
docker run --rm -p 3001:3001 -v noteapp-dev:/data -e JWT_SECRET=dev-only noteapp:local
```
If the package is private, run `docker login ghcr.io` first with a token that has `read:packages`.
