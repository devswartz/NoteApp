# Store releases (iOS and Mac App Store)

Every `vX.Y.Z` tag can go to App Review on both platforms with one click. Workflow: `.github/workflows/store-submit.yml` (scripts `scripts/store-submit.mjs` and `scripts/store-whats-new.mjs`).

## The flow

1. **Tag.** `vX.Y.Z` starts the usual builds: `mobile.yml` uploads the iOS build to TestFlight, `mac-app-store.yml` uploads the macOS `.pkg`. It also starts **Store submit**.
2. **Read and approve.** Store submit's first job puts the What's New text in the run summary. The two submit jobs (iOS, macOS) then wait for the `app-store` environment: open the run → **Review deployments** → tick `app-store` → **Approve and deploy**. One approval covers both platforms.
3. **Submitted.** Each job waits for its build of that version to finish processing in App Store Connect (state VALID; up to 90 minutes, so approving straight after tagging is fine). Then it reuses the platform's editable version (renamed to the new version number) or creates one, attaches the build, sets What's New, sets **release automatically after approval**, and submits for review. Description, keywords and screenshots stay as they are.
4. **Released.** When Apple approves, the version goes live by itself.

**A version still in review is replaced.** If the platform has a version Waiting for Review or In Review (last week's tag, say), its review submission is cancelled, that version goes back to Developer Rejected, and it is renamed and resubmitted with the new build. The run log says so in a warning. It never replaces a newer version with an older one, and never touches a version that is Pending Developer Release or already live (the run stops with an error instead).

The build is found by version (`CFBundleShortVersionString` = the tag without `v`), and the newest build number of that version is used. Build numbers (`CFBundleVersion`) are each workflow's run number, so iOS and macOS numbers differ; that's fine.

## One-time setup

1. **Settings → Environments → New environment** named `app-store` (the workflow creates it on its first run if it's missing, but without protection, so set it up first).
2. **Required reviewers:** add yourself. Without this the jobs don't wait, and every tag is submitted straight away.
3. **Deployment branches and tags → Selected branches and tags → Add rule:** tag `v*`. Then only release tags can use the environment (and its approval).
4. Secrets: the existing repository secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (Admin key). Nothing new.

## Skipping a tag

Reject the deployment (**Review deployments** → **Reject**), or just leave it: nothing is sent to Apple until you approve. The build stays in TestFlight. Note that a newer tag's submit job queues behind an unapproved older one for the same platform, so reject a tag you're skipping rather than leaving it.

## Submitting an older tag, or retrying

Actions → **Store submit** → **Run workflow** on `main`, with `tag` = e.g. `v0.5.4`, platforms both / ios / macos. Its builds must already be in App Store Connect. **dry_run** only reads App Store Connect and logs what it would change. The run still needs the approval. It reads What's New from `main`, so this is also how to fix the text of a tag that's already pushed: add its section to `docs/store/whats-new.md` on `main`, reject the tag's run, and run it by hand.

Re-running is safe: a version that's already submitted with the same build, approved or live is left alone.

## What's New

From the version's section in `docs/store/whats-new.md` (format at the top of that file), the same text on both platforms, at most 4000 characters. Without a section it's made from the version's `CHANGELOG.md` entry, keeping only bullets that read as user-facing. If most of the entry is developer notes, it falls back to a generic "Bug fixes and improvements…" line with a warning. Check it locally:

```bash
node scripts/store-whats-new.mjs v0.5.4 --explain
```

## Still needs a person

- **Screenshots** when the UI changes noticeably (`docs/store/app-store-listing.md` says how they're made). Upload them in App Store Connect before approving; the job doesn't touch them.
- **Description, keywords, promotional text, privacy answers, age rating**: edited in App Store Connect when needed.
- **App Review**: questions in Resolution Center, rejections (fix, tag a new version, approve again), and the review account staying valid.
- **The first macOS version** has no What's New (Apple doesn't allow it); the job notes that and submits anyway.
- **A version Pending Developer Release** (only if someone switched it to manual release) must be released or rejected by hand before the next submission.
- **A failed submit** (missing metadata, a new required screenshot size, an export compliance question) stops with an `::error::` naming the problem: fix it in App Store Connect and run Store submit again for the tag.

Export compliance: `ITSAppUsesNonExemptEncryption = false` is in the iOS app's `Info.plist` and the Mac app's `Info.plist` (Apple reads it from the main app only, not the share extension or widget), so builds don't ask. For a build without it, the job answers "no non-exempt encryption" (HTTPS only) before attaching it.
