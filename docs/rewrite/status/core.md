# core stream: status and handover

The **core** stream owns `crates/` (except `crates/nv-editor`), `tests/corpus/`, `scripts/corpus/`
and the Rust parts of CI. The overseeing session folds this file into `docs/rewrite/STATUS.md`.

## Now

- **Ink is done on `rewrite/core-ink`** (cut from `rewrite/native` add315c, not merged; **core
  pauses**): read, add, erase, move, delete and lasso and eraser hit tests for a native page's
  strokes, in the web's own format ("For apple: ink"). Still queued as below: Kotlin/Android and
  the M7 server work.
- **The whole `rewrite/core-tree` step is done** (cut from `rewrite/native` 501dcbf, not merged;
  **core pauses**): tree management (create, rename, recolour, move, duplicate and delete
  notebooks, sections and pages, the Trash; "For apple: tree management"), then **sharing**
  (members, invites, notebook and page shares; "For apple: sharing"), **version history** (list,
  preview, restore into an open page; "For apple: version history") and **locked pages** (set the
  password, lock and unlock, Face ID devices, lock a page, tasks of locked pages kept off the
  disk; "For apple: locked pages"). **Next queued: Kotlin/Android** (bindings and the Android
  library build in CI), **and the M7 server work once the owner approves CHANGELOG-SYNC.md.**
- **The whole `rewrite/core-tasks-full` step is done** (cut from `rewrite/native` a625e3c, not
  merged): the full task model (task details, update, tags, teams, members, reminders, quick add;
  "For apple: task details"), **full-text search** ("For apple: search") and **comment threads**
  ("For apple: comments"). That answers all of apple's open requests to core. **Core pauses
  after this step.**
- Before that: box calls on `LivePage` (branch `rewrite/core-boxes`, "For apple: boxes", "For
  editor: boxes"), then task calls, live doc plumbing and the fragment reader (branch
  `rewrite/core-tasks`: "For apple: task calls", "For editor: the live doc").
- **Next, in order** (for a fresh session; see the handover below): Kotlin bindings with an
  Android library build in CI (`cargo-ndk`, including the platform verifier's Android init,
  below), then the CHANGELOG-SYNC.md design (M7 server work, once the owner approves it).
- **For the editor stream:** the engine has no command that adds or removes a `comment` mark yet;
  apple's Comment button needs one (`set_comment(thread_id)` / `unset_comment(thread_id)`, see "For
  apple: comments").

## For apple: ink (2026-11-22, `rewrite/core-ink`)

All additions (new records, an `InkError`, an `InkStrokeBuilder` object, new `LivePage` methods
and free functions; nothing renamed; `apps/apple` grepped for every new name). Each write is
**one local edit** on the live page, like the box calls, so it goes out through the live doc and
the offline queue and is kept in the store; a local call does not fire `onChange` for itself, so
redraw after it. After `close()` the writes throw `InkError.Closed`; locked pages follow the
existing rule (edits stay in memory, nothing is queued in the store).

```swift
// read
page.inkStrokes() -> [InkStrokeInfo]                      // drawing order: z key, then id
readInk(document: Data) throws -> [InkStrokeInfo]         // the same from a document (a version preview, the store)
page.inkOutline(id:) -> [Float]                           // one stroke's path commands
inkOutlineOps(data: Data) -> [Float]                      // path commands of any blob
inkOutlineSvg(data: Data) -> String                       // SVG path d
inkOutlineTriangles(data: Data) -> [Float]                // x, y per vertex, 3 per triangle
// draw a stroke live, add it when the pen lifts
InkStrokeBuilder(tool: UInt8, color: UInt32, width: Float, pressure: Bool, tilt: Bool)
builder.push(x:y:pressure:altitude:azimuth:tMs:)          // t in ms (Double), any clock that only runs forwards
builder.pushMany(samples: [Double])                       // coalesced samples, 6 numbers each
builder.pointCount() -> UInt32
builder.preview(predicted: [Float]) -> [Float]            // path commands of the stroke so far + predicted x, y, pressure
page.addInkStroke(builder:) throws -> InkStrokeInfo?      // nil when it has no points; spends the builder
page.addInkStrokeFromSamples(tool:color:width:pressure:tilt:samples: [Double]) throws -> InkStrokeInfo?
// edit
page.eraseInk(track: [Float], radius: Float, partial: Bool) throws -> InkEraseResult   // {removed, added}
page.moveInkStrokes(ids: [String], dx: Float, dy: Float) throws -> [InkMovedStroke]    // {oldId, newId}
page.deleteInkStrokes(ids: [String]) throws -> [String]                                 // the ids that were there
// hit tests (read only)
page.inkHitLasso(polygon: [Float], minFraction: Float) throws -> [String]
page.inkHitPath(track: [Float], radius: Float) throws -> [String]
page.inkHitPoint(x: Float, y: Float, radius: Float) throws -> [String]
// enum InkError: .Invalid(message), .Closed
```

`InkStrokeInfo { id, readable, tool, color, width, z, flags, createdMs, pointCount, bounds:
InkBounds?, points: [Float], data: Data }`; `InkBounds { minX, minY, maxX, maxY }`.

- **Units and space.** Everything is **page points from the page origin, the same space as box
  x and y** (the canvas surface; a box's own origin is not used). Stored to 1/8 point; widths
  to 1/16. Colour is 0xRRGGBBAA as stored (a highlighter has its alpha in it; the web's is
  0x59 = 0.35). Tool 0 is the pen, 1 the highlighter. `width` is the width at pressure 0.5 (the
  web's choices: pen 1.5, 2.5, 4; highlighter 12, 18, 26). `flags`: bit 0 tilt recorded, bit 1
  the pressure came from a device. Time is ms. Altitude and azimuth are radians (pi/2 and 0
  without tilt).
- **Flat arrays.** `points` is six floats per point: x, y, pressure (0 to 1), altitude,
  azimuth, t (ms since the stroke began). `track`, `polygon` and `predicted` are flat
  (x, y, ...; predicted is x, y, pressure). `samples` for the builder is `Double`, six per sample:
  x, y, pressure, altitude, azimuth, t (the clock's ms: a `Double` keeps them exact).
- **What is smoothed where.** Smoothing happens **once, at capture**, in the builder (nv-ink's
  `StrokeBuilder`, as the web's): a one-euro filter on x and y (min cutoff 4 Hz, beta 0.04), points
  less than half a point from the last kept one dropped (unless the pressure changed by more than
  0.1), the last sample always kept. What is stored is those filtered points. **Rendering**
  then fits a curve through the stored points (centripetal Catmull-Rom, sampled every 1.5
  points) and gives each sample a radius from its pressure (pen: `width / 2 * (0.35 + 1.3 *
  pressure)`; highlighter: even `width / 2`); the outline is the union of the capsules between
  samples. Pressure is not filtered. Without `pressure: true` the stroke's pressure is a constant
  0.5.
- **How to draw.** Fill the **outline**, not the points: `inkOutline(id:)` (or
  `inkOutlineOps(data:)` for a blob you hold) returns commands: `0 x y` move, `1 x y` line, `2
  cx cy r` a whole circle (`arc(0, 2 pi)`), `3` close. Fill the whole path once with the
  **nonzero** rule (overlaps are then painted once, so a translucent highlighter stays even).
  Colour from `color`; the web draws near-black ink near-white in the dark theme (luminance
  below 0.25 becomes 0xe6e6e6; `displayColor` in `src/ink/render.ts`), print uses the stored
  colour. Highlighters are drawn **under** the text boxes, pens **over** them; within a layer in
  `inkStrokes()` order (that order is already z then id). Cache the path per stroke id: strokes
  never change (a move or erase makes new ids). For the stroke being drawn, call
  `builder.preview(predicted:)` each frame (it re-fits the whole stroke, fine for a few
  thousand points) and draw it on a live layer; `predicted` (UIKit's predicted touches) are
  drawn but not kept.
- **Adding.** Create a builder when the pencil touches down, `push` (or `pushMany` with the
  coalesced touches) as samples arrive, and call `addInkStroke(builder:)` **once**, when it
  lifts: that is the one edit that is sent. Drop the builder to cancel. The call picks the id (12
  base-36 characters), the creation time (now) and the z key (one after the highest key among the
  strokes on its layer: highlighters are a layer of their own), and returns the stored stroke.
  `addInkStrokeFromSamples` does the same from a finished list.
- **Erasing.** `eraseInk(track:radius:partial:)`: the web's eraser is a disc of radius **8**
  points dragged along the finger or pencil path. `partial: false` (the web's "eraser") deletes
  **every stroke whose ink the disc touches along the track**. `partial: true` (the web's "partial
  eraser") cuts each touched stroke where the disc reaches its ink and adds what is left as
  **new strokes with new ids** (same style, z and creation time; pieces of fewer than two points
  are dropped), deleting the original. Both are one edit. The web collects a whole gesture and
  writes it once when the pointer lifts (one undo step); do the same (pass the whole track at the
  end, or call per segment: each call is an edit of its own). A single point is a tap. Show what
  would go with `inkHitPath(track:radius:)` while dragging (same rule as the stroke eraser).
- **Lasso, move, delete.** The web has **no lasso, move, resize or recolour yet** (PLAN_INK phase I5;
  its select tool only picks boxes), so these are new, not a copy:
  - `inkHitLasso(polygon:minFraction:)` selects strokes with **at least `minFraction` of their
    stored points inside the polygon (even-odd rule), and at least one point**: the engine's
    rule, whose wrapper defaults to **0.5** (use 0.5). The closing edge is implied (3 or more
    vertices). Unreadable strokes are never selected. `inkHitPoint` is the tap test: any stroke
    whose ink is within `radius` of the point (the exact outline, not the bounds).
  - `moveInkStrokes(ids:dx:dy:)` shifts the stored points (quantised to 1/8 point again) and
    writes them as **new ids** (old deleted, same z), in one edit; it returns the id pairs so
    the selection can follow. Missing and unreadable ids are skipped. Call it **once when the
    drag ends**; move the cached paths yourself during the drag.
  - `deleteInkStrokes(ids:)` deletes by id and returns the ones that were there (ids someone
    else deleted already are skipped, as on the web).
  - Recolour and resize are **not built**: the web offers neither. A recolour would be one
    more delete-and-add with a different colour.
- **Unknown and newer data.** `inkStrokes()` lists **every** blob in the page's `ink` map,
  including ones this build can't decode (a newer format version, a damaged blob):
  `readable: false`, `data` holds the exact bytes, header fields are filled when the header
  decodes, `points` is empty and `bounds` nil. Draw nothing for them; keep them. They are
  never rewritten: erase, move and the lasso skip them, and only an explicit
  `deleteInkStrokes` removes one. Values in `ink` that are not byte blobs (or are empty or over
  512 KB) are not listed, as on the web (`pageInk`), and are left in the map. A readable stroke
  that is moved or cut is re-encoded by this build (flags and tilt kept, the box recomputed).
- **Performance.** One call per stroke end, per erase gesture end, per drag end, never per
  point. `inkStrokes()` decodes every stroke (points, flat) each call: read it when the page
  opens and after remote changes, then keep a dictionary by id; a stroke that appears or
  disappears is a new id. The hit tests decode the page too, so run them on a drag's moves at
  most every frame, with a bounds prefilter on your side if you have thousands of strokes.
  Encoding is about 5 bytes a point: a long stroke is a few KB.
- **Format and checking.** The blob is nv-ink's (`crates/nv-ink/src/blob.rs`, version 1); the
  `ink` root map holds id -> bytes (`Y.Map`, values `Uint8Array` on the web), so the web reads
  strokes from here and the other way round with no conversion. `scripts/corpus/ink-ops.ts` runs
  today's web ink code (the engine WASM's builder, `erase`, `hitPath`, `hitLasso`, `encode`;
  `commitStroke`, `commitErase`, `EraseSession`, `zAfter`, `topZ`) on the `settings-and-ink`
  page: a pen arc, a highlighter and a red line added, a partial erase over two of them, a
  stroke erase of the third, a move (the engine's decode, shift and encode: the web has no
  move) and three lasso queries, and commits the blobs after every step in
  `tests/corpus/ink-ops/`. `crates/nv-core/tests/ink_ops.rs` makes the same edits through the Rust
  functions and matches **every blob byte for byte** after every step, and the lasso picks.
  Copied rather than imported: the layer rule of `InkRenderer.zKeys` (`render.ts`) and the
  loop in `eraseGesture` (`InkSurface.tsx`), both in React-side files; the script says so.
  `crates/nv-core/tests/ink.rs` checks add, erase, move and delete through two copies of a
  `LivePage` on the stand-in server (they converge, each reaches the server, an unreadable
  stroke survives), and `ink_against_a_running_server` in `server.rs` checks a stroke drawn on
  one sign-in, cut from another, and the server's saved copy (real server, port 4487, passed).
  **Not run:** the web app drawing a stroke the Rust core wrote (byte-identical to the web's own
  blobs, so it should); a pencil on a device; the speed of a page with thousands of strokes.

## For apple: sharing (2026-11-22, `rewrite/core-tree`)

Members, invites, notebook shares and page shares, as the server does them
(`server/routes/workspaces.ts`; the web's callers are `src/components/sharing/*`). All additions:
no existing record or call changed (`members(workspaceId:)` stays, and returns the members only).
No name clashes with `apps/apple` (grepped for every new name).

```swift
// workspace people
core.workspacePeople(workspaceId:) throws -> WorkspacePeople          // {members: [WorkspaceMember], invites: [PendingInvite]}
core.inviteMember(workspaceId:, email:, role: String? = nil) throws -> InviteResult
core.resendInvite(workspaceId:, email:) throws -> InviteResult
core.revokeInvite(workspaceId:, email:) throws
core.setMemberRole(workspaceId:, userId:, role:) throws
core.removeMember(workspaceId:, userId:) throws
core.leaveWorkspace(workspaceId:) throws
core.inviteInfo(token:) throws -> InviteInfo
core.acceptInvite(token:) throws -> AcceptedInvite                     // {workspaceId, pageId: String?}
// notebooks (visibility itself is setNotebookVisibility, from tree management)
core.notebookShares(notebookId:) throws -> NotebookShares              // {visibility, createdBy, userIds}
core.setNotebookShares(notebookId:, userIds: [String]) throws -> [String]
// pages
core.pageShares(pageId:) throws -> PageShares                          // {shares: [PageShareEntry], invites: [PageInviteEntry]}
core.sharePageWithMember(pageId:, userId:, canEdit:) throws -> PageShareResult
core.sharePageByEmail(pageId:, email:, canEdit:) throws -> PageShareResult
core.setPageShareEdit(pageId:, userId:, canEdit:) throws -> PageShares
core.removePageShare(pageId:, userId:) throws -> PageShares            // your own id: "Remove from Shared with me"
core.revokePageInvite(pageId:, email:) throws -> PageShares
core.sharedPages() throws -> [SharedPageEntry]                         // "Shared with me"
```

Records: `PendingInvite { email, role, invitedBy?, createdAt?, expiresAt? }`, `InviteResult { status
("added" | "invited"), emailed, inviteUrl? }`, `InviteInfo { workspaceId, workspaceName,
invitedByName, email, role, expired, page: InvitedPage? }`, `InvitedPage { id, title, canEdit }`,
`PageShareEntry { userId, name, email, color, canEdit, member }`, `PageInviteEntry { email,
canEdit, expiresAt?, createdAt }`, `PageShareResult { status ("shared" | "invited"), emailed,
inviteUrl?, shares: PageShares }`, `SharedPageEntry { id, title, icon?, workspaceId,
workspaceName, member, canEdit, sharedByName?, sharedAt }`. Roles are the strings owner, admin,
member, viewer.

**Server routes used.** `GET|POST /workspaces/:id/members` | `PATCH|DELETE
/workspaces/:id/members/:userId` | `POST /workspaces/:id/invites/:email/resend` | `DELETE
/workspaces/:id/invites/:email` | `GET /invites/:token` | `POST /invites/:token/accept` | `GET|PUT
/notebooks/:id/shares` | `GET|POST /pages/:id/shares` | `PATCH|DELETE /pages/:id/shares/:userId` |
`DELETE /pages/:id/invites/:email` | `GET /shared-pages` (all in `server/routes/workspaces.ts`).
Leaving is `DELETE .../members/<your id>`. Not used: `/shared-tasks` (tasks assigned to you on
pages shared from workspaces you are not in), `/pages/:id/people`.

**Who can do what** (the server decides; refusals come back as `CoreError.Server` with its
message; viewers can read the member list):
- List members: any member, viewers included. **Pending invites: owners and admins only** (empty
  for everyone else).
- Invite, resend, revoke an invite: owners and admins; **only an owner may invite an owner**.
- Change a role: owners and admins; **only an owner may make an owner or change one**; the last
  owner cannot be demoted (400). Remove a member: owners and admins (**only an owner may remove an
  owner**; the last owner cannot go, 400); their open tasks are unassigned and their shares in the
  workspace end. **Leave: any role**, except the last owner (400, make another owner first).
- Accept an invite: signed in **as the invited address** (403 otherwise); 410 expired, 404 no
  longer valid (resent, revoked, or already used).
- Notebook shares (the people a *private* notebook is shared with): **the notebook's creator
  only** (403), only workspace members (400), and not while the notebook holds a locked page (400,
  `has_locked_page`). Anyone who can see the notebook may read the list.
- Page shares: whoever has edit access to the page's notebook (in a **private notebook, only its
  creator**). Sharing with someone **outside the workspace (by email, or an account that is not a
  member): owners and admins only** (403). At most 200 shares and invites per page. A locked page
  cannot be shared. A member's role caps what a share grants (a viewer only views). Anyone may
  remove their own share.
- Adding people to a workspace that has a locked page outside a private notebook is refused (400,
  `has_locked_page`): move the page into a private notebook, or remove its lock.

**With mail off** (the test server, or a self-hosted one without SMTP): invites still work, but
nothing is sent. `InviteResult.emailed` is false and `inviteUrl` is the link to **hand over
yourself** (show it to copy). The link's last path part is the token for `inviteInfo` and
`acceptInvite`; the host in it is the server's `PUBLIC_URL`, or in development
`http://localhost:5173`, not necessarily this server. An invitee whose address has a **confirmed
account** is simply added ("added", no link); one with an unconfirmed account gets a link
instead. A person who signs up later with an invited address joins at sign-up when accounts are
confirmed at once (mail off), or when they confirm the address. Links work for 14 days
(`expiresAt` on `PendingInvite`); resending makes a fresh link and the old one stops working.

**The stored data.** Leaving a workspace, accepting an invite, and changing or removing your own
role fetch the workspace list again and store it, so `cachedWorkspaces` follows and a workspace
you left disappears from the store with its tree, tasks and page documents. `setNotebookShares`
fetches the tree again. Nothing else is stored: share lists, invite links and people's emails are
read each time and not kept. **Online only**: offline these throw `CoreError.Network` and change
nothing (no queue; writes are never retried).

## For apple: version history (2026-11-22, `rewrite/core-tree`)

```swift
core.pageVersions(pageId:) throws -> [PageVersion]                     // newest first
core.pageVersion(pageId:, versionId:) throws -> PageVersionDocument    // {version, document: Data}
core.restoreVersion(page: LivePage, versionId:) throws -> String?      // id of the "before restore" version
```

`PageVersion { id, title, authorId?, reason ("auto" | "manual" | "restore"), at, createdAt }`:
`at` is when the content was last edited before the snapshot (the time the web's list shows),
`createdAt` when it was saved; both ISO instants; `authorId` is a user id (name it with
`workspacePeople` / `members`); "restore" means "before restore" in the web's list. Server:
`GET /pages/:id/versions` (also takes an automatic snapshot first when one is due),
`GET /pages/:id/versions/:vid`, `POST /pages/:id/versions { reason }` (`server/routes/pages.ts`,
`server/versions.ts`; snapshots are kept in full for 24 h, hourly for 7 days, then daily, at most
200).

**Preview.** `pageVersion(...).document` is a Yjs update like `pageDocument`: `readPage`,
`pageContent` and `pageMarkdown` read it. It is not stored on the device. Anyone who can open the
page may list and preview; restoring needs edit access (a viewer gets 403 before anything changes).

**How restore works.** **The server has no restore route; the web restores in the client**
(`src/editor/VersionHistory.tsx`): `POST /pages/:id/versions {reason: "restore"}` saves the
current state, then `replacePageContent` replaces the live document's content with a copy of the
version's in one Yjs transaction. `restoreVersion` does the same on the **open `LivePage`**
(`nv_model::restore::replace_page_content`, the Rust form of `replacePageContent`):
1. it fetches the version (`GET`), waits up to 3 s for edits not yet sent to reach the server (so
   the snapshot has them), asks the server to snapshot the current state (`POST`), and only then
2. replaces the page's content in **one local edit**: every box and the default fragment are
   deleted, the version's boxes (same ids and geometry) and content are inserted as copies, page
   colour and rule lines come back when the version has them, and so does handwriting; a version
   from before pages were canvases becomes one wide box. Returns the id of the "before restore"
   version (the newest existing one when nothing changed since it; none for an empty page), which
   is also the way to **undo**: `restoreVersion` with that id.
- **The open page changes at once** (`info()`, `document()`); the listener's `onChange` is *not*
  called for your own edit (as for any local edit): read `info()` after the call.
- **Other open copies converge**: the edit goes out like typing. Edits others make at the same
  moment into text the restore deleted are lost with it (as with any delete).
- **Offline queue.** The restore is queued behind edits not yet sent and kept in the store until
  the server confirms it, so a restore made while the socket is down goes out on reconnect, in
  order, and survives a restart. The HTTP steps need a connection: **offline, `restoreVersion`
  throws `Network` and changes nothing**. Nothing can bring the old content back: the restore
  *deletes* items and inserts new ones, and a deleted item stays deleted in every merge, however
  old the copy (a stored page, an earlier queued edit, a device that was offline all along).
  (Merging the *version's own update* into the live page would do nothing, so a restore cannot be
  done that way: always use `restoreVersion`.)
- A closed page throws `Network` ("the page is closed"). Tests: scripted ones
  (`crates/nv-core/tests/versions.rs`, with an edit queued offline and an old copy merged in
  later), model ones (`crates/nv-model/src/restore.rs`), and the real server (two open copies
  converge, the server's saved page matches, an old copy merged into both changes nothing, undo).

## For apple: locked pages (2026-11-22, `rewrite/core-tree`)

Answers "Unlocking locked pages in the Core API" (apple's request; the "unlock" notes under
"Answers to apple's requests" are now built). Server: `server/routes/locks.ts`, `server/locks.ts`;
the web's side is `src/lib/lockedNotes.ts`.

```swift
core.lockedNotesStatus() throws -> LockedNotesStatus
core.setLockedNotesPassword(password:, currentPassword: String? = nil) throws -> String?   // expiresAt
core.unlockLockedNotes(password:) throws -> String                                        // expiresAt
core.unlockLockedNotesWithDevice(deviceId:, secret:, installId:) throws -> String
core.registerUnlockDevice(installId:, label: String? = nil) throws -> NewUnlockDevice     // {id, secret, expiresAt}
core.removeUnlockDevice(deviceId:) throws
core.lockLockedNotes() throws                                                             // "Lock now"
core.keepLockedNotesUnlocked() throws -> LockKeepalive                                    // {unlocked, expiresAt?}
core.lockPage(pageId:) throws
core.removePageLock(pageId:, password:) throws
```

`LockedNotesStatus { hasPassword, unlocked, expiresAt?, idleMs, lockedPages, failures,
blockedUntil?, triesBeforeLockout, devices: [UnlockDevice] }`, `UnlockDevice { id, label?,
createdAt, lastUsedAt?, expiresAt }`. Routes: `GET /locked-notes`, `POST /locked-notes/password`,
`POST /locked-notes/unlock` (password, or `deviceId` + `secret` + `installId`), `POST
/locked-notes/lock`, `POST /locked-notes/keepalive`, `POST|DELETE /locked-notes/devices`, `POST
/pages/:id/lock`, `POST /pages/:id/lock/remove`. Not built: the forgotten-password reset by
emailed code (`/locked-notes/reset/start`, `/locked-notes/reset`), `/locked-notes/file-key`
(upload links on locked pages).

- **One password per account**, separate from the sign-in password, 6 to 72 bytes.
  `setLockedNotesPassword` sets it, or changes it (`currentPassword` required; a wrong one counts
  as a wrong try). Setting or changing it unlocks this sign-in; **changing it locks every other
  sign-in and removes every device**.
- **Unlocking is per sign-in** (the refresh-token family), not per page: `unlockLockedNotes`
  unlocks all of the account's locked pages for this sign-in. **It lasts `idleMs` (5 minutes)
  without activity.** `keepLockedNotesUnlocked` (call it about every minute while a locked page
  is on screen) and editing an open locked page (the server does it every 30 s of activity) push
  it back; `lockLockedNotes`, sign-out, a password change, or the lapse end it. When it ends the
  server closes the locked pages' sockets (4403): an open `LivePage` ends with `.noAccess`. Close
  open locked pages yourself on "Lock now" and when the app goes to the background (the web
  locks on background).
- **Wrong tries**: `Server` 400 `wrong_password` (the message says how many tries are left);
  after 5 in a row, `Server` 429 `locked_out` for 15 minutes, doubling per further failure up to
  24 hours (the owner is emailed); `status.failures` / `blockedUntil` show it. No password set:
  409 `no_lock_password`.
- **Face ID / Touch ID.** After an unlock **with the password**, `registerUnlockDevice(installId:
  label:)` returns `{id, secret}` once (403 `locked` while locked): keep `id` and `secret` in the
  keychain behind biometrics, and `installId` (a random string of at least 16 characters the app
  makes once per install). After the biometric check, `unlockLockedNotesWithDevice`. It works for
  that sign-in and install only, for 30 days. A secret the server no longer accepts (another
  sign-in, another install, expired, password changed) is `Server` 401 `device_revoked`: ask for
  the password (**this counts as a wrong try**; the core does not retry it). One device per
  sign-in and install: registering again replaces it.
- **Locking a page** (`lockPage`): needs a password (409 `no_lock_password`), edit access, and a
  page **only you can see** (a private notebook shared with nobody, or a workspace you alone are
  in, and not shared page by page: 403 `not_private`). You become its owner; nobody else, admins
  included, sees it any more. `removePageLock` needs the password (404 for anyone but its owner).
  Other rules of the server: a locked page cannot be shared or duplicated and may only move into a
  private notebook.
- **Reading an unlocked page.** `pageDocument`, `pageVersions`/`pageVersion`, comments, search
  text, task text and `openLivePage` work as for any page while this sign-in is unlocked. While
  locked, content calls answer `Server` 404 (measured for `pageDocument` and `pageVersions`: the page
  "isn't there"; comments are documented above as 403) and the owner still sees its title in the
  tree (`PageMeta.locked`; `search` finds it by title only).
- **Tasks.** `tasks(workspaceId:)` returns the tasks of locked pages **in full while unlocked**
  (`Task.locked == false`) and as "Locked task" with `locked == true` while locked.

**What is never stored** (tested, see below):
- **The password and the device secret**: not kept anywhere by the core, not logged
  (`nv_api::Request` and `NewUnlockDevice` hide them from `Debug`). Passwords go in the body of
  the one request. The one `secret` is returned once, for your keychain.
- **The content of a locked page, unlocked or not**: no page document (`pageDocument` of an
  unlocked page is not saved; `cachedPageDocument` stays nil), no outbox (the offline queue of a
  locked page's edits), no queued task changes. A page counts as locked when a stored tree marks
  it (`PageMeta.locked`, true whether or not the sign-in is unlocked). **Live editing of an
  unlocked page keeps its edits in memory only**, as before: an edit made while the connection is
  down is held in the `LivePage` and lost if the app quits before it reconnects (`unsentUpdates()`
  shows them; `unsentPages()` does not list the page).
- **Task text of locked pages**: after an unlock the server sends these tasks in full; `nv-store`
  redacts them **before writing** (title "Locked task", empty description, no tags,
  `locked: true`; due date, status, assignee and checklist counts stay, as the server's
  `redactTask`). `tasks()` still *returns* the full list to the caller, and nothing else of them is
  stored, so `cachedTasks` shows "Locked task". Locking a page redacts the tasks stored before
  (`lockPage` marks it in the stored tree at once, drops its stored document, queued edits and
  queued task changes, and folds the write-ahead log into the database file).
- **While the core believes the sign-in may be unlocked** (after an unlock, a password set, or a
  status or keep-alive that said unlocked; until `lockLockedNotes` or a status that says locked) it
  **fetches the workspace's tree again first** in `tasks()`, `pageDocument()` and
  `openLivePage()`/`openPage()`, so a page locked from another device is recognised before
  anything is stored. That is one extra request per such call. Not covered: an app restarted
  within 5 minutes of an unlock on a device whose stored tree is stale and which calls `tasks()`
  before any tree call; call `lockedNotesStatus()` at launch (it sets the flag) and `tree()`
  before `tasks()`, as you do.

**Tests.** Scripted (`crates/nv-core/tests/locked.rs`): after an unlock with a stale stored tree,
a task list with marker titles and descriptions is stored redacted and **the SQLite file, its WAL
and SHM are searched byte by byte** for the markers (UTF-8 and UTF-16), with a positive control; a
task write answers in full and is stored redacted; locking a page with a failing tree refetch;
**live editing of an unlocked locked page against the stand-in collab server** (edit online, edit
while disconnected, close) with the markers absent from the file; passwords and device secrets
absent; and the calls' bodies. `crates/nv-store/src/tests.rs` (redaction by `put_tasks`,
`put_task`, `put_tree`, `mark_page_locked`; the file after locking), `nv-api` tests (bodies;
`device_revoked` sent once; `Debug` hides bodies), and `locked_pages_against_a_running_server`
(real server: password, lock, unlock, wrong password, lockout counter, Face ID device unlock and
revocation, password change, remove lock; markers absent from the file).

## For apple: tree management (2026-11-22, `rewrite/core-tree`)

Answers apple's request for tree writes (create, rename, recolour, move, duplicate, delete, Trash).
All additions: no existing record or call changed (`Tree`, `Notebook`, `Section` and `PageMeta`
are as before). The truth is the server: `server/routes/tree.ts` (notebooks, sections, move,
copy), `server/routes/pages.ts` (pages), `server/routes/trash.ts` and `server/trash.ts` (Trash);
the web's callers are `src/components/shell/treeDnd.ts` (drops), `notesRows.tsx` (menus),
`NewNotebookDialog.tsx` and `src/lib/trash.ts` (delete + Undo).

```swift
// notebooks
core.createNotebook(workspaceId:, name:, color: String? = nil, visibility: String? = nil) throws -> NewNotebook   // {id, sectionId}
core.renameNotebook(notebookId:, name:) throws
core.setNotebookColor(notebookId:, color:) throws
core.setNotebookVisibility(notebookId:, visibility:) throws -> UInt32     // page shares that ended
core.moveNotebook(notebookId:, index: UInt32? = nil) throws -> Double      // new position
core.deleteNotebook(notebookId:) throws -> Trashed                         // {trashId, tasks}
// sections (and subsections)
core.createSection(notebookId:, name:, parentId: String? = nil, color: String? = nil) throws -> String   // id
core.renameSection(sectionId:, name:) throws
core.setSectionColor(sectionId:, color:) throws
core.moveSection(sectionId:, notebookId:, parentId: String? = nil, index: UInt32? = nil) throws -> SectionPlace
core.copySection(sectionId:, notebookId: String? = nil, name: String? = nil) throws -> String            // id of the copy
core.deleteSection(sectionId:) throws -> Trashed
// pages
core.createPage(sectionId:, title: String? = nil) throws -> String        // id
core.renamePage(pageId:, title:) throws
core.setPageIcon(pageId:, icon: String?) throws                           // nil clears
core.movePage(pageId:, sectionId: String? = nil, index: UInt32? = nil) throws -> PagePlace
core.copyPage(pageId:, sectionId: String? = nil, title: String? = nil) throws -> String                  // id of the copy
core.deletePage(pageId:) throws -> Trashed
// Trash
core.trash(workspaceId:) throws -> [TrashEntry]
core.restoreFromTrash(workspaceId:, kind: TrashKind, id:) throws -> String?   // where it went, nil: back as it was
core.deleteForever(workspaceId:, kind:, id:) throws
core.emptyTrash(workspaceId:) throws -> UInt32                                // entries removed
core.cachedTrashedPages(workspaceId:) -> [TrashedPage]?                       // local, from the stored tree
// pure helpers (the web's, same results)
positionAt(siblingPositions: [Double], index: UInt32) -> Double
dropIndex(siblingIds: [String], targetId: String, after: Bool) -> UInt32
```

Records: `NewNotebook { id, sectionId }`, `PagePlace { sectionId, position }`,
`SectionPlace { notebookId, parentId: String?, position }`, `Trashed { trashId, tasks }`,
`TrashedPage { id, title }`, `TrashEntry { kind, id, name, icon: String?, deletedAt, deletedBy:
String?, deletedByName: String?, expiresAt, daysLeft, path, pages, sections }`, enum
`TrashKind { page, section, notebook }`. Times are ISO instants (UTC). No name clashes with
`apps/apple` (grepped for each: none).

**Server routes used.** `POST /workspaces/:id/notebooks` | `PATCH /notebooks/:id` (`name`,
`color`, `visibility`) | `POST /notebooks/:id/move` | `DELETE /notebooks/:id` | `POST
/notebooks/:id/sections` | `PATCH /sections/:id` (`name`, `color`) | `POST /sections/:id/move` |
`POST /sections/:id/copy` | `DELETE /sections/:id` | `POST /sections/:id/pages` | `PATCH
/pages/:id` (`title`, `icon`) | `POST /pages/:id/move` | `POST /pages/:id/copy` | `DELETE
/pages/:id` | `GET /workspaces/:id/trash` | `POST /trash/:kind/:id/restore` | `DELETE
/trash/:kind/:id` | `DELETE /workspaces/:id/trash`. The PATCH routes also take `position`,
`notebookId`, `parentId`, `sectionId` and (pages) `titleWas`/`iconWas`; the core does not send
them (moves use the `/move` routes, as the web does; the stale-title check is for the web's
editor, which can hold an old title).

**Positions and moves.**
- Positions are the server's: REAL numbers per sibling list (notebooks of a workspace, top-level
  sections of a notebook, subsections of a section, pages of a section). **You never send a
  position.** A move sends `index`: the place among the new siblings **without the item itself**
  (0 = first; omitted = last). The server turns it into a position (empty list 1; at or past the
  end last + 1; first, first - 1; else the average of the two neighbours) and **returns it**.
  `positionAt` is the same rule (`treePosition.ts`), for an optimistic drop; `dropIndex` is the
  web's `indexFor`: pass the new siblings in position order without the dragged item, the target
  row and whether the drop is below it; "inside" a section or notebook has no target, so use the
  sibling count (or leave `index` nil).
- **Pages** (`movePage`): `sectionId` nil keeps the section (a reorder); another section of the
  same workspace moves it there (any notebook). Another workspace: `Server` 400 ("Cannot move
  between workspaces"). Needs edit access to the target section. A locked page may only go to a
  notebook only its owner can see (400 otherwise).
- **Sections** (`moveSection`): always says where. `parentId` a section id: nested under it, and
  **that section's notebook wins** over `notebookId`; `parentId` nil: the top level of
  `notebookId`. Its subsections and pages go with it (their `notebookId` changes in the tree).
  Refused with 400: into itself or one of its own subsections, past 3 levels (`MAX_SECTION_DEPTH`,
  `shared/sections.ts`; mirror `canNestUnder` in the UI), another workspace, or a section holding
  locked pages into a notebook others can see. The web's drop rules: a section dropped on the
  middle of another nests there, on a notebook goes to its top level.
- **Notebooks** (`moveNotebook`): reorder only; `index` is among the workspace's other notebooks.
- `createSection(parentId:)` makes a subsection (same notebook, 3 levels). Create always appends
  (last position).
- **Duplicate.** `copyPage`: in its own section the copy sits right after the original and is
  titled "<title> (copy)" ("Untitled (copy)" if empty); into another section it goes to the end and
  keeps the title; `title` overrides. The tasks written on the page are copied too. A locked page
  cannot be duplicated (400 "Remove the lock to duplicate this page"). `copySection`: copies the
  subsections and pages (and their tasks), **leaves locked pages out**; same notebook: named
  "<name> (copy)" next to the original's siblings (end of the list); another notebook of the
  workspace (`notebookId`): keeps the name, at the top level. Both need edit access; the
  workspace must be the same (400 otherwise).
- **Create a notebook.** The server makes it with one section named "General" (`sectionId`). The
  new-notebook dialog's starting structures are apple's: the web renames/recolours that section
  and adds more with `createSection` and pages with `createPage` + `setPageIcon`
  (`NewNotebookDialog.tsx`). `visibility` "private" makes it visible to its creator (and whoever
  it is shared with, next step). Names are trimmed by the server, 1 to 100 characters (400
  otherwise); colours are `#rrggbb` (400 otherwise); a page title is cut to 300 characters. Page
  icons: an emoji or short text, cut to 16 characters.
- **New page.** `createPage(sectionId:, title:)` makes a blank canvas page (title "" = untitled).
  The web's "New page" additionally asks the server for the section's default template and fills
  the page from its creator's client; that client-side fill is not part of this call.
- Who may do what (server): members and up can create, rename, move, copy and delete in
  notebooks they can see; viewers get `Server` 403/404. A **notebook** is deleted only by its
  creator or a workspace admin, its visibility changed only by its creator. Private notebooks are
  invisible to others (404).

**What delete does.** Every delete goes to the **Trash**, not away, for 60 days: `deletePage`,
`deleteSection` (with its subsections and pages), `deleteNotebook` (with everything in it). It
returns `Trashed { trashId, tasks }`: `tasks` is how many tasks were on what went (the web's toast
says "Its n tasks stay in your task list"; they do stay, shown as on a page "in Trash"). The web's
Undo is `restoreFromTrash(kind:, id:)` with the deleted item's own id (`trashId` equals it).
- `trash(workspaceId:)`: the entries the caller may see, newest first: for each, the item at the
  top of the batch. Members and up only (viewers: empty); someone else's locked page is not
  listed. `path` is "Notebook > Section" (empty for a notebook), `pages`/`sections` count what went
  with it, `daysLeft` runs from 60.
- `restoreFromTrash` puts back the entry and everything trashed with it. If its old place is gone it
  goes elsewhere and the call returns the name (a page: the notebook's first section; a section:
  the notebook's top level, named by the notebook). `nil`: back as it was. A page or section whose
  notebook is also in the Trash: `Server` 409 "Its notebook is in the Trash too" (restore the
  notebook first). An entry that is gone (purged, expired, or not yours): 404.
- `deleteForever` removes an entry for good (its tasks become standalone; cannot be undone) and
  `emptyTrash` removes all of the caller's visible entries (**owners and admins only**, others
  get 403; returns how many entries went).

**The stored tree.** After every write the server accepted, the core **fetches the workspace's
tree again and stores it** (not a local patch: a restore, a duplicate or a section move touches
rows only the server knows, and the server's positions stay exact). So when the call returns,
`cachedTree(workspaceId:)` shows the change, with the server's own positions. Which workspace is
found from the stored tree by the id; if the id is in no stored tree every stored workspace tree
is refreshed; without a store (`Core(serverUrl:)`) nothing is fetched. If that refetch fails (the
connection dropped right after the write) the call still returns success (it is done on the
server) and the stored tree stays stale until the next `tree(workspaceId:)`. Apple can also
patch its own copy at once for the drop and let the refetch correct it.
- **Locked pages** are unchanged: the refetched tree marks a page locked and the store deletes its
  document, as with any tree load. Moving, renaming and trashing one's own locked page work; the
  server withholds other people's locked pages from every list.
- **Trash and stored documents.** The tree now reads `trashedPages` (`[{id, title}]`, members and
  up): `nv-store` keeps them as `trashed_page` rows, and **a trashed page keeps its stored
  document** (so Undo/restore is instant and offline reading works), where before the tree load
  that follows a delete dropped it as "no longer shown". A page gone from both `pages` and
  `trashedPages` (deleted forever, or access lost) loses its document as before. A trashed page is
  not a live page: nothing new is stored for it and its offline edits are refused.
  `cachedTrashedPages(workspaceId:)` is the list, for a task's "in Trash" label. The public
  `Tree` record is unchanged (no `trashedPages` field), so `Tree(...)` initialisers keep building.
- Tasks are not refetched: after `deleteForever` or `emptyTrash` the tasks of purged pages lose
  their page on the server; call `tasks(workspaceId:)` to see it.

**Online only.** These calls are not queued: the server makes every id (a client-chosen id is
ignored), so an offline create could not be named, ordered or referred to by later calls (move a
page that does not exist yet), and moves and deletes depend on positions and permissions only the
server knows. Offline they throw `CoreError.Network` unchanged, nothing is changed, and nothing
is sent twice (writes are never retried). Refusals are `CoreError.Server(status:, message:, code:)`
with the server's message (400 rules above, 403 role, 404 gone/not visible, 409 restore blocked);
`SignedOut` as everywhere. Show the message in the dialog. `cachedTree` stays as it was after a
failure.

**Tests.** `crates/nv-api/tests/tree.rs` (every call's method, path, body and answer),
`crates/nv-core/tests/tree_edit.rs` (scripted: bodies, the stored tree after each write, trash and
restore keeping the document, locked pages, offline, refusals, failed refetch, no store, the
position helpers), `crates/nv-store/src/tests.rs` (trashed pages), and the real-server test
`tree_management_against_a_running_server` in `crates/nv-core/tests/server.rs` (creates a
notebook, sections, subsections, 3-level limit, pages; renames, colours, icons; reorders,
moves between sections and notebooks; duplicates pages and a section; trash, restore, delete
forever, empty), which also checks the stored tree equals the server's after the whole run.

## For apple: not in this step

Sharing, version history and unlocking locked pages are done (the three sections above). Not done
here: the forgotten locked-notes password reset (emailed code), the section's default template (`defaultTemplateId`/`noDefaultTemplate` on `Section` in
`shared/types.ts`; the core's `Section` does not carry them yet), page "pending template" fills,
notebook sharing lists (`sharedWith`), favourites.

## For apple: search (2026-11-22, `rewrite/core-tasks-full`)

Answers apple's request "search(workspace_id, q) so the palette finds text inside pages". All
additions. The truth is the server's `GET /workspaces/:id/search?q=&limit=`
(`server/routes/search.ts`); the web's use is `PaletteInner` in `src/components/CommandPalette.tsx`
(asks 150 ms after the last keystroke, no limit given, shows the page snippet with `<mark>`).

```swift
core.search(workspaceId:, query:, limit: UInt32? = nil) throws -> SearchResults
parseSnippet(snippet:) -> [SnippetRun]          // pure; search() already applies it
```

- `SearchResults { pages: [PageSearchHit], tasks: [TaskSearchHit] }`, best match first in each
  list.
- `PageSearchHit { pageId, title, icon: String?, snippet: [SnippetRun], notebookName, sectionName,
  path }`. `path` is the server's "Notebook › Section › Subsection" string, ready to show (the
  web's crumb).
- `SnippetRun { text, matched: Bool }`. The server wraps matched terms in « and » (about 14 words
  of context, `…` at cut ends); `parseSnippet` splits on `«…»` exactly as the web's
  `highlightSnippet` does (markers dropped, empty runs left out, an unclosed « stays text). An
  **empty `snippet` array** means a title-only match (nothing to show under the title).
- `TaskSearchHit { task: TaskDetail, snippet: [SnippetRun]? }`: the snippet is present only when
  the task's **description** matched (the title is shown anyway).
- Matching (server): every word is prefix-matched ("plan" finds "planning") and stemmed, all
  words must match, at most 12 words, the query is cut to 200 characters. Title hits weigh 10x
  text hits; ties go to the recently edited. Open tasks sort before done ones. `limit` is 1 to 50
  per list (server default 20). Sub-task occurrences of repeating tasks are not searched.
- A blank (whitespace) query returns empty results **without a request**.
- **Locked pages:** the owner finds a locked page by its **title only** (its text is never
  indexed, so `snippet` is empty); tasks on locked pages are left out. Pages in notebooks the
  caller cannot see are never returned.
- **Online only.** Nothing is cached or queued; without a connection `search` throws
  `CoreError.Network` unchanged, and a rejected sign-in gives `CoreError.SignedOut`. The
  device's own title search (the tree) is still the offline fallback, apple's to keep.
- The server has no "recent pages" or quick-switcher endpoint (the web's palette lists recent
  pages from the tree it already holds), so there is nothing to add for that.
- Swift names: `SearchResults`, `PageSearchHit`, `TaskSearchHit`, `SnippetRun` do not clash with
  `apps/apple` (its own `SearchHit` and `SearchLogic` are untouched).

## For apple: comments (2026-11-22, `rewrite/core-tasks-full`)

Answers apple's request for comment threads (list for a page, create on a range, reply, resolve).
The truth is `server/routes/comments.ts`; the web's use is `src/editor/collabComments.ts`
(`beginComment`, the store) and `src/editor/collabCommentsPanel.tsx`. All calls **need the
network**: nothing is cached or queued, and `CoreError.Network` is returned unchanged.

```swift
core.pageComments(pageId:) throws -> [CommentThread]                         // oldest thread first
core.addCommentThread(pageId:, threadId:, quote:, body:) throws -> CommentThread
core.replyToCommentThread(threadId:, body:) throws -> CommentThread
core.resolveCommentThread(threadId:) throws -> CommentThread
core.reopenCommentThread(threadId:) throws -> CommentThread
core.editComment(commentId:, body:) throws -> CommentThread                  // your own only
core.deleteComment(commentId:) throws -> Bool                                // true: that was the thread's last comment, the thread is gone
core.deleteCommentThread(threadId:) throws
newCommentThreadId() -> String                                               // a random UUID
```

- `CommentThread { id, pageId, workspaceId, quote, createdBy, createdAt, resolved: Bool,
  resolvedAt: String?, resolvedBy: String?, comments: [ThreadComment] }`; `ThreadComment { id,
  threadId, authorId, body, createdAt, editedAt: String? }`. Comments are oldest first; the first
  started the thread. Times are ISO instants (UTC). Authors are user ids: `Core.members(...)` has
  names and colours (an author may be `deleted-user`). Bodies are plain text, 1 to 10 000
  characters (the server answers 400 for blank or longer). `quote` is the selected text, cut to 500
  characters. There is no mention parsing in the API (the server's notification hooks read `@name`
  from the body; the client sends plain text).
- **Who may do what** (server): anyone who can open the page can read threads (viewers too).
  Members and up can start a thread, reply, resolve and reopen (any of them, not only the
  starter); a viewer gets `CoreError.Server(status: 403, ...)`. Editing a comment: its author
  only. Deleting a comment: its author or a workspace admin; deleting the last one removes the
  thread. Deleting a whole thread: its starter or an admin. A reply to a resolved thread reopens it.
  Locked pages answer 403 until unlocked.
- **The anchor.** A thread is tied to the page text by a `comment` mark whose attribute
  `threadId` equals the thread's id (`Mark::Comment { thread_id }` in `content.rs`, so reading
  existing anchors already works). The server never touches the document: the mark is the client's
  job, and the server accepts any UUID as the thread id. **The call order the web uses**
  (`beginComment`, `submitComment`, `cancelComment` in `collabComments.ts`), which apple should
  follow:
  1. On Comment with a non-empty selection: `let id = newCommentThreadId()`; keep the selected
     text (at most 500 characters) as `quote`.
  2. **Mark the selection with `id` through the editor engine** (the web's `setComment(id)`), so
     the highlight shows while the composer is open and follows concurrent edits.
  3. The user types the comment; **then** `core.addCommentThread(pageId:, threadId: id, quote:,
     body:)`. Retrying with the same id returns the same thread (safe after a timeout); another
     user's id gives 409.
  4. If the user cancels, or step 3 fails for good: remove the mark of `id` (`unsetComment(id)`).
  5. When a thread is deleted (`deleteCommentThread`, or `deleteComment` returned `true`): remove
     its mark the same way. Resolved threads keep their mark; the web just stops highlighting them
     (it draws marks only for open threads that `pageComments` returned).
  **The engine has no such commands today** (`crates/nv-editor` and `EditorSession` have none and
  nothing in `nv-core` writes the mark), so the editor stream needs to add `set_comment(thread_id)`
  (mark the current selection) and `unset_comment(thread_id)` (remove every mark of that thread).
  Until it does, apple can list, create (step 3 alone), reply, resolve and delete threads and show
  `quote`, but a new thread has no highlight in the page. (The server's header comment in
  `comments.ts` says "create the thread, then add the mark"; the web does it the other way round,
  as above.)
- Live updates: the server publishes an event `{type: 'comments', workspaceId, pageId}` on its
  event stream when a thread changes; the core has no event stream yet, so refetch with
  `pageComments` after your own calls and when the page is opened.
- Swift names: `CommentThread`, `ThreadComment` do not clash with `apps/apple` (no `Comment*` or
  `Thread*` types there).

## For apple: task details (2026-11-22, `rewrite/core-tasks-full`)

All additions; nothing was renamed or removed, and `apps/apple` constructs `CoreTask(...)`
(`LookData.swift`), so **`Task` is unchanged** and the full task is a new record, `TaskDetail`.
Apple's open request ("task fields to write ... to read: `team_id`, `recurrence`, `reminders`,
`created_by`, `completed_by`, `assigned_by` ... tag, team and member lists with names") is
answered below. The truth for every field is the server: `server/tasks.ts` (`rowToTask`,
`validate`, `updateTask`), `shared/types.ts` (`Task`, `TaskPatch`, `Recurrence`, `Reminder`),
`server/routes/{tasks,reminders,teams,workspaces}.ts`; the web's use is
`src/components/TaskDetail.tsx` and `src/store/tasks.ts`.

**Reading.**

```swift
core.cachedTaskDetail(taskId:) -> TaskDetail?                // the stored task, instant
core.cachedTaskDetails(workspaceId:) -> [TaskDetail]?        // like cachedTasks
core.taskDetails(workspaceId:) throws -> [TaskDetail]        // like tasks(): sends queued changes first
```

There is no "get one task" on the server (only the workspace list, PATCH answers and the
`task` event), so a task's detail is the list's entry. `TaskDetail` = `Task`'s fields plus:

| Field | Type | Meaning |
|---|---|---|
| `title`, `description` | String | description is plain text, up to 50 000 characters |
| `done` | Bool | status `open`/`done` |
| `priority` | UInt8 | 1 urgent, 2, 3, 4 none (the default) |
| `dueDate` | String? | **local calendar date `YYYY-MM-DD`, no time zone** ("the 5th" is the 5th wherever you are) |
| `dueTime` | String? | **local `HH:mm`** (24 h), shown with the date; no zone either |
| `recurrence` | TaskRecurrence? | the repeat rule, below |
| `reminderAt` | String? | the original single reminder: an **ISO instant in UTC** (`2026-12-01T08:00:00.000Z`) |
| `assigneeId`, `assignedBy` | String? | user ids; `assignedBy` is who last set the assignee (server-set; none while unassigned) |
| `createdBy`, `completedBy` | String / String? | user ids (`createdBy` may be `deleted-user`) |
| `pageId`, `parentId` | String? | the note it is written on; its parent task (one level deep) |
| `teamId` | String? | one team |
| `tagIds` | [String] | no order |
| `checklistDone`, `checklistTotal` | UInt32? | counts of the plain checklists under the task in its note (server counts them when the page is saved) |
| `completedAt`, `createdAt`, `updatedAt` | String(?) | ISO instants, UTC |
| `locked` | Bool | on a locked page not unlocked: title and text withheld |

`TaskRecurrence { freq, interval?, byWeekday?, byMonthDay?, byNthWeekday?, until?, count?,
basis? }`: `freq` is `day`, `week`, `month`, `year` or `weekday` (Mon to Fri, no interval);
`interval` 1 to 365; `byWeekday` days 0 Sunday to 6 Saturday (weeks start Monday for "every 2
weeks on ..."); `byMonthDay` 1 to 31 or -1 (last day); `byNthWeekday { n: 1...5 or -1, weekday }`
("the 2nd Tuesday"); `until` is a `YYYY-MM-DD` (inclusive); `count` is the series length;
`basis` is `due` (default) or `completion`. A rule a newer server writes that this core can't
read comes back as no rule (the task still reads).

Not stored on the task, so not in `TaskDetail`: **subtask order** (the server has no position
field; the web lists subtasks by `createdAt`, the order in the task list; their order inside the
note is the note's) and **checklist items** (they are text in the page, only the counts are
fields; `taskNotes` returns them as Markdown).

**Writing: `core.updateTask(taskId:changes:) throws -> TaskDetail`.** One PATCH with only the
fields you set (a `TaskChanges` record; every field defaults to "leave it"). The call returns
the task as the server has it now.

```swift
TaskChanges(title:, description:, done:, priority:, dueDate:, clearDueDate:, dueTime:, clearDueTime:,
            recurrence:, clearRecurrence:, reminderAt:, clearReminderAt:, assigneeId:, clearAssignee:,
            teamId:, clearTeam:, tagIds:, pageId:, clearPage:, parentId:, clearParent:)
```

- **Set** a field by giving it a value; **clear** one by its `clear…` flag (`dueDate`, `dueTime`,
  `recurrence`, `reminderAt`, `assigneeId`, `teamId`, `pageId`, `parentId`): the call then sends
  `null`, exactly what the web sends (`updateTask(id, { dueDate: null })`). A value given with its
  flag wins. Absent means untouched. `title`, `description` ("" empties it), `priority`, `done`
  and `tagIds` (the whole list; `[]` clears) can't be null.
- **Server rules you will meet** (`server/tasks.ts`): only workspace members or editors of the
  note may edit; a viewer, or a note shared view-only, gets `.Server(status: 403 ...)` (the
  assignee may still tick or reopen). Teams and tags are for members. The assignee must be a
  member of the workspace (or someone the page is shared with). A subtask has no subtasks of its
  own and can't change page without its parent; `parentId` of a task that has subtasks is refused
  (400). `pageId`/`parentId` set `null` take a task off its note / make it its own task.
- **Ticking** (`done: true`): a recurring task is not completed: the server leaves a done copy
  in the history, moves the task's `dueDate` to the next date (and its single reminder by the
  same offset) and keeps it open. The returned `TaskDetail` is that open task. Offline the
  stored copy is shown done (the server's roll-forward arrives when the change is sent).
- **Checked first.** What the server would refuse (`validate`) is refused before anything is
  sent or queued, as `.Server(status: 400, message: ...)` with the server's own words (`Invalid
  priority`, `Invalid due date`, `Invalid due time`, `Invalid title` > 1000 characters, `Invalid
  description` > 50 000, `Invalid tags` > 50, `Invalid recurrence frequency/interval/weekdays/day
  of month/nth weekday/end date/occurrence count/basis`). Dates must be real dates (the server only
  checks the shape).
- **The web's two conveniences are the app's to do** (the core doesn't know your "today"): when
  it sets a **time** on a task with no due date it also sets `dueDate` to today; when it sets a
  **rule** on a task with no due date it sets `dueDate` to `firstOccurrence(rule:, from: today)`.
  Do both in the same `updateTask`.

**Offline.** The same queue as `setTaskTitle`: with a store, a change the server can't be reached
for is kept in `task_ops` (the stored PATCH body, so no schema change), applied to the stored
task at once and the call returns the task as it will be (`assignedBy` is you, `completedAt` and
`completedBy` set when ticking), `unsentTaskChanges()` counts it, `sendTaskChanges()` sends it, and
`taskDetails`/`tasks` lay waiting changes over the list. Several changes to one task are sent as
separate PATCHes in order. A refused queued change is dropped and noted in `taskError()`. Not
queued (the call throws `Network`): no store, a locked page, a task the store doesn't know. Tags,
teams, members, reminders and notes (below) are **online only**: they throw `Network` offline
(they are not cached).

**Creating with fields.** `NewTaskInput` has new fields after `done`, all defaulted, so existing
calls compile: `description`, `priority`, `dueDate`, `dueTime`, `recurrence`, `reminderAt`,
`assigneeId`, `teamId`, `tagIds`. They are validated like `updateTask`'s.

**The lists a task points into** (all `throws`, online only):

```swift
core.tags(workspaceId:) -> [TaskTag]                          // id, name, color "#rrggbb"
core.createTag(workspaceId:, name:, color:) -> TaskTag        // by name; an existing name (any case) returns it; "#" dropped; members and up
core.teams(workspaceId:) -> [TaskTeam]                        // id, name, color, parentId, memberIds
core.members(workspaceId:) -> [WorkspaceMember]               // id, name, email, color, role
core.taskNotes(taskId:) -> String                             // the notes under the task in its page, Markdown ("- [ ] x", "- [x] y"), "" if none
core.taskReminders(taskId:) -> [TaskReminder]                 // yours only
core.addReminder(taskId:, spec:) / updateReminder(reminderId:, spec:) / deleteReminder(reminderId:)
```

`ReminderSpec` is `.at(at: ISO UTC)` or `.before(minutes: 0...86400)` (before the task's due time,
or the user's default reminder time on a date-only task; it follows the due date when that
moves). At most 10 per task. `TaskReminder.nextFireAt` is when it fires next (none once fired, no
due date, or the task is done). Team creation and tag editing/deletion are admin screens and
aren't in the Core API.

**Quick add.** It is parsed on the client today (`shared/quickadd.ts`, used by
`src/components/QuickAdd.tsx` and the subtask field), so it is ported:

```swift
parseQuickAdd(text:, today:) -> QuickAddResult
// today: the user's LOCAL date "YYYY-MM-DD" ("tomorrow", "friday", "in 2 weeks" count from it;
// a malformed one means today in UTC). No time zone argument: dates have none.
QuickAddResult { title, dueDate?, dueTime?, priority?, recurrence?, assignee?, tags: [String], team?, tokens }
QuickAddToken { start, end, kind }   // UTF-16 offsets (String.utf16, NSRange); kind: .date .time .priority .recurrence .assignee .tag .team
```

Same words as the web: `today tod tonight tomorrow tmr tmrw`, `next week` (Monday), `next month`
(the 1st), `in N days|weeks|months`, weekdays (`fri`, `on friday`, `next friday`: the next one
strictly after today), `Nov 30`, `30 Nov`, `Dec 25th`, `2026-12-01`, times (`3pm`, `at 3:30pm`,
`at 15:30`, `noon`, `midnight`), `p1`..`p4` or `!p1`, `@name`, `#tag` (several; a letter first),
`+team`, and repeats (`daily`, `every 2 weeks on mon,thu`, `every month on the 15th`, `every 2nd
tuesday`, `every weekday`, ... with `until 2026-12-31`, `for 10 times`/`x10`, `after
completion`); "by", "due", "on", "at" before a date or time go with it. A repeat with no date
starts on its first matching day; a monthly or yearly rule is pinned to the date's day. It does
**not** resolve names or create anything: the web then does, and the app does the same:

```swift
let q = parseQuickAdd(text: line, today: todayLocal)
let me = core.user()!.id
let assignee = q.assignee.flatMap { resolveMember(mention: $0, members: members, me: me) } ?? me   // the web defaults to you
let team = q.team.flatMap { resolveTeam(text: $0, teams: teams) }   // unresolved: the web keeps " +text" in the title
let tagIds = try q.tags.map { try core.createTag(workspaceId: ws, name: $0, color: nil).id }       // makes missing tags
try core.createTaskWith(workspaceId: ws, task: NewTaskInput(title: q.title, pageId: page, done: false,
    priority: q.priority ?? 4, dueDate: q.dueDate, dueTime: q.dueTime, recurrence: q.recurrence,
    assigneeId: assignee, teamId: team, tagIds: tagIds))
```

(An `@name` that resolves to nobody stays in the title as `@name`, as the web does.) Also exported,
for the Repeat row: `describeRecurrence(rule:, dueDate:) -> String` ("Every 2 weeks on Mon,
Thu", "Every month on the last day", "Every year on Feb 14"; the web's task detail text) and
`firstOccurrence(rule:, from:) -> String`.

**How it was checked.** `scripts/corpus/quickadd.ts` runs the web's own `parseQuickAdd` over 134
lines for 4 "today"s (Thu 5 Nov 2026, leap day 2028, year end, month end: 536 results, tokens
included) and `describeRecurrence`/`firstOccurrence` over 21 rules, committed in
`tests/corpus/quickadd.json`; `crates/nv-core/tests/quickadd.rs` reproduces every one.
`crates/nv-core/tests/task_detail.rs` (scripted server: every field, bodies, clears, validation,
offline queue, lists, reminders) and `crates/nv-api/tests/client.rs` cover the calls; the
real-server test (`task_details_against_a_running_server`) sets and reads back every field,
clears them, ticks (plain and recurring), makes and unmakes a subtask, and runs reminders, tags
and members against `server/index.ts`. **Not run against a real server:** teams (the Core API
can't create one; `teams()` and `teamId` are tested with the scripted server only), a
non-member assignee, an edit refused as view-only (403), and the offline queue replaying a task
change against a server.

## For apple: boxes (2026-11-22, `rewrite/core-boxes`)

All additions (a new `BoxError` and new `LivePage` methods; nothing renamed), so today's Swift
compiles unchanged. Each call is **one local edit** on the live page, written in the web app's
own format (below), so it goes out like typing does: sent at once, kept in the store and resent
after a restart if offline. Units are the page's own: points from the page origin (what
`BoxGeometryStore` calls "from the surface origin").

```swift
LivePage.createBox(x: Double, y: Double, w: Double, z: Double) throws -> String   // the new id
LivePage.createBoxWithId(id: String, x:, y:, w:, z:) throws                       // your id; exists on a repeat
LivePage.moveBox(id: String, x: Double, y: Double) throws
LivePage.resizeBox(id: String, w: Double) throws                                  // also clears `wide`
LivePage.bringToFront(id: String) throws -> Double                                // the box's z afterwards
LivePage.deleteBox(id: String) throws                                             // empty boxes only
LivePage.deleteBoxWithContent(id: String) throws                                  // whatever it holds
newBoxId() -> String                                                              // free function
// enum BoxError (cases capitalised in Swift, as CoreError's): .NoSuchBox(id), .Exists(id), .NotEmpty(id), .Invalid(message), .Closed
```

- **Values.** x and y are rounded to whole points and clamped to 0...20000; `w` to 120...2400
  (the web's `clampPos`/`clampWidth`), so `moveBox` to a negative point puts the box at 0. `z` is
  stored as given. NaN or infinity is `invalid`. The web also snaps to the grid on ruled pages
  and starts a box 12 pt above a click: both stay the app's job (apple already does the 12 pt).
- **z.** "Front" is one above the highest z on the page; a box already alone on top stays where
  it is (nothing is written, the call returns its z); a tie at the top counts as not in front.
  For `createBox`, pass `z` = (highest z on the page) + 1 (0 if none), as the web does:
  `(page.info().boxes.map(\.z).max() ?? 0) + 1`.
- **A new box is empty**: an entry in `boxes` and an empty `box:<id>` fragment, like the web's
  `createBox`; the editor adds the first paragraph when it opens the box. It exists in the live
  document at once, so `EditorSession.openLive(page:, field: "box:" + id, ...)` works right after
  `createBox`, and so does `EditorSession.open` on `page.document()`; typing goes out through the
  session. Checked in `crates/nv-core/tests/boxes.rs` (typing reaches the stand-in server).
- **Deleting.** The web removes a box the user left empty without asking, and deletes a box with
  content only when the user selects it and presses Delete (with an undo toast; the core has no
  undo). So `deleteBox` refuses a box with content with `.NotEmpty` and changes nothing (empty
  paragraphs count as empty, as the web's `fragmentIsEmpty` does); for a user-chosen delete use
  `deleteBoxWithContent`. Neither deletes tasks on the box's task lines (the web does, through
  the task calls): read `readPage(document:).taskIds` first and `deleteTask` them.
- **Errors.** An id not on the page is `.NoSuchBox` (someone may have deleted it: drop it
  locally). After `close()` every call is `.Closed` and writes nothing. Locked pages: ordinary
  local edits, so they follow the existing rule (a locked page's edits stay in memory, nothing
  is queued in the store).
- **Implementing `BoxGeometryStore`**: `savesToServer = true`; `createBox(x:y:width:front:)` →
  `try page.createBox(x: x, y: y, w: width, z: front)`, return the id (no more `local-` ids);
  `moveBox` → `moveBox`; `resizeBox(_, width:)` → `resizeBox(id:w:)`; `bringToFront(_, z:)` →
  `bringToFront(id:)` (core computes z; the `z` argument isn't needed, or use the returned
  value); `deleteBox` → `deleteBox` (`deleteBoxWithContent` when the user chose to delete a box
  with text). Others' box changes arrive through `LivePageListener.onChange` (`PageInfo.boxes`)
  as before; a local call does not fire `onChange` for itself (like local typing), so redraw
  after the call.
- **The format, as the web writes it** (listed with sources in the header of
  `crates/nv-model/src/boxes.rs`): a box is a nested Y.Map in `boxes` with `x`, `y`, `w`, `z`
  numbers and `wide: true` only when set; moves and resizes set those keys on that map, and a
  resize deletes `wide`; ids are 16 base-36 characters (8 random bytes, two characters each,
  `newBoxId` in `src/editor/canvasGeom.ts`). A legacy plain-object entry is converted to a map
  the first time it is edited (the web ignores such entries).
- **How it was checked.** `scripts/corpus/box-ops.ts` runs today's web code (`newBoxMap`,
  `boxAtClick`, `frontZ`, `clampPos`/`clampWidth`, `boxGeoms`; `setGeom` and `removeBox` are
  copied from `CanvasEditor.tsx` because that file is React) on the `canvas-boxes` page and
  commits the result in `tests/corpus/box-ops/`; `crates/nv-model/tests/box_ops.rs` makes the
  same five edits through the Rust calls and compares the raw `boxes` map (after an
  encode/decode) and `Page::read` field by field. **Not run:** the web app reading bytes
  written by Rust (the structure is the same as the web's own, so it should); worth a look on a
  real page.

## For editor: boxes (2026-11-22)

Nothing to change. `EditorSession::open` / `open_live` read boxes through `Page::read` (their
`check_field`), which sees a box made by `LivePage::create_box` at once (its entry exists and its
fragment is empty), and opening an empty fragment adds the trailing paragraph as for any box.
`crates/nv-core/tests/boxes.rs` opens a new box by both routes and types in it. For later:
`nv_model::boxes::{create_box, move_box, resize_box, bring_to_front, delete_box}` take a
`yrs::Doc`, so a web-style box edit can be made on any doc, not only a `LivePage`'s.

## For apple: task calls (2026-11-21, `rewrite/core-tasks`)

All additions; nothing was renamed or removed, so today's Swift compiles unchanged (checked by
generating the Swift bindings on Windows; the Apple CI run is the real check).

- **The easy way: `core.pageTasks(workspaceId:pageId:) -> TaskCallbacks`.** Pass it as `tasks`
  to `EditorSession.open` (and later `openLive`) instead of `LocalTaskCallbacks`. Its calls
  return at once, so they are safe where the session calls them (with its lock held, on the
  main thread): titles come from this page's own changes, then the stored tasks; creates,
  renames, deletes and restores go to the server on its own thread (`nv-core-tasks`, one per
  `pageTasks` object, ended when it is released), in order, and are queued offline (below).
  Tasks are made in `workspaceId`, on `pageId`. Keep one per open page. A refused write shows
  in `core.taskError()`. There is no change notification yet: refresh the task list from
  `cachedTasks` (or `tasks`) when you next show it.
- **The calls themselves**, if apple keeps its own `TaskCallbacks` (all block on the network,
  so call them off the main thread, in order, e.g. on the serial queue):
  - `newTaskId() -> String` (free function): a random v4 UUID, lower case, as the web app's
    `crypto.randomUUID()`.
  - `createTaskWith(workspaceId:task: NewTaskInput) throws -> Task`; `NewTaskInput { id: String?,
    title: String, pageId: String?, parentId: String?, done: Bool }` (all but `title` have
    defaults). The server accepts the client's id (a UUID; `server/tasks.ts` `createTask`) and
    a retry with the same id returns the task it already made (409 if another user or workspace
    used it). An empty title is allowed. `done: true` is a create then a PATCH, as the web
    app's restore does.
  - `setTaskTitle(taskId:title:) throws -> Task` (PATCH `{ title }`; the server trims it).
  - `deleteTask(taskId:) throws` (DELETE `/tasks/:id`; subtasks go too, on the server and in
    the store; a task already gone, 404, counts as deleted; a refusal such as 403 puts the
    stored copy back).
  - `canRestoreTask(taskId:) -> Bool` (instant) and `restoreTask(taskId:) throws -> Bool`:
    bring back a task this Core deleted, with its subtasks, same ids and fields (description,
    due, priority, assignee, tags, recurrence…), done ones done again: what the web app's undo
    does (`restoreTasks` in `src/store/tasks.ts`; the server has no undelete, the task is made
    again with its old id). Needs a store (the fields come from the stored copy).
  - `cachedTask(taskId:) -> Task?` (instant, from the store, queued changes included).
  - `sendTaskChanges() throws -> UInt32` (send what was queued offline; returns how many still
    wait), `unsentTaskChanges() -> UInt32`, `taskError() -> String?`.
- **`TaskCallbacks` → Core** (what `pageTasks` does; for an own implementation):

  | `TaskCallbacks` | Core |
  |---|---|
  | `newId()` | `newTaskId()` |
  | `create(id, title, done)` | `createTaskWith(ws, NewTaskInput(id, title, pageId, nil, done))` |
  | `delete(id)` | `deleteTask(id)` (keep the title locally until it's done) |
  | `restore(id) -> Bool` | answer at once: "did this page delete it?"; then `restoreTask(id)` behind (falls back to `createTaskWith` with the old title when it returns false, e.g. no store) |
  | `title(id) -> String?` | this page's pending change, else `cachedTask(id)?.title` (never a network call: it is called while drawing) |
  | `setTitle(id, title)` | `setTaskTitle(id, title)` |

  The engine calls these with the session's lock held, so nothing in them may block on the
  network or call back into the session: do the Core call on another queue (in order), and
  answer `title`/`restore` from local state.
- **Offline.** With a store, a task write the server can't be reached for is kept in the store
  (new table `task_ops`, schema 3, upgraded in place), applied to the stored tasks at once, and
  the call returns as if it worked (the task as it will be). Writes are sent in order, one at a
  time: by `sendTaskChanges()`, before `tasks()` reads the list, and before every task write
  (a write made while earlier ones still wait queues behind them). `tasks()` lays writes still
  waiting over the server's list. A queued write the server then refuses (4xx) is dropped,
  noted in `taskError()`, and a refused create is removed from the stored tasks; 5xx and
  network errors keep it for later. Not queued (the call throws `Network` as before): without
  a store, for a task on a page the stored tree doesn't show unlocked (its title is the user's
  text), and for an edit of a task the store doesn't know. Apple could call
  `sendTaskChanges()` when a live page reaches `.synced`.
- **Behaviour changes** (no API change): `createTask(workspaceId:title:pageId:)` now sends an
  id the core makes; it, `setTaskDone` and the new calls queue offline instead of throwing
  `Network` (when the rules above allow), and `tasks()` sends queued writes first. Locked
  pages: unchanged (tasks are stored as the server sends them, redacted).

## For editor: the live doc (2026-11-21, `rewrite/core-tasks`)

Core's half of `EditorSession::open_live`; editor writes `open_live` in `editor_session.rs`.

- **What core provides** (`crates/nv-core/src/client.rs`, crate-visible, on `LivePage`):

  ```rust
  impl LivePage {
      /// The page's live document (a handle: clone it into the editor's binding).
      pub(crate) fn doc(&self) -> &nv_model::yrs::Doc;
      /// Run `hook` around every remote update; returns its id.
      pub(crate) fn add_remote_hook(&self, hook: Arc<dyn nv_sync::RemoteHook>) -> u64;
      pub(crate) fn remove_remote_hook(&self, id: u64);
      /// `close()` was called: edits on `doc()` are no longer sent.
      pub(crate) fn is_closed(&self) -> bool;
  }
  // nv-sync (crates/nv-sync/src/protocol.rs), re-exported as nv_sync::RemoteHook:
  pub trait RemoteHook: Send + Sync {
      /// Call `apply` once (it is called after you if you don't): it applies the update with
      /// REMOTE_ORIGIN and returns whether the document changed.
      fn around_remote(&self, apply: &mut dyn FnMut() -> bool);
  }
  ```

  And in nv-model: `nv_model::Page::fragment(doc: &Doc, name: &str) -> Fragment` and
  `nv_model::tree::read_fragment(txn, name) -> Vec<Node>` (now public): one fragment, `default`
  or any `box:<id>` with or without geometry, without reading the rest of the page (an absent
  fragment reads as empty).
- **Why a hook around the update, not a callback after it.** The engine's remote path takes
  sticky positions on the old tree *before* the update and maps them after
  (`remote.rs`: `stick` → `apply_remote` → `read` → `unstick`), and its `finish()` writes the
  whole tree as a diff against the fragment, so an edit landing between a remote update and
  the session's re-read would undo the remote change. `around_remote` lets the session hold its
  own mutex across stick, apply and re-read, so the session's tree and the fragment always match
  whenever the lock is free.
- **Local edits.** Any transaction on `doc()` whose origin isn't `nv_sync::REMOTE_ORIGIN` is a
  local edit: LiveDoc's update observer takes it when it commits (on the editing thread), keeps
  it in the outbox (the store) and sends it, exactly as `LivePage::apply_update` does. So the
  binding's `LOCAL` and `LOAD` writes (the trailing paragraph at open too) and the undo
  manager's writes all go out; nothing else to call. They are not reported back: `on_change`
  and the hooks fire only for updates from the server, and the server's echo of a local edit
  changes nothing (hooks see `apply() == false`). Tested in
  `crates/nv-core/src/live_doc_tests.rs` (edit on the doc with an own origin, online and
  offline: server, outbox, receipt; a remote update runs the hook with before/after; a hook
  holding its lock while another thread edits under the same lock).
- **Threads and locks.**
  - `around_remote` runs on the page's connection thread (`nv-sync`), for every remote update
    (sync step 2 after each connect, and updates), with no core or nv-sync lock held and no
    yrs transaction open. `apply()` opens a write transaction on the doc and commits it before
    it returns.
  - So the session's hook takes the session's `Mutex<Editor>`, then calls `apply()`. Local
    calls take the same mutex, then write the doc: one lock order (session mutex → yrs
    transaction), no deadlock. Inside the hook, hold no yrs transaction on the doc while calling
    `apply()` (the engine's `stick` drops its read transaction before returning: fine).
  - Several sessions on one page each add a hook; they nest (first added outermost), so during
    a remote update the connection thread holds every session's mutex at once, in the order they
    were added. Rule: never call into one session while holding another's lock (and
    `TaskCallbacks` must not call sessions). Don't call `LivePage::close()`, `apply_update`,
    `presence` or `unsent_updates` with the session locked (they take the page's lock, which
    `close()` holds while it waits up to 1 s for the connection thread).
  - The hook should hold the session through a `Weak` (the session holds `Arc<LivePage>`, which
    holds the hooks: a cycle otherwise); remove it in the session's `Drop`.
  - `LivePageListener::on_change` fires after the hooks, on the same thread: when apple hears
    it, the sessions already hold the new tree, so it just re-reads `state()` / `view_state()`.
  - Edits queued offline from an earlier run are applied to `doc()` before `open_live_page`
    returns, without hooks (no session exists yet).
- **What editor would change** (nv-editor, editor-owned):
  1. In `remote.rs`, a variant of `Editor::apply_update` that takes the apply step instead of
     bytes, e.g. `pub fn around_remote(&mut self, apply: &mut dyn FnMut() -> bool)`: the same
     `suspend_composition` / stick / *apply()* / read / unstick / `resume_composition` as today,
     with `b.apply_remote(update)?` replaced by `apply()` (skip the re-read when it returns
     false, if you like). `Binding::apply_remote` must not be used on the live doc: its origin
     (`nv-editor-remote`) isn't `REMOTE_ORIGIN`, so the update would be sent back out as a local
     edit (harmless, Yjs is idempotent, but wasteful).
  2. `Editor::open` already takes a `Doc` by value; `Doc` is a handle, so
     `Editor::open(page.doc().clone(), &field, …)` binds to the live doc itself. Nothing else in
     the engine owns a separate doc.
- **Suggested signature** (editor writes it in `editor_session.rs`):

  ```rust
  #[uniffi::export]
  impl EditorSession {
      /// `field` of a page open live: edits go out through the page, others' come in through it.
      #[uniffi::constructor]
      pub fn open_live(
          page: Arc<LivePage>,
          field: String,
          tasks: Arc<dyn TaskCallbacks>,
      ) -> Result<Arc<EditorSession>, EditorError>;
  }
  ```

  Sketch: refuse when `page.is_closed()`; check the field with `Page::fragment` or the box
  geometry (open after `LiveStatus::Synced`, or the doc may not have the box yet and the
  trailing paragraph written at open would merge in beside the server's content);
  `Editor::open(page.doc().clone(), …)`; keep `page` and the hook id in the session; the hook is
  `struct LiveHook(Weak<EditorSession>)` whose `around_remote` upgrades, locks the editor and
  calls `ed.around_remote(apply)` (or just `apply()` when the session is gone). In live mode
  `apply_update` / `encode_update_since` aren't needed (keep them for corpus pages). With
  `core.pageTasks(...)` as `tasks`, the session's task lines are backed by the server.

## For apple: live pages (2026-11-21, `rewrite/core-sync`)

All additions; nothing was renamed, so today's Swift compiles unchanged.

- **New: `Core.openLivePage(pageId:listener: LivePageListener) throws -> LivePage`.** Returns at
  once (it throws only for a server URL that can't be used): the page connects on its own thread
  and reports through `LivePageListener { onStatus(status: LiveStatus); onChange(page: PageInfo) }`
  (called on that thread; hop to the main thread). It stays in sync until `close()`:
  - `LiveStatus.connecting(attempt:)`: opening the socket (attempt 0 the first time, else how
    many tries in a row failed).
  - `.connected`: socket open, waiting for the server's copy.
  - `.synced`: up to date; edits flow; queued edits have been sent. Heard once per connection.
  - `.reconnecting(attempt:inMs:code:reason:)`: not connected; the core tries again by itself in
    `inMs` ms (0 = at once, after refreshing the session on a 4401). `attempt` counts from 1 and
    starts again after a sync; `code` is the server's close code (nil: network). Delays: 1 s
    doubling to 30 s, times 0.75–1.25 (as the web app). Show "Offline, reconnecting…"; nothing to do.
  - `.ended(reason:message:)`, always the last status, no more reconnecting:
    `LiveEnd.closed` (you called `close()`), `.noAccess` (4403: locked, deleted or unshared; the
    stored copy and queued edits are deleted), `.signedOut` (the refresh token was rejected:
    end the session as for `CoreError.SignedOut`).
  - 4401 (token expired) is handled inside: the core refreshes through the same session (one
    refresh at a time across threads; the refresh token rotates, so store `refreshToken()` again
    when you next touch the keychain) and reconnects at once, up to 3 times in a row, then with
    the usual delays.
- **So apple can drop its reopen loop** (`retryLater`, `attempts`, the 4401 reopen and the
  `dropConnection` on `Failed`/`Closed`): open once with `openLivePage`, map the statuses to the
  badge, end on `.ended`, call `close()` when the page leaves the screen. `close()` returns at once
  while waiting to reconnect, and within about 1 s if a connect is hanging (the thread then
  finishes on its own, silently); keep calling it off the main thread to be safe.
- **`Core.openPage` still works** and its `SyncStatus` is unchanged, but it now reconnects by
  itself as well: a drop is reported as `.failed(message)` (network) or `.closed(code, reason)`
  (the server's code, e.g. 1012 or 4401 while it refreshes), and is followed by `.connected` /
  `.synced` again; the end is `.closed` 1000 (closed), 4403 (no access) or 4401 (signed out).
  Today's loop (close on `Failed`/`Closed`, reopen) keeps working on top of that; it is just no
  longer needed. `openPage` still blocks for the first connect.
- **Local edits are kept until the server has them.** `LivePage.applyUpdate` (and the editor
  session later) edits go into a queue that is saved in the store (new table, schema 2), sent once
  the sync handshake is done (again after each reconnect) and removed when the server's receipt
  comes back. Opening a page with queued edits (e.g. after a restart while offline) applies them to
  the document and sends them. New: `LivePage.unsentUpdates() -> UInt32` (0 = all on the server)
  and `Core.unsentPages() -> [String]` (pages with edits not yet sent; for an "unsynced" mark).
  Locked pages and pages not in a stored tree keep edits in memory only; sign-out clears them.
- **Store rule change:** a page's document (and its queued edits) is stored only when a stored
  tree shows the page unlocked. Before, a page no tree had shown yet was stored; it might have
  been a locked one. Apple loads the tree before opening pages, so nothing changes in practice.
- **New: `Core.storeError() -> String?`**, the last store write that failed (the store is a cache,
  so calls carry on), also printed to stderr as `[nv-store] write failed: …`. For diagnostics.
- **TLS now uses the system's trust store and checks** (Security.framework through
  `rustls-platform-verifier`) instead of a bundled Mozilla root list, for HTTP and the collab
  socket. So a user-installed or MDM root works, and revocation follows the system. The
  NotiveloCore package now links `Security` and `CoreFoundation` (in its `Package.swift`).
  Apple's guidance is not to evaluate trust on the main thread; all TLS happens inside network
  calls, which apple already makes off the main thread.

### Answers to apple's requests

- **Is `Core.openPage` blocking? Which calls are safe concurrently?** `openPage` blocks for the
  first connect (up to about 10 s per step when the network hangs); `openLivePage` doesn't. Every
  `Core` and `LivePage` call is safe from several threads at once, so apple can use a concurrent
  queue: the session's tokens are behind a mutex and refreshes are serialised (when several
  calls find the token stale at once, one refreshes and the others use its token; refresh tokens
  are never spent twice), HTTP goes through one thread-safe ureq agent (each call blocks only its
  own thread), and the store serialises its reads and writes behind its own mutex (WAL mode;
  each write is one short transaction). What blocks: every server call (sign-in, `workspaces()`,
  `tree`, `tasks`, `pageDocument`, task writes; GETs retry up to 3 times on network errors),
  `openPage`, and `signOut` (it revokes the session on the server). Instant: the `cached*` reads,
  `hasStore`, `user`, `refreshToken`, `unsentPages`, `storeError`, `openLivePage`, and the
  `LivePage` calls (`info`, `document`, `applyUpdate`, `presence`, `announcePresence`,
  `unsentUpdates`); `LivePage.close()` as above. One ordering note: `signOut` while pages are open
  should close them first (their threads would otherwise end with `.signedOut` on their next
  refresh, which is harmless).
- **Unlocking locked pages in the Core API** (built 2026-11-22: see "For apple: locked pages"; kept for the reasoning). What it would take:
  - Server (server/routes/locks.ts, read only): `GET /locked-notes` (status), `POST
    /locked-notes/unlock` with `{ password }` or `{ deviceId, secret }` → `{ expiresAt }` (rate
    limited), `POST /locked-notes/lock`, `POST /locked-notes/keepalive`, `POST
    /locked-notes/devices` `{ label }` → `{ id, secret }` (only while unlocked; for Face ID /
    Touch ID), `DELETE /locked-notes/devices/:id`. An unlock is per sign-in (the refresh-token
    family, `sid` in the access token) and lapses after idle time; typing on an unlocked page keeps
    it alive (the collab server does that itself every 30 s of activity).
  - Core: nv-api calls for those, and `Core.lockedNotesStatus()`, `unlockLockedNotes(password:)`,
    `unlockWithDevice(deviceId:secret:)`, `registerUnlockDevice(label:) -> {id, secret}` (apple keeps
    the secret in the keychain behind biometrics), `lockNow()`. Then `openLivePage` on a locked page
    works as for any page (the server lets the socket in for an unlocked sign-in).
  - Care needed: the store must keep refusing locked pages' documents (it does: the tree still
    marks them locked) and must not keep unredacted tasks: after an unlock `GET .../tasks` sends
    locked pages' task titles in full, which `tasks()` would store today. So tasks on locked pages
    would have to be redacted before storing (or not stored) while unlocked. Also relock on
    background/timeout like the web app (`lockNow`, and the server closes locked pages' sockets
    with 4403 when the unlock lapses, which now ends the page with `.noAccess` and drops its copy).
  - Roughly a day with tests against the real server.

## For apple: the on-device store (2026-11-21)

- Construct with `Core.withStore(serverUrl:dbPath:)`, e.g. a file in Application Support
  (excluded from backups). The folder is created if missing; a file that can't be read (damaged,
  or written by a newer app) is replaced by an empty one. `Core(serverUrl:)` still works and has
  no store (`hasStore()` is false, every `cached*` returns nil).
- Reads come in pairs. `cachedWorkspaces()`, `cachedTree(workspaceId:)`,
  `cachedTasks(workspaceId:)`, `cachedPageDocument(pageId:)` are local and instant (nil when
  nothing is stored; fine on the main thread). `workspaces()`, `tree(workspaceId:)`,
  `tasks(workspaceId:)`, `pageDocument(pageId:)` ask the server, store the answer, and when the
  server can't be reached (`CoreError.Network`) return the stored copy instead (they still throw
  when nothing is stored, and on `Server`/`SignedOut`). So: show the cached copy, then call the
  server one and show its answer.
- Offline launch: `restoreSession` throws `Network`; keep the refresh token and carry on: the
  network reads then fall back to the stored copies.
- `createTask` and `setTaskDone` update the stored tasks. `signOut()` clears the store; signing in
  as a different user clears it first.
- A `LivePage` saves its document to the store each time it is `Synced` and when it is closed; a
  `Closed(4403)` deletes the stored copy.
- Locked pages are never stored: a tree that marks a page locked deletes its stored document, and
  the store refuses to save one. Tasks on locked pages are stored as the server sent them
  (already redacted), as the web app does.

## For apple: box content (2026-11-21)

- `readPage(update:)` now returns `PageInfo.content: [BoxContent]`, and so does every
  `PageListener.onChange(page:)`. There's also `pageContent(update:) -> [BoxContent]` on its own;
  for a live page, use `livePage.info().content`.
- `BoxContent { boxId: String?, nodes: [ContentNode] }`: `default` first (`boxId == nil`, the old
  document column, usually empty), then each box in reading order (matching `PageInfo.boxes`).
- `ContentNode { kind: NodeKind, attrs: [Attr], runs: [TextRun], children: [ContentNode], markers: [String] }`:
  - `kind` is an enum of the editor's nodes (`.paragraph`, `.heading`, `.bulletList`,
    `.orderedList`, `.taskList`, `.taskItem`, `.taskRef`, `.callout`, `.details`, `.table`,
    `.image`, `.fileAttachment`, `.mention`, `.pageLink`, `.hardBreak`, …), `.text` for a text
    node, and `.unknown(name:)` for something a newer app wrote (show its children, or "update to
    see this").
  - `attrs` are the stored attributes (`level`, `checked`, `taskId`, `emoji`, `src`, …) as
    `AttrValue` (`.null`, `.bool`, `.number`, `.text`, `.json`).
  - `runs` (text nodes only): `TextRun { text, marks: [Mark] }` with `Mark` = `.bold`, `.italic`,
    `.underline`, `.strike`, `.code`, `.link(href:)`, `.textColor(color:)`,
    `.highlight(color: String?)` (nil = default yellow), `.comment(threadId:)`, `.unknown(name:)`.
  - `markers` (ordered lists only): each item's marker as exports number it ("1.", "b)", "iv."),
    with continued numbering already applied.
- The XCFramework now has an iOS simulator slice and a macOS slice that are both arm64 + x86_64,
  so Intel builds link. The iOS device slice is still arm64 only.

## Done

- 2026-11-22, ink (`rewrite/core-ink`): nv-model `ink.rs` (the `ink` map's one-transaction
  writes, opaque blobs), nv-core `ink.rs` (strokes read with points and bounds, outline as path
  commands, SVG and triangles, `InkStrokeBuilder` with the web's capture smoothing, add, erase
  whole and partial, move, delete, lasso, path and point hit tests on `LivePage`; z keys and ids
  as the web's); `nv-ink` itself unchanged (the web's WASM is untouched). Corpus:
  `scripts/corpus/ink-ops.ts` and `tests/corpus/ink-ops/`. Tests: `crates/nv-core/tests/{ink_ops,ink}.rs`,
  unit tests in `ink.rs` and `nv-model/src/ink.rs`, `ink_against_a_running_server` (port 4487, passed).
- 2026-11-22, sharing, version history and locked-page unlock (`rewrite/core-tree`): nv-api
  `share.rs`, `versions.rs`, `locks.rs` (members and invites, notebook and page shares, shared
  pages, versions and the restore snapshot, locked-notes calls) with their types, `Request`'s
  `Debug` hides bodies, and a 401 `device_revoked` is not refreshed and retried; nv-model
  `restore.rs` (`replace_page_content`, the Rust `replacePageContent`); nv-store redacts tasks of
  locked pages before writing (`put_tasks`, `put_task`, `put_tree`) and `mark_page_locked`;
  nv-core `sharing.rs`, `versions.rs` (`restoreVersion` on an open `LivePage`), `locked.rs` (and
  the tree refetch while unlocked). Tests: `crates/nv-api/tests/share_versions_locks.rs`,
  `crates/nv-core/tests/{sharing,versions,locked}.rs`, nv-model restore tests, nv-store tests, and
  `sharing_against_a_running_server`, `version_history_and_restore_against_a_running_server` and
  `locked_pages_against_a_running_server` (real server on port 4477, passed).

- 2026-11-22, tree management (`rewrite/core-tree`): nv-api `tree.rs` (`create_notebook`,
  `patch_notebook`, `move_notebook`, `delete_notebook`, `create_section`, `patch_section`,
  `move_section`, `copy_section`, `delete_section`, `create_page`, `patch_page`, `move_page`,
  `copy_page`, `delete_page`, `trash`, `restore_from_trash`, `purge_from_trash`, `empty_trash`),
  `Tree.trashed_pages`; nv-store keeps `trashed_page` rows and the stored documents of trashed
  pages, plus `workspace_of` / `tree_workspaces`; nv-core `tree_edit.rs` (the Core calls above,
  `positionAt`, `dropIndex`, `cachedTrashedPages`), each write followed by a stored-tree refetch.
  Tests: `crates/nv-api/tests/tree.rs`, `crates/nv-core/tests/tree_edit.rs`, nv-store tests, and
  `tree_management_against_a_running_server` (real server on port 4467, passed).
- 2026-11-22, search and comment threads (`rewrite/core-tasks-full`): nv-api `search`,
  `page_comments`, `add_comment_thread`, `reply_to_thread`, `set_thread_resolved`,
  `delete_comment_thread`, `edit_comment`, `delete_comment` with `SearchResult`/`CommentThread`
  types; nv-core `search.rs` (`Core.search`, `parseSnippet`/`SnippetRun`, `pageComments`,
  `addCommentThread`, `replyToCommentThread`, `resolveCommentThread`, `reopenCommentThread`,
  `editComment`, `deleteComment`, `deleteCommentThread`, `newCommentThreadId`). Tests:
  `crates/nv-api/tests/search_comments.rs`, `crates/nv-core/tests/search.rs` (scripted transport),
  the real-server test `search_and_comments_against_a_running_server` (page text written through
  a live page, found after the server's debounced save; a full thread round trip; passed locally
  on port 4457), Swift `testSnippetRunsAndThreadIds`. No server changes.

- 2026-11-22, the full task model (`rewrite/core-tasks-full`): nv-api `Task` with every server field
  (`assigned_by`, `completed_by`; missing and unknown fields tolerated), typed `Recurrence`,
  `TaskPatch` (`Option<Option<_>>`, `null` to clear), `Client::patch_task`, `completed_tasks`,
  `task_notes`, `tags`/`create_tag`, `teams`, `members`, `reminders`/`add_reminder`/
  `update_reminder`/`delete_reminder`; nv-core `task_detail.rs` (`TaskDetail`, `TaskChanges`,
  `updateTask`, `cachedTaskDetail(s)`, `taskDetails`, lists, reminders, `resolveMember`,
  `resolveTeam`, `describeRecurrence`, `firstOccurrence`, validation as `server/tasks.ts`),
  `NewTaskInput` with the quick-add fields, `quickadd.rs` + `recurrence.rs` (the web's quick add
  and repeat-rule text ported; new dependency `regex`), the offline queue carrying every field
  (no schema bump; optimistic copy sets `assignedBy`/`completedBy`). Tests: nv-api client tests
  (all fields, patch bodies, endpoints); `tests/corpus/quickadd.json` from
  `scripts/corpus/quickadd.ts` (the web's parser, 536 results, plus 21 rules) checked by
  `crates/nv-core/tests/quickadd.rs`; `crates/nv-core/tests/task_detail.rs`; the real-server test
  `task_details_against_a_running_server` (passed locally against `server/index.ts` on port
  4447); Swift `testQuickAddAndTaskFields`.

- 2026-11-22, box calls (`rewrite/core-boxes`): `nv_model::boxes` (create, move, resize, front,
  delete in the web's own format; `box_id_from`; `BoxError`), `crates/nv-core/src/boxes.rs`
  (`LivePage.createBox`/`createBoxWithId`/`moveBox`/`resizeBox`/`bringToFront`/`deleteBox`/
  `deleteBoxWithContent`, `newBoxId`, `BoxError`). Tests: nv-model unit tests (each call
  round-trips through `Page::read`, one update per call, clamping, plain-object entries),
  `crates/nv-model/tests/box_ops.rs` against `tests/corpus/box-ops/` (made by
  `scripts/corpus/box-ops.ts` with the web's code), `crates/nv-core/tests/boxes.rs` (create,
  `EditorSession` opens it and types, everything reaches the stand-in server), the real-server
  test extended (a box made on one sign-in, typed in, moved and widened; seen by the other and in
  the server's saved copy; passed locally on port 4437), Swift `testBoxCallsOnALivePage`.
- 2026-11-21, task calls and live-doc plumbing (`rewrite/core-tasks`): nv-api `delete_task`,
  `set_task_title`, `NewTask` with every TaskPatch field (and `Deserialize`); nv-store schema 3
  (`task_ops` queue with the locked-page rule, `task(id)` with an index, `remove_task` with
  subtasks); `crates/nv-core/src/tasks.rs` (`newTaskId`, `createTaskWith`/`NewTaskInput`,
  `setTaskTitle`, `deleteTask`, `canRestoreTask`/`restoreTask`, `cachedTask`,
  `sendTaskChanges`, `unsentTaskChanges`, `taskError`, `pageTasks` → `TaskCallbacks`; writes
  serialised, queued offline); `createTask`/`setTaskDone`/`tasks` routed through it; nv-sync
  `RemoteHook`/`RemoteHooks` around remote updates (`SyncDoc::remote_hooks`,
  `LiveDoc::remote_hooks`); `LivePage::doc`/`add_remote_hook`/`remove_remote_hook`/`is_closed`
  (crate-visible); nv-model `Page::fragment` and public `tree::read_fragment`. Tests: nv-api
  `task_writes_create_with_a_client_id_rename_and_delete`; nv-store task-op queue, removal
  with subtasks, upgrade from version 2; nv-sync `remote_hooks_run_around_each_remote_update_once`;
  nv-core `tests/tasks.rs` (online writes and restore, offline queue across a restart, refusals
  and overlay, locked pages and unknown tasks, `pageTasks`) and `src/live_doc_tests.rs` (above);
  nv-model `a_fragment_reads_on_its_own_with_or_without_geometry`; the real-server test now also
  creates a task with a client id, retries it, renames it, deletes it with a subtask, and
  restores it through a stored Core (passed locally against `server/index.ts`, on port 4427
  because 4417 was taken by another process).
- 2026-11-21, nv-sync robustness (`rewrite/core-sync`): `LiveDoc` reconnects with backoff
  (injectable `Backoff`), refreshes on 4401 through a `Session` (`access_token_replacing` in nv-api,
  serialised refreshes), stops on 4403 / signed out, closes promptly; local edits queue until a
  receipt (a step 1 after sending, answered in order) with an `Outbox` in nv-store (schema 2,
  `outbox` table, upgrade step); `openLivePage` + `LiveStatus`/`LiveEnd`/`LivePageListener`;
  `openPage` kept (reconnects too, old statuses); `unsentUpdates`, `unsentPages`, `storeError`;
  store refuses docs and queued edits of pages not known unlocked; TLS through
  `rustls-platform-verifier` (ureq `platform-verifier`, own rustls config for the socket;
  webpki-roots gone). Tests: `crates/nv-sync/tests/sync.rs` (stand-in server in
  `tests/support`, shared with `crates/nv-core/tests/live.rs`): drops, 1012, backoff timing and
  reset, 4401 refresh, signed out, a refresh that keeps failing, 4403, close while waiting and
  while connecting, offline edits sent after reconnecting, queue restored into a new LiveDoc;
  Core-level: restart with the same store, 4401 through the Core, `NoAccess` forgetting the queue,
  locked pages in memory only, `openPage` mapping; nv-store: outbox, upgrade from version 1, failed
  writes; Swift `testALivePageWithoutASessionEnds`; the real-server test now also opens a page
  with `openLivePage` and waits for the receipt (passed locally against `server/index.ts`).

- 2026-11-21, nv-store (`rewrite/core-store`): `crates/nv-store` (rusqlite bundled; records as
  JSON columns; `schema_version` 1 with an `UPGRADES` list; locked pages never stored; pruning as
  `prunePageCaches`), `Core::with_store` and the `cached_*` reads in `client.rs`, a non-exported
  `Core::with_transport` for tests. Tests: nv-store unit tests, `crates/nv-core/tests/store.rs`
  (scripted transport: cached-first, offline fallback, locked pages, sign-out, offline launch),
  LivePage save tests in `client.rs`, the Swift `testCoreWithAStore`.
- 2026-11-21, M4 step 1 (`rewrite/core-m4`): `crates/nv-core/src/content.rs`, tests in
  `crates/nv-core/tests/api.rs` and the Swift `testBoxContent`; `build-xcframework.sh` uses
  `lipo` for the simulator and macOS slices and now runs `rustup target add` for its own targets (so apple-native.yml needs no change); rust.yml and apple-native.yml are both green on it.
- 2026-11-21, M3 (`rewrite/core-m3`, merged): `nv-api`, `nv-sync`, the online Core API, `rewrite.yml`.
- 2026-11-21, M1 (`rewrite/core-m1`, merged): corpus, `nv-model`, `nv-core` + XCFramework.

## Handover (for the next core session)

Start each step in a fresh session (earlier contexts are large). What it needs to know:

- **Layout.** `nv-model` reads a page into an owned `Page` (fragments as `tree::Node`) and must
  keep passing `tests/corpus` (`crates/nv-model/tests/corpus.rs`). `nv-api::Client` is blocking
  (ureq + rustls/ring) behind a `Transport` trait, so unit tests use a scripted transport.
  `nv-sync` has `protocol::SyncDoc` (no I/O, unit-tested) and `live::LiveDoc` (a socket thread;
  local edits are found by a keyed `observe_update_v1`; remote ones carry the origin
  `REMOTE_ORIGIN`). `nv-core` holds the uniffi types: `lib.rs` (page reading), `content.rs`
  (box content) and `client.rs` (`Core`, `LivePage`, `PageListener`).
- **Docs.** Create them with `nv_model::new_doc()` (UTF-16 offsets, like Yjs in JS). yrs has
  the `sync` feature on (nv-sync turns it on), so docs and observers are Send + Sync.
- **Tests against the real server.** Start it with
  `PORT=4417 DATA_DIR=<scratch> JWT_SECRET=<32+ chars> GIT_SHA=core-test SIGNUP_MODE=open npx tsx server/index.ts`,
  then `NV_TEST_SERVER=http://127.0.0.1:4417 cargo test -p nv-core --test server`. Stop it
  afterwards (on Windows: find the PID listening on 4417 with `netstat -ano`, then `taskkill /F /T`). If 4417 is already taken (another session's server), use another port, e.g. 4427; don't stop a server you didn't start.
- **nv-store (done).** `Store` (one account; `Mutex<Connection>`, shared as `Arc<Store>` by the
  `Core` and its `LivePage`s). Store write errors are ignored by the Core (fail soft, like
  `offlineCache.ts`) but kept in `Store::last_error` and printed to stderr. A schema change: bump
  `SCHEMA_VERSION` and append a step to `UPGRADES` (now at 3: the `outbox`, then `task_ops`). Page documents and
  queued edits are stored only for pages a stored tree shows unlocked.
  Not stored yet: trashed pages (nv-api's `Tree` has no `trashedPages`, so their docs are pruned),
  members, tags. A live page isn't seeded from the stored copy when it opens (merging an old copy
  could bring back content a version restore removed); `cachedPageDocument` is for showing a page
  read-only while offline.
- **nv-sync (done).** `live.rs`: one thread per page runs connect → `connection()` → back off,
  until `close()` (a `Condvar` wakes it; `close()` waits at most 1 s, then detaches a thread stuck
  connecting). Tokens come from a `Session` (the Core's: `access_token`, and
  `access_token_replacing(rejected)` after a 4401). Local edits: the doc observer pushes to
  `Inner::fresh`; the thread moves them into its queue and the `Outbox` (the Core's
  `StoreOutbox`), sends them after the first step 2 of each connection, then sends a step 1 as a
  receipt (at most every 500 ms) and confirms everything sent before it when its step 2 comes
  back (the server answers step 1s in order, after applying what came before). Restored edits are
  applied to the doc before the observer is registered. `protocol.rs` reports `doc_changed` only
  when an update changed something, so receipts don't trigger `on_change`. Statuses are in
  `nv_sync::Status`; the Core maps them to `LiveStatus` (new API) or `SyncStatus` (old). The
  stand-in server for tests is `crates/nv-sync/tests/support/mod.rs` (drop, kick with a code,
  offline, forbidden, token list).
- **TLS.** `rustls-platform-verifier` 0.7 for ureq (`rustls-no-provider` + `platform-verifier`,
  ring provider passed in `UreqTransport::default`) and the socket (`tls_config()` in live.rs).
  **Android:** the verifier needs initialising from the JVM before the first TLS connection
  (`rustls_platform_verifier::android::init_with_env(env, context)` called from JNI, plus the
  crate's Kotlin component on the classpath, its `rustls-platform-verifier-android` Maven
  artifact); without it the first connection fails. To do with the Kotlin step. A fallback if that
  ever blocks a platform: `webpki-roots` behind a cfg for that target only.
- **Tasks (done).** `tasks.rs`: every task write takes `TaskState::order` (one at a time, in
  order, across threads), sends the store's queue first, and queues itself on `Network` when the
  store allows (`nv_store::TaskOp`: create, PATCH, delete). `apply_locally` applies a queued
  write to the stored tasks (also re-applied over the server's list in `tasks()`). Deleted
  tasks are kept in memory (`TaskState::deleted`, cleared on sign-out) for `restore_task`.
  `PageTasks` is the Rust `TaskCallbacks` over the Core: a channel to one worker thread, a
  local title overlay cleared when each job settles (kept for good without a store). Not done:
  a change notification for task lists; queued edits of tasks the store doesn't know; the
  queue can't merge a create and a delete of the same task (both are sent).
- **Live doc for the editor (done, core's half).** `RemoteHooks` live in `SyncDoc` (shared by
  its clones); `SyncDoc::apply_remote` runs them nested around the transaction. Editor writes
  `open_live` (see "For editor: the live doc"); until then the `LivePage` accessors are
  `#[cfg_attr(not(test), allow(dead_code))]`.
- **Kotlin and Android.** uniffi's Kotlin from the same library (`--language kotlin`), plus
  `cargo-ndk` for `aarch64-linux-android`, `armv7-linux-androideabi` and `x86_64-linux-android`
  in a Linux job.
- **Known gaps.** The static library is about 44 MB per slice before linking; nobody has
  measured the linked size against the 10 MB budget yet. The corpus records today's quirks
  (mentions and page links missing from Markdown; page links missing from the search text).
