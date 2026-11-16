# Claude plugin checklist

The Claude version of the ChatGPT package in [`../chatgpt-directory/`](../chatgpt-directory/). It connects to the same server (`https://app.notiveloapp.com/mcp`, OAuth), so the review cases, reviewer account and listing text there apply here too. Checked against Anthropic's pages on 16 Nov 2026:

- Plugin manifest: https://code.claude.com/docs/en/plugins-reference
- Marketplaces: https://code.claude.com/docs/en/plugin-marketplaces
- Publishing and the directory: https://code.claude.com/docs/en/plugins/publish

## What is in the repo

| File | What |
|---|---|
| `plugins/notivelo/.claude-plugin/plugin.json` | Manifest: name `notivelo`, display name, version, author, links, and the directory listing fields (`icon`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl`, `documentationUrl`). |
| `plugins/notivelo/.mcp.json` | The hosted server, `type: http`, asking for `notes:read notes:write`. The user can still untick "edit" on the consent page. |
| `plugins/notivelo/skills/notivelo/SKILL.md` | How Claude should use the tools: search, read, then write; append rather than overwrite; real due dates; what can't be done (delete, locked pages). |
| `plugins/notivelo/README.md` | Listing text, install steps, limits, support links. |
| `plugins/notivelo/assets/logo.png` | `logo-512.png` from the ChatGPT folder. |
| `.claude-plugin/marketplace.json` | Makes this repo a marketplace named `notivelo`, so people can install from GitHub. |

## Server side: nothing to change

The OAuth server already handles Claude Code. It supports dynamic client registration and Client ID Metadata Documents, and allows loopback redirect URIs on any port (`server/oauth/clients.ts`). Activity is attributed by the client's own name, so changes show as made through Claude, not ChatGPT.

## Checked (16 Nov 2026, Claude Code 2.1.325)

- `claude plugin validate --strict .` (marketplace): passed.
- `claude plugin validate --strict --profile directory ./plugins/notivelo`: passed once the MIT licence was set.
- Loaded with `--plugin-dir`: `claude mcp list` shows `plugin:notivelo:notivelo: https://app.notiveloapp.com/mcp (HTTP) - Needs authentication` (the expected 401 when signed out), and the skill loads as `notivelo:notivelo`.
- **Not yet checked:** a full sign-in and the review cases. That needs Devon at the browser.

## Devon's steps

1. **Licence: done.** plugin.json says `"license": "MIT"` (Devon, 16 Nov 2026). It covers the plugin's own files (config and text), not the app; the repo has no root LICENSE.
2. **Sign in once.** `claude --plugin-dir plugins/notivelo`, then `/mcp` > notivelo > sign in, with your own account or the reviewer account. Check the consent page names the app sensibly and that Settings > Connected apps lists it.
3. **Run the review cases** in [`../chatgpt-directory/review-cases.md`](../chatgpt-directory/review-cases.md) in Claude Code (5 positive, 3 negative). Activity should say "through Claude Code".
4. **Merge and push** this branch, so `claude plugin marketplace add devswartz/NoteApp` works for others.
5. **Directory (optional).** Submitting needs a paid claude.ai plan: https://claude.ai/directory/manage. Run `claude plugin validate --strict --profile directory ./plugins/notivelo` first. The portal runs more checks than the CLI, including a safety scan and a policy review. You can also submit the MCP server on its own as a connector from the same portal.

## Keep in step

- The listing text in README.md and plugin.json `description` follows `../chatgpt-directory/listing.md`. If you change one, change the others.
- Bump `version` in plugin.json for every release, or users who installed from the marketplace keep the old copy.
- Tool changes on the server need no plugin release. Claude reads the tool list live.
