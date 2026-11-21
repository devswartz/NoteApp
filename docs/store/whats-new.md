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

## v1.5.13

- Undo and Redo on iPhone: the buttons are now in the top bar of every note you can edit.
- Fixed: tasks on a note in the Trash can be completed and deleted again.

## v1.5.9

- Deleting task lines from a note now deletes the tasks: select as many as you like and press Delete, just like bullets. Undo brings them back.

## v1.5.8

- Fixed: task lines no longer overlap on iPhone and iPad.
- The save checkmark no longer clutters the toolbar on iPhone.

## v1.5.7

- Hybrid is now the default look: a dark toolbar around a light, paper-like page. You can switch to Light, Dark or System any time in Settings › Appearance.
- Fixed on iPad: the toolbar now sits below the status bar instead of underneath it.

<!--
## v0.5.4

- Example: Pages open faster on iPhone.
- Fixed: …
-->
