//! 補間済みの点列から、間隔どおりにダブを打つ。
//! 筆圧カーブ、傾き、速度、入り抜き、散布はここで決める。

use std::collections::VecDeque;

use crate::brush::{AngleMode, BrushDef};
use crate::{PolyPoint, Stamp};

/// 速度を 0..1 に正規化するときの上限 (px/秒)
const FULL_SPEED: f32 = 2000.0;

/// 決定的な乱数(xorshift32)。同じ入力ログから同じ絵が出るように、ストロークごとに固定の種で始める。
#[derive(Clone, Copy, Debug)]
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        (x as f32) / (u32::MAX as f32)
    }
    /// -1..1
    fn signed(&mut self) -> f32 {
        self.next() * 2.0 - 1.0
    }
}

pub struct Stamper {
    def: BrushDef,
    since_last: f32,
    last: Option<PolyPoint>,
    /// ストローク開始からの距離
    traveled: f32,
    /// 進行方向(ラジアン)
    direction: f32,
    /// 抜きのために出力を遅らせているダブ(ダブ, その位置の距離)
    pending: VecDeque<(Stamp, f32)>,
    rng: Rng,
}

impl Stamper {
    pub fn new(def: BrushDef) -> Self {
        Self {
            def,
            since_last: 0.0,
            last: None,
            traveled: 0.0,
            direction: 0.0,
            pending: VecDeque::new(),
            rng: Rng(0x9E37_79B9),
        }
    }

    fn tilt_mag(p: &PolyPoint) -> f32 {
        ((p.tilt_x * p.tilt_x + p.tilt_y * p.tilt_y).sqrt() / 90.0).clamp(0.0, 1.0)
    }

    /// 筆圧・傾き・速度・入りから半径を決める(散布は含まない)。
    pub fn radius_at(&self, p: &PolyPoint, dist: f32) -> f32 {
        let d = &self.def;
        let pr = d.pressure_size.apply(p.pressure);
        let mut r = d.size * (d.size_min + (1.0 - d.size_min) * pr);
        if d.tilt_size > 0.0 {
            r *= 1.0 + Self::tilt_mag(p) * d.tilt_size;
        }
        if d.speed_size != 0.0 {
            let s = (p.speed / FULL_SPEED).clamp(0.0, 1.0);
            r *= (1.0 + d.speed_size * s).max(0.1);
        }
        if d.taper_in > 0.0 {
            r *= (dist / d.taper_in).clamp(0.0, 1.0).max(0.02);
        }
        r.max(0.05)
    }

    pub fn opacity_at(&self, p: &PolyPoint) -> f32 {
        let d = &self.def;
        let po = d.pressure_opacity.apply(p.pressure);
        (d.flow * (d.opacity_min + (1.0 - d.opacity_min) * po)).clamp(0.0, 1.0)
    }

    fn angle_aspect(&self, p: &PolyPoint) -> (f32, f32) {
        let d = &self.def;
        let mut aspect = d.roundness;
        let tilt = Self::tilt_mag(p);
        if d.tilt_flatten > 0.0 {
            aspect *= 1.0 - d.tilt_flatten * tilt * 0.85;
        }
        let angle = match d.angle {
            AngleMode::Fixed(deg) => deg.to_radians(),
            AngleMode::Direction => self.direction,
            AngleMode::Tilt => {
                if tilt > 0.02 {
                    p.tilt_y.atan2(p.tilt_x)
                } else {
                    self.direction
                }
            }
        };
        (angle, aspect.max(0.05))
    }

    fn stamp_at(&mut self, p: &PolyPoint, dist: f32) -> Stamp {
        let mut radius = self.radius_at(p, dist);
        let mut opacity = self.opacity_at(p);
        let (angle, aspect) = self.angle_aspect(p);
        let (mut x, mut y) = (p.x, p.y);
        let d = &self.def;
        if d.scatter_pos > 0.0 {
            let amp = d.scatter_pos * radius;
            x += self.rng.signed() * amp;
            y += self.rng.signed() * amp;
        }
        if d.scatter_size > 0.0 {
            radius *= 1.0 - d.scatter_size * self.rng.next();
        }
        if d.scatter_opacity > 0.0 {
            opacity *= 1.0 - d.scatter_opacity * self.rng.next();
        }
        Stamp {
            x,
            y,
            radius: radius.max(0.05),
            opacity,
            angle,
            aspect,
        }
    }

    /// 抜きがあるときは、終端から taper_out 以内のダブを保留する。
    fn emit(&mut self, s: Stamp, dist: f32, out: &mut Vec<Stamp>) {
        if self.def.taper_out <= 0.0 {
            out.push(s);
            return;
        }
        self.pending.push_back((s, dist));
        while let Some(&(front, d)) = self.pending.front() {
            if self.traveled - d > self.def.taper_out {
                out.push(front);
                self.pending.pop_front();
            } else {
                break;
            }
        }
    }

    pub fn feed(&mut self, p: PolyPoint, out: &mut Vec<Stamp>) {
        let Some(last) = self.last else {
            let s = self.stamp_at(&p, 0.0);
            self.emit(s, 0.0, out);
            self.last = Some(p);
            self.since_last = 0.0;
            return;
        };

        let dx = p.x - last.x;
        let dy = p.y - last.y;
        let seg_len = (dx * dx + dy * dy).sqrt();
        if seg_len <= f32::EPSILON {
            self.last = Some(p);
            return;
        }
        self.direction = dy.atan2(dx);
        let seg_start = self.traveled;

        let mut traveled = 0.0f32;
        loop {
            let t_here = traveled / seg_len;
            let here = lerp(&last, &p, t_here);
            let spacing = (self.def.spacing * self.radius_at(&here, seg_start + traveled)).max(0.25);
            let need = spacing - self.since_last;
            if traveled + need > seg_len {
                self.since_last += seg_len - traveled;
                break;
            }
            traveled += need;
            self.since_last = 0.0;
            let t = traveled / seg_len;
            let sp = lerp(&last, &p, t);
            let dist = seg_start + traveled;
            self.traveled = dist;
            let s = self.stamp_at(&sp, dist);
            self.emit(s, dist, out);
        }
        self.traveled = seg_start + seg_len;
        self.last = Some(p);
    }

    pub fn finish(&mut self, out: &mut Vec<Stamp>) {
        if let Some(last) = self.last {
            if self.since_last > 0.25 {
                let dist = self.traveled;
                let s = self.stamp_at(&last, dist);
                self.emit(s, dist, out);
            }
        }
        // 抜き: 終端からの距離で細くする
        let end = self.traveled;
        let taper = self.def.taper_out;
        for (mut s, d) in self.pending.drain(..) {
            if taper > 0.0 {
                let k = ((end - d) / taper).clamp(0.0, 1.0);
                s.radius = (s.radius * k).max(0.05);
            }
            out.push(s);
        }
        self.last = None;
        self.since_last = 0.0;
    }
}

fn lerp(a: &PolyPoint, b: &PolyPoint, t: f32) -> PolyPoint {
    PolyPoint {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        pressure: a.pressure + (b.pressure - a.pressure) * t,
        tilt_x: a.tilt_x + (b.tilt_x - a.tilt_x) * t,
        tilt_y: a.tilt_y + (b.tilt_y - a.tilt_y) * t,
        speed: a.speed + (b.speed - a.speed) * t,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Curve;

    fn def() -> BrushDef {
        BrushDef {
            size: 10.0,
            size_min: 0.0,
            spacing: 0.2,
            pressure_size: Curve::linear(),
            pressure_opacity: Curve::linear(),
            opacity_min: 1.0,
            ..BrushDef::default()
        }
    }

    fn pt(x: f32, y: f32, pressure: f32) -> PolyPoint {
        PolyPoint::new(x, y, pressure)
    }

    #[test]
    fn first_point_always_stamps() {
        let mut s = Stamper::new(def());
        let mut out = vec![];
        s.feed(pt(50.0, 50.0, 1.0), &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].x, out[0].y), (50.0, 50.0));
        assert_eq!(out[0].aspect, 1.0);
    }

    #[test]
    fn stamps_are_evenly_spaced_on_straight_line() {
        let mut s = Stamper::new(def());
        let mut out = vec![];
        for i in 0..=20 {
            s.feed(pt(i as f32 * 5.0, 0.0, 1.0), &mut out);
        }
        assert!(out.len() > 40, "スタンプ数が少なすぎる: {}", out.len());
        for w in out.windows(2) {
            let d = ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt();
            assert!((d - 2.0).abs() < 0.01, "間隔ずれ: {}", d);
        }
    }

    #[test]
    fn spacing_carries_across_segments() {
        let mut s = Stamper::new(def());
        let mut out = vec![];
        for i in 0..=10 {
            s.feed(pt(i as f32, 0.0, 1.0), &mut out);
        }
        assert_eq!(out.len(), 6, "{:?}", out);
    }

    #[test]
    fn pressure_scales_radius() {
        let s = Stamper::new(def());
        assert!((s.radius_at(&pt(0.0, 0.0, 1.0), 100.0) - 10.0).abs() < 1e-4);
        assert!((s.radius_at(&pt(0.0, 0.0, 0.5), 100.0) - 5.0).abs() < 1e-4);
        assert!(s.radius_at(&pt(0.0, 0.0, 0.0), 100.0) > 0.0);
    }

    #[test]
    fn finish_caps_the_stroke_end() {
        let mut s = Stamper::new(def());
        let mut out = vec![];
        s.feed(pt(0.0, 0.0, 1.0), &mut out);
        s.feed(pt(1.5, 0.0, 1.0), &mut out);
        assert_eq!(out.len(), 1);
        s.finish(&mut out);
        assert_eq!(out.len(), 2);
        assert_eq!(out.last().unwrap().x, 1.5);
    }

    #[test]
    fn taper_in_grows_and_taper_out_shrinks() {
        let mut s = Stamper::new(BrushDef {
            taper_in: 20.0,
            taper_out: 20.0,
            ..def()
        });
        let mut out = vec![];
        for i in 0..=50 {
            s.feed(pt(i as f32 * 2.0, 0.0, 1.0), &mut out);
        }
        // 抜きの分は保留されているので、終端近くはまだ出ていない
        assert!(out.last().unwrap().x < 100.0 - 20.0 + 2.5, "{:?}", out.last());
        s.finish(&mut out);
        let first = out.first().unwrap();
        let mid = out.iter().find(|s| (s.x - 50.0).abs() < 1.5).unwrap();
        let last = out.last().unwrap();
        assert!(first.radius < mid.radius * 0.3, "入りが効いていない {first:?} {mid:?}");
        assert!(last.radius < mid.radius * 0.3, "抜きが効いていない {last:?} {mid:?}");
        assert!((last.x - 100.0).abs() < 1.0, "終端まで届く {last:?}");
        // 半径は入りで単調に増え、抜きで単調に減る
        let rs: Vec<f32> = out.iter().map(|s| s.radius).collect();
        let peak = rs.iter().cloned().fold(0.0, f32::max);
        assert!((peak - 10.0).abs() < 1e-3);
    }

    #[test]
    fn tilt_flattens_and_direction_angle_follows_motion() {
        let mut s = Stamper::new(BrushDef {
            tilt_flatten: 1.0,
            angle: AngleMode::Direction,
            ..def()
        });
        let mut out = vec![];
        let mut p = pt(0.0, 0.0, 1.0);
        p.tilt_x = 60.0;
        s.feed(p, &mut out);
        let mut q = pt(0.0, 30.0, 1.0);
        q.tilt_x = 60.0;
        s.feed(q, &mut out);
        let st = out.last().unwrap();
        assert!(st.aspect < 0.6, "{st:?}");
        assert!((st.angle - std::f32::consts::FRAC_PI_2).abs() < 1e-3, "{st:?}");
    }

    #[test]
    fn scatter_is_deterministic() {
        let run = || {
            let mut s = Stamper::new(BrushDef {
                scatter_pos: 1.0,
                scatter_size: 0.5,
                ..def()
            });
            let mut out = vec![];
            for i in 0..=10 {
                s.feed(pt(i as f32 * 5.0, 0.0, 1.0), &mut out);
            }
            out
        };
        let a = run();
        let b = run();
        assert_eq!(a, b);
        assert!(a.iter().any(|s| s.y.abs() > 0.5), "散布が効いていない");
    }

    #[test]
    fn speed_size_thins_fast_strokes() {
        let s = Stamper::new(BrushDef {
            speed_size: -0.8,
            ..def()
        });
        let mut slow = pt(0.0, 0.0, 1.0);
        slow.speed = 0.0;
        let mut fast = pt(0.0, 0.0, 1.0);
        fast.speed = 5000.0;
        assert!(s.radius_at(&fast, 100.0) < s.radius_at(&slow, 100.0) * 0.5);
    }
}
