#!/usr/bin/env bash
# Builds the core for Android as a Gradle library module, NotiveloCore (Linux or macOS with the Android NDK):
#
#   target/android/NotiveloCore/
#     build.gradle.kts, settings.gradle.kts, consumer-rules.pro   (from crates/nv-core/kotlin/NotiveloCore/)
#     gradle.properties                              rustlsPlatformVerifierVersion, from Cargo.lock
#     src/main/AndroidManifest.xml
#     src/main/jniLibs/<abi>/libnv_core.so           the core, ffi profile (release, panics unwind), stripped
#     src/main/kotlin/com/notivelo/core/nv_core.kt   the uniffi Kotlin bindings (package com.notivelo.core)
#     src/main/kotlin/com/notivelo/core/NotiveloCore.kt   NotiveloCore.init(context): call from Application.onCreate
#
# An app includes the folder as a Gradle module, or `gradle assembleRelease` in it makes the .aar.
# Needs: the Android NDK (ANDROID_NDK_HOME, or ANDROID_NDK_LATEST_HOME on GitHub's runners) and
#   cargo install cargo-ndk --locked
# Minimum Android API 24 (7.0). NV_ABIS="arm64-v8a" builds one ABI only.
set -euo pipefail
cd "$(dirname "$0")/../.."

PROFILE=ffi
API=24
read -r -a ABIS <<< "${NV_ABIS:-arm64-v8a armeabi-v7a x86_64}"
OUT=target/android/NotiveloCore
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-${ANDROID_NDK_LATEST_HOME:-}}"
[ -n "$ANDROID_NDK_HOME" ] || { echo "Set ANDROID_NDK_HOME to the Android NDK"; exit 1; }
command -v cargo-ndk >/dev/null || { echo "cargo-ndk is not installed (see the header of this script)"; exit 1; }

triple() {
  case "$1" in
    arm64-v8a) echo aarch64-linux-android ;;
    armeabi-v7a) echo armv7-linux-androideabi ;;
    x86_64) echo x86_64-linux-android ;;
    *) echo "unknown ABI $1" >&2; exit 1 ;;
  esac
}
TRIPLES=()
for a in "${ABIS[@]}"; do TRIPLES+=("$(triple "$a")"); done
if command -v rustup >/dev/null; then rustup target add "${TRIPLES[@]}"; fi

# 16 KB page alignment (required by Android 15 devices with 16 KB pages).
export RUSTFLAGS="${RUSTFLAGS:-} -C link-arg=-Wl,-z,max-page-size=16384"

rm -rf "$OUT"
mkdir -p "$OUT/src/main/jniLibs"
NDK_ARGS=()
for a in "${ABIS[@]}"; do NDK_ARGS+=(-t "$a"); done
# cargo-ndk points cc/ar/the linker at the NDK's clang (ring and rusqlite's bundled SQLite compile C).
cargo ndk "${NDK_ARGS[@]}" --platform "$API" -o "$OUT/src/main/jniLibs" \
  build -p nv-core --lib --profile "$PROFILE" --locked

# cargo-ndk also copies the other cdylib in the build (nv-ink, the web engine's WASM crate): not needed, nv-core links it in.
rm -f "$OUT"/src/main/jniLibs/*/libnv_ink.so

# Library mode reads the exported API from a built library (any ABI's: the API is the same).
# The generator is a host binary: build it without cargo-ndk's environment.
cargo run -p nv-core --features bindgen --bin uniffi-bindgen --locked -- \
  generate --library "$OUT/src/main/jniLibs/${ABIS[0]}/libnv_core.so" --language kotlin \
  --config crates/nv-core/kotlin/uniffi.toml --out-dir "$OUT/gen"

KT="$OUT/src/main/kotlin"
mkdir -p "$KT"
cp -R "$OUT/gen/com" "$KT/"
rm -rf "$OUT/gen"

# The metadata the generator reads is in the symbols, so strip only now (the .dynsym that JNI and JNA use stays).
STRIP=$(ls "$ANDROID_NDK_HOME"/toolchains/llvm/prebuilt/*/bin/llvm-strip | head -1)
for so in "$OUT"/src/main/jniLibs/*/libnv_core.so; do "$STRIP" --strip-unneeded "$so"; done
cp -R crates/nv-core/kotlin/NotiveloCore/src/main/kotlin/com "$KT/"
cp crates/nv-core/kotlin/NotiveloCore/src/main/AndroidManifest.xml "$OUT/src/main/"
cp crates/nv-core/kotlin/NotiveloCore/{build.gradle.kts,settings.gradle.kts,consumer-rules.pro} "$OUT/"

# The Maven component of the certificate verifier must match the crate's version in Cargo.lock.
VER=$(awk '/^name = "rustls-platform-verifier-android"$/ { getline; gsub(/version = "|"/, ""); print; exit }' Cargo.lock)
[ -n "$VER" ] || { echo "rustls-platform-verifier-android is not in Cargo.lock"; exit 1; }
printf 'rustlsPlatformVerifierVersion=%s\nandroid.useAndroidX=true\norg.gradle.jvmargs=-Xmx2g\n' "$VER" > "$OUT/gradle.properties"

ls -l "$OUT"/src/main/jniLibs/*/libnv_core.so
echo "Built $OUT (platform-verifier component $VER, minSdk $API)"
