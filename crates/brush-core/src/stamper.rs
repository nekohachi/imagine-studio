//! スタンプ生成。補間済みポリラインに沿って、等間隔にブラシチップを配置する。

use crate::pressure::PressureCurve;
use crate::{BrushParams, PolyPoint, Stamp};

/// ポリラインを受け取り、spacing 間隔でスタンプを発行する。
/// セグメント境界をまたいでも間隔が保たれるよう、残距離を持ち越す。
pub struct Stamper {
    params: BrushParams,
    curve: PressureCurve,
    /// 前回スタンプからの累積距離
    since_last: f32,
    last: Option<PolyPoint>,
}

impl Stamper {
    pub fn new(params: BrushParams) -> Self {
        Self {
            params,
            curve: PressureCurve::new(params.pressure_gamma),
            since_last: 0.0,
            last: None,
        }
    }

    /// 現在の筆圧からスタンプ半径を求める。
    fn radius_at(&self, pressure: f32) -> f32 {
        let p = self.curve.apply(pressure);
        let r = self.params.min_radius_ratio + (1.0 - self.params.min_radius_ratio) * p;
        (self.params.radius * r).max(0.1)
    }

    /// 現在の筆圧からスタンプ不透明度を求める。
    fn opacity_at(&self, pressure: f32) -> f32 {
        let p = self.curve.apply(pressure);
        let pressure_term = 1.0 + (p - 1.0) * self.params.pressure_affects_opacity;
        (self.params.flow * pressure_term).clamp(0.0, 1.0)
    }

    fn stamp_at(&self, p: &PolyPoint) -> Stamp {
        Stamp {
            x: p.x,
            y: p.y,
            radius: self.radius_at(p.pressure),
            opacity: self.opacity_at(p.pressure),
        }
    }

    /// ポリライン点を 1 つ進め、発行すべきスタンプを out に追加する。
    pub fn feed(&mut self, p: PolyPoint, out: &mut Vec<Stamp>) {
        let Some(last) = self.last else {
            // ストローク先頭: 必ず 1 発打つ(タップで点が打てること)
            out.push(self.stamp_at(&p));
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

        // セグメント上を歩き、spacing 距離ごとにスタンプを置く。
        // spacing はその地点の筆圧半径に比例(細い線ほど細かく打つ)。
        let mut traveled = 0.0f32;
        loop {
            let t_here = traveled / seg_len;
            let pressure_here = last.pressure + (p.pressure - last.pressure) * t_here;
            let spacing = (self.params.spacing * self.radius_at(pressure_here)).max(0.5);
            let need = spacing - self.since_last;
            if traveled + need > seg_len {
                self.since_last += seg_len - traveled;
                break;
            }
            traveled += need;
            self.since_last = 0.0;
            let t = traveled / seg_len;
            let sp = PolyPoint {
                x: last.x + dx * t,
                y: last.y + dy * t,
                pressure: last.pressure + (p.pressure - last.pressure) * t,
            };
            out.push(self.stamp_at(&sp));
        }
        self.last = Some(p);
    }

    /// ストローク終端。終点にスタンプが乗っていなければ 1 発打って締める。
    pub fn finish(&mut self, out: &mut Vec<Stamp>) {
        if let Some(last) = self.last {
            if self.since_last > 0.25 {
                out.push(self.stamp_at(&last));
            }
        }
        self.last = None;
        self.since_last = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn params() -> BrushParams {
        BrushParams {
            radius: 10.0,
            spacing: 0.2,
            pressure_gamma: 1.0,
            min_radius_ratio: 0.0,
            ..Default::default()
        }
    }

    fn pt(x: f32, y: f32, pressure: f32) -> PolyPoint {
        PolyPoint { x, y, pressure }
    }

    #[test]
    fn first_point_always_stamps() {
        let mut s = Stamper::new(params());
        let mut out = vec![];
        s.feed(pt(50.0, 50.0, 1.0), &mut out);
        assert_eq!(out.len(), 1);
        assert_eq!((out[0].x, out[0].y), (50.0, 50.0));
    }

    #[test]
    fn stamps_are_evenly_spaced_on_straight_line() {
        let mut s = Stamper::new(params());
        let mut out = vec![];
        // 全筆圧 1.0 → spacing = 0.2 * 10px = 2px 固定
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
        let mut s = Stamper::new(params());
        let mut out = vec![];
        // 1px 刻みの細かい入力でも spacing(2px)ごとにしか打たれない
        for i in 0..=10 {
            s.feed(pt(i as f32, 0.0, 1.0), &mut out);
        }
        // 先頭 1 + 10px / 2px = 6 発
        assert_eq!(out.len(), 6, "{:?}", out);
    }

    #[test]
    fn pressure_scales_radius() {
        let s = Stamper::new(params());
        assert!((s.radius_at(1.0) - 10.0).abs() < 1e-4);
        assert!((s.radius_at(0.5) - 5.0).abs() < 1e-4);
    }

    #[test]
    fn zero_pressure_radius_is_clamped_positive() {
        let s = Stamper::new(params());
        assert!(s.radius_at(0.0) > 0.0);
    }

    #[test]
    fn finish_caps_the_stroke_end() {
        let mut s = Stamper::new(params());
        let mut out = vec![];
        s.feed(pt(0.0, 0.0, 1.0), &mut out);
        s.feed(pt(1.5, 0.0, 1.0), &mut out); // spacing 未満 → まだ 1 発
        assert_eq!(out.len(), 1);
        s.finish(&mut out);
        assert_eq!(out.len(), 2); // 終端で締めの 1 発
        assert_eq!(out.last().unwrap().x, 1.5);
    }
}
