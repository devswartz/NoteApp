#!/usr/bin/env bash
# The Kotlin bindings on a plain JVM (Linux or macOS host, JDK 17 and Gradle 8.x installed): builds the core
# for the host, generates the bindings, and runs crates/nv-core/kotlin/Tests (JUnit 5, JNA) on the page corpus.
# No emulator: this proves the generated Kotlin and libnv_core agree, not the Android packaging.
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$PWD

PROFILE=ffi
OUT=target/kotlin-jvm
case "$(uname -s)" in
  Darwin) LIB=libnv_core.dylib ;;
  *) LIB=libnv_core.so ;;
esac

cargo build -p nv-core --lib --profile "$PROFILE" --locked
rm -rf "$OUT"
mkdir -p "$OUT/gen"
cargo run -p nv-core --features bindgen --bin uniffi-bindgen --locked -- \
  generate --library "target/$PROFILE/$LIB" --language kotlin \
  --config crates/nv-core/kotlin/Tests/uniffi-jvm.toml --out-dir "$OUT/gen"

cd crates/nv-core/kotlin/Tests
gradle --no-daemon --console=plain test \
  -PnvGenerated="$ROOT/$OUT/gen" -PnvLibDir="$ROOT/target/$PROFILE" -PnvCorpusDir="$ROOT/tests/corpus"
