//! 変形: 選択範囲(無ければレイヤー全体)の画素を持ち上げ、アフィン変換して置き直す。
//! 持ち上げている間の表示は GPU が行う(floating の画素をそのまま渡す)。

use crate::tile::Rect;

/// 2×3 のアフィン行列。dst = [a c e; b d f] · [x y 1]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Affine {
    pub a: f32,
    pub b: f32,
    pub c: f32,
    pub d: f32,
    pub e: f32,
    pub f: f32,
}

impl Affine {
    pub const IDENTITY: Affine = Affine {
        a: 1.0,
        b: 0.0,
        c: 0.0,
        d: 1.0,
        e: 0.0,
        f: 0.0,
    };

    pub fn apply(&self, x: f32, y: f32) -> (f32, f32) {
        (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)
    }

    pub fn inverse(&self) -> Option<Affine> {
        let det = self.a * self.d - self.b * self.c;
        if det.abs() < 1e-9 {
            return None;
        }
        let ia = self.d / det;
        let ib = -self.b / det;
        let ic = -self.c / det;
        let id = self.a / det;
        Some(Affine {
            a: ia,
            b: ib,
            c: ic,
            d: id,
            e: -(ia * self.e + ic * self.f),
            f: -(ib * self.e + id * self.f),
        })
    }

    /// 矩形の 4 隅を写した外接矩形(整数、外側へ丸める)。
    pub fn bounds_of(&self, r: Rect) -> Rect {
        let pts = [
            self.apply(r.x as f32, r.y as f32),
            self.apply(r.right() as f32, r.y as f32),
            self.apply(r.x as f32, r.bottom() as f32),
            self.apply(r.right() as f32, r.bottom() as f32),
        ];
        let x0 = pts.iter().map(|p| p.0).fold(f32::INFINITY, f32::min).floor() as i32;
        let y0 = pts.iter().map(|p| p.1).fold(f32::INFINITY, f32::min).floor() as i32;
        let x1 = pts.iter().map(|p| p.0).fold(f32::NEG_INFINITY, f32::max).ceil() as i32;
        let y1 = pts.iter().map(|p| p.1).fold(f32::NEG_INFINITY, f32::max).ceil() as i32;
        Rect::new(x0, y0, (x1 - x0).max(0), (y1 - y0).max(0))
    }
}

/// 持ち上げた画素。
#[derive(Clone, Debug)]
pub struct Floating {
    pub rect: Rect,
    /// プリマルチ RGBA8、rect.w × rect.h
    pub data: Vec<u8>,
    /// 持ち上げ時の選択範囲(A8、rect.w × rect.h)。無ければ None
    pub mask: Option<Vec<u8>>,
}

/// `src`(rect_src の並び、`bpp` バイト / 画素)を `m` で写し、出力矩形 `dst_rect` の並びで返す。
/// 双一次補間。範囲外は 0。
pub fn resample(src: &[u8], src_rect: Rect, bpp: usize, m: &Affine, dst_rect: Rect) -> Vec<u8> {
    let mut out = vec![0u8; dst_rect.w.max(0) as usize * dst_rect.h.max(0) as usize * bpp];
    let Some(inv) = m.inverse() else { return out };
    let sw = src_rect.w as i32;
    let sh = src_rect.h as i32;
    let fetch = |x: i32, y: i32, c: usize| -> f32 {
        if x < 0 || y < 0 || x >= sw || y >= sh {
            0.0
        } else {
            src[(y as usize * sw as usize + x as usize) * bpp + c] as f32
        }
    };
    for dy in 0..dst_rect.h {
        for dx in 0..dst_rect.w {
            // 出力画素の中心を元へ戻す
            let (ox, oy) = inv.apply(dst_rect.x as f32 + dx as f32 + 0.5, dst_rect.y as f32 + dy as f32 + 0.5);
            let sx = ox - src_rect.x as f32 - 0.5;
            let sy = oy - src_rect.y as f32 - 0.5;
            let x0 = sx.floor() as i32;
            let y0 = sy.floor() as i32;
            if x0 < -1 || y0 < -1 || x0 > sw || y0 > sh {
                continue;
            }
            let tx = sx - x0 as f32;
            let ty = sy - y0 as f32;
            let o = (dy as usize * dst_rect.w as usize + dx as usize) * bpp;
            for c in 0..bpp {
                let v = fetch(x0, y0, c) * (1.0 - tx) * (1.0 - ty)
                    + fetch(x0 + 1, y0, c) * tx * (1.0 - ty)
                    + fetch(x0, y0 + 1, c) * (1.0 - tx) * ty
                    + fetch(x0 + 1, y0 + 1, c) * tx * ty;
                out[o + c] = (v + 0.5).clamp(0.0, 255.0) as u8;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affine_inverse_and_bounds() {
        let m = Affine {
            a: 2.0,
            b: 0.0,
            c: 0.0,
            d: 2.0,
            e: 10.0,
            f: 5.0,
        };
        let inv = m.inverse().unwrap();
        let (x, y) = inv.apply(30.0, 25.0);
        assert!((x - 10.0).abs() < 1e-5 && (y - 10.0).abs() < 1e-5);
        assert_eq!(m.bounds_of(Rect::new(0, 0, 10, 10)), Rect::new(10, 5, 20, 20));
        assert!(Affine { a: 0.0, b: 0.0, c: 0.0, d: 0.0, e: 0.0, f: 0.0 }.inverse().is_none());
    }

    #[test]
    fn resample_translates_and_scales() {
        // 2×2 の赤
        let src = vec![255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255, 255, 0, 0, 255];
        let sr = Rect::new(0, 0, 2, 2);
        let t = Affine { e: 3.0, f: 1.0, ..Affine::IDENTITY };
        let out = resample(&src, sr, 4, &t, Rect::new(3, 1, 2, 2));
        assert_eq!(out, src, "平行移動は画素がそのまま");
        let s = Affine { a: 2.0, d: 2.0, ..Affine::IDENTITY };
        let out = resample(&src, sr, 4, &s, Rect::new(0, 0, 4, 4));
        // 真ん中は不透明、角は補間で少し薄い
        assert_eq!(out[(1 * 4 + 1) * 4 + 3], 255);
        assert!(out[3] < 255 && out[3] > 0, "{}", out[3]);
    }
}
