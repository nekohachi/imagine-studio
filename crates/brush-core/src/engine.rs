//! ストロークエンジン。スタビライザー → スプライン補間 → スタンプ生成を束ね、
//! 「生入力を入れるとスタンプが出てくる」1 本のパイプラインとして提供する。

use crate::spline::SplineSampler;
use crate::stabilizer::Stabilizer;
use crate::stamper::Stamper;
use crate::{BrushParams, InputPoint, PolyPoint, Stamp};

pub struct StrokeEngine {
    stabilizer: Stabilizer,
    sampler: SplineSampler,
    stamper: Stamper,
    last_raw: Option<InputPoint>,
    last_pushed: Option<PolyPoint>,
    active: bool,
}

impl StrokeEngine {
    /// ストロークを開始する。
    /// `stabilizer_radius` は手ぶれ補正の強さ(px)。0 で補正なし。
    pub fn begin(params: BrushParams, stabilizer_radius: f32) -> Self {
        // 補間の細かさはブラシ半径に応じて決める(細いブラシほど細かく)
        let max_step = (params.radius * 0.25).clamp(0.75, 3.0);
        Self {
            stabilizer: Stabilizer::new(stabilizer_radius),
            sampler: SplineSampler::new(max_step),
            stamper: Stamper::new(params),
            last_raw: None,
            last_pushed: None,
            active: true,
        }
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    /// 生入力を 1 点与え、新たに描くべきスタンプ列を返す。
    pub fn add_point(&mut self, p: InputPoint) -> Vec<Stamp> {
        debug_assert!(self.active, "finish 後の add_point");
        self.last_raw = Some(p);
        let (sx, sy) = self.stabilizer.feed(p.x, p.y);
        self.push_poly(PolyPoint {
            x: sx,
            y: sy,
            pressure: p.pressure,
        })
    }

    /// ストロークを終了し、残りのスタンプ列を返す。
    /// スタビライザーの遅れを実ペン位置まで詰め、スプラインの未確定区間を flush する。
    pub fn finish(&mut self) -> Vec<Stamp> {
        self.active = false;
        let mut out = vec![];
        if let Some(raw) = self.last_raw {
            let (x, y) = self.stabilizer.drain(raw.x, raw.y);
            out.extend(self.push_poly(PolyPoint {
                x,
                y,
                pressure: raw.pressure,
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

    fn input(x: f32, y: f32, pressure: f32, time: f64) -> InputPoint {
        InputPoint { x, y, pressure, time }
    }

    fn params() -> BrushParams {
        BrushParams {
            radius: 8.0,
            spacing: 0.25,
            pressure_gamma: 1.0,
            min_radius_ratio: 0.1,
            ..Default::default()
        }
    }

    #[test]
    fn tap_produces_a_dot() {
        let mut e = StrokeEngine::begin(params(), 0.0);
        let mut stamps = e.add_point(input(100.0, 100.0, 0.8, 0.0));
        stamps.extend(e.finish());
        assert!(!stamps.is_empty());
        assert_eq!((stamps[0].x, stamps[0].y), (100.0, 100.0));
    }

    #[test]
    fn straight_stroke_covers_full_length() {
        let mut e = StrokeEngine::begin(params(), 0.0);
        let mut stamps = vec![];
        for i in 0..=10 {
            stamps.extend(e.add_point(input(i as f32 * 10.0, 50.0, 1.0, i as f64 * 0.008)));
        }
        stamps.extend(e.finish());
        let first = stamps.first().unwrap();
        let last = stamps.last().unwrap();
        assert!((first.x - 0.0).abs() < 0.5);
        assert!((last.x - 100.0).abs() < 1.0, "終点未到達: {:?}", last);
        // 全スタンプが直線上
        for s in &stamps {
            assert!((s.y - 50.0).abs() < 0.5);
        }
    }

    #[test]
    fn stabilized_stroke_still_reaches_endpoint() {
        let mut e = StrokeEngine::begin(params(), 16.0);
        let mut stamps = vec![];
        for i in 0..=10 {
            stamps.extend(e.add_point(input(i as f32 * 10.0, 0.0, 1.0, i as f64 * 0.008)));
        }
        stamps.extend(e.finish());
        // スタビライザーの遅れがあっても drain で終点まで届く
        let last = stamps.last().unwrap();
        assert!((last.x - 100.0).abs() < 1.0, "終点未到達: {:?}", last);
    }

    #[test]
    fn stabilizer_flattens_jittery_line() {
        // 上下 ±6px のジグザグ入力を、補正あり/なしで比較
        let jitter =
            |i: usize| -> f32 { if i % 2 == 0 { 6.0 } else { -6.0 } };

        let max_dev = |stab: f32| -> f32 {
            let mut e = StrokeEngine::begin(params(), stab);
            let mut stamps = vec![];
            for i in 0..=30 {
                stamps.extend(e.add_point(input(
                    i as f32 * 4.0,
                    100.0 + jitter(i),
                    1.0,
                    i as f64 * 0.008,
                )));
            }
            stamps.extend(e.finish());
            // 始点・終点は生のペン位置を必ず通る仕様のため、中間区間で比較する
            stamps
                .iter()
                .filter(|s| s.x > 20.0 && s.x < 100.0)
                .map(|s| (s.y - 100.0).abs())
                .fold(0.0f32, f32::max)
        };

        let raw_dev = max_dev(0.0);
        let stabilized_dev = max_dev(12.0);
        assert!(
            stabilized_dev < raw_dev * 0.5,
            "補正効果なし: raw={} stabilized={}",
            raw_dev,
            stabilized_dev
        );
    }

    #[test]
    fn pressure_variation_changes_stamp_radius() {
        let mut e = StrokeEngine::begin(params(), 0.0);
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
}
