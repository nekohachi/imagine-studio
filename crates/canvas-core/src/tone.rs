//! トーン(網点化)。docs/06: 塗り(A8 のマスク)に非破壊で乗せる。線数、濃度、角度、形。
//! CPU(書き出し、下 / 上まとめ)と GPU(編集中レイヤーの表示)で同じ式を使う。

use serde::{Deserialize, Serialize};

use crate::tile::Rect;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Tone {
    /// 線数(lpi)
    pub lines: f32,
    /// 原稿の解像度(dpi)。線数と合わせて周期 px を決める
    pub dpi: f32,
    /// 濃度 0..1
    pub density: f32,
    /// 角度(度)
    pub angle: f32,
    /// 0 円(網点)、1 線、2 ノイズ(砂目)
    pub shape: u8,
}

impl Default for Tone {
    fn default() -> Self {
        Self {
            lines: 60.0,
            dpi: 600.0,
            density: 0.5,
            angle: 45.0,
            shape: 0,
        }
    }
}

fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0).max(1e-6)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn hash2(x: f32, y: f32) -> f32 {
    let v = (x * 127.1 + y * 311.7).sin() * 43758.547;
    v - v.floor()
}

impl Tone {
    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }

    pub fn sanitized(mut self) -> Self {
        self.lines = self.lines.clamp(5.0, 200.0);
        self.dpi = self.dpi.clamp(72.0, 1200.0);
        self.density = self.density.clamp(0.0, 1.0);
        self.shape = self.shape.min(2);
        self
    }

    /// 1 周期の px。
    pub fn period(&self) -> f32 {
        (self.dpi / self.lines.max(1.0)).max(1.0)
    }

    /// 画素 (x, y)(中心座標)の黒の濃さ 0..1。gl.ts の toneCoverage と同じ式。
    pub fn coverage(&self, x: f32, y: f32) -> f32 {
        let p = self.period();
        let (s, c) = self.angle.to_radians().sin_cos();
        let u = (c * x + s * y) / p;
        let v = (-s * x + c * y) / p;
        let aa = 0.5 / p;
        let d = self.density;
        match self.shape {
            1 => {
                let fv = (v - v.round()).abs();
                1.0 - smoothstep(d * 0.5 - aa, d * 0.5 + aa, fv)
            }
            2 => {
                let cu = (u * 4.0).floor();
                let cv = (v * 4.0).floor();
                if hash2(cu, cv) < d {
                    1.0
                } else {
                    0.0
                }
            }
            _ => {
                if d <= 0.5 {
                    let r = (d / std::f32::consts::PI).sqrt();
                    let fu = u - u.round();
                    let fv = v - v.round();
                    let dist = (fu * fu + fv * fv).sqrt();
                    1.0 - smoothstep(r - aa, r + aa, dist)
                } else {
                    // 50% を超えたら、黒地に白い穴(升目の角)
                    let r = ((1.0 - d) / std::f32::consts::PI).sqrt();
                    let fu = (u + 0.5) - (u + 0.5).round();
                    let fv = (v + 0.5) - (v + 0.5).round();
                    let dist = (fu * fu + fv * fv).sqrt();
                    smoothstep(r - aa, r + aa, dist)
                }
            }
        }
    }

    /// A8 の矩形(`rect` の並び)に掛ける。
    pub fn apply(&self, alpha: &mut [u8], rect: Rect) {
        let w = rect.w.max(0) as usize;
        for (i, a) in alpha.iter_mut().enumerate() {
            if *a == 0 {
                continue;
            }
            let x = (i % w) as i32 + rect.x;
            let y = (i / w) as i32 + rect.y;
            let k = self.coverage(x as f32 + 0.5, y as f32 + 0.5);
            *a = (*a as f32 * k + 0.5) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dot_density_matches_area() {
        for d in [0.1f32, 0.3, 0.5, 0.7, 0.9] {
            let t = Tone {
                lines: 60.0,
                dpi: 600.0,
                density: d,
                angle: 0.0,
                shape: 0,
            };
            // 周期 10px × 10 周期の平均濃度は density に近い
            let mut sum = 0.0;
            for y in 0..100 {
                for x in 0..100 {
                    sum += t.coverage(x as f32 + 0.5, y as f32 + 0.5);
                }
            }
            let avg = sum / 10000.0;
            assert!((avg - d).abs() < 0.06, "density {d} → {avg}");
        }
    }

    #[test]
    fn line_and_noise_and_apply() {
        let line = Tone { shape: 1, angle: 0.0, density: 0.5, ..Default::default() };
        let mut sum = 0.0;
        for y in 0..100 {
            sum += line.coverage(3.5, y as f32 + 0.5);
        }
        assert!((sum / 100.0 - 0.5).abs() < 0.06);
        let noise = Tone { shape: 2, density: 0.3, ..Default::default() };
        let mut sum = 0.0;
        for y in 0..200 {
            for x in 0..200 {
                sum += noise.coverage(x as f32 + 0.5, y as f32 + 0.5);
            }
        }
        assert!((sum / 40000.0 - 0.3).abs() < 0.08, "{}", sum / 40000.0);
        let mut a = vec![255u8; 20 * 20];
        Tone::default().apply(&mut a, Rect::new(0, 0, 20, 20));
        assert!(a.iter().any(|&v| v == 0) && a.iter().any(|&v| v == 255));
        let mut z = vec![0u8; 4];
        Tone::default().apply(&mut z, Rect::new(0, 0, 2, 2));
        assert_eq!(z, vec![0; 4]);
    }
}
