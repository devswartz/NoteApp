# What's New (App Store release notes)

The text App Store Connect shows under "What's New in This Version", for iOS and macOS alike. `.github/workflows/store-submit.yml` reads it when a `vX.Y.Z` tag is submitted (`scripts/store-whats-new.mjs`), and shows it in the run summary before you approve.

Format:

- One section per version, headed `## v0.5.4` (the tag). Everything up to the next `##` heading is the text.
- Write for people using the app: what's new and what's fixed, in plain words. No PR numbers, file names, server or CI notes.
- Plain text. `- ` bullets become `•`; bold, italics, links and code marks are removed (the App Store shows no formatting).
- At most 4000 characters; a longer section fails the run. HTML comments (`<!-- -->`) are ignored.
- Put the section in the commit you tag. To fix the text of a tag already pushed, add it on `main` and run **Store submit** by hand for that tag (see `docs/STORE_RELEASES.md`).

No section for a version: the text is made from that version's `CHANGELOG.md` entry, keeping only user-facing bullets (first sentence or two of each). If the entry is mostly developer notes, a generic line is used instead and the run shows a warning.

Newest version first.

<!--
## v0.5.4

- Example: Pages open faster on iPhone.
- Fixed: …
-->
