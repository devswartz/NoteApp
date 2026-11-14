# Store releases (iOS and Mac App Store)

A tag goes to App Review on both platforms when its release notes say so. Workflow: `.github/workflows/store-submit.yml` (scripts `scripts/store-submit.mjs` and `scripts/store-whats-new.mjs`). There is no approval step in GitHub: the owner authorises each release in chat, and the tag is that authorisation.

## The flow

1. **The owner says in chat** that a release goes to the App Store.
2. **Claude writes the section** `## vX.Y.Z` in `docs/store/whats-new.md` in the release commit (format at the top of that file).
3. **Tag.** `vX.Y.Z` starts the usual builds: `mobile.yml` uploads the iOS build to TestFlight, `mac-app-store.yml` uploads the macOS `.pkg`. It also starts **Store submit**, whose first job shows the What's New text in the run summary.
4. **Submitted automatically.** Each submit job (iOS, macOS) waits for its build of that version to finish processing in App Store Connect (state VALID; up to 90 minutes). Then it reuses the platform's editable version (renamed to the new version number) or creates one, attaches the build, sets What's New, sets **release automatically after approval**, and submits for review. Description, keywords and screenshots stay as they are.
5. **Released automatically** when Apple approves.

**No section, no store release.** A tag whose commit has no section for it still builds for TestFlight; Store submit succeeds, its summary says "No What's New section for vX.Y.Z; not submitted to the App Store", and the submit jobs are skipped. On tag pushes there is no fallback to the CHANGELOG.

**A version still in review is replaced.** If the platform has a version Waiting for Review or In Review (last week's tag, say), its review submission is cancelled, that version goes back to Developer Rejected, and it is renamed and resubmitted with the new build. The run log says so in a warning. It never replaces a newer version with an older one, and never touches a version that is Pending Developer Release or already live (the run stops with an error instead).

**One submission per platform at a time.** A newer tag's submit job queues behind a running one (concurrency group `store-submit-ios` / `store-submit-macos`, never cancelled in progress). GitHub keeps one queued job per group, so if a third tag arrives meanwhile, the middle one is dropped and the newest goes next.

The build is found by version (`CFBundleShortVersionString` = the tag without `v`), and the newest build number of that version is used. Build numbers (`CFBundleVersion`) are each workflow's run number, so iOS and macOS numbers differ; that's fine.

Secrets: the existing repository secrets `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` (Admin key). No environment or other setup.

## Skipping a tag

Don't add a `whats-new.md` section for it. To stop a run that's already waiting for its build, cancel it in Actions before it submits.

## Submitting an older tag, or retrying

Actions → **Store submit** → **Run workflow** on `main`, with `tag` = e.g. `v0.5.4`, platforms both / ios / macos. Its builds must already be in App Store Connect. **dry_run** only reads App Store Connect and logs what it would change. It reads What's New from `main`: the tag's section if there is one, otherwise (with a warning) the version's `CHANGELOG.md` entry or a generic line. This is also how to submit a tag whose section was forgotten: add the section on `main` and run it by hand.

Re-running is safe: a version that's already submitted with the same build, approved or live is left alone.

## What's New

From the version's section in `docs/store/whats-new.md` (format at the top of that file), the same text on both platforms, at most 4000 characters. Only for a manual run without a section is it made from the version's `CHANGELOG.md` entry, keeping only bullets that read as user-facing, or, if most of the entry is developer notes, a generic "Bug fixes and improvements…" line, with a warning. Check it locally:

```bash
node scripts/store-whats-new.mjs v0.5.4 --section-only   # what a tag push uses (exit 3: no section)
node scripts/store-whats-new.mjs v0.5.4 --explain        # manual-run fallback, showing kept/dropped bullets
```

## Still needs a person

- **Screenshots** when the UI changes noticeably (`docs/store/app-store-listing.md` says how they're made). Upload them in App Store Connect before tagging; the job doesn't touch them.
- **Description, keywords, promotional text, privacy answers, age rating**: edited in App Store Connect when needed.
- **App Review**: questions in Resolution Center, rejections (fix, tag a new version with a What's New section), and the review account staying valid.
- **The first macOS version** has no What's New (Apple doesn't allow it); the job notes that and submits anyway.
- **A version Pending Developer Release** (only if someone switched it to manual release) must be released or rejected by hand before the next submission.
- **A failed submit** (missing metadata, a new required screenshot size, an export compliance question) stops with an `::error::` naming the problem: fix it in App Store Connect and run Store submit again for the tag.

Export compliance: `ITSAppUsesNonExemptEncryption = false` is in the iOS app's `Info.plist` and the Mac app's `Info.plist` (Apple reads it from the main app only, not the share extension or widget), so builds don't ask. For a build without it, the job answers "no non-exempt encryption" (HTTPS only) before attaching it.
