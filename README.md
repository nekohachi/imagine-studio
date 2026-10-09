# Imagine Studio

SAI の書き味、Photoshop の機能、CLIP STUDIO のイラストと漫画、Procreate の UI 密度を 1 つにしたお絵描き PWA。
操作は「長押しの輪」。自作のドット絵アプリと 3D モデリングアプリ(macbeth)の UI 思想を引き継ぐ。

- 対象端末: iPad mini(iPadOS Safari)、Wacom MovinkPad Pro 14(Android Chrome)。Windows は Chrome / Edge
- 実装: PWA + WASM(TypeScript + Vite、Rust、WebGL2)
- 色深度: 8bit
- 用途: イラスト、漫画(Web と印刷)、手描きアニメ、3D 参照

## 設計書

| 番号 | 内容 |
|---|---|
| [00](docs/00-decisions.md) | 決定事項 |
| [01](docs/01-concept.md) | コンセプトと設計思想 |
| [02](docs/02-architecture.md) | アーキテクチャ、8bit の扱い、軽さの原則 |
| [03](docs/03-data-model.md) | データモデル、タイル、Undo、ファイル形式 |
| [04](docs/04-input-ui.md) | 入力と UI、輪、修飾ボタン、ジェスチャ |
| [05](docs/05-brush.md) | ブラシエンジン |
| [06](docs/06-manga.md) | 漫画 |
| [07](docs/07-animation.md) | アニメ |
| [08](docs/08-3d-reference.md) | 3D 参照レイヤー |
| [09](docs/09-performance-budget.md) | 性能予算 |
| [10](docs/10-roadmap.md) | ロードマップと優先度 |
| [11](docs/11-phase0-checklist.md) | フェーズ 0 チェックリスト |

## 構成(予定)

```
apps/web/            PWA 本体
packages/ring/       輪、修飾ボタン、ドック、HUD
packages/timeline/   レイヤー × フレーム格子
crates/brush-core/   ブラシエンジン
crates/canvas-core/  タイル、合成、履歴、ファイル形式
crates/wasm/         JS との結合
```

## 元になった資産

- `nekohachi/pixel-art-tool`: 輪の原型、タイムライン、GIF / Aseprite / gzip、Firebase 同期、非破壊変換
- `nekohachi/macbethUnity` の `claude/tablet-3d-modeling-app-f6b1x5`: 輪の現行版、修飾ボタン、ジェスチャ、3D 操作
- `nekohachi/macbethUnity` の `claude/drawing-app-design-iiiuit`: 以前のお絵描き設計と brush-core
