#!/usr/bin/env bash
# Builds the core for Apple platforms as a local Swift package, NotiveloCore (macOS with Xcode only):
#
#   target/apple/NotiveloCore/
#     Package.swift                   (from crates/nv-core/swift/)
#     nv_coreFFI.xcframework          static libraries: iOS device, iOS simulator (arm64), macOS (arm64)
#     Sources/NotiveloCore/nv_core.swift   the uniffi Swift bindings
#     Tests/NotiveloCoreTests/        `NV_CORPUS_DIR=$PWD/tests/corpus swift test` runs them on the Mac
#
# Apps add it as a local package (XcodeGen: packages: NotiveloCore: path: …) and `import NotiveloCore`.
# Needs: rustup targets aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin.
# Built with the `ffi` profile (release, but panics unwind so uniffi turns them into errors).
set -euo pipefail
cd "$(dirname "$0")/../.."

PROFILE=ffi
TARGETS=(aarch64-apple-ios aarch64-apple-ios-sim aarch64-apple-darwin)
OUT=target/apple/NotiveloCore
WORK=target/apple/work

for t in "${TARGETS[@]}"; do
  cargo build -p nv-core --lib --profile "$PROFILE" --target "$t" --locked
done
lib() { echo "target/$1/$PROFILE/libnv_core.a"; }

rm -rf "$OUT" "$WORK"
mkdir -p "$WORK/gen" "$WORK/headers" "$OUT/Sources/NotiveloCore"

# Library mode reads the exported API from the built library itself.
cargo run -p nv-core --features bindgen --bin uniffi-bindgen --locked -- \
  generate --library "target/aarch64-apple-darwin/$PROFILE/libnv_core.dylib" --language swift --out-dir "$WORK/gen"

cp "$WORK/gen/nv_coreFFI.h" "$WORK/headers/"
cp "$WORK/gen/nv_coreFFI.modulemap" "$WORK/headers/module.modulemap"

xcodebuild -create-xcframework \
  -library "$(lib aarch64-apple-ios)" -headers "$WORK/headers" \
  -library "$(lib aarch64-apple-ios-sim)" -headers "$WORK/headers" \
  -library "$(lib aarch64-apple-darwin)" -headers "$WORK/headers" \
  -output "$OUT/nv_coreFFI.xcframework"

cp "$WORK/gen/nv_core.swift" "$OUT/Sources/NotiveloCore/"
cp crates/nv-core/swift/Package.swift "$OUT/"
cp -R crates/nv-core/swift/Tests "$OUT/"

for t in "${TARGETS[@]}"; do echo "$t: $(wc -c < "$(lib "$t")") bytes (static library, before linking)"; done
echo "Built $OUT"
