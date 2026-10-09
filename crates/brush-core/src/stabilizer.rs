//! 手ぶれ補正(スタビライザー)。
//!
//! SAI の「安定化」と同じ挙動の「ひも(rope)方式」を実装する。
//! 補正後の点はペン先から半径 `radius` の「ひも」で引きずられるイメージで、
//! ペン先が半径以内で揺れても線は動かず、半径を超えた分だけ引っ張られる。
//! 遅延を足さずに高周波の震えだけを落とせるのがこの方式の利点。

/// ひも方式スタビライザー。radius = 0 で補正なし(入力をそのまま返す)。
#[derive(Clone, Copy, Debug)]
pub struct Stabilizer {
    radius: f32,
    pos: Option<(f32, f32)>,
}

impl Stabilizer {
    pub fn new(radius: f32) -> Self {
        Self {
            radius: radius.max(0.0),
            pos: None,
        }
    }

    pub fn radius(&self) -> f32 {
        self.radius
    }

    /// 生のペン位置を与え、補正後の位置を返す。
    pub fn feed(&mut self, x: f32, y: f32) -> (f32, f32) {
        match self.pos {
            None => {
                self.pos = Some((x, y));
                (x, y)
            }
            Some((sx, sy)) => {
                let dx = x - sx;
                let dy = y - sy;
                let dist = (dx * dx + dy * dy).sqrt();
                if dist > self.radius && dist > f32::EPSILON {
                    let k = (dist - self.radius) / dist;
                    let nx = sx + dx * k;
                    let ny = sy + dy * k;
                    self.pos = Some((nx, ny));
                    (nx, ny)
                } else {
                    (sx, sy)
                }
            }
        }
    }

    /// ストローク終端処理。ひもの遅れ分を最終ペン位置まで詰める。
    /// ペンを離した位置まで線が届かないと「線が短くなる」違和感が出るため必須。
    pub fn drain(&mut self, x: f32, y: f32) -> (f32, f32) {
        self.pos = Some((x, y));
        (x, y)
    }

    pub fn reset(&mut self) {
        self.pos = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_point_passes_through() {
        let mut s = Stabilizer::new(10.0);
        assert_eq!(s.feed(100.0, 50.0), (100.0, 50.0));
    }

    #[test]
    fn jitter_within_radius_is_absorbed() {
        let mut s = Stabilizer::new(10.0);
        s.feed(100.0, 100.0);
        // 半径 10px 以内の揺れでは出力が一切動かない
        for (jx, jy) in [(103.0, 101.0), (98.0, 96.0), (105.0, 104.0)] {
            assert_eq!(s.feed(jx, jy), (100.0, 100.0));
        }
    }

    #[test]
    fn output_trails_pen_by_radius() {
        let mut s = Stabilizer::new(10.0);
        s.feed(0.0, 0.0);
        let (x, y) = s.feed(100.0, 0.0);
        // 出力はペン先から常に radius だけ遅れて追従する
        assert!((x - 90.0).abs() < 1e-4);
        assert!(y.abs() < 1e-4);
    }

    #[test]
    fn zero_radius_is_passthrough() {
        let mut s = Stabilizer::new(0.0);
        s.feed(0.0, 0.0);
        assert_eq!(s.feed(3.0, 4.0), (3.0, 4.0));
        assert_eq!(s.feed(-2.0, 7.0), (-2.0, 7.0));
    }

    #[test]
    fn drain_reaches_final_position() {
        let mut s = Stabilizer::new(20.0);
        s.feed(0.0, 0.0);
        s.feed(10.0, 0.0); // まだ動かない
        assert_eq!(s.drain(10.0, 0.0), (10.0, 0.0));
    }
}
