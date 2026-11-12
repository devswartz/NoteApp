# iOS signing in CI

The release workflow (`.github/workflows/mobile.yml`, job `ios`) archives the app and uploads it to TestFlight with Xcode's
**cloud-managed signing**: the App Store Connect API key (`ASC_KEY_P8`, `ASC_KEY_ID`, `ASC_ISSUER_ID`) plus `APPLE_TEAM_ID` let
`xcodebuild -allowProvisioningUpdates` create what it needs for the app and its extensions (App, ShareExtension, TodayWidget).
There is no `.p12` or provisioning profile to keep.

## The flow

1. **Revoke leftover CI development certificates** (`scripts/ios-revoke-ci-certs.mjs`, using the same API key).
2. **Archive** with automatic signing (`CODE_SIGN_STYLE=Automatic`, `-allowProvisioningUpdates`, the API key). The archive is
   signed for development, which is what keeps the **App Group** and **push** entitlements in the app and both extensions.
3. **Export** with `method = app-store-connect`, automatic signing: Xcode re-signs everything with the account's cloud-managed
   **Apple Distribution** certificate and App Store profiles. First to a local `.ipa`.
4. **Verify** that `.ipa`: the app and each extension must be signed by an `Apple Distribution` authority and keep their App Group
   entitlement, and the app its push (`aps-environment`) entitlement. The log prints the authority and entitlement lines.
5. **Upload** to TestFlight (a second export with `destination = upload`).
6. **Revoke** the development certificate this run created (step 1's script again, `if: always()`).

## Why the revoke steps

Automatic signing on a fresh macOS runner asks Apple for an *Apple Development* certificate on every run (they show up named
"Apple Development: Created via API …"), and the account has a small limit, so after enough releases the archive fails with
"Your account has reached the maximum number of certificates … No profiles for 'com.devswartz.notivelo'". The runner is thrown
away, so those certificates can never be reused; they are just clutter that has to be removed.

`scripts/ios-revoke-ci-certs.mjs` (ES256 token from the API key; no dependencies):
- lists development certificates (`DEVELOPMENT`, `IOS_DEVELOPMENT`) and revokes only those whose name or display name
  contains **"Created via API"**; it logs each one's id and display name (never a key);
- keeps everything else: your own Mac's "Apple Development: <your name>" certificate, distribution certificates, valid profiles;
- deletes the *invalid* Xcode-managed development profiles ("iOS Team Provisioning Profile …") that revoking leaves behind;
- never fails the build (a problem is logged as a warning); `--dry-run` only prints what it would do.

Dry run from your own machine to see what it would revoke:

```
ASC_KEY_P8="$(cat AuthKey_XXXX.p8)" ASC_KEY_ID=XXXX ASC_ISSUER_ID=<issuer uuid> node scripts/ios-revoke-ci-certs.mjs --dry-run
```

The API key needs the **Admin** role (certificates can only be revoked with it).

## What was tried instead, and failed (v0.4.5–v0.4.6)

- **Unsigned archive** (`CODE_SIGNING_ALLOWED=NO`) and signing at export: the exported app had no App Group entitlement, even
  with the entitlements copied into the archive by hand (export does not sign with them).
- **Archive with an Apple Distribution identity under automatic signing**: Xcode refuses ("X is automatically signed for
  development, but a conflicting code signing identity Apple Distribution has been manually specified").
- A stored distribution certificate with manual profiles would work too but needs a Mac or a signing script and secrets to renew
  every year; not used.

## What to check on a run

- "Revoke leftover CI development certificates" logs how many certificates it found and revoked (ids and display names).
- The archive and export succeed; the log shows `Authority=Apple Distribution: …` for the app and each `.appex`, with
  `application-groups` (and `aps-environment` for the app).
- The build appears in App Store Connect → TestFlight, and developer.apple.com → Certificates holds no leftover "Created via API"
  development certificate afterwards.
- If the account is *already* at its limit, the first run's first step frees it; re-run if the archive failed before that.
