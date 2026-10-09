# Imagine Studio

長押しの輪で操作するお絵描き・漫画・アニメ PWA。設計は `docs/` が正。迷ったら `docs/00-decisions.md` を先に読む。

## 構成

- `apps/web`: Vite + TypeScript の PWA 本体。素の DOM、フレームワーク不使用。
- `crates/brush-core`: ブラシエンジン(純 Rust、GPU 非依存)。
- `crates/wasm`: wasm-bindgen 結合。`scripts/build-wasm.sh` で `apps/web/src/wasm/` に出す(生成物はコミットしない)。
- `packages/`: 輪、タイムラインなどの共通モジュール(これから)。
- `docs/`: 設計書。番号順。

## コマンド

```
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.100 --locked   # wasm-pack は使わない
pnpm install
pnpm wasm          # Rust → wasm → apps/web/src/wasm/
pnpm dev           # 開発サーバ
pnpm typecheck && pnpm test && cargo test --workspace
pnpm build && pnpm smoke   # 実際の Chromium で描いて確かめる
```

## 守ること

- 画素は 8bit(RGBA8 / R8)だけ。浮動小数テクスチャを足さない。
- 描画はワーカー(OffscreenCanvas)。メインスレッドは DOM と入力だけ。
- 描画はフレームごとに 1 回。ポインタイベントごとに描かない。
- 何もしていないときは rAF を止める。
- 3D、PSD、縦書き、動画書き出し、トーン、同期は動的 import で読む。核のバンドルに入れない。
- wasm-bindgen のクレートと CLI の版は一致させる(0.2.100)。
- コミットメッセージと文書は日本語。
- 性能に関わる変更は `docs/09-performance-budget.md` の表と照らす。
