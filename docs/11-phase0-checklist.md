# 11. フェーズ 0 チェックリスト

フェーズ 0 の完了条件。すべて実機で確認する。数値は 09 の目標と比べる。

## 足場

- [ ] モノレポ(pnpm workspace + Cargo workspace)が `pnpm install && pnpm build` で通る
- [ ] `apps/web` が Vite で起動し、PWA としてホーム画面に追加できる(iPad mini、MovinkPad)
- [ ] CI(vitest、cargo test、Playwright)が GitHub Actions で通る
- [ ] GitHub Pages に配信される(`https://nekohachi.github.io/imagine-studio/`)
- [ ] wasm-pack のビルドが SIMD 有効で通り、Safari でも読み込める
- [ ] OffscreenCanvas + WebGL2 がワーカーで動く(Safari 17 以降、Chrome)

## brush-core の載せ替え

- [ ] `crates/brush-core` を移植し、既存テスト約 25 件が通る
- [ ] Pointer Events → ワーカー → brush-core → ダブ → WebGL2 のインスタンシング描画が 1 本つながる
- [ ] `getCoalescedEvents` の点が全部描かれる(間引きで角が落ちない)
- [ ] `getPredictedEvents`(Chrome)で先行描画し、確定点で描き直せる
- [ ] 筆圧と傾きが両端末で取れる(値をベンチ画面に表示)
- [ ] ペン検出後の指が描画に行かない(パームリジェクション)
- [ ] ストロークバッファ方式で、同一ストローク内で不透明度が重ならない

## 計測(09 の表を埋める)

| 項目 | MovinkPad | iPad mini |
|---|---|---|
| ペン先から画面までの遅延(ms) | | |
| ストローク中のフレーム時間(ms) | | |
| 1 ストロークのダブ数上限と間隔補正が効くか | | |
| B4 600dpi A8、20 レイヤーのメモリ(MB)と、LRU 退避が間に合うか | | |
| A4 350dpi RGBA8、30 レイヤーのメモリ(MB) | | |
| 起動から描き始めまで(秒、2 回目以降) | | |
| 核のバンドル(JS KB、WASM KB) | | |
| 無操作 1 秒後の CPU(rAF 停止) | | |
| 全体表示(ミップ)時のフレーム時間 | | |

## 書き味の評価(DESIGN.md から移植)

- [ ] 速い線で角が丸まらない
- [ ] ゆっくりした線が震えない(ひも補正の強度 0 / 10 / 20 / 40 で確認)
- [ ] 線の終端が実ペン位置まで届く(drain)
- [ ] 細い線(半径 1px)の AA が汚くない
- [ ] 筆圧の立ち上がりが自然(カーブ既定値の確認)
- [ ] 傾きでダブが潰れる
- [ ] 遅延が体感で気にならない(MovinkPad)
- [ ] 指描きで速度→筆圧が自然

## 判断

- [ ] 09 の目標に届く見込みがあるか。届かない項目は原因と対策を 00 の経緯に残す
- [ ] ストロークバッファを RGBA8 で済ませられるか、RGBA16F が必要か(05 参照)
- [ ] Safari のメモリ上限の実測値(LRU しきい値を決める)
