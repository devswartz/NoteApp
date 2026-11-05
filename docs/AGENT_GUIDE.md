# Guide for agents working on NoteApp

Read this, then `PLAN.md`, then `ARCHITECTURE.md` (once it exists) before writing code.

## How the team works
- A **manager session** coordinates. It splits work, reviews PRs and merges them into `main`. You are a **worker** that owns one area (see `PLAN.md` §6 and your kickoff prompt).
- **`main`** is the integration branch, and CI must stay green on it. Work on your own branch (`feat/<area>`) and land work through **PRs into `main`**.
- **Small PRs, often.** One feature or fix per PR, ideally under about 500 changed lines. Open a PR as soon as one piece works; don't hold a big branch for hours. Keep working on the next piece while it waits for review.
- **Rebase on `main`** before opening each PR and at least every couple of hours (`git fetch origin main && git rebase origin/main`). After a PR is merged, keep working on the same branch (rebase it onto the new `main`); merged PRs are squash-merged, so drop the already-merged commits.

## Ownership
- Only change files your area owns (listed in your kickoff prompt).
- **Shared files** are `shared/types.ts`, DB migrations, `server/index.ts`, route registration and `src/App.tsx`. You may make *small, additive* changes to them, such as a new type, a new migration file or a new route line, in their **own PR titled `[shared] …`**. The manager merges those first. Don't refactor shared files.
- **DB schema:** add a new migration only; never edit an existing one.
- If you need something from another area, write it up under "Needs from others" in your PR description. The manager passes it on. Don't make the change in their files yourself.

## Every PR
- `npm run typecheck`, `npm test` and `npm run build` pass locally before you push.
- Add tests for logic: server routes, task sync, recurrence math, and so on.
- The PR description follows this template:
  ```
  ## What changed
  ## How I tested it
  ## Needs from others
  ## Status of my area   (done / in progress / next up — the manager reads this to track you)
  ```
- No secrets, tokens or internal IPs in code, commits or PR text.

## Product rules
- Tasks: the `tasks` row is the single source of truth. Notes contain only `taskRef` nodes holding a `taskId`. Don't store copies of task fields in page documents.
- Platform features (notifications, storage, file pickers, deep links, opening external links) go through `src/platform/`. The rest of the app never calls browser-only APIs directly, because Tauri and Capacitor shells will swap in their own implementations.
- Auth uses bearer tokens; the API base URL is configurable. Don't assume cookies or a same-origin API.
- The hosting interface is fixed in `docs/DEPLOY_CONTRACT.md`; don't change it without the manager.
- The UI should be clean, fast and keyboard-friendly (Linear/Notion style), with a real mobile layout rather than a shrunken desktop one.

## When you finish or get stuck
- Update the "Status of my area" section in your latest PR.
- If you're blocked on a decision only the user can make, say so clearly in the PR, then carry on with whatever else you can do.
