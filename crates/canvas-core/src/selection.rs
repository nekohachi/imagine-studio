//! 選択範囲と塗りつぶし。選択範囲は A8 の Cel(全面)。
//! 描画はこのマスクで絞られる(Cel::composite の mask)。

use crate::cel::Cel;
use crate::tile::{PixelFormat, Rect};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SelectMode {
    Replace,
    Add,
    Subtract,
}

impl SelectMode {
    pub fn from_index(i: u32) -> Self {
        match i {
            1 => SelectMode::Add,
            2 => SelectMode::Subtract,
            _ => SelectMode::Replace,
        }
    }
}

/// 全面の A8 バッファ(選択の作業用)。
pub struct Mask {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl Mask {
    pub fn new(width: u32, height: u32) -> Self {
        Self {
            width,
            height,
            data: vec![0; width as usize * height as usize],
        }
    }

    pub fn from_cel(cel: &Cel) -> Self {
        Self {
            width: cel.width(),
            height: cel.height(),
            data: cel.read_rect(cel.bounds()),
        }
    }

    pub fn to_cel(&self) -> Cel {
        let mut c = Cel::new(PixelFormat::A8, self.width, self.height);
        c.write_rect(Rect::new(0, 0, self.width as i32, self.height as i32), &self.data);
        c.take_dirty();
        c
    }

    pub fn is_empty(&self) -> bool {
        self.data.iter().all(|&a| a == 0)
    }

    /// 選ばれた画素を囲む矩形。無ければ空。
    pub fn bounds(&self) -> Rect {
        let w = self.width as usize;
        let (mut x0, mut y0, mut x1, mut y1) = (usize::MAX, usize::MAX, 0usize, 0usize);
        for (i, &a) in self.data.iter().enumerate() {
            if a == 0 {
                continue;
            }
            let (x, y) = (i % w, i / w);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        if x0 == usize::MAX {
            Rect::default()
        } else {
            Rect::new(x0 as i32, y0 as i32, (x1 - x0 + 1) as i32, (y1 - y0 + 1) as i32)
        }
    }

    pub fn fill_rect(&mut self, r: Rect, v: u8) {
        let r = r.intersect(&Rect::new(0, 0, self.width as i32, self.height as i32));
        for y in r.y..r.bottom() {
            let row = y as usize * self.width as usize;
            self.data[row + r.x as usize..row + r.right() as usize].fill(v);
        }
    }

    /// 多角形(偶奇規則)を塗る。点は (x, y) の並び。
    pub fn fill_polygon(&mut self, pts: &[(f32, f32)], v: u8) {
        if pts.len() < 3 {
            return;
        }
        let ymin = pts.iter().map(|p| p.1).fold(f32::INFINITY, f32::min).floor().max(0.0) as i32;
        let ymax = pts
            .iter()
            .map(|p| p.1)
            .fold(f32::NEG_INFINITY, f32::max)
            .ceil()
            .min(self.height as f32) as i32;
        let mut xs: Vec<f32> = Vec::new();
        for y in ymin..ymax {
            let sy = y as f32 + 0.5;
            xs.clear();
            for i in 0..pts.len() {
                let (x0, y0) = pts[i];
                let (x1, y1) = pts[(i + 1) % pts.len()];
                if (y0 <= sy && y1 > sy) || (y1 <= sy && y0 > sy) {
                    xs.push(x0 + (sy - y0) * (x1 - x0) / (y1 - y0));
                }
            }
            xs.sort_by(|a, b| a.total_cmp(b));
            for pair in xs.chunks_exact(2) {
                let a = pair[0].round().max(0.0) as i32;
                let b = pair[1].round().min(self.width as f32) as i32;
                if b > a {
                    self.fill_rect(Rect::new(a, y, b - a, 1), v);
                }
            }
        }
    }

    /// 別のマスクを mode で合わせる。
    pub fn combine(&mut self, other: &Mask, mode: SelectMode) {
        match mode {
            SelectMode::Replace => self.data.copy_from_slice(&other.data),
            SelectMode::Add => {
                for (d, s) in self.data.iter_mut().zip(&other.data) {
                    *d = (*d).max(*s);
                }
            }
            SelectMode::Subtract => {
                for (d, s) in self.data.iter_mut().zip(&other.data) {
                    *d = (*d).saturating_sub(*s);
                }
            }
        }
    }

    pub fn invert(&mut self) {
        for d in &mut self.data {
            *d = 255 - *d;
        }
    }
}

/// 色の近さ。プリマルチ RGBA8 同士の最大チャンネル差(透明は透明同士で近い)。
#[inline]
fn color_distance(a: &[u8], b: &[u8]) -> u8 {
    let mut m = 0u8;
    for c in 0..4 {
        m = m.max(a[c].abs_diff(b[c]));
    }
    m
}

/// 塗りつぶし / 自動選択の領域を求める。`pixels` は全面のプリマルチ RGBA8。
/// `contiguous` なら種からつながる所、そうでなければ全面の似た色。
pub fn region_by_color(
    pixels: &[u8],
    width: u32,
    height: u32,
    seed_x: i32,
    seed_y: i32,
    tolerance: u8,
    contiguous: bool,
) -> Mask {
    let mut mask = Mask::new(width, height);
    let w = width as i32;
    let h = height as i32;
    if seed_x < 0 || seed_y < 0 || seed_x >= w || seed_y >= h {
        return mask;
    }
    let px = |x: i32, y: i32| -> &[u8] {
        let i = (y as usize * width as usize + x as usize) * 4;
        &pixels[i..i + 4]
    };
    let seed = px(seed_x, seed_y).to_vec();
    let near = |x: i32, y: i32| color_distance(px(x, y), &seed) <= tolerance;
    if !contiguous {
        for y in 0..h {
            for x in 0..w {
                if near(x, y) {
                    mask.data[(y * w + x) as usize] = 255;
                }
            }
        }
        return mask;
    }
    // スキャンライン塗り
    let mut stack: Vec<(i32, i32)> = vec![(seed_x, seed_y)];
    while let Some((x, y)) = stack.pop() {
        if mask.data[(y * w + x) as usize] != 0 || !near(x, y) {
            continue;
        }
        let mut x0 = x;
        while x0 > 0 && mask.data[(y * w + x0 - 1) as usize] == 0 && near(x0 - 1, y) {
            x0 -= 1;
        }
        let mut x1 = x;
        while x1 + 1 < w && mask.data[(y * w + x1 + 1) as usize] == 0 && near(x1 + 1, y) {
            x1 += 1;
        }
        for xx in x0..=x1 {
            mask.data[(y * w + xx) as usize] = 255;
        }
        for ny in [y - 1, y + 1] {
            if ny < 0 || ny >= h {
                continue;
            }
            let mut xx = x0;
            while xx <= x1 {
                if mask.data[(ny * w + xx) as usize] == 0 && near(xx, ny) {
                    stack.push((xx, ny));
                    // 同じ連続区間は 1 回で済ませる
                    while xx <= x1 && near(xx, ny) {
                        xx += 1;
                    }
                } else {
                    xx += 1;
                }
            }
        }
    }
    mask
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn polygon_and_rect_and_combine() {
        let mut m = Mask::new(10, 10);
        m.fill_polygon(&[(0.0, 0.0), (10.0, 0.0), (10.0, 10.0)], 255);
        // 右上の三角: (8,1) は中、(1,8) は外
        assert_eq!(m.data[1 * 10 + 8], 255);
        assert_eq!(m.data[8 * 10 + 1], 0);
        let mut r = Mask::new(10, 10);
        r.fill_rect(Rect::new(0, 0, 5, 10), 255);
        let mut a = Mask::new(10, 10);
        a.combine(&m, SelectMode::Replace);
        a.combine(&r, SelectMode::Add);
        assert_eq!(a.data[8 * 10 + 1], 255);
        a.combine(&r, SelectMode::Subtract);
        assert_eq!(a.data[8 * 10 + 1], 0);
        assert_eq!(a.data[1 * 10 + 8], 255);
        a.invert();
        assert_eq!(a.data[1 * 10 + 8], 0);
        assert_eq!(a.bounds().w, 10);
        assert!(!a.is_empty());
    }

    #[test]
    fn flood_fill_stops_at_edges_and_global_matches_everywhere() {
        let (w, h) = (8u32, 8u32);
        let mut px = vec![0u8; (w * h * 4) as usize];
        // 縦の黒い壁 x=4
        for y in 0..h {
            let i = ((y * w + 4) * 4) as usize;
            px[i..i + 4].copy_from_slice(&[0, 0, 0, 255]);
        }
        // 右側に 1 画素だけ別の透明領域の目印は無し(全部透明)
        let m = region_by_color(&px, w, h, 1, 1, 0, true);
        assert_eq!(m.data[1 * 8 + 3], 255);
        assert_eq!(m.data[1 * 8 + 4], 0, "壁");
        assert_eq!(m.data[1 * 8 + 6], 0, "壁の向こう");
        let g = region_by_color(&px, w, h, 1, 1, 0, false);
        assert_eq!(g.data[1 * 8 + 6], 255);
        assert_eq!(g.data[1 * 8 + 4], 0);
        // 許容値を上げると壁も入る
        let t = region_by_color(&px, w, h, 1, 1, 255, true);
        assert_eq!(t.data[1 * 8 + 4], 255);
        let out = region_by_color(&px, w, h, -1, 0, 0, true);
        assert!(out.is_empty());
    }
}
