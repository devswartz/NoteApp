# ChatGPT Directory submission checklist

Everything for submitting Notivelo's connector (https://app.notiveloapp.com/mcp) to the ChatGPT directory, in order. Checked against OpenAI's pages on 13 Nov 2026:

- Guidelines: https://developers.openai.com/apps-sdk/app-submission-guidelines
- Submission steps: https://developers.openai.com/plugins/deploy/submission
- Package format: https://developers.openai.com/plugins/build/plugins
- Tool annotations: https://developers.openai.com/plugins/reference
- Errors: https://developers.openai.com/plugins/deploy/submission-errors
- Dashboard: https://platform.openai.com/plugins

## What changed from our original plan

OpenAI now calls these "plugins". A submission is a **ZIP package** (`plugin.json`, `mcp.json`, logo), not a web form: the listing text, the 5 + 3 test cases and the demo video link all go inside `plugin.json`. Reviewer credentials still go in a form. Draft package: [`package/`](package/).

## Ready (in this folder)

- [x] Listing text, category, URLs (all load signed out): listing.md, and the same in package/plugin.json. Field lengths checked.
- [x] Logo: logo-1024.png, logo-512.png, logo.svg; package/assets/logo.png (the 1024 version).
- [x] package/mcp.json: `https://app.notiveloapp.com/mcp`, OAuth with `cimd` client registration (what ChatGPT uses; DCR also works on our side).
- [x] 5 positive + 3 negative test cases with tests behind them: review-cases.md, and in package/plugin.json.
- [x] Demo video script: demo-video.md.
- [x] Reviewer account steps and seed script (tested locally, not on production): reviewer-account.md, scripts/seed-review-account.ts.
- [x] Publisher facts and monetisation (none; `commerce: false`): publisher.md.
- [x] Tool annotations: every tool sets `readOnlyHint`, `destructiveHint` and `openWorldHint` explicitly (server/mcp/index.ts). `replace_box_content` and `update_task` are `destructiveHint: true` (they overwrite), the other writes `false`, all `openWorldHint: false`. Checked by tests/mcp.test.ts.
- [x] Privacy policy: new section "Connected apps and AI assistants" (legal/privacy.md). **Needs lawyer review**, and a release to reach production (the live /privacy page does not have it yet).
- [x] Sign-up is open on production (`/api/auth/config` says `signupMode: open`), so directory users can create an account.

## Blockers to fix before submitting

1. **Domain verification file.** When connecting the server, OpenAI gives a challenge token that must be served as plain text, and nothing else, at `https://app.notiveloapp.com/.well-known/openai-apps-challenge`. Today that path returns the web app's HTML page (200, text/html), so verification would fail. Needs a small server change (for example an `OPENAI_APPS_CHALLENGE` environment variable served as `text/plain` from server/wellKnown.ts), a release, and the token set on production. Not done in this branch: it's a code change to agree first.
2. **Privacy policy live.** Merge and release the privacy update (after lawyer review, or accept the draft) so https://app.notiveloapp.com/privacy mentions connected AI apps before reviewers read it.

## Devon's steps, in order

1. **Publisher verification.** In https://platform.openai.com/settings/organization/general, complete individual or business verification (publisher.md). You must be the organisation owner, or have "Apps Management Write".
2. **Decide the open items** in publisher.md: legal name (individual or company), countries (proposed: no restriction), `developerName`.
3. **Fix blocker 1 and 2** above and release.
4. **Reviewer account.** Create it, verify its email, run the seed script with your own credentials (reviewer-account.md). Do not commit or paste the credentials anywhere but the Review details form.
5. **Run the 8 cases** in ChatGPT against the reviewer account (review-cases.md), on desktop **and** on the ChatGPT mobile app (the guidelines ask for both). Tidy the account afterwards.
6. **Record the demo** (demo-video.md), upload it unlisted, check the link in a private window.
7. **Finish the package:** add `"demo_recording_url": "<link>"` inside `extensions.com.openai.review` in package/plugin.json. Build the ZIP from the **contents** of `package/` (plugin.json, mcp.json and assets/ at the top level of the ZIP, not inside a folder). No secrets in it.
8. **Upload.** At https://platform.openai.com/plugins choose **Upload new or existing plugin**, then **Upload plugin**. Fix anything under **Metadata & Skills > Issues** (Copy issues, fix, **Upload plugin to fix issues**). The negative test case field names in our draft (`description`, `prompt`, `expected_behavior`) are a best guess; OpenAI's page names only the positive ones. If the upload flags them, rename to what it asks for.
9. **Hosted connection.** Open **MCPs**, select the server, **Connect**. Check: URL `https://app.notiveloapp.com/mcp`, authentication OAuth, client registration CIMD, no extra headers. Do the domain verification (blocker 1). Connect and sign in (your own account is fine here, or the reviewer account).
10. **Automated tool scan.** Wait for it, review the discovered tools (12: 7 read, 5 write; no delete tools) and any **Issues**. Use **Rescan** after fixes.
11. **Test the saved version.** Before submitting, use the connected draft in ChatGPT and run the review cases once more, so what reviewers get is what you tested.
12. **Review details.** In **Metadata & Skills > Review information > Review details**, check the imported test cases, enter the reviewer email and password, login URL, workspace and sign-in steps (reviewer-account.md, section 4), and **Save details**.
13. **Submit.** Select the draft, **Submit for review**, and complete the policy attestations (OpenAI does not publish their wording; read each one, they cover usage policies, privacy and data use). Only one review can be active at a time.
14. **Wait for email.** Feedback arrives by email; track it under **Review status**. If rejected: fix, upload a corrected ZIP, or reply to the email to appeal.
15. **Publish.** After approval, open the approved version and choose **Publish plugin**.

## After publishing

- Tool changes on the server don't need a new ZIP: OpenAI rescans daily and puts eligible changes live after automated checks. A changed tool may be held for review; compare "Held update" with "Live definition" under MCPs.
- Listing or logo changes need a new version number, a new ZIP and a new review.
- The server URL can't be changed through the dashboard; contact OpenAI support.

## Smaller things to know

- Tool responses: the guidelines ask to leave out timestamps and IDs unless needed. `list_pages` returns each page's `updatedAt`, and responses carry the ids the next tool needs. Both are reasonable to keep; if the scan flags them, explain or trim.
- ChatGPT's metadata document prefers `private_key_jwt`, which OpenAI says needs confirming with them before use. We don't use it: our server only offers `none` (public client with PKCE), and ChatGPT picks that. Covered by tests/oauth.test.ts.
- The support, privacy and terms pages are drawn by JavaScript; they load fine in a browser.
