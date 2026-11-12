# Android signing

The Mobile workflow (`.github/workflows/mobile.yml`) builds a signed release APK on every version tag (`vX.Y.Z`) and attaches it to that tag's GitHub release as **`Notivelo.apk`**. That file is what the README's Android download link points to:
`https://github.com/devswartz/NoteApp/releases/latest/download/Notivelo.apk`

The same step also builds the signed `.aab` for Google Play. Without the four secrets below, the workflow skips both with a warning and does not fail. Nothing secret is in the repo: `apps/mobile/android/app/build.gradle` reads the keystore location and passwords from environment variables that the workflow sets.

> **Back up the keystore and its passwords now, in two places (a password manager and an offline copy).** Android only installs an update over an existing app if it is signed with the same key. If you lose this keystore, nobody can update Notivelo from the APK. They would have to uninstall it (losing local data) and install a new build signed with a different key. You cannot recover or recreate the key.

## 1. Create the keystore (once)

Needs a JDK (`keytool` comes with it). Run this anywhere safe, not inside the repo:

```
keytool -genkeypair -v -keystore notivelo-release.jks -alias notivelo -keyalg RSA -keysize 4096 -validity 10000
```

It asks for a keystore password, then your name and organisation (any values you are happy to have inside the certificate), then a key password (pressing Return reuses the keystore password). Remember the alias, `notivelo` above. Never commit the `.jks` file.

## 2. Turn it into a text secret

GitHub secrets are text, so the keystore is stored as base64.

Windows PowerShell:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("notivelo-release.jks")) | Set-Clipboard
```

That copies the base64 text to the clipboard. On macOS or Linux: `base64 -i notivelo-release.jks | pbcopy` (macOS) or `base64 -w0 notivelo-release.jks` (Linux).

## 3. Add the four secrets

In GitHub: the repository, **Settings**, **Secrets and variables**, **Actions**, **New repository secret**. Add:

| Name | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | the base64 text from step 2 (paste it, no extra spaces or line breaks) |
| `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
| `ANDROID_KEY_ALIAS` | `notivelo` (or the alias you chose) |
| `ANDROID_KEY_PASSWORD` | the key password |

## 4. Release

Push a version tag as usual. The Mobile workflow signs the APK and uploads `Notivelo.apk` to the release for that tag. The Desktop workflow makes that release as a draft, and the Mobile workflow creates it if it gets there first, so whichever finishes first, one draft ends up with all the files. Publish the draft when you are ready, after which the `latest/download` link serves the new APK.

Users who install the APK directly must allow installs from their browser or file manager once (Android asks the first time). The APK is not on Google Play, so Play Protect may show a one-time "unknown developer" prompt.

If a build is skipped, the workflow run shows a warning: "The Android signing secrets are not set".
