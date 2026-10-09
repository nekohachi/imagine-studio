//! canvas-core: キャンバスの画素の「正」を持つコア。
//!
//! docs/03 の方針:
//! - 256×256 のスパースタイル。空タイルは持たない。
//! - 画素は 8bit だけ。RGBA8(プリマルチプライド)と A8(モノクロ)。
//! - ダーティはタイル単位。GPU への転送はダーティタイルだけ。
//! - Undo はタイル差分。MB 上限で古いものから捨てる。
//!
//! GPU には触らない。ストロークの焼き込みは、GPU で描いたストロークバッファの
//! 汚れた矩形を受け取って CPU で合成する(1 ストロークに 1 回)。

pub mod cel;
pub mod document;
pub mod history;
pub mod io;
pub mod tile;

pub use cel::{Blend, Cel};
pub use document::{Document, Layer, LayerId};
pub use history::{Entry, History};
pub use tile::{PixelFormat, Rect, Tile, TileKey, TILE};
