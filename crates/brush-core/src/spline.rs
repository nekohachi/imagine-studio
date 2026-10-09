//! Catmull-Rom スプラインによる入力補間。
//!
//! タッチ/ペンイベントは 60〜240Hz でしか届かないため、速い線では点の間隔が
//! 大きく開く。点をそのまま直線で結ぶとカクつくので、Catmull-Rom スプライン
//! (全制御点を必ず通る)で滑らかに補間し、密なポリラインへ変換する。

use crate::PolyPoint;
use std::collections::VecDeque;

/// Catmull-Rom 補間(centripetal ではなく uniform 版。
/// 手描き入力は点間隔が比較的均一なため uniform で十分滑らか)。
pub fn catmull_rom(p0: PolyPoint, p1: PolyPoint, p2: PolyPoint, p3: PolyPoint, t: f32) -> PolyPoint {
    let t2 = t * t;
    let t3 = t2 * t;
    let w0 = -0.5 * t3 + t2 - 0.5 * t;
    let w1 = 1.5 * t3 - 2.5 * t2 + 1.0;
    let w2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
    let w3 = 0.5 * t3 - 0.5 * t2;
    PolyPoint {
        x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
        y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
        pressure: (w0 * p0.pressure + w1 * p1.pressure + w2 * p2.pressure + w3 * p3.pressure)
            .clamp(0.0, 1.0),
    }
}

/// 逐次スプラインサンプラー。
/// 点を 1 つずつ受け取り、確定した区間(1〜2 点遅れ)を密なポリラインとして返す。
/// ストローク中のリアルタイム描画に使えるよう、まとめてではなく逐次動作する。
pub struct SplineSampler {
    window: VecDeque<PolyPoint>,
    /// 補間出力の最大間隔 (px)。小さいほど滑らかだがスタンプ生成の負荷が上がる
    max_step: f32,
}

impl SplineSampler {
    pub fn new(max_step: f32) -> Self {
        Self {
            window: VecDeque::with_capacity(4),
            max_step: max_step.max(0.1),
        }
    }

    /// 点を追加し、新たに確定したポリライン点列を返す。
    pub fn push(&mut self, p: PolyPoint) -> Vec<PolyPoint> {
        self.window.push_back(p);
        match self.window.len() {
            1 => vec![p], // 始点は即確定
            2 => vec![],  // 次の点が来るまで保留
            3 => {
                // [a, b, c]: 始点側は a を複製して a→b 区間を確定
                let a = self.window[0];
                let b = self.window[1];
                let c = self.window[2];
                self.sample_segment(a, a, b, c)
            }
            _ => {
                // [a, b, c, d]: 中央区間 b→c を確定し、窓を 1 つ進める
                let a = self.window[0];
                let b = self.window[1];
                let c = self.window[2];
                let d = self.window[3];
                let out = self.sample_segment(a, b, c, d);
                self.window.pop_front();
                out
            }
        }
    }

    /// ストローク終端。終点を複製して残りの区間を確定する。
    pub fn finish(&mut self) -> Vec<PolyPoint> {
        let out = match self.window.len() {
            2 => {
                let a = self.window[0];
                let b = self.window[1];
                self.sample_segment(a, a, b, b)
            }
            3 => {
                let a = self.window[0];
                let b = self.window[1];
                let c = self.window[2];
                self.sample_segment(a, b, c, c)
            }
            _ => vec![],
        };
        self.window.clear();
        out
    }

    /// p1→p2 区間を弧長に応じた分割数でサンプリングする(t=0 は前区間の
    /// 終端と重複するため含めない)。
    fn sample_segment(
        &self,
        p0: PolyPoint,
        p1: PolyPoint,
        p2: PolyPoint,
        p3: PolyPoint,
    ) -> Vec<PolyPoint> {
        let chord = ((p2.x - p1.x).powi(2) + (p2.y - p1.y).powi(2)).sqrt();
        let n = (chord / self.max_step).ceil().max(1.0) as usize;
        (1..=n)
            .map(|i| catmull_rom(p0, p1, p2, p3, i as f32 / n as f32))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pt(x: f32, y: f32) -> PolyPoint {
        PolyPoint { x, y, pressure: 1.0 }
    }

    #[test]
    fn curve_passes_through_control_points() {
        let (p0, p1, p2, p3) = (pt(0.0, 0.0), pt(10.0, 0.0), pt(20.0, 10.0), pt(30.0, 10.0));
        let at0 = catmull_rom(p0, p1, p2, p3, 0.0);
        let at1 = catmull_rom(p0, p1, p2, p3, 1.0);
        assert!((at0.x - p1.x).abs() < 1e-4 && (at0.y - p1.y).abs() < 1e-4);
        assert!((at1.x - p2.x).abs() < 1e-4 && (at1.y - p2.y).abs() < 1e-4);
    }

    #[test]
    fn sampler_emits_first_point_immediately() {
        let mut s = SplineSampler::new(2.0);
        let out = s.push(pt(5.0, 5.0));
        assert_eq!(out, vec![pt(5.0, 5.0)]);
    }

    #[test]
    fn straight_line_stays_straight_and_dense() {
        let mut s = SplineSampler::new(2.0);
        let mut all = vec![];
        for i in 0..6 {
            all.extend(s.push(pt(i as f32 * 20.0, 0.0)));
        }
        all.extend(s.finish());
        // 直線入力なら補間結果も直線上にある
        for p in &all {
            assert!(p.y.abs() < 1e-3, "y ずれ: {:?}", p);
        }
        // 終点まで到達している
        let last = all.last().unwrap();
        assert!((last.x - 100.0).abs() < 1e-3);
        // おおむね max_step 以下に分割されている(始端区間はスプラインの
        // パラメータ速度が一定でないため 2 割程度の超過を許容する)
        for w in all.windows(2) {
            let d = ((w[1].x - w[0].x).powi(2) + (w[1].y - w[0].y).powi(2)).sqrt();
            assert!(d <= 2.0 * 1.25, "間隔が粗い: {}", d);
        }
    }

    #[test]
    fn two_point_stroke_reaches_endpoint() {
        let mut s = SplineSampler::new(2.0);
        let mut all = s.push(pt(0.0, 0.0));
        all.extend(s.push(pt(10.0, 0.0)));
        all.extend(s.finish());
        let last = all.last().unwrap();
        assert!((last.x - 10.0).abs() < 1e-3);
    }

    #[test]
    fn pressure_is_interpolated_within_range() {
        let mut s = SplineSampler::new(1.0);
        let mut all = vec![];
        for (i, pr) in [0.0f32, 0.3, 0.8, 1.0].iter().enumerate() {
            all.extend(s.push(PolyPoint {
                x: i as f32 * 30.0,
                y: 0.0,
                pressure: *pr,
            }));
        }
        all.extend(s.finish());
        for p in &all {
            assert!((0.0..=1.0).contains(&p.pressure));
        }
        // 筆圧はおおむね単調に増える(オーバーシュートは clamp 済み)
        assert!(all.last().unwrap().pressure > all.first().unwrap().pressure);
    }
}
