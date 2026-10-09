//! ストロークエンジン。移動平均 → ひも → スプライン補間 → ダブ生成を束ね、
//! 「生入力を入れるとダブが出てくる」1 本のパイプラインとして提供する。

use std::collections::VecDeque;

use crate::brush::BrushDef;
use crate::spline::SplineSampler;
use crate::stabilizer::Stabilizer;
use crate::stamper::Stamper;
use crate::{InputPoint, PolyPoint, Stamp};

/// 位置の移動平均(軽い補正)。ひもの前段。
struct MovingAverage {
    n: usize,
    buf: VecDeque<(f32, f32)>,
}

impl MovingAverage {
    fn new(n: u32) -> Self {
        Self {
            n: n as usize,
            buf: VecDeque::new(),
        }
    }
    fn feed(&mut self, x: f32, y: f32) -> (f32, f32) {
        if self.n < 2 {
            return (x, y);
        }
        self.buf.push_back((x, y));
        while self.buf.len() > self.n {
            self.buf.pop_front();
        }
        let k = self.buf.len() as f32;
        let (sx, sy) = self.buf.iter().fold((0.0, 0.0), |a, p| (a.0 + p.0, a.1 + p.1));
        (sx / k, sy / k)
    }
}

pub struct StrokeEngine {
    smoother: MovingAverage,
    stabilizer: Stabilizer,
    sampler: SplineSampler,
    stamper: Stamper,
    last_raw: Option<InputPoint>,
    last_pushed: Option<PolyPoint>,
    speed: f32,
    active: bool,
}

impl StrokeEngine {
    /// ストロークを開始する。
    pub fn begin(def: &BrushDef) -> Self {
        // 補間の細かさはブラシ半径に応じて決める(細いブラシほど細かく)
        let max_step = (def.size * 0.25).clamp(0.75, 3.0);
        Self {
            smoother: MovingAverage::new(def.smoothing),
            stabilizer: Stabilizer::new(def.stabilizer),
            sampler: SplineSampler::new(max_step),
            stamper: Stamper::new(def.clone()),
            last_raw: None,
            last_pushed: None,
            speed: 0.0,
            active: true,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// 生入力を 1 点与え、新たに描くべきダブ列を返す。
    pub fn add_point(&mut self, p: InputPoint) -> Vec<Stamp> {
        debug_assert!(self.active, "finish 後の add_point");
        if let Some(prev) = self.last_raw {
            let dt = (p.time - prev.time) as f32;
            if dt > 1e-4 {
                let d = ((p.x - prev.x).powi(2) + (p.y - prev.y).powi(2)).sqrt();
                // 速度は暴れるので EMA で均す
                self.speed += (d / dt - self.speed) * 0.5;
            }
        }
        self.last_raw = Some(p);
        let (mx, my) = self.smoother.feed(p.x, p.y);
        let (sx, sy) = self.stabilizer.feed(mx, my);
        self.push_poly(PolyPoint {
            x: sx,
            y: sy,
            pressure: p.pressure,
            tilt_x: p.tilt_x,
            tilt_y: p.tilt_y,
            speed: self.speed,
        })
    }

    /// ストロークを終了し、残りのダブ列を返す。
    /// ひもの遅れを実ペン位置まで詰め、スプラインの未確定区間と抜きの保留を flush する。
    pub fn finish(&mut self) -> Vec<Stamp> {
        self.active = false;
        let mut out = vec![];
        if let Some(raw) = self.last_raw {
            let (x, y) = self.stabilizer.drain(raw.x, raw.y);
            out.extend(self.push_poly(PolyPoint {
                x,
                y,
                pressure: raw.pressure,
                tilt_x: raw.tilt_x,
                tilt_y: raw.tilt_y,
                speed: self.speed,
            }));
        }
        let tail = self.sampler.finish();
        for pt in tail {
            self.stamper.feed(pt, &mut out);
        }
        self.stamper.finish(&mut out);
        out
    }

    fn push_poly(&mut self, p: PolyPoint) -> Vec<Stamp> {
        // スタビライザーの不感帯内では同一座標が連続する。
        // ゼロ長セグメントをスプラインに入れると折り返しノイズになるため捨てる。
        if let Some(last) = self.last_pushed {
            let d2 = (p.x - last.x).powi(2) + (p.y - last.y).powi(2);
            if d2 < 0.01 {
                return vec![];
            }
        }
        self.last_pushed = Some(p);
        let mut out = vec![];
        for pt in self.sampler.push(p) {
            self.stamper.feed(pt, &mut out);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::brush::Curve;

    fn input(x: f32, y: f32, pressure: f32, time: f64) -> InputPoint {
        InputPoint::new(x, y, pressure, time)
    }

    fn def(stabilizer: f32) -> BrushDef {
        BrushDef {
            size: 8.0,
            spacing: 0.25,
            size_min: 0.1,
            pressure_size: Curve::linear(),
            stabilizer,
            ..BrushDef::default()
        }
    }

    #[test]
    fn tap_produces_a_dot() {
        let mut e = StrokeEngine::begin(&def(0.0));
        let mut stamps = e.add_point(input(100.0, 100.0, 0.8, 0.0));
        stamps.extend(e.finish());
        assert!(!stamps.is_empty());
        assert_eq!((stamps[0].x, stamps[0].y), (100.0, 100.0));
    }

    #[test]
    fn straight_stroke_covers_full_length() {
        let mut e = StrokeEngine::begin(&def(0.0));
        let mut stamps = vec![];
        for i in 0..=10 {
            stamps.extend(e.add_point(input(i as f32 * 10.0, 50.0, 1.0, i as f64 * 0.008)));
        }
        stamps.extend(e.finish());
        let first = stamps.first().unwrap();
        let last = stamps.last().unwrap();
        assert!((first.x - 0.0).abs() < 0.5);
        assert!((last.x - 100.0).abs() < 1.0, "終点未到達: {:?}", last);
        for s in &stamps {
            assert!((s.y - 50.0).abs() < 0.5);
        }
    }

    #[test]
    fn stabilized_stroke_still_reaches_endpoint() {
        let mut e = StrokeEngine::begin(&def(16.0));
        let mut stamps = vec![];
        for i in 0..=10 {
            stamps.extend(e.add_point(input(i as f32 * 10.0, 0.0, 1.0, i as f64 * 0.008)));
        }
        stamps.extend(e.finish());
        let last = stamps.last().unwrap();
        assert!((last.x - 100.0).abs() < 1.0, "終点未到達: {:?}", last);
    }

    #[test]
    fn stabilizer_and_smoothing_flatten_jittery_line() {
        let jitter = |i: usize| -> f32 { if i % 2 == 0 { 6.0 } else { -6.0 } };
        let max_dev = |d: BrushDef| -> f32 {
            let mut e = StrokeEngine::begin(&d);
            let mut stamps = vec![];
            for i in 0..=30 {
                stamps.extend(e.add_point(input(i as f32 * 4.0, 100.0 + jitter(i), 1.0, i as f64 * 0.008)));
            }
            stamps.extend(e.finish());
            stamps
                .iter()
                .filter(|s| s.x > 20.0 && s.x < 100.0)
                .map(|s| (s.y - 100.0).abs())
                .fold(0.0f32, f32::max)
        };
        let raw_dev = max_dev(def(0.0));
        let rope_dev = max_dev(def(12.0));
        let avg_dev = max_dev(BrushDef {
            smoothing: 4,
            ..def(0.0)
        });
        assert!(rope_dev < raw_dev * 0.5, "ひも: raw={raw_dev} stabilized={rope_dev}");
        assert!(avg_dev < raw_dev * 0.5, "移動平均: raw={raw_dev} avg={avg_dev}");
    }

    #[test]
    fn pressure_variation_changes_stamp_radius() {
        let mut e = StrokeEngine::begin(&def(0.0));
        let mut stamps = vec![];
        for i in 0..=10 {
            let pressure = i as f32 / 10.0;
            stamps.extend(e.add_point(input(i as f32 * 10.0, 0.0, pressure, i as f64 * 0.008)));
        }
        stamps.extend(e.finish());
        let r_first = stamps.first().unwrap().radius;
        let r_max = stamps.iter().map(|s| s.radius).fold(0.0f32, f32::max);
        assert!(r_max > r_first * 2.0, "筆圧が半径に反映されていない");
    }

    #[test]
    fn speed_is_estimated_from_time() {
        let mut e = StrokeEngine::begin(&def(0.0));
        for i in 0..=5 {
            e.add_point(input(i as f32 * 100.0, 0.0, 1.0, i as f64 * 0.01));
        }
        // 100px / 10ms = 10000 px/s に近づく
        assert!(e.speed > 5000.0, "{}", e.speed);
    }
}
