#!/usr/bin/env bash
# Builds the ink engine (crates/nv-ink) to WASM and writes the JS glue into src/ink/generated/.
# Those files are committed, so the web, Docker, desktop and mobile builds need no Rust toolchain;
# CI (.github/workflows/rust.yml) rebuilds them with the pinned toolchain and fails if they differ.
#
# Needs: the Rust toolchain in RUST_TOOLCHAIN below with the wasm32-unknown-unknown target, and
# wasm-bindgen-cli at the exact version nv-ink pins (cargo install wasm-bindgen-cli --version 0.2.130 --locked).
# The committed files should come from CI's build (Linux): if a local build differs, take the
# `ink-wasm` artifact from the failing CI run (or run this script on Linux).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=src/ink/generated
WASM_BINDGEN_VERSION=0.2.130

have=$(wasm-bindgen --version 2>/dev/null | awk '{print $2}')
if [ "$have" != "$WASM_BINDGEN_VERSION" ]; then
  echo "wasm-bindgen $WASM_BINDGEN_VERSION is needed (found '${have:-none}')" >&2
  exit 1
fi

# Paths baked into the binary (panic locations) must not depend on where it was built.
export RUSTFLAGS="--remap-path-prefix=$PWD=/notivelo --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo"
cargo build -p nv-ink --release --locked --target wasm32-unknown-unknown --features wasm
wasm-bindgen --target web --out-dir "$OUT" --out-name nv_ink target/wasm32-unknown-unknown/release/nv_ink.wasm

raw=$(wc -c < "$OUT/nv_ink_bg.wasm")
gz=$(gzip -9 -n -c "$OUT/nv_ink_bg.wasm" | wc -c)
echo "nv_ink_bg.wasm: $raw bytes, $gz gzipped"
