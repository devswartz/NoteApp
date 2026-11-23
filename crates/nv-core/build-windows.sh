#!/usr/bin/env bash
# Builds the core for Windows as a .NET package layout (Git Bash on Windows, or CI's windows-latest):
#
#   target/windows/NotiveloCore/
#     runtimes/win-x64/native/nv_core.dll      the core, ffi profile (release, panics unwind)
#     runtimes/win-arm64/native/nv_core.dll
#     generated/nv_core.cs                     uniffi-bindgen-cs output (namespace Notivelo.Native)
#     Notivelo.Core/Notivelo.Core.csproj       compiles generated/nv_core.cs; `dotnet pack` makes the NuGet package
#     Tests/Notivelo.Core.Tests/               xunit: `NV_CORPUS_DIR=$PWD/tests/corpus dotnet test` (x64 host)
#
# Needs: rustup targets x86_64-pc-windows-msvc aarch64-pc-windows-msvc (the latter needs the MSVC ARM64
# build tools: ring compiles C), and uniffi-bindgen-cs, the release built for uniffi 0.32:
#   cargo install uniffi-bindgen-cs --locked --git https://github.com/NordSecurity/uniffi-bindgen-cs --tag v0.12.0+v0.32.0
# NV_TARGETS="x86_64-pc-windows-msvc" builds x64 only.
set -euo pipefail
cd "$(dirname "$0")/../.."

PROFILE=ffi
read -r -a TARGETS <<< "${NV_TARGETS:-x86_64-pc-windows-msvc aarch64-pc-windows-msvc}"
OUT=target/windows/NotiveloCore

if command -v rustup >/dev/null; then rustup target add "${TARGETS[@]}"; fi
command -v uniffi-bindgen-cs >/dev/null || { echo "uniffi-bindgen-cs is not installed (see the header of this script)"; exit 1; }

# Link the C runtime statically: the DLL then needs no Visual C++ Redistributable on the user's PC
# (with --target, RUSTFLAGS applies to the target only, not to build scripts).
export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+crt-static"

for t in "${TARGETS[@]}"; do
  cargo build -p nv-core --lib --profile "$PROFILE" --target "$t" --locked
done

rm -rf "$OUT"
mkdir -p "$OUT/generated"
for t in "${TARGETS[@]}"; do
  case "$t" in
    x86_64-*) rid=win-x64 ;;
    aarch64-*) rid=win-arm64 ;;
    *) echo "unknown target $t"; exit 1 ;;
  esac
  mkdir -p "$OUT/runtimes/$rid/native"
  cp "target/$t/$PROFILE/nv_core.dll" "$OUT/runtimes/$rid/native/"
done

# Library mode reads the exported API from a built library (any target's: the API is the same).
uniffi-bindgen-cs --library --no-format --config crates/nv-core/csharp/uniffi.toml \
  --out-dir "$OUT/generated" "target/${TARGETS[0]}/$PROFILE/nv_core.dll"

cp -R crates/nv-core/csharp/Notivelo.Core crates/nv-core/csharp/Tests "$OUT/"
ls -l "$OUT"/runtimes/*/native/nv_core.dll
echo "Built $OUT"
