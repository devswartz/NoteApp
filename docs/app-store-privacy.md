# App Store Connect: App Privacy answers

Answer sheet for the App Privacy questionnaire (App Store Connect → the app → App Privacy). Based on the code as of 12 November 2026 (v0.4.0 page sharing included); the user-facing policy is `legal/privacy.md`, served at `/privacy`. Re-check both when a feature changes what is stored or sent.

Privacy Policy URL: `https://notes.devswartz.com/privacy`

## Why not "Data Not Collected"

Apple counts data as "collected" when it leaves the device and is kept longer than needed to answer the request in real time. Notivelo is a synced service: accounts (name, email, password hash) and all notes, tasks, comments and uploads are stored in SQLite and on disk on the operator's server (`server/migrations/001-initial.sql`, `server/routes/files.ts`) so they sync between devices and can be shared with other people. That is collection, even though it is only used to run the app, so "Data Not Collected" would be wrong. What is genuinely only on the device is not declared: the Face ID / Touch ID app lock (the check is done by iOS; the app only gets success or failure, `src/platform/capacitor.ts` → `createAppLock`), local preferences (theme, tree state, last workspace, app-lock flag), the offline copy of pages and tasks in IndexedDB (`src/lib/offlineCache.ts`, `src/editor/collab.ts`), the Share Extension queue and Today widget snapshot in the App Group (`apps/mobile/ios/App/Shared/SharedStore.swift`), and locally scheduled notifications.

## Global answers

- Do you or your third-party partners collect data from this app? **Yes**
- Tracking (any data type): **No.** No advertising, no data brokers, no SDKs that track, no linking with third-party data. Do not register the app for ATT; no `NSUserTrackingUsageDescription` is needed.
- Third-party partners: none collect data for their own purposes. Amazon SES (email), Cloudflare (proxy), Apple/Google push and Microsoft (opt-in OneNote import) act only as service providers.

## Data types to declare

For every type below: **Linked to the user: Yes. Used for tracking: No.**

| Apple category → data type | What it is in Notivelo | Purposes | Source |
|---|---|---|---|
| Contact Info → **Name** | Display name on the account, shown to workspace members and people on shared pages | App Functionality | `users.name`, `server/routes/auth.ts` (`PATCH /me`) |
| Contact Info → **Email Address** | Sign-in, confirmation, password reset, invitations, reminder and digest emails (sent via Amazon SES) | App Functionality | `users.email`, `server/mail.ts`, `server/reminders/email.ts` |
| User Content → **Photos or Videos** | Images the user uploads into pages (picked with the system picker; no photo library permission is requested) | App Functionality | `server/routes/files.ts` (`SAFE_TYPES`) |
| User Content → **Other User Content** | Notes/pages and their version history, tasks, comments, tags, templates, other uploaded files, OneNote and workspace imports, text shared in through the Share Extension | App Functionality | `server/migrations/*.sql`, `server/versions.ts`, `server/onenote.ts`, `server/export.ts` |
| User Content → **Customer Support** | The "Send feedback" message, emailed to the admins with name, email, user ID, app version, platform and user agent | App Functionality | `server/routes/feedback.ts` |
| Identifiers → **User ID** | Internal account ID; also attached to error reports and feedback | App Functionality | `users.id`, `server/routes/clientErrors.ts` |
| Diagnostics → **Crash Data** | Uncaught errors and React render errors: message, stack, app version, page path without query, user agent, user ID when signed in. Logged only, not stored in the DB | App Functionality | `src/lib/errorReporting.ts`, `server/routes/clientErrors.ts` |

Notes on the choices:

- **Purposes.** Everything is "App Functionality". Error reports are used only to find and fix bugs, which Apple puts under App Functionality; there is no Analytics, Product Personalization, Developer's Advertising or Third-Party Advertising use. If Apple's reviewer pushes back on emails, reminder and digest mails are transactional and opt-in, so App Functionality still fits; declare "Developer's Communications" only if marketing or newsletter mail is ever added.
- **Diagnostics → Crash Data** is declared as Linked because the report carries the user ID when signed in. "Performance Data" and "Other Diagnostic Data" are not collected (request timings are only aggregate counters in memory, `server/requests.ts`).
- **Push tokens** (APNs device tokens, `device_tokens`) are not declared as Device ID: Apple's Device ID means a device-level identifier such as the advertising identifier, and the push token is only used to deliver the user's own notifications.
- **Session user agent and time zone** are stored (`refresh_tokens.user_agent`, `notification_settings.time_zone`) only to show signed-in devices and time reminders; Apple has no data type for them and they are covered by App Functionality above. If you prefer to be maximal, add Other Data → Other Data Types (App Functionality, Linked).

## Not collected (answer "No" / leave unticked)

- Health & Fitness, Financial Info, Location (precise or coarse), Sensitive Info, Contacts, Browsing History, Purchases.
- Contact Info → Phone Number, Physical Address, Other User Contact Info.
- User Content → Emails or Text Messages, Audio Data, Gameplay Content.
- Search History: search terms answer the request and are not stored or logged (`server/requests.ts` strips query strings from the access log).
- Usage Data (Product Interaction, Advertising Data, Other Usage Data): no analytics SDK. The workspace activity feed records who changed what, but as user-visible content of the workspace, not usage analytics.
- Identifiers → Device ID: no IDFA, IDFV or similar is read.
- IP address: not stored in the database or logs; held in memory only for rate limiting (`server/ratelimit.ts`). Cloudflare sees it as the network proxy.
- Biometrics: never leave the device.

## Before submitting

- The iOS project has no `PrivacyInfo.xcprivacy` privacy manifest. The app and its extensions use `UserDefaults` (App Group, a "required reason" API), and Capacitor plugins may bring their own manifests; add one for the app target (and the extensions) declaring `NSPrivacyAccessedAPICategoryUserDefaults` (reason `1C8F.1` for App Group access), `NSPrivacyTracking` false and the collected types above, or App Store Connect will warn on upload.
- Confirm the privacy policy URL loads in production and the contact inbox in it is read.
