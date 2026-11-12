# iOS signing in CI

Why this exists: every iOS archive on a fresh macOS runner used to sign with automatic signing, which asks Apple for an
**Apple Development** certificate because the runner has none. Each run created another one until the account reached
Apple's limit, and the v0.4.5 archive failed with "Your account has reached the maximum number of certificates … No
profiles for 'com.devswartz.notivelo' / '.ShareExtension'".

## What CI does now (`.github/workflows/mobile.yml`, job `ios`)

1. **Archive unsigned** (`CODE_SIGNING_ALLOWED=NO`, no `-allowProvisioningUpdates`). Nothing is signed, so no development
   certificate is requested. (The project's Release configuration still says `CODE_SIGN_IDENTITY = "iPhone Developer"`;
   the override on the command line wins, and the project file is untouched so local Xcode builds behave as before.)
2. **Export with cloud-managed signing**: `xcodebuild -exportArchive` with the App Store Connect API key and
   `method = app-store-connect`, `signingStyle = automatic`, `signingCertificate = Apple Distribution`. Xcode uses the
   account's cloud-managed **Apple Distribution** certificate and creates the App Store provisioning profiles for the
   three targets: **App** (`com.devswartz.notivelo`), **ShareExtension** (`.ShareExtension`) and **TodayWidget**
   (`.TodayWidget`). Cloud-managed distribution certificates live in Apple's cloud, not on the runner, and do not count
   toward the development-certificate limit.
3. **Verify the signature before uploading.** A first export writes a local `.ipa`; the job fails unless the app and each
   extension are signed by an `Apple Distribution` authority and kept their App Group entitlement (and the app its push
   `aps-environment`). Only then is a second export run with `destination = upload`, which sends it to TestFlight.

No new secrets are needed: the existing `ASC_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID` and `APPLE_TEAM_ID` are enough. The
API key must have the **Admin** role (cloud-managed distribution signing needs it; see docs/MOBILE.md).

## What Devon needs to do once

1. **Revoke the CI-created development certificates.** developer.apple.com → Certificates, Identifiers & Profiles →
   Certificates. Revoke the **Apple Development** certificates created by the CI runs: they are named like
   "Apple Development: Created via API (XXXXXXXXXX)" (or a runner name), and many were created on the dates of the
   iOS builds (every tag run since TestFlight began). **Keep** the one you use on your own Mac (it has your name and
   its private key is in your Keychain; Xcode → Settings → Accounts shows which ones you hold). Revoking a CI one is
   harmless: nothing depends on it. If unsure, revoke all of the "Created via API" ones; Xcode makes a new one for you
   when you next build on your Mac.
2. Also remove any **Development** provisioning profiles named "iOS Team Provisioning Profile: …" or listing the CI
   certificates (Profiles page). They are regenerated on demand.
3. Check the **Apple Distribution** certificates on the same page. Cloud-managed ones appear as
   "Cloud Managed Apple Distribution". There should be at most one or two; if the limit of Distribution certificates
   is reached too, revoke old unused ones the same way.
4. Confirm the three identifiers exist with their capabilities (docs/MOBILE.md): `com.devswartz.notivelo` (Push
   Notifications, Associated Domains, App Groups `group.com.devswartz.notivelo`), `.ShareExtension` and `.TodayWidget`
   (App Groups).

## What to verify on the next tag

In the `ios` job of the Mobile workflow:
- "Archive (unsigned) and export (cloud-signed, Apple Distribution)" succeeds. The archive step should show no
  "Provisioning profile" or certificate lines.
- The log prints, for the app and each `.appex`: `Authority=Apple Distribution: …` and your `TeamIdentifier`. The checks
  after it must pass (no "::error::… not signed with an Apple Distribution certificate" / "lost its App Group
  entitlement" / "lost its push entitlement").
- The second export uploads; the build appears in App Store Connect → TestFlight after processing.
- developer.apple.com → Certificates shows **no new Apple Development certificate** from that run.

## If the unsigned archive turns out not to work

The risk is that an unsigned archive loses its entitlements, which the verification step above catches before upload
(the job fails with "lost its … entitlement"). Then switch to the stored-certificate route:
1. On a Mac: Keychain Access → export the **Apple Distribution** certificate with its private key as `dist.p12`
   (with a password). Create **App Store** provisioning profiles for the three bundle ids on developer.apple.com and
   download them.
2. Add secrets `IOS_DIST_P12` (base64 of the .p12), `IOS_DIST_P12_PASSWORD`, and `IOS_PROFILE_APP`,
   `IOS_PROFILE_SHARE`, `IOS_PROFILE_WIDGET` (base64 of each .mobileprovision).
3. In the job: create a temporary keychain, import the .p12, copy the profiles to
   `~/Library/MobileDevice/Provisioning Profiles`, archive with `CODE_SIGN_STYLE=Manual
   CODE_SIGN_IDENTITY="Apple Distribution"` and a `PROVISIONING_PROFILE_SPECIFIER` per target, and export with
   `signingStyle = manual` and a `provisioningProfiles` map. The runner is discarded afterwards, so nothing is
   minted; certificates and profiles expire after a year, so the secrets need renewing then.
