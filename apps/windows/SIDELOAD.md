# Sideloading the unsigned Windows build

CI (`.github/workflows/windows.yml`, job `windows`) uploads two artifacts on every push to a `rewrite/**` branch:
`notivelo-windows-x64-msix-unsigned` and `notivelo-windows-arm64-msix-unsigned` (kept 14 days). Each holds one `.msix`
with no signature and no certificate. Pick the one for your PC (`$env:PROCESSOR_ARCHITECTURE`: `AMD64` is x64, `ARM64` is arm64).

CI patches the manifest Publisher to `CN=Notivelo Dev, OID.2.25.311729368913984317654407730594956997722=1` before packaging.
That OID marks the package as one Windows may install unsigned. The committed `Package.appxmanifest` keeps `CN=Notivelo Dev`.

## Install

Windows 11 only, with Developer Mode on (Settings > System > For developers > Developer Mode). In PowerShell:

```powershell
Add-AppxPackage -Path .\Notivelo.Windows_0.0.1.0_x64.msix -AllowUnsigned
```

Then start "Notivelo" from the Start menu. The app is self-contained: no Windows App Runtime install is needed.

## Update

Run the same command with a newer package. A package with the same version number is not treated as an update: remove the app first.

## Remove

```powershell
Get-AppxPackage Notivelo.Windows.Dev | Remove-AppxPackage
```

The app's data (`%LOCALAPPDATA%\Notivelo`) and the sign-in kept in the Credential Locker stay until you delete them.

## Caveats

- `-AllowUnsigned` is a Windows 11 feature (recent builds; not Windows 10). If PowerShell says the parameter does not exist, the PC is too old.
- Developer Mode is required for unsigned packages.
- The package is not trusted by anyone: there is no publisher identity, no Store update and no SmartScreen reputation. Install it only from a build you made or trust.
- The identity name is `Notivelo.Windows.Dev` and the package is for testing. It cannot be installed next to a signed or Store build of a different identity, and it cannot be signed afterwards without changing the Publisher back.
- The version is `0.0.1.0` for every build, so remove the old copy before installing a new one.
- This was set up from the documented behaviour of `-AllowUnsigned` and the Publisher OID; it has not been tried on a PC yet.
