//! タイルと矩形。

/// タイルの一辺(px)。
pub const TILE: usize = 256;

/// 画素形式。タイルのヘッダに持ち、将来の追加(16bit など)を塞がない。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub enum PixelFormat {
    /// プリマルチプライド RGBA、各 8bit
    Rgba8,
    /// アルファ(濃度)だけ 8bit。漫画の線画やトーン、マスク用
    A8,
}

impl PixelFormat {
    pub const fn bytes_per_pixel(self) -> usize {
        match self {
            PixelFormat::Rgba8 => 4,
            PixelFormat::A8 => 1,
        }
    }
    pub const fn tile_bytes(self) -> usize {
        TILE * TILE * self.bytes_per_pixel()
    }
}

/// タイルの座標(タイル単位)。負も許す(キャンバス拡張のため)。
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct TileKey {
    pub tx: i32,
    pub ty: i32,
}

impl TileKey {
    pub fn new(tx: i32, ty: i32) -> Self {
        Self { tx, ty }
    }
    /// このタイルがキャンバス上で占める矩形。
    pub fn rect(self) -> Rect {
        Rect::new(
            self.tx * TILE as i32,
            self.ty * TILE as i32,
            TILE as i32,
            TILE as i32,
        )
    }
}

/// 1 タイル分の画素。長さは format.tile_bytes()。
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Tile {
    pub format: PixelFormat,
    pub data: Box<[u8]>,
}

impl Tile {
    pub fn empty(format: PixelFormat) -> Self {
        Self {
            format,
            data: vec![0u8; format.tile_bytes()].into_boxed_slice(),
        }
    }
    /// 全画素が透明か。
    pub fn is_blank(&self) -> bool {
        match self.format {
            PixelFormat::Rgba8 => self.data.chunks_exact(4).all(|p| p[3] == 0),
            PixelFormat::A8 => self.data.iter().all(|&a| a == 0),
        }
    }
    pub fn bytes(&self) -> usize {
        self.data.len()
    }
}

/// 整数矩形(px)。右下は含まない。
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl Rect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }
    pub fn is_empty(&self) -> bool {
        self.w <= 0 || self.h <= 0
    }
    pub fn right(&self) -> i32 {
        self.x + self.w
    }
    pub fn bottom(&self) -> i32 {
        self.y + self.h
    }
    pub fn intersect(&self, o: &Rect) -> Rect {
        let x0 = self.x.max(o.x);
        let y0 = self.y.max(o.y);
        let x1 = self.right().min(o.right());
        let y1 = self.bottom().min(o.bottom());
        if x1 <= x0 || y1 <= y0 {
            Rect::default()
        } else {
            Rect::new(x0, y0, x1 - x0, y1 - y0)
        }
    }
    pub fn union(&self, o: &Rect) -> Rect {
        if self.is_empty() {
            return *o;
        }
        if o.is_empty() {
            return *self;
        }
        let x0 = self.x.min(o.x);
        let y0 = self.y.min(o.y);
        let x1 = self.right().max(o.right());
        let y1 = self.bottom().max(o.bottom());
        Rect::new(x0, y0, x1 - x0, y1 - y0)
    }
    /// この矩形に触れるタイルのキー(行優先)。
    pub fn tiles(&self) -> impl Iterator<Item = TileKey> {
        let t = TILE as i32;
        let (x0, y0, x1, y1) = if self.is_empty() {
            (0, 0, 0, 0)
        } else {
            (
                self.x.div_euclid(t),
                self.y.div_euclid(t),
                (self.right() - 1).div_euclid(t) + 1,
                (self.bottom() - 1).div_euclid(t) + 1,
            )
        };
        (y0..y1).flat_map(move |ty| (x0..x1).map(move |tx| TileKey::new(tx, ty)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rect_tiles_cover_edges() {
        let r = Rect::new(250, 0, 10, 1);
        let keys: Vec<_> = r.tiles().collect();
        assert_eq!(keys, vec![TileKey::new(0, 0), TileKey::new(1, 0)]);
        assert_eq!(Rect::new(0, 0, 256, 256).tiles().count(), 1);
        assert_eq!(Rect::new(0, 0, 257, 1).tiles().count(), 2);
        assert_eq!(Rect::default().tiles().count(), 0);
    }

    #[test]
    fn rect_negative_tiles() {
        let keys: Vec<_> = Rect::new(-1, -1, 2, 2).tiles().collect();
        assert_eq!(keys.len(), 4);
        assert_eq!(keys[0], TileKey::new(-1, -1));
    }

    #[test]
    fn intersect_and_union() {
        let a = Rect::new(0, 0, 10, 10);
        let b = Rect::new(5, 5, 10, 10);
        assert_eq!(a.intersect(&b), Rect::new(5, 5, 5, 5));
        assert_eq!(a.union(&b), Rect::new(0, 0, 15, 15));
        assert!(a.intersect(&Rect::new(20, 20, 1, 1)).is_empty());
    }

    #[test]
    fn blank_tile() {
        let mut t = Tile::empty(PixelFormat::Rgba8);
        assert!(t.is_blank());
        t.data[3] = 1;
        assert!(!t.is_blank());
        assert_eq!(Tile::empty(PixelFormat::A8).bytes(), TILE * TILE);
    }
}
