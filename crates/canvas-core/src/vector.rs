//! ベクターレイヤー(docs/06 のペン入れ)。
//!
//! ストロークは入力点のまま持つ(ブラシ定義の JSON、色、[x, y, 筆圧, 時刻, 傾き x, 傾き y] × n)。
//! 画素は CPU で作り直せるキャッシュ。ダブ(brush-core の出力)はここでは作らず、
//! 呼び出し側(wasm)がブラシエンジンを回して渡す。ダブの描き方は GPU のシェーダと同じ式。
//!
//! ベクター消しゴムは 3 種(docs/06): 通常(触れた所を切る)、触れた線を消す、交点まで消す。

use serde::{Deserialize, Serialize};

use crate::tile::Rect;

/// 入力点の要素数: x, y, pressure, time, tilt_x, tilt_y
pub const VPOINT: usize = 6;
/// ダブの要素数: x, y, radius, opacity, angle, aspect, colorPacked, 予備
pub const VDAB: usize = 8;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct VStroke {
    /// ブラシ定義の JSON(brush-core の BrushDef)
    pub brush: String,
    pub color: [u8; 3],
    /// [x, y, pressure, time, tilt_x, tilt_y] × n
    pub points: Vec<f32>,
}

impl VStroke {
    pub fn len(&self) -> usize {
        self.points.len() / VPOINT
    }
    pub fn is_empty(&self) -> bool {
        self.points.len() < VPOINT
    }
    pub fn point(&self, i: usize) -> (f32, f32) {
        (self.points[i * VPOINT], self.points[i * VPOINT + 1])
    }
    /// ブラシの半径(JSON の size)。読めなければ 4。
    pub fn size(&self) -> f32 {
        serde_json::from_str::<serde_json::Value>(&self.brush)
            .ok()
            .and_then(|v| v.get("size").and_then(|s| s.as_f64()))
            .map_or(4.0, |s| s as f32)
    }
    /// 点列の外接矩形に `pad` を足したもの(整数 px)。
    pub fn bounds(&self, pad: f32) -> Rect {
        if self.is_empty() {
            return Rect::new(0, 0, 0, 0);
        }
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        for i in 0..self.len() {
            let (x, y) = self.point(i);
            x0 = x0.min(x);
            y0 = y0.min(y);
            x1 = x1.max(x);
            y1 = y1.max(y);
        }
        let x0 = (x0 - pad).floor() as i32;
        let y0 = (y0 - pad).floor() as i32;
        let x1 = (x1 + pad).ceil() as i32;
        let y1 = (y1 + pad).ceil() as i32;
        Rect::new(x0, y0, x1 - x0 + 1, y1 - y0 + 1)
    }
    /// 描画に影響する範囲(半径の 2 倍 + 余白)。散布や入り抜きで少し広がるので余裕を取る。
    pub fn paint_bounds(&self) -> Rect {
        self.bounds(self.size() * 2.0 + 3.0)
    }
    pub fn bytes(&self) -> usize {
        self.brush.len() + self.points.len() * 4 + 16
    }
    /// JSON の数値項目を書き換える(無ければ足す)。
    pub fn set_brush_number(&mut self, key: &str, value: f32) {
        if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&self.brush) {
            if let Some(obj) = v.as_object_mut() {
                obj.insert(key.to_string(), serde_json::json!(value));
                if let Ok(s) = serde_json::to_string(&v) {
                    self.brush = s;
                }
            }
        }
    }
    pub fn brush_number(&self, key: &str) -> Option<f32> {
        serde_json::from_str::<serde_json::Value>(&self.brush)
            .ok()
            .and_then(|v| v.get(key).and_then(|s| s.as_f64()))
            .map(|s| s as f32)
    }
    /// 平行移動。
    pub fn translate(&mut self, dx: f32, dy: f32) {
        for p in self.points.chunks_exact_mut(VPOINT) {
            p[0] += dx;
            p[1] += dy;
        }
    }
    /// 拡縮(ブラシの半径も平均倍率で)。
    pub fn scale(&mut self, sx: f32, sy: f32) {
        for p in self.points.chunks_exact_mut(VPOINT) {
            p[0] *= sx;
            p[1] *= sy;
        }
        let s = self.size() * ((sx + sy) * 0.5);
        self.set_brush_number("size", s.clamp(0.1, 1000.0));
    }
}

// ---- CPU ラスタライズ ----

/// プリマルチ RGBA8 の矩形バッファ。GPU のストロークバッファと同じ役。
pub struct DabBuf {
    pub rect: Rect,
    pub data: Vec<u8>,
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    if e1 <= e0 {
        return if x < e0 { 0.0 } else { 1.0 };
    }
    let t = ((x - e0) / (e1 - e0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

impl DabBuf {
    pub fn new(rect: Rect) -> Self {
        let n = rect.w.max(0) as usize * rect.h.max(0) as usize * 4;
        Self {
            rect,
            data: vec![0; n],
        }
    }

    /// ダブ列(VDAB 要素ずつ)を src-over で打つ。式は gl.ts の DAB_VS / DAB_FS と同じ
    /// (半径 0.75 への切り上げと面積補正、hardness による縁、1px の AA)。紙目と混色は無し。
    pub fn stamp(&mut self, dabs: &[f32], hardness: f32) {
        if self.rect.is_empty() {
            return;
        }
        let w = self.rect.w as usize;
        let h = self.rect.h as usize;
        for d in dabs.chunks_exact(VDAB) {
            let (cx, cy, r0, op, angle, aspect, packed) = (d[0], d[1], d[2], d[3], d[4], d[5].max(0.05), d[6]);
            let r = r0.max(0.75);
            let cov = (r0 * r0) / (r * r);
            let rr = r + 1.0;
            let opacity = op * cov;
            if opacity <= 0.0 {
                continue;
            }
            let cr = (packed / 65536.0).floor();
            let cg = ((packed - cr * 65536.0) / 256.0).floor();
            let cb = packed - cr * 65536.0 - cg * 256.0;
            let color = [cr / 255.0, cg / 255.0, cb / 255.0];
            let edge0 = (r * hardness).min((r - 1.5).max(0.0));
            let (s, c) = angle.sin_cos();
            // 回した四角の外接矩形
            let ex = (c * rr).abs() + (s * rr * aspect).abs();
            let ey = (s * rr).abs() + (c * rr * aspect).abs();
            let x0 = ((cx - ex).floor() as i32 - self.rect.x).max(0);
            let y0 = ((cy - ey).floor() as i32 - self.rect.y).max(0);
            let x1 = ((cx + ex).ceil() as i32 - self.rect.x + 1).min(w as i32);
            let y1 = ((cy + ey).ceil() as i32 - self.rect.y + 1).min(h as i32);
            if x0 >= x1 || y0 >= y1 {
                continue;
            }
            for py in y0..y1 {
                let fy = (py + self.rect.y) as f32 + 0.5 - cy;
                for px in x0..x1 {
                    let fx = (px + self.rect.x) as f32 + 0.5 - cx;
                    // 逆回転して、扁平は形で表し距離は円のまま測る
                    let lx = c * fx + s * fy;
                    let ly = -s * fx + c * fy;
                    if lx.abs() > rr || ly.abs() > rr * aspect {
                        continue;
                    }
                    let dist = (lx * lx + (ly / aspect) * (ly / aspect)).sqrt();
                    let a = (1.0 - smoothstep(edge0, r, dist)) * opacity;
                    if a <= 0.0 {
                        continue;
                    }
                    let o = (py as usize * w + px as usize) * 4;
                    let dst = &mut self.data[o..o + 4];
                    let f = 1.0 - a;
                    for ch in 0..3 {
                        let v = color[ch] * a * 255.0 + dst[ch] as f32 * f;
                        dst[ch] = (v + 0.5).min(255.0) as u8;
                    }
                    let v = a * 255.0 + dst[3] as f32 * f;
                    dst[3] = (v + 0.5).min(255.0) as u8;
                }
            }
        }
    }

    /// ダブ列の外接矩形(余白込み)。
    pub fn dabs_bounds(dabs: &[f32]) -> Rect {
        let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
        let mut any = false;
        for d in dabs.chunks_exact(VDAB) {
            let r = d[2].max(0.75) + 2.0;
            x0 = x0.min(d[0] - r);
            y0 = y0.min(d[1] - r);
            x1 = x1.max(d[0] + r);
            y1 = y1.max(d[1] + r);
            any = true;
        }
        if !any {
            return Rect::new(0, 0, 0, 0);
        }
        let x0 = x0.floor() as i32;
        let y0 = y0.floor() as i32;
        Rect::new(x0, y0, x1.ceil() as i32 - x0 + 1, y1.ceil() as i32 - y0 + 1)
    }
}

// ---- 消しゴムの幾何 ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EraseMode {
    /// 触れた所を切る
    Normal,
    /// 触れた線を丸ごと消す
    Touch,
    /// 触れた所から、他の線との交点まで消す
    Intersect,
}

impl EraseMode {
    pub fn from_u32(n: u32) -> Self {
        match n {
            1 => EraseMode::Touch,
            2 => EraseMode::Intersect,
            _ => EraseMode::Normal,
        }
    }
}

fn dist_point_seg(px: f32, py: f32, ax: f32, ay: f32, bx: f32, by: f32) -> f32 {
    let (dx, dy) = (bx - ax, by - ay);
    let l2 = dx * dx + dy * dy;
    let t = if l2 <= 1e-12 { 0.0 } else { (((px - ax) * dx + (py - ay) * dy) / l2).clamp(0.0, 1.0) };
    let (qx, qy) = (ax + dx * t, ay + dy * t);
    ((px - qx).powi(2) + (py - qy).powi(2)).sqrt()
}

/// 線分 ab と cd の交点(ab 上のパラメータ t)。平行や外れは None。
fn seg_intersect(ax: f32, ay: f32, bx: f32, by: f32, cx: f32, cy: f32, dx: f32, dy: f32) -> Option<f32> {
    let r = (bx - ax, by - ay);
    let s = (dx - cx, dy - cy);
    let den = r.0 * s.1 - r.1 * s.0;
    if den.abs() < 1e-9 {
        return None;
    }
    let qp = (cx - ax, cy - ay);
    let t = (qp.0 * s.1 - qp.1 * s.0) / den;
    let u = (qp.0 * r.1 - qp.1 * r.0) / den;
    if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
        Some(t)
    } else {
        None
    }
}

/// 消しゴムの経路(VPOINT ずつ)に触れている点の印。`thr` は距離の閾値。
fn hits(stroke: &VStroke, path: &[f32], thr: f32) -> Vec<bool> {
    let n = stroke.len();
    let mut hit = vec![false; n];
    let pp: Vec<(f32, f32)> = path.chunks_exact(VPOINT).map(|p| (p[0], p[1])).collect();
    if pp.is_empty() || n == 0 {
        return hit;
    }
    // 粗い外接矩形同士で早めに弾く
    let b = stroke.bounds(thr);
    let (mut px0, mut py0, mut px1, mut py1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for &(x, y) in &pp {
        px0 = px0.min(x);
        py0 = py0.min(y);
        px1 = px1.max(x);
        py1 = py1.max(y);
    }
    if px1 < b.x as f32 || py1 < b.y as f32 || px0 > b.right() as f32 || py0 > b.bottom() as f32 {
        return hit;
    }
    for i in 0..n {
        let (x, y) = stroke.point(i);
        // 点 対 経路の線分
        let mut h = false;
        if pp.len() == 1 {
            h = ((x - pp[0].0).powi(2) + (y - pp[0].1).powi(2)).sqrt() <= thr;
        } else {
            for w in pp.windows(2) {
                if dist_point_seg(x, y, w[0].0, w[0].1, w[1].0, w[1].1) <= thr {
                    h = true;
                    break;
                }
            }
        }
        if h {
            hit[i] = true;
            continue;
        }
        // 線の線分 対 経路の点(入力が疎なとき)
        if i + 1 < n {
            let (bx, by) = stroke.point(i + 1);
            for &(ex, ey) in &pp {
                if dist_point_seg(ex, ey, x, y, bx, by) <= thr {
                    hit[i] = true;
                    hit[i + 1] = true;
                    break;
                }
            }
        }
    }
    hit
}

/// 点 i..=j を切り出した断片。切った端は入り抜きを消す(途中で急に細くならないように)。
fn piece(stroke: &VStroke, i: usize, j: usize) -> VStroke {
    let mut s = VStroke {
        brush: stroke.brush.clone(),
        color: stroke.color,
        points: stroke.points[i * VPOINT..(j + 1) * VPOINT].to_vec(),
    };
    if i > 0 {
        s.set_brush_number("taper_in", 0.0);
    }
    if j + 1 < stroke.len() {
        s.set_brush_number("taper_out", 0.0);
    }
    s
}

/// 印の付いていない区間を断片にする(2 点以上のものだけ)。
fn split_by_hits(stroke: &VStroke, hit: &[bool]) -> Vec<VStroke> {
    let mut out = Vec::new();
    let mut start: Option<usize> = None;
    for (i, &h) in hit.iter().enumerate() {
        match (h, start) {
            (false, None) => start = Some(i),
            (true, Some(s)) => {
                if i - s >= 2 {
                    out.push(piece(stroke, s, i - 1));
                }
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        if hit.len() - s >= 2 {
            out.push(piece(stroke, s, hit.len() - 1));
        }
    }
    out
}

/// 交点まで消す: 触れた点の両側へ辿り、他の線(または自分の離れた区間)と交わる線分で止める。
/// 戻り値は残す断片。
fn cut_to_intersections(strokes: &[VStroke], idx: usize, hit: &[bool]) -> Vec<VStroke> {
    let s = &strokes[idx];
    let n = s.len();
    let Some(first) = hit.iter().position(|&h| h) else { return vec![s.clone()] };
    let last = hit.iter().rposition(|&h| h).unwrap_or(first);
    // 相手の線分(外接矩形で絞る)
    let b = s.bounds(1.0);
    let mut segs: Vec<[f32; 4]> = Vec::new();
    for (k, o) in strokes.iter().enumerate() {
        if k == idx {
            continue;
        }
        if o.bounds(1.0).intersect(&b).is_empty() {
            continue;
        }
        for i in 0..o.len().saturating_sub(1) {
            let (ax, ay) = o.point(i);
            let (bx, by) = o.point(i + 1);
            segs.push([ax, ay, bx, by]);
        }
    }
    let crosses = |i: usize| -> Option<f32> {
        // 線分 i(点 i → i+1)が相手と交わるか。自分自身は 2 つ以上離れた線分だけ
        let (ax, ay) = s.point(i);
        let (bx, by) = s.point(i + 1);
        let mut best: Option<f32> = None;
        for sg in &segs {
            if let Some(t) = seg_intersect(ax, ay, bx, by, sg[0], sg[1], sg[2], sg[3]) {
                best = Some(best.map_or(t, |b: f32| b.min(t)));
            }
        }
        for j in 0..n.saturating_sub(1) {
            if j + 1 < i.saturating_sub(1) || j > i + 2 {
                let (cx, cy) = s.point(j);
                let (dx, dy) = s.point(j + 1);
                if let Some(t) = seg_intersect(ax, ay, bx, by, cx, cy, dx, dy) {
                    best = Some(best.map_or(t, |b: f32| b.min(t)));
                }
            }
        }
        best
    };
    let mut out = Vec::new();
    // 後ろ向き: first から 0 へ。交わる線分 i があれば、点 0..=i と交点までを残す
    let mut i = first;
    let mut head: Option<(usize, f32)> = None;
    while i > 0 {
        i -= 1;
        if let Some(t) = crosses(i) {
            // 交点に近い側(t が大きい = 点 i+1 寄り)。最も遠い交点を取るため、点 i からの最大 t を探し直す
            let (ax, ay) = s.point(i);
            let (bx, by) = s.point(i + 1);
            let mut tmax = t;
            for sg in &segs {
                if let Some(t2) = seg_intersect(ax, ay, bx, by, sg[0], sg[1], sg[2], sg[3]) {
                    tmax = tmax.max(t2);
                }
            }
            head = Some((i, tmax));
            break;
        }
    }
    if let Some((i, t)) = head {
        let mut p = piece(s, 0, i);
        p.points.extend_from_slice(&lerp_point(s, i, t));
        p.set_brush_number("taper_out", 0.0);
        out.push(p);
    }
    // 前向き: last から n-1 へ
    let mut j = last;
    let mut tail: Option<(usize, f32)> = None;
    while j + 1 < n {
        if let Some(t) = crosses(j) {
            tail = Some((j, t));
            break;
        }
        j += 1;
    }
    if let Some((j, t)) = tail {
        let mut pts = lerp_point(s, j, t).to_vec();
        pts.extend_from_slice(&s.points[(j + 1) * VPOINT..]);
        let mut p = VStroke {
            brush: s.brush.clone(),
            color: s.color,
            points: pts,
        };
        p.set_brush_number("taper_in", 0.0);
        if p.len() >= 2 {
            out.push(p);
        }
    }
    out
}

fn lerp_point(s: &VStroke, i: usize, t: f32) -> [f32; VPOINT] {
    let a = &s.points[i * VPOINT..(i + 1) * VPOINT];
    let b = &s.points[(i + 1) * VPOINT..(i + 2) * VPOINT];
    let mut out = [0.0; VPOINT];
    for k in 0..VPOINT {
        out[k] = a[k] + (b[k] - a[k]) * t;
    }
    out
}

/// 消しゴムを掛けた結果。`range` の線を `replaced` に置き換える。
pub struct EraseResult {
    pub range: std::ops::Range<usize>,
    pub replaced: Vec<VStroke>,
    /// 描き直しが要る範囲(消えた線の描画範囲)
    pub dirty: Rect,
}

/// 経路(VPOINT ずつ)で消す。何も触れなければ None。
pub fn erase(strokes: &[VStroke], path: &[f32], radius: f32, mode: EraseMode) -> Option<EraseResult> {
    let mut affected: Vec<(usize, Vec<VStroke>)> = Vec::new();
    let mut dirty: Option<Rect> = None;
    for (idx, s) in strokes.iter().enumerate() {
        let thr = radius + s.size();
        let hit = hits(s, path, thr);
        if !hit.iter().any(|&h| h) {
            continue;
        }
        let pieces = match mode {
            EraseMode::Normal => split_by_hits(s, &hit),
            EraseMode::Touch => Vec::new(),
            EraseMode::Intersect => cut_to_intersections(strokes, idx, &hit),
        };
        let pb = s.paint_bounds();
        dirty = Some(dirty.map_or(pb, |d| d.union(&pb)));
        affected.push((idx, pieces));
    }
    let first = affected.first()?.0;
    let last = affected.last()?.0;
    let mut replaced = Vec::new();
    let mut ai = 0;
    for idx in first..=last {
        if ai < affected.len() && affected[ai].0 == idx {
            replaced.extend(affected[ai].1.drain(..));
            ai += 1;
        } else {
            replaced.push(strokes[idx].clone());
        }
    }
    Some(EraseResult {
        range: first..last + 1,
        replaced,
        dirty: dirty?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(x0: f32, y0: f32, x1: f32, y1: f32, n: usize) -> VStroke {
        let mut points = Vec::new();
        for i in 0..n {
            let t = i as f32 / (n - 1) as f32;
            points.extend_from_slice(&[x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1.0, i as f32 * 8.0, 0.0, 0.0]);
        }
        VStroke {
            brush: r#"{"size":2,"taper_in":10,"taper_out":10}"#.into(),
            color: [0, 0, 0],
            points,
        }
    }

    #[test]
    fn stamp_matches_shader_shape() {
        let mut b = DabBuf::new(Rect::new(0, 0, 32, 32));
        // 半径 6、不透明、硬さ 1 の円を中心 (16, 16) に
        let dabs = [16.0, 16.0, 6.0, 1.0, 0.0, 1.0, 0.0, 0.0];
        b.stamp(&dabs, 1.0);
        let px = |x: usize, y: usize| b.data[(y * 32 + x) * 4 + 3];
        assert_eq!(px(16, 16), 255, "中心は不透明");
        assert_eq!(px(16, 2), 0, "遠くは透明");
        assert!(px(16, 11) > 200, "半径の内側 {}", px(16, 11));
        assert!(px(16, 21) > 0 && px(16, 21) < 255, "縁は AA {}", px(16, 21));
        assert_eq!(px(16, 23), 0, "半径の外");
        // 細い線: 半径 0.25 でも点になる(面積補正で薄く)
        let mut t = DabBuf::new(Rect::new(0, 0, 8, 8));
        t.stamp(&[4.5, 4.5, 0.25, 1.0, 0.0, 1.0, 0.0, 0.0], 1.0);
        let a = t.data[(4 * 8 + 4) * 4 + 3];
        assert!(a > 0 && a < 60, "{a}");
        // 色
        let mut c = DabBuf::new(Rect::new(0, 0, 8, 8));
        c.stamp(&[4.0, 4.0, 3.0, 1.0, 0.0, 1.0, 200.0 * 65536.0 + 100.0 * 256.0 + 50.0, 0.0], 1.0);
        assert_eq!(&c.data[(4 * 8 + 4) * 4..(4 * 8 + 4) * 4 + 4], &[200, 100, 50, 255]);
    }

    #[test]
    fn erase_normal_splits_touch_removes() {
        let s = vec![line(0.0, 50.0, 100.0, 50.0, 21)];
        let path = [50.0, 40.0, 1.0, 0.0, 0.0, 0.0, 50.0, 60.0, 1.0, 8.0, 0.0, 0.0];
        let r = erase(&s, &path, 3.0, EraseMode::Normal).unwrap();
        assert_eq!(r.range, 0..1);
        assert_eq!(r.replaced.len(), 2, "真ん中を切ると 2 本");
        assert!(r.replaced[0].brush_number("taper_out") == Some(0.0));
        assert!(r.replaced[0].brush_number("taper_in") == Some(10.0));
        assert!(r.replaced[1].brush_number("taper_in") == Some(0.0));
        let t = erase(&s, &path, 3.0, EraseMode::Touch).unwrap();
        assert!(t.replaced.is_empty());
        assert!(erase(&s, &[50.0, 0.0, 1.0, 0.0, 0.0, 0.0], 3.0, EraseMode::Normal).is_none(), "触れていない");
    }

    #[test]
    fn erase_to_intersections() {
        // 横線を縦線 2 本が x=30 と x=70 で横切る。x=50 で触ると 30..70 だけ消える
        let s = vec![
            line(0.0, 50.0, 100.0, 50.0, 41),
            line(30.0, 0.0, 30.0, 100.0, 5),
            line(70.0, 0.0, 70.0, 100.0, 5),
        ];
        let path = [50.0, 50.0, 1.0, 0.0, 0.0, 0.0];
        let r = erase(&s, &path, 1.0, EraseMode::Intersect).unwrap();
        assert_eq!(r.range, 0..1);
        assert_eq!(r.replaced.len(), 2, "{:?}", r.replaced.iter().map(|p| p.len()).collect::<Vec<_>>());
        let a = &r.replaced[0];
        let b = &r.replaced[1];
        let (ax, _) = a.point(a.len() - 1);
        let (bx, _) = b.point(0);
        assert!((ax - 30.0).abs() < 0.01, "{ax}");
        assert!((bx - 70.0).abs() < 0.01, "{bx}");
    }

    #[test]
    fn bounds_and_transform() {
        let mut s = line(10.0, 20.0, 30.0, 40.0, 3);
        let b = s.bounds(0.0);
        assert_eq!((b.x, b.y), (10, 20));
        assert!(b.right() >= 30 && b.bottom() >= 40);
        s.translate(5.0, 5.0);
        assert_eq!(s.point(0), (15.0, 25.0));
        s.scale(2.0, 2.0);
        assert_eq!(s.point(0), (30.0, 50.0));
        assert!((s.size() - 4.0).abs() < 1e-5);
    }
}
