#!/bin/sh
# Rust コアを wasm に組み、wasm-bindgen で JS 結合を apps/web/src/wasm/ に出す。
# wasm-pack は使わない(バイナリ配布に依存しないため)。必要なもの:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version 0.2.100 --locked
set -eu
cd "$(dirname "$0")/.."
RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+simd128" \
  cargo build --release --target wasm32-unknown-unknown -p imagine-wasm
wasm-bindgen --target web --out-dir apps/web/src/wasm --out-name imagine_wasm \
  target/wasm32-unknown-unknown/release/imagine_wasm.wasm
ls -la apps/web/src/wasm/imagine_wasm_bg.wasm
