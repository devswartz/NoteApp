#!/usr/bin/env bash
# Builds the ink engine (crates/nv-ink, `ffi` feature) for the iPad app as an XCFramework of static
# libraries: device (aarch64-apple-ios), simulator (arm64 + x86_64) and macOS (arm64, so the Swift
# package's tests run with `swift test`). Output: apps/mobile/ios/App/NvInk/NvInkFFI.xcframework,
# which the NvInk Swift package links. Not committed: the Mobile and Rust workflows build it on macOS.
# Needs macOS with Xcode and: rustup target add aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=apps/mobile/ios/App/NvInk/NvInkFFI.xcframework
WORK=target/ink-ios
export IPHONEOS_DEPLOYMENT_TARGET=15.0
export MACOSX_DEPLOYMENT_TARGET=12.0

build() {
  cargo rustc -p nv-ink --lib --release --locked --features ffi --target "$1" --crate-type staticlib
}
for t in aarch64-apple-ios aarch64-apple-ios-sim x86_64-apple-ios aarch64-apple-darwin; do build "$t"; done

rm -rf "$WORK" "$OUT"
mkdir -p "$WORK/headers" "$WORK/sim"
cp crates/nv-ink/include/nv_ink.h "$WORK/headers/"
cat > "$WORK/headers/module.modulemap" <<'MAP'
module NvInkFFI {
  header "nv_ink.h"
  export *
}
MAP
lipo -create target/aarch64-apple-ios-sim/release/libnv_ink.a target/x86_64-apple-ios/release/libnv_ink.a -output "$WORK/sim/libnv_ink.a"
xcodebuild -create-xcframework \
  -library target/aarch64-apple-ios/release/libnv_ink.a -headers "$WORK/headers" \
  -library "$WORK/sim/libnv_ink.a" -headers "$WORK/headers" \
  -library target/aarch64-apple-darwin/release/libnv_ink.a -headers "$WORK/headers" \
  -output "$OUT"
ls -la "$OUT"
du -sh "$OUT"/*/libnv_ink.a
