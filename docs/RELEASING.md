# Releasing NoteApp

Images live at `ghcr.io/devswartz/noteapp` and are built by
`.github/workflows/publish.yml`. The homelab pulls them itself (see `deploy/README.md`).

| Event | Tags pushed | Who runs it |
|---|---|---|
| Merge to `main` | `:staging`, `:sha-<7-char sha>` | staging (auto, within ~5 min) |
| Push tag `vX.Y.Z` | `:vX.Y.Z`, `:prod` | prod |
| Push tag `vX.Y.Z-rc.N` | `:vX.Y.Z-rc.N` only (never `:prod`) | nobody, unless pinned |

`GET /api/health` reports the git SHA the running image was built from.

Images are published by the `publish` job in the **CI** workflow
(`.github/workflows/ci.yml`, which calls `publish.yml`), and only after `check`,
`docker` and `e2e` pass. To re-publish `:staging` by hand, run **Publish image**
from the Actions tab on `main`. Note that this skips CI, and runs on any other
branch do nothing.

A version tag `vX.Y.Z` also starts the **Desktop** workflow (macOS/Windows
installers in a draft GitHub Release; see `docs/DESKTOP.md`) and the **Mobile**
workflow (Android build, iOS build, TestFlight when its secrets exist; see
`docs/MOBILE.md`). They run independently of the image and don't block it.
Pre-release tags (`vX.Y.Z-rc.N`) start them too. `mobile-vX.Y.Z` builds only
the mobile apps.

## Staging
Merge a PR into `main`. CI publishes `:staging`, and the homelab timer
(`noteapp-update@staging.timer`) pulls it within about 5 minutes.
Check: `curl -s https://staging.notiveloapp.com/api/health`.

## Cut a production release
1. Check that staging is healthy and the build you want is on it. `version` in `/api/health` should match the `main` commit.
2. Tag that commit and push the tag:
   ```sh
   git fetch origin main
   git tag -a v1.2.3 -m "v1.2.3" <sha>    # usually origin/main
   git push origin v1.2.3
   ```
3. Wait for the **CI** run for the tag to finish (Actions tab): `check` → `docker` → `e2e` → `publish`. The `publish` job pushes `:v1.2.3` and moves `:prod`; if any check fails, nothing is published.
4. Prod picks it up on the next timer run, or right away with:
   `sudo systemctl start noteapp-update@prod.service`
5. Check: `curl -s https://app.notiveloapp.com/api/health`.

6. Desktop: check the **Desktop** run, review its draft release, and **publish** it. That's what ships the update to installed apps.
7. App Store (iOS and macOS): check the What's New text in the **Store submit** run's summary and approve the `app-store` environment. It submits both for review and they release automatically once Apple approves. See `docs/STORE_RELEASES.md`.

Versions follow semver: `vMAJOR.MINOR.PATCH`. Never re-push an existing tag.
The first release, with every one-time setup step, is walked through in `docs/LAUNCH_CHECKLIST.md`.

## App builds are locked to the production server
Release builds of the iPhone, Android and desktop apps always talk to
`https://app.notiveloapp.com` (`src/platform/serverUrl.ts`, `apps/desktop/src-tauri/src/config.rs`).
Only debug builds and internal builds have a hidden **Change server…**: mobile with the
Mobile workflow's **allow_server_switch** input (`MOBILE_ALLOW_SERVER_SWITCH=1`), desktop when
compiled with `NOTEAPP_ALLOW_SERVER_SWITCH=1`. Never ship an internal build to the stores.

Older versions let people pick a server and saved it. On its first start a release build
forgets that choice. If the saved server was production under one of its *old* host names,
the sign-in is kept; for any other server the app signs out. The old names are not in the
code: set the repository variable (or secret) **`LEGACY_PROD_HOSTS`** to a comma-separated list
of host names (no scheme or path) before building. The Mobile and Desktop workflows pass it to
the build (`VITE_LEGACY_PROD_HOSTS` for mobile, compiled into the desktop app). Empty means
nobody's sign-in is kept: everyone who upgrades signs in once. See `docs/DOMAIN_MOVE.md`.

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
