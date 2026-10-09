//! 筆圧カーブ。生の筆圧値をサイズ・不透明度へマッピングする前段の変換。

/// ガンマカーブによる筆圧変換。
/// gamma > 1.0 で「軽いタッチでは細く、押し込むと急に太くなる」硬めの立ち上がり、
/// gamma < 1.0 で柔らかい立ち上がりになる。SAI の筆圧設定に相当する。
#[derive(Clone, Copy, Debug)]
pub struct PressureCurve {
    pub gamma: f32,
}

impl PressureCurve {
    pub fn new(gamma: f32) -> Self {
        Self {
            gamma: gamma.max(0.05),
        }
    }

    pub fn apply(&self, pressure: f32) -> f32 {
        pressure.clamp(0.0, 1.0).powf(self.gamma)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoints_are_preserved() {
        for gamma in [0.5, 1.0, 2.0] {
            let c = PressureCurve::new(gamma);
            assert_eq!(c.apply(0.0), 0.0);
            assert_eq!(c.apply(1.0), 1.0);
        }
    }

    #[test]
    fn gamma_above_one_softens_midtones() {
        let c = PressureCurve::new(2.0);
        assert!(c.apply(0.5) < 0.5);
    }

    #[test]
    fn monotonically_increasing() {
        let c = PressureCurve::new(1.4);
        let mut prev = -1.0f32;
        for i in 0..=100 {
            let v = c.apply(i as f32 / 100.0);
            assert!(v >= prev);
            prev = v;
        }
    }

    #[test]
    fn out_of_range_input_is_clamped() {
        let c = PressureCurve::new(1.0);
        assert_eq!(c.apply(-0.5), 0.0);
        assert_eq!(c.apply(1.5), 1.0);
    }
}
