# 02. アーキテクチャ

## 全体

```
+-----------------------------------------------------------+
|  Shell (PWA)  manifest / sw.js / IndexedDB / File System   |
+-----------------------------------------------------------+
|  UI (TypeScript, 素の DOM)                                  |
|   輪 / 修飾ボタン / 上バー / 左レール / パネル / ドック     |
+-----------------------------------------------------------+
|  Input (TypeScript)                                         |
|   Pointer Events, coalesced / predicted, 指の本数判定,      |
|   パームリジェクション, 修飾状態                             |
+-----------------------------------------------------------+
|  Render worker (OffscreenCanvas + WebGL2)                   |
|   タイル合成, ダブ描画, ミップ, 表示変換, ディザ             |
+-----------------------------------------------------------+
|  Core (Rust → WASM, シングルスレッド)                        |
|   document / tiles / brush-core / compositor / history / io |
+-----------------------------------------------------------+
|  Optional (必要時にだけ読み込む)                             |
|   three.js (3D 参照), PSD, 縦書きテキスト, 動画書き出し,    |
|   トーン, Firebase 同期                                     |
+-----------------------------------------------------------+
```

## スレッド構成

- メインスレッド: DOM と入力だけ。ポインタイベントを受け取り、ワーカーへ転送する。
- 描画ワーカー: OffscreenCanvas を持ち、WASM コアと WebGL2 を両方動かす。ストロークの計算と合成と表示がすべてここで閉じるので、メインスレッドの重さが線に出ない。
- WASM はシングルスレッド。GitHub Pages では COOP / COEP ヘッダーを出せず SharedArrayBuffer が使えないため。将来 Service Worker でヘッダーを注入する手はあるが、設計はそれに依存しない。
- メインとワーカーの間は `postMessage` と `ArrayBuffer` の転送だけ。共有メモリは使わない。

## リポジトリ構成(モノレポ)

```
imagine-studio/
  apps/web/            Vite + TypeScript の PWA 本体
  packages/ring/       輪、修飾ボタン、ドック、HUD(macbeth からコピー)
  packages/timeline/   レイヤー × フレーム格子(pixel-art-tool からコピー)
  crates/brush-core/   以前のブランチから移植(拡張あり)
  crates/canvas-core/  タイル、合成、差分履歴、ファイル形式(新規)
  crates/wasm/         JS との結合(wasm-bindgen)
  docs/                この設計書
  tests/               vitest、Playwright、Rust、ゴールデン画像
  .github/workflows/   CI と Pages 配信(macbeth のものを流用)
```

## 技術選定

| 層 | 選定 | 備考 |
|---|---|---|
| UI | TypeScript + Vite、素の DOM | macbeth と同じ。フレームワーク不使用 |
| コア | Rust、wasm-bindgen、wasm-pack | SIMD 有効でビルド。`Limits` は WebGL2 の範囲に収める |
| 描画 | WebGL2 | WebGPU は iPadOS で安定するまで使わない。テクスチャは RGBA8 と R8 のみ |
| 3D | three.js | 読み込みは動的 import。コアバンドルには含めない |
| 保存 | IndexedDB(自動保存、タイル退避)、File System Access(Windows / Android)、ダウンロード(iPadOS) | iPadOS はホーム画面に追加した PWA で使う |
| 同期 | Firebase Realtime Database(REST + SSE) | ドット絵アプリの実装を流用。必要時にだけ読み込む |
| テスト | vitest(TS)、cargo test(Rust)、Playwright(E2E、`page.evaluate` で内部関数を直接叩く) | ドット絵アプリと macbeth の流儀を踏襲 |

## 8bit の扱い

決定事項(00)の補足。8bit で起きる 2 つの問題と対処。

1. 低い不透明度の筆跡が濁る(プリマルチプライド形式で低アルファの色情報が量子化で削られる)。
   対処: ブラシエンジンとストロークバッファの中は浮動小数で計算し、ストローク終了時に 1 回だけ 8bit に落とす。SAI と同じ考え方。
2. エアブラシの薄い階調を重ねたときのバンディング。
   対処: 表示用の合成シェーダの最終段で微小なノイズを足す(ディザ)。保存データには入れない。

合成は sRGB のまま行う。リニア合成にすると乗算やスクリーンの見た目が Photoshop や CLIP STUDIO とずれ、PSD 互換が崩れる。

## 軽さの原則(09 の性能予算と対になる)

1. 毎フレーム合成するのは 3 枚だけ。編集中レイヤーより下をまとめた 1 枚、上をまとめた 1 枚、編集中レイヤーとストロークバッファ。レイヤーを切り替えたときだけ上下をまとめ直す。
2. 描き直すのは汚れた矩形だけ。ストローク中は触ったタイルだけ再合成し、画面転送も矩形に絞る。
3. 縮小表示はタイルのミップで描く。2 分の 1、4 分の 1 の縮小タイルを持ち、汚れたときだけ作り直す。
4. 何もしていないときは描画ループを止める。
5. 起動時に読むのは核だけ。3D、PSD、縦書き、動画書き出し、トーン、同期は最初に使ったときに読み込む。
6. GPU の型は RGBA8 と R8 だけ。浮動小数テクスチャは使わない。
7. ブラシは間隔で律速する。1 ストロークあたりのダブ数に上限を置き、超えたら間隔を自動で広げる。
8. 描画はポインタイベントごとではなく、フレームごとに 1 回。120Hz では 8ms が予算。

## 端末ごとの差分

| 項目 | iPad mini(Safari) | MovinkPad Pro 14(Chrome) |
|---|---|---|
| 筆圧・傾き | Pointer Events(`pressure`, `tiltX/Y`) | 同じ |
| ホバー | Pencil Pro で `pointermove` が来る | Pro Pen 3 で来る |
| 予測イベント | 無ければ素通り | `getPredictedEvents` を使う |
| 低遅延キャンバス | 無し | `desynchronized: true` |
| `pointerrawupdate` | 無し | 使う |
| メモリ | 厳しい。LRU 退避が必須 | 12GB、余裕 |
| 保存データ | ホーム画面に追加した PWA で使う(7 日消去の対象外) | 制約なし |
| 画面 | 8.3 インチ、DPR 2 | 14 インチ 2880×1800、DPR 2、120Hz |
