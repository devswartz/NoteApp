# ChatGPT Directory listing: Notivelo

Copy for the ChatGPT plugin directory (OpenAI's "Plugins" dashboard at https://platform.openai.com/plugins). Checked against OpenAI's pages on 13 Nov 2026:

- Guidelines: https://developers.openai.com/apps-sdk/app-submission-guidelines
- Submission: https://developers.openai.com/plugins/deploy/submission
- Package format: https://developers.openai.com/plugins/build/plugins

The listing is no longer typed into a form. It goes into a ZIP package (`plugin.json` + `mcp.json` + the logo), under `extensions.com.openai.interface`. A ready draft is in [`package/`](package/). The text below is the same as in `package/plugin.json`; if you change one, change the other.

Rules from the guidelines that this copy follows: no "MCP" or "plugin" in the name, no pricing, plans, trials or promotions, no comparisons with other apps, nothing that can't be checked.

## Fields

| Field (`interface.*`) | Value | Count / limit |
|---|---|---|
| `displayName` (name) | Notivelo | 8 / 30 |
| `shortDescription` (subtitle) | Your notes and tasks in chat | 28 / 30 |
| `developerName` | Notivelo | 8 / 80 (the directory shows your *verified* name, see publisher.md) |
| `category` | Productivity | pick from the dashboard list |
| `brandColor` | #4F46E5 | contrast vs white 6.3:1 (needs 2:1) |
| `brandColorDark` | #818CF8 | contrast vs #212121 5.4:1 (needs 2:1) |
| `capabilities` | Read, Write | (Codex field; harmless for ChatGPT) |
| `logo` | `./assets/logo.png` (1024 x 1024) | square, at least 48 px, at most 5 MiB |
| `longDescription` | below | 1,915 / 4,000 |
| `defaultPrompt` | below, 3 prompts | at most 3, each at most 128 |

Keywords: the package format has no keyword field for the directory. The portable manifest has `keywords`, so they are there: `notes, tasks, to-do, notebook, meeting notes, project planning, onenote`.

## Short description (subtitle)

```
Your notes and tasks in chat
```

## Long description

```
Notivelo is a notes and tasks app: workspaces, notebooks, sections and pages, with tasks that live inside your notes. Connect your Notivelo account to ChatGPT to find, read and write your notes from a conversation.

What you can ask ChatGPT to do
- Find notes: search page titles and text across your workspaces, or browse your notebooks, sections and pages.
- Read a page: get a page's text box by box, with the tasks on it and their notes.
- Write notes: create a page in a section, add text to the end of a page or of one text box, or rewrite one text box. Headings, lists, tables and "- [ ]" to-do lines become Notivelo formatting and real tasks.
- Manage tasks: list open or completed tasks, see one task with its subtasks, create a task (on a page, in a workspace, or as a subtask), and tick, reopen, rename, reschedule, reprioritise or reassign it.

Who it is for
People and small teams who keep meeting notes, project plans and to-do lists in Notivelo and want ChatGPT to summarise them, draft new pages, tidy up a page or turn a conversation into tasks.

You stay in control
- You sign in to Notivelo and choose what ChatGPT may do: read only, or read and edit. You can disconnect at any time in Notivelo, Settings > Connected apps.
- ChatGPT acts as you and sees only what you can see in Notivelo.
- It cannot delete anything: no pages, sections, notebooks or tasks.
- Locked pages are never shown to ChatGPT, not even their titles.
- Every change shows in the page's activity as made through ChatGPT, and the page keeps a version from before the change, so you can restore it from Version history.

Limitations
- Images and file attachments are not read or written.
- Very long pages are cut off, with a notice saying so.
- There are limits on how much text can be written at once and how many changes can be made in a short time.
- You need a Notivelo account. You can create one at app.notiveloapp.com.
```

## Example prompts (`defaultPrompt`)

| Prompt | Count |
|---|---|
| Search my Notivelo notes for last week's meeting and summarise the decisions. | 77 |
| Turn the action items from this chat into Notivelo tasks with due dates. | 72 |
| Create a Notivelo page in my Planning section with a project plan for this idea. | 80 |

## URLs

All four are required for an MCP plugin, must be HTTPS, and must load for someone who is not signed in. Checked with `curl` (signed out) on 13 Nov 2026:

| Field | URL | Result |
|---|---|---|
| `websiteURL` | https://notiveloapp.com | 301 to https://app.notiveloapp.com/, which is 200 (sign-in page) |
| `supportURL` | https://app.notiveloapp.com/support | 200 |
| `privacyPolicyURL` | https://app.notiveloapp.com/privacy | 200 |
| `termsOfServiceURL` | https://app.notiveloapp.com/terms | 200 |

Also checked: `https://app.notiveloapp.com/mcp` answers 401 with a pointer to the OAuth metadata (expected, signed out); `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-authorization-server` are 200 JSON; `/api/health` is 200 (`version daa50ed`).

Note: the support, privacy and terms pages are drawn by the web app in the browser (the raw HTML is the app shell, `<title>Notivelo</title>`). They show fine in any browser. If OpenAI's checker ever complains that a page has no text, that is the reason.

The website URL goes to the sign-in page, since notiveloapp.com has no separate marketing page. That is accepted by the guidelines, but a simple landing page would read better in the directory.

## Logo

Exported from `public/icon.svg` by `node scripts/chatgpt-directory-icons.mjs` (re-run it if the icon changes):

| File | What |
|---|---|
| `logo-1024.png` | 1024 x 1024, full-bleed square (indigo background, white page with tick). Use this as `logo`. |
| `logo-512.png` | 512 x 512, same. |
| `logo.svg` | Same design as SVG, square `viewBox` 0 0 512 512 with numeric width/height. |
| `logo-rounded-512.png` | The rounded app icon with transparent corners, only if a rounded file is ever asked for. |

The square version is used because ChatGPT puts its own rounded or circular mask on logos; the page and tick sit well inside the centre, so nothing is cut off. A separate dark logo (`logoDark`) is optional and not needed: the indigo tile reads well on dark backgrounds.

## Commerce

`commerce: false`. Notivelo has no paid plans, subscriptions or in-app purchases (see publisher.md).
