//! コマ枠(docs/06)。コマは凸多角形の列。縦 / 横 / 斜めの線で割り、コマ間に隙間を空ける。
//! 画素(枠線の黒と、コマの外の白)はここから作り直せるキャッシュ。
//!
//! フォルダ構造はまだ無いので「コマ枠レイヤー」として、絵のレイヤーの上に置いて使う
//! (コマの外を白で埋めれば、下の絵がはみ出しても隠れる)。

use serde::{Deserialize, Serialize};

use crate::selection::Mask;
use crate::tile::Rect;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Panel {
    /// 頂点(時計回りでも反時計回りでもよい)。凸多角形
    pub pts: Vec<[f32; 2]>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Frame {
    pub panels: Vec<Panel>,
    /// 枠線の太さ px
    pub border: f32,
    /// コマ間の隙間 px: 左右(縦に割ったとき)と天地(横に割ったとき)
    pub gutter_h: f32,
    pub gutter_v: f32,
    /// コマの外を白で埋める
    pub fill_gutter: bool,
}

impl Default for Frame {
    fn default() -> Self {
        Self {
            panels: Vec::new(),
            border: 6.0,
            gutter_h: 24.0,
            gutter_v: 40.0,
            fill_gutter: true,
        }
    }
}

/// 半平面 `a·x + b·y + c >= 0` で凸多角形を切る(Sutherland–Hodgman の 1 辺ぶん)。
fn clip(poly: &[[f32; 2]], a: f32, b: f32, c: f32) -> Vec<[f32; 2]> {
    let n = poly.len();
    let mut out = Vec::with_capacity(n + 2);
    if n == 0 {
        return out;
    }
    let side = |p: [f32; 2]| a * p[0] + b * p[1] + c;
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        let sp = side(p);
        let sq = side(q);
        if sp >= 0.0 {
            out.push(p);
        }
        if (sp >= 0.0) != (sq >= 0.0) {
            let t = sp / (sp - sq);
            out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
        }
    }
    out
}

fn area2(poly: &[[f32; 2]]) -> f32 {
    let n = poly.len();
    let mut s = 0.0;
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        s += p[0] * q[1] - q[0] * p[1];
    }
    s
}

/// 凸多角形を内側へ `d` だけ縮める(各辺を法線方向に寄せて切り直す)。
pub fn inset(poly: &[[f32; 2]], d: f32) -> Vec<[f32; 2]> {
    if d <= 0.0 || poly.len() < 3 {
        return poly.to_vec();
    }
    let sign = if area2(poly) >= 0.0 { 1.0 } else { -1.0 };
    let mut out = poly.to_vec();
    let n = poly.len();
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        let (ex, ey) = (q[0] - p[0], q[1] - p[1]);
        let len = (ex * ex + ey * ey).sqrt();
        if len < 1e-6 {
            continue;
        }
        // 内向きの法線(符号付き面積で向きを合わせる)
        let (nx, ny) = (-ey / len * sign, ex / len * sign);
        // 内側: n·x >= n·p + d
        let c = -(nx * p[0] + ny * p[1]) - d;
        out = clip(&out, nx, ny, c);
        if out.len() < 3 {
            return Vec::new();
        }
    }
    out
}

fn contains(poly: &[[f32; 2]], x: f32, y: f32) -> bool {
    if poly.len() < 3 {
        return false;
    }
    let sign = if area2(poly) >= 0.0 { 1.0 } else { -1.0 };
    let n = poly.len();
    for i in 0..n {
        let p = poly[i];
        let q = poly[(i + 1) % n];
        let cross = (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
        if cross * sign < 0.0 {
            return false;
        }
    }
    true
}

impl Frame {
    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }

    /// 基本枠 1 コマ(紙の端から `margin` px 内側)。
    pub fn page(width: u32, height: u32, margin: f32) -> Self {
        let m = margin.max(0.0);
        let (w, h) = (width as f32, height as f32);
        Self {
            panels: vec![Panel {
                pts: vec![[m, m], [w - m, m], [w - m, h - m], [m, h - m]],
            }],
            ..Default::default()
        }
    }

    /// 点 (x0, y0) を含むコマを、(x0, y0)–(x1, y1) を通る直線で 2 つに割る。隙間は向きで決める
    /// (縦の線なら左右、横の線なら天地、斜めはその間)。割れたら真。
    pub fn split(&mut self, x0: f32, y0: f32, x1: f32, y1: f32) -> bool {
        let Some(idx) = self.panels.iter().position(|p| contains(&p.pts, x0, y0)) else { return false };
        let (dx, dy) = (x1 - x0, y1 - y0);
        let len = (dx * dx + dy * dy).sqrt();
        if len < 1e-3 {
            return false;
        }
        // 法線
        let (nx, ny) = (-dy / len, dx / len);
        // 隙間: 法線が水平に近いほど左右の隙間、垂直に近いほど天地
        let t = ny.abs();
        let gap = self.gutter_h * (1.0 - t) + self.gutter_v * t;
        let c0 = -(nx * x0 + ny * y0);
        let poly = self.panels[idx].pts.clone();
        let a = clip(&poly, nx, ny, c0 - gap * 0.5);
        let b = clip(&poly, -nx, -ny, -c0 - gap * 0.5);
        if a.len() < 3 || b.len() < 3 {
            return false;
        }
        self.panels[idx] = Panel { pts: a };
        self.panels.insert(idx + 1, Panel { pts: b });
        true
    }

    /// 点を含むコマを消す(隣と結合はしない)。
    pub fn remove_at(&mut self, x: f32, y: f32) -> bool {
        let Some(idx) = self.panels.iter().position(|p| contains(&p.pts, x, y)) else { return false };
        self.panels.remove(idx);
        true
    }

    /// 画素(プリマルチ RGBA8、width × height)。枠線は黒、コマの外は白(fill_gutter のとき)。
    pub fn render(&self, width: u32, height: u32) -> Vec<u8> {
        let mut inside = Mask::new(width, height);
        let mut inner = Mask::new(width, height);
        for p in &self.panels {
            let pts: Vec<(f32, f32)> = p.pts.iter().map(|q| (q[0], q[1])).collect();
            inside.fill_polygon(&pts, 255);
            let ins = inset(&p.pts, self.border);
            let pts2: Vec<(f32, f32)> = ins.iter().map(|q| (q[0], q[1])).collect();
            inner.fill_polygon(&pts2, 255);
        }
        let n = width as usize * height as usize;
        let mut out = vec![0u8; n * 4];
        for i in 0..n {
            let o = i * 4;
            if inside.data[i] == 0 {
                if self.fill_gutter {
                    out[o..o + 4].copy_from_slice(&[255, 255, 255, 255]);
                }
            } else if inner.data[i] == 0 {
                out[o..o + 4].copy_from_slice(&[0, 0, 0, 255]);
            }
        }
        out
    }

    pub fn bounds(width: u32, height: u32) -> Rect {
        Rect::new(0, 0, width as i32, height as i32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_split_and_render() {
        let mut f = Frame::page(200, 100, 10.0);
        assert_eq!(f.panels.len(), 1);
        // 縦に割る(x = 100)
        assert!(f.split(100.0, 50.0, 100.0, 60.0));
        assert_eq!(f.panels.len(), 2);
        let a = &f.panels[0].pts;
        let b = &f.panels[1].pts;
        let ax = a.iter().map(|p| p[0]).fold(f32::MIN, f32::max);
        let bx = b.iter().map(|p| p[0]).fold(f32::MAX, f32::min);
        assert!((bx - ax - f.gutter_h).abs() < 0.01, "隙間 {} {}", ax, bx);
        // 隙間の外で割ろうとしても何も起きない
        assert!(!f.split(100.0, 50.0, 100.0, 60.0), "隙間の中にはコマが無い");
        let px = f.render(200, 100);
        let at = |x: usize, y: usize| &px[(y * 200 + x) * 4..(y * 200 + x) * 4 + 4];
        assert_eq!(at(2, 2), &[255, 255, 255, 255], "外は白");
        assert_eq!(at(12, 50), &[0, 0, 0, 255], "枠線は黒");
        assert_eq!(at(50, 50), &[0, 0, 0, 0], "中は透明");
        assert_eq!(at(100, 50), &[255, 255, 255, 255], "隙間は白");
        // 斜めに割る
        assert!(f.split(50.0, 50.0, 60.0, 70.0));
        assert_eq!(f.panels.len(), 3);
        assert!(f.remove_at(150.0, 50.0));
        assert_eq!(f.panels.len(), 2);
    }

    #[test]
    fn inset_shrinks_convex() {
        let sq = [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]];
        let i = inset(&sq, 2.0);
        assert_eq!(i.len(), 4);
        for p in &i {
            assert!(p[0] >= 1.99 && p[0] <= 8.01 && p[1] >= 1.99 && p[1] <= 8.01, "{p:?}");
        }
        let rev = [[0.0, 0.0], [0.0, 10.0], [10.0, 10.0], [10.0, 0.0]];
        assert_eq!(inset(&rev, 2.0).len(), 4);
        assert!(inset(&sq, 6.0).is_empty(), "縮めすぎると消える");
    }
}
