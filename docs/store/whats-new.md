# What's New (App Store release notes)

The text App Store Connect shows under "What's New in This Version", for iOS and macOS alike. **A section here is what makes a tag a store release:** when a `vX.Y.Z` tag is pushed, `.github/workflows/store-submit.yml` submits both App Store versions for review only if this file, in the tagged commit, has a section for that tag. No section: the builds go to TestFlight as usual and nothing is submitted. See `docs/STORE_RELEASES.md`.

How a store release happens: the owner says in chat that the release goes to the App Store → Claude writes the section in the release commit → tag → submitted automatically → released automatically once Apple approves.

Format:

- One section per version, headed `## v0.5.4` (the tag). Everything up to the next `##` heading is the text.
- Write for people using the app: what's new and what's fixed, in plain words. No PR numbers, file names, server or CI notes.
- Plain text. `- ` bullets become `•`; bold, italics, links and code marks are removed (the App Store shows no formatting).
- At most 4000 characters; a longer section fails the run. HTML comments (`<!-- -->`) are ignored, so a commented-out section doesn't count.
- Check it with `node scripts/store-whats-new.mjs v0.5.4 --section-only`.

Only a manual **Store submit** run (an older tag) falls back, when a section is missing, to that version's `CHANGELOG.md` entry (user-facing bullets only) or a generic line, with a warning.

Newest version first.

<!--
## v0.5.4

- Example: Pages open faster on iPhone.
- Fixed: …
-->
