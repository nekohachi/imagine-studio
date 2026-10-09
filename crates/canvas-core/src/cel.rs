//! Cel: 1 レイヤー × 1 フレームの画素。スパースタイルの集まり。

use std::collections::{HashMap, HashSet};

use crate::tile::{PixelFormat, Rect, Tile, TileKey, TILE};

/// ストロークを焼くときの合成。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Blend {
    /// プリマルチプライド src-over
    Normal,
    /// 消しゴム。src のアルファ分だけ dst を薄くする
    Erase,
}

/// 変更前のタイル。None は「タイルが無かった」。Undo はこれを現在と入れ替えるだけ。
pub type Snapshot = Vec<(TileKey, Option<Tile>)>;

pub struct Cel {
    format: PixelFormat,
    width: u32,
    height: u32,
    tiles: HashMap<TileKey, Tile>,
    dirty: HashSet<TileKey>,
}

impl Cel {
    pub fn new(format: PixelFormat, width: u32, height: u32) -> Self {
        Self {
            format,
            width,
            height,
            tiles: HashMap::new(),
            dirty: HashSet::new(),
        }
    }

    pub fn format(&self) -> PixelFormat {
        self.format
    }
    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn bounds(&self) -> Rect {
        Rect::new(0, 0, self.width as i32, self.height as i32)
    }

    pub fn tile(&self, key: TileKey) -> Option<&Tile> {
        self.tiles.get(&key)
    }
    pub fn tile_count(&self) -> usize {
        self.tiles.len()
    }
    pub fn memory_bytes(&self) -> usize {
        self.tiles.len() * self.format.tile_bytes()
    }
    /// 持っているタイルのキー(並び順は固定)。
    pub fn keys(&self) -> Vec<TileKey> {
        let mut v: Vec<_> = self.tiles.keys().copied().collect();
        v.sort();
        v
    }

    /// 前回の take_dirty 以降に変わったタイル。GPU への転送に使う。
    pub fn take_dirty(&mut self) -> Vec<TileKey> {
        let mut v: Vec<_> = self.dirty.drain().collect();
        v.sort();
        v
    }
    pub fn mark_dirty(&mut self, key: TileKey) {
        self.dirty.insert(key);
    }

    /// タイルを差し替えて、前のものを返す(履歴の入れ替えに使う)。
    pub fn restore(&mut self, key: TileKey, tile: Option<Tile>) -> Option<Tile> {
        self.dirty.insert(key);
        match tile {
            Some(t) => self.tiles.insert(key, t),
            None => self.tiles.remove(&key),
        }
    }

    /// GPU で描いたストロークバッファ(プリマルチプライド RGBA8、`rect.w * 4` バイトごとの行)を
    /// `opacity` を掛けて焼き込む。1 ストロークに 1 回だけ呼ぶ(同一ストローク内で濃くならない)。
    /// 戻り値は触ったタイルの変更前(Undo 用)。
    pub fn composite(&mut self, rect: Rect, src: &[u8], opacity: f32, blend: Blend) -> Snapshot {
        let rect = rect.intersect(&self.bounds());
        if rect.is_empty() {
            return Vec::new();
        }
        let src_stride = (rect.w as usize) * 4;
        debug_assert!(src.len() >= src_stride * rect.h as usize);
        let opq = (opacity.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
        let mut snap = Vec::new();
        for key in rect.tiles() {
            let tr = key.rect();
            let r = tr.intersect(&rect);
            if r.is_empty() {
                continue;
            }
            // この範囲に塗りがあるか先に見る(空タイルを作らないため)
            if !region_has_alpha(src, src_stride, &rect, &r) {
                continue;
            }
            let existed = self.tiles.contains_key(&key);
            if !existed && blend == Blend::Erase {
                continue;
            }
            let before = self.tiles.get(&key).cloned();
            let tile = self
                .tiles
                .entry(key)
                .or_insert_with(|| Tile::empty(self.format));
            blend_region(tile, &tr, src, src_stride, &rect, &r, opq, blend);
            let blank = blend == Blend::Erase && tile.is_blank();
            if blank {
                self.tiles.remove(&key);
            }
            self.dirty.insert(key);
            snap.push((key, before));
        }
        snap
    }

    /// 全部消す。
    pub fn clear(&mut self) -> Snapshot {
        let mut snap: Vec<_> = self.tiles.drain().map(|(k, t)| (k, Some(t))).collect();
        snap.sort_by_key(|(k, _)| *k);
        for (k, _) in &snap {
            self.dirty.insert(*k);
        }
        snap
    }

    /// 矩形の画素を自分の形式で読む(書き出しや読み戻し用)。範囲外や空タイルは 0。
    pub fn read_rect(&self, rect: Rect) -> Vec<u8> {
        let bpp = self.format.bytes_per_pixel();
        let mut out = vec![0u8; (rect.w.max(0) as usize) * (rect.h.max(0) as usize) * bpp];
        if rect.is_empty() {
            return out;
        }
        let stride = rect.w as usize * bpp;
        for key in rect.tiles() {
            let Some(tile) = self.tiles.get(&key) else { continue };
            let tr = key.rect();
            let r = tr.intersect(&rect);
            if r.is_empty() {
                continue;
            }
            for y in r.y..r.bottom() {
                let sy = (y - tr.y) as usize;
                let dy = (y - rect.y) as usize;
                let sx = (r.x - tr.x) as usize;
                let dx = (r.x - rect.x) as usize;
                let n = r.w as usize * bpp;
                let s = &tile.data[(sy * TILE + sx) * bpp..(sy * TILE + sx) * bpp + n];
                out[dy * stride + dx * bpp..dy * stride + dx * bpp + n].copy_from_slice(s);
            }
        }
        out
    }

    /// 矩形の画素を自分の形式で上書きする(読み込みや貼り付け用)。
    pub fn write_rect(&mut self, rect: Rect, src: &[u8]) -> Snapshot {
        let rect_in = rect.intersect(&self.bounds());
        if rect_in.is_empty() {
            return Vec::new();
        }
        let bpp = self.format.bytes_per_pixel();
        let stride = rect.w as usize * bpp;
        let mut snap = Vec::new();
        for key in rect_in.tiles() {
            let tr = key.rect();
            let r = tr.intersect(&rect_in);
            if r.is_empty() {
                continue;
            }
            let before = self.tiles.get(&key).cloned();
            let tile = self
                .tiles
                .entry(key)
                .or_insert_with(|| Tile::empty(self.format));
            for y in r.y..r.bottom() {
                let ty = (y - tr.y) as usize;
                let sy = (y - rect.y) as usize;
                let tx = (r.x - tr.x) as usize;
                let sx = (r.x - rect.x) as usize;
                let n = r.w as usize * bpp;
                tile.data[(ty * TILE + tx) * bpp..(ty * TILE + tx) * bpp + n]
                    .copy_from_slice(&src[sy * stride + sx * bpp..sy * stride + sx * bpp + n]);
            }
            if tile.is_blank() {
                self.tiles.remove(&key);
            }
            self.dirty.insert(key);
            snap.push((key, before));
        }
        snap
    }
}

fn region_has_alpha(src: &[u8], stride: usize, src_rect: &Rect, r: &Rect) -> bool {
    for y in r.y..r.bottom() {
        let row = (y - src_rect.y) as usize * stride;
        let x0 = (r.x - src_rect.x) as usize * 4;
        let x1 = x0 + r.w as usize * 4;
        if src[row + x0..row + x1].chunks_exact(4).any(|p| p[3] != 0) {
            return true;
        }
    }
    false
}

#[inline]
fn mul255(a: u32, b: u32) -> u32 {
    (a * b + 127) / 255
}

#[allow(clippy::too_many_arguments)]
fn blend_region(
    tile: &mut Tile,
    tr: &Rect,
    src: &[u8],
    stride: usize,
    src_rect: &Rect,
    r: &Rect,
    opq: u32,
    blend: Blend,
) {
    let bpp = tile.format.bytes_per_pixel();
    for y in r.y..r.bottom() {
        let srow = (y - src_rect.y) as usize * stride + (r.x - src_rect.x) as usize * 4;
        let drow = ((y - tr.y) as usize * TILE + (r.x - tr.x) as usize) * bpp;
        let s = &src[srow..srow + r.w as usize * 4];
        let d = &mut tile.data[drow..drow + r.w as usize * bpp];
        match (tile.format, blend) {
            (PixelFormat::Rgba8, Blend::Normal) => {
                for (sp, dp) in s.chunks_exact(4).zip(d.chunks_exact_mut(4)) {
                    let sa = mul255(sp[3] as u32, opq);
                    if sa == 0 {
                        continue;
                    }
                    let f = 255 - sa;
                    for c in 0..4 {
                        let sc = mul255(sp[c] as u32, opq);
                        dp[c] = (sc + mul255(dp[c] as u32, f)).min(255) as u8;
                    }
                }
            }
            (PixelFormat::Rgba8, Blend::Erase) => {
                for (sp, dp) in s.chunks_exact(4).zip(d.chunks_exact_mut(4)) {
                    let sa = mul255(sp[3] as u32, opq);
                    if sa == 0 {
                        continue;
                    }
                    let f = 255 - sa;
                    for c in 0..4 {
                        dp[c] = mul255(dp[c] as u32, f) as u8;
                    }
                }
            }
            (PixelFormat::A8, Blend::Normal) => {
                for (sp, dp) in s.chunks_exact(4).zip(d.iter_mut()) {
                    let sa = mul255(sp[3] as u32, opq);
                    if sa == 0 {
                        continue;
                    }
                    *dp = (sa + mul255(*dp as u32, 255 - sa)).min(255) as u8;
                }
            }
            (PixelFormat::A8, Blend::Erase) => {
                for (sp, dp) in s.chunks_exact(4).zip(d.iter_mut()) {
                    let sa = mul255(sp[3] as u32, opq);
                    if sa == 0 {
                        continue;
                    }
                    *dp = mul255(*dp as u32, 255 - sa) as u8;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// rect いっぱいを 1 色(プリマルチ)で塗ったストロークバッファ
    fn solid(rect: Rect, rgba: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::with_capacity(rect.w as usize * rect.h as usize * 4);
        for _ in 0..rect.w * rect.h {
            v.extend_from_slice(&rgba);
        }
        v
    }

    #[test]
    fn composite_creates_only_touched_tiles() {
        let mut cel = Cel::new(PixelFormat::Rgba8, 1024, 1024);
        let r = Rect::new(250, 10, 20, 20);
        let snap = cel.composite(r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Normal);
        assert_eq!(cel.tile_count(), 2);
        assert_eq!(snap.len(), 2);
        assert!(snap.iter().all(|(_, before)| before.is_none()));
        assert_eq!(cel.take_dirty().len(), 2);
        assert!(cel.take_dirty().is_empty());
        let px = cel.read_rect(Rect::new(255, 10, 2, 1));
        assert_eq!(&px[..], &[0, 0, 0, 255, 0, 0, 0, 255]);
        assert_eq!(cel.read_rect(Rect::new(0, 0, 1, 1)), vec![0, 0, 0, 0]);
    }

    #[test]
    fn transparent_src_creates_nothing() {
        let mut cel = Cel::new(PixelFormat::Rgba8, 512, 512);
        let r = Rect::new(0, 0, 512, 512);
        let snap = cel.composite(r, &solid(r, [0, 0, 0, 0]), 1.0, Blend::Normal);
        assert!(snap.is_empty());
        assert_eq!(cel.tile_count(), 0);
    }

    #[test]
    fn opacity_scales_and_src_over_accumulates() {
        let mut cel = Cel::new(PixelFormat::Rgba8, 256, 256);
        let r = Rect::new(0, 0, 1, 1);
        cel.composite(r, &solid(r, [255, 0, 0, 255]), 0.5, Blend::Normal);
        let a = cel.read_rect(r);
        assert_eq!(a[3], 128);
        assert_eq!(a[0], 128);
        cel.composite(r, &solid(r, [255, 0, 0, 255]), 0.5, Blend::Normal);
        let b = cel.read_rect(r);
        // 0.5 の上に 0.5 で 0.75
        assert!((b[3] as i32 - 191).abs() <= 1, "{b:?}");
    }

    #[test]
    fn erase_removes_blank_tiles_and_skips_missing() {
        let mut cel = Cel::new(PixelFormat::Rgba8, 256, 256);
        let r = Rect::new(0, 0, 4, 4);
        cel.composite(r, &solid(r, [0, 0, 255, 255]), 1.0, Blend::Normal);
        assert_eq!(cel.tile_count(), 1);
        let snap = cel.composite(r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Erase);
        assert_eq!(snap.len(), 1);
        assert!(snap[0].1.is_some());
        assert_eq!(cel.tile_count(), 0, "全部消えたタイルは持たない");
        let snap = cel.composite(r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Erase);
        assert!(snap.is_empty(), "無いタイルを消しても何も起きない");
    }

    #[test]
    fn a8_takes_alpha_only() {
        let mut cel = Cel::new(PixelFormat::A8, 256, 256);
        let r = Rect::new(10, 10, 2, 2);
        cel.composite(r, &solid(r, [200, 100, 50, 200]), 1.0, Blend::Normal);
        assert_eq!(cel.read_rect(r), vec![200, 200, 200, 200]);
        cel.composite(r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Erase);
        assert_eq!(cel.tile_count(), 0);
    }

    #[test]
    fn restore_swaps_and_marks_dirty() {
        let mut cel = Cel::new(PixelFormat::Rgba8, 256, 256);
        let r = Rect::new(0, 0, 1, 1);
        let snap = cel.composite(r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Normal);
        cel.take_dirty();
        let (key, before) = snap.into_iter().next().unwrap();
        let after = cel.restore(key, before);
        assert!(after.is_some());
        assert_eq!(cel.tile_count(), 0);
        assert_eq!(cel.take_dirty(), vec![key]);
        cel.restore(key, after);
        assert_eq!(cel.read_rect(r)[3], 255);
    }

    #[test]
    fn write_and_read_rect_roundtrip_across_tiles() {
        let mut cel = Cel::new(PixelFormat::Rgba8, 600, 600);
        let r = Rect::new(200, 200, 100, 100);
        let mut src = vec![0u8; 100 * 100 * 4];
        for (i, p) in src.chunks_exact_mut(4).enumerate() {
            p[0] = (i % 251) as u8;
            p[3] = 255;
        }
        cel.write_rect(r, &src);
        assert_eq!(cel.tile_count(), 4);
        assert_eq!(cel.read_rect(r), src);
        assert_eq!(cel.memory_bytes(), 4 * 256 * 256 * 4);
    }

    #[test]
    fn clips_to_bounds() {
        let mut cel = Cel::new(PixelFormat::Rgba8, 100, 100);
        let r = Rect::new(90, 90, 50, 50);
        cel.composite(r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Normal);
        assert_eq!(cel.tile_count(), 1);
        assert_eq!(cel.read_rect(Rect::new(99, 99, 1, 1))[3], 255);
    }
}
