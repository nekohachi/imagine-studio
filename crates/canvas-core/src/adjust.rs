//! 色調補正とフィルタ。GPU の仮表示と同じ式を CPU で確定に使う(docs/10 の P0)。

use serde::{Deserialize, Serialize};

/// 色調補正のパラメータ。すべて 0 が「変化なし」。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Adjust {
    /// 明るさ -1..1
    pub brightness: f32,
    /// コントラスト -1..1
    pub contrast: f32,
    /// 色相のずれ(度)
    pub hue: f32,
    /// 彩度 -1..1
    pub saturation: f32,
    /// 明度 -1..1(HSL の L)
    pub lightness: f32,
    /// レベル補正: 入力の黒 0..1、入力の白 0..1、ガンマ、出力の黒、出力の白
    pub in_black: f32,
    pub in_white: f32,
    pub gamma: f32,
    pub out_black: f32,
    pub out_white: f32,
    /// トーンカーブ(マスター)。x, y とも 0..1。空なら無し
    pub curve: Vec<[f32; 2]>,
}

impl Default for Adjust {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            contrast: 0.0,
            hue: 0.0,
            saturation: 0.0,
            lightness: 0.0,
            in_black: 0.0,
            in_white: 1.0,
            gamma: 1.0,
            out_black: 0.0,
            out_white: 1.0,
            curve: Vec::new(),
        }
    }
}

impl Adjust {
    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }

    pub fn is_identity(&self) -> bool {
        *self == Adjust::default()
    }

    /// チャンネル共通の変換表(明るさ、コントラスト、レベル、カーブ)。
    pub fn lut(&self) -> [u8; 256] {
        let mut out = [0u8; 256];
        for (i, o) in out.iter_mut().enumerate() {
            let mut v = i as f32 / 255.0;
            // レベル
            let span = (self.in_white - self.in_black).max(1e-4);
            v = ((v - self.in_black) / span).clamp(0.0, 1.0);
            v = v.powf(1.0 / self.gamma.max(0.05));
            v = self.out_black + v * (self.out_white - self.out_black);
            // 明るさとコントラスト
            v += self.brightness;
            let c = if self.contrast >= 0.0 { 1.0 + self.contrast * 3.0 } else { 1.0 + self.contrast };
            v = (v - 0.5) * c + 0.5;
            // カーブ(折れ線)
            if self.curve.len() >= 2 {
                v = curve_apply(&self.curve, v);
            }
            *o = (v.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
        }
        out
    }

    /// 1 画素(ストレート RGB 0..1)に色相・彩度・明度を掛ける。
    pub fn hsl_apply(&self, rgb: [f32; 3]) -> [f32; 3] {
        if self.hue == 0.0 && self.saturation == 0.0 && self.lightness == 0.0 {
            return rgb;
        }
        let (mut h, mut s, mut l) = rgb_to_hsl(rgb);
        h = (h + self.hue / 360.0).rem_euclid(1.0);
        s = if self.saturation >= 0.0 {
            s + (1.0 - s) * self.saturation
        } else {
            s * (1.0 + self.saturation)
        };
        l = if self.lightness >= 0.0 {
            l + (1.0 - l) * self.lightness
        } else {
            l * (1.0 + self.lightness)
        };
        hsl_to_rgb(h, s.clamp(0.0, 1.0), l.clamp(0.0, 1.0))
    }

    /// プリマルチ RGBA8 の画素列に適用する。`mask`(A8)があればその濃さぶんだけ。
    pub fn apply_premul(&self, px: &mut [u8], mask: Option<&[u8]>) {
        let lut = self.lut();
        for (i, p) in px.chunks_exact_mut(4).enumerate() {
            let a = p[3];
            if a == 0 {
                continue;
            }
            let k = mask.map_or(255, |m| m[i]);
            if k == 0 {
                continue;
            }
            let af = a as f32 / 255.0;
            let mut c = [
                p[0] as f32 / 255.0 / af,
                p[1] as f32 / 255.0 / af,
                p[2] as f32 / 255.0 / af,
            ];
            for v in &mut c {
                *v = lut[(v.clamp(0.0, 1.0) * 255.0 + 0.5) as usize] as f32 / 255.0;
            }
            c = self.hsl_apply(c);
            let kf = k as f32 / 255.0;
            for ch in 0..3 {
                let orig = p[ch] as f32 / 255.0;
                let newv = c[ch].clamp(0.0, 1.0) * af;
                p[ch] = ((orig + (newv - orig) * kf) * 255.0 + 0.5) as u8;
            }
        }
    }
}

fn curve_apply(pts: &[[f32; 2]], x: f32) -> f32 {
    if x <= pts[0][0] {
        return pts[0][1];
    }
    for w in pts.windows(2) {
        if x <= w[1][0] {
            let t = (x - w[0][0]) / (w[1][0] - w[0][0]).max(1e-6);
            return w[0][1] + (w[1][1] - w[0][1]) * t;
        }
    }
    pts[pts.len() - 1][1]
}

pub fn rgb_to_hsl([r, g, b]: [f32; 3]) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let l = (max + min) / 2.0;
    if max - min < 1e-6 {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 { d / (2.0 - max - min) } else { d / (max + min) };
    let h = if max == r {
        ((g - b) / d + if g < b { 6.0 } else { 0.0 }) / 6.0
    } else if max == g {
        ((b - r) / d + 2.0) / 6.0
    } else {
        ((r - g) / d + 4.0) / 6.0
    };
    (h, s, l)
}

pub fn hsl_to_rgb(h: f32, s: f32, l: f32) -> [f32; 3] {
    if s <= 0.0 {
        return [l, l, l];
    }
    let q = if l < 0.5 { l * (1.0 + s) } else { l + s - l * s };
    let p = 2.0 * l - q;
    let f = |mut t: f32| {
        t = t.rem_euclid(1.0);
        if t < 1.0 / 6.0 {
            p + (q - p) * 6.0 * t
        } else if t < 0.5 {
            q
        } else if t < 2.0 / 3.0 {
            p + (q - p) * (2.0 / 3.0 - t) * 6.0
        } else {
            p
        }
    };
    [f(h + 1.0 / 3.0), f(h), f(h - 1.0 / 3.0)]
}

/// ガウスぼかし(分離型)。プリマルチ RGBA8、w × h。半径 px。
pub fn gaussian_blur(px: &mut [u8], w: usize, h: usize, radius: f32) {
    if radius <= 0.1 || w == 0 || h == 0 {
        return;
    }
    let sigma = radius / 2.0;
    let r = (sigma * 3.0).ceil() as i32;
    let kernel: Vec<f32> = (-r..=r).map(|i| (-(i * i) as f32 / (2.0 * sigma * sigma)).exp()).collect();
    let sum: f32 = kernel.iter().sum();
    let kernel: Vec<f32> = kernel.iter().map(|k| k / sum).collect();
    let mut tmp = vec![0f32; w * h * 4];
    // 横
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0f32; 4];
            for (ki, k) in kernel.iter().enumerate() {
                let sx = (x as i32 + ki as i32 - r).clamp(0, w as i32 - 1) as usize;
                let i = (y * w + sx) * 4;
                for c in 0..4 {
                    acc[c] += px[i + c] as f32 * k;
                }
            }
            let o = (y * w + x) * 4;
            tmp[o..o + 4].copy_from_slice(&acc);
        }
    }
    // 縦
    for y in 0..h {
        for x in 0..w {
            let mut acc = [0f32; 4];
            for (ki, k) in kernel.iter().enumerate() {
                let sy = (y as i32 + ki as i32 - r).clamp(0, h as i32 - 1) as usize;
                let i = (sy * w + x) * 4;
                for c in 0..4 {
                    acc[c] += tmp[i + c] * k;
                }
            }
            let o = (y * w + x) * 4;
            for c in 0..4 {
                px[o + c] = (acc[c] + 0.5).clamp(0.0, 255.0) as u8;
            }
        }
    }
}

/// アンシャープマスク。amount 0..2 程度。
pub fn unsharp(px: &mut [u8], w: usize, h: usize, radius: f32, amount: f32) {
    let mut blurred = px.to_vec();
    gaussian_blur(&mut blurred, w, h, radius);
    for (p, b) in px.chunks_exact_mut(4).zip(blurred.chunks_exact(4)) {
        for c in 0..3 {
            let v = p[c] as f32 + (p[c] as f32 - b[c] as f32) * amount;
            // プリマルチなのでアルファを超えない
            p[c] = v.clamp(0.0, p[3] as f32) as u8;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_is_identity() {
        let a = Adjust::default();
        assert!(a.is_identity());
        let lut = a.lut();
        assert_eq!(lut[0], 0);
        assert_eq!(lut[128], 128);
        assert_eq!(lut[255], 255);
        let mut px = vec![100, 50, 25, 255, 0, 0, 0, 0];
        a.apply_premul(&mut px, None);
        assert_eq!(px, vec![100, 50, 25, 255, 0, 0, 0, 0]);
    }

    #[test]
    fn brightness_contrast_levels_curve() {
        let b = Adjust { brightness: 0.2, ..Default::default() };
        assert!((b.lut()[128] as i32 - 179).abs() <= 1);
        let c = Adjust { contrast: 1.0, ..Default::default() };
        assert!((c.lut()[128] as i32 - 128).abs() <= 2);
        assert_eq!(c.lut()[200], 255);
        let l = Adjust { in_black: 0.5, ..Default::default() };
        assert_eq!(l.lut()[127], 0);
        assert_eq!(l.lut()[255], 255);
        let k = Adjust { curve: vec![[0.0, 1.0], [1.0, 0.0]], ..Default::default() };
        assert_eq!(k.lut()[0], 255);
        assert_eq!(k.lut()[255], 0);
    }

    #[test]
    fn hue_rotates_and_hsl_roundtrips() {
        for rgb in [[1.0, 0.0, 0.0], [0.2, 0.7, 0.3], [0.5, 0.5, 0.5], [0.0, 0.0, 1.0]] {
            let (h, s, l) = rgb_to_hsl(rgb);
            let back = hsl_to_rgb(h, s, l);
            for c in 0..3 {
                assert!((back[c] - rgb[c]).abs() < 1e-4, "{rgb:?} {back:?}");
            }
        }
        let a = Adjust { hue: 120.0, ..Default::default() };
        let g = a.hsl_apply([1.0, 0.0, 0.0]);
        assert!(g[1] > 0.99 && g[0] < 0.01, "{g:?}");
        let s = Adjust { saturation: -1.0, ..Default::default() };
        let gray = s.hsl_apply([1.0, 0.0, 0.0]);
        assert!((gray[0] - gray[1]).abs() < 1e-4);
    }

    #[test]
    fn mask_limits_adjust() {
        let a = Adjust { brightness: 1.0, ..Default::default() };
        let mut px = vec![0, 0, 0, 255, 0, 0, 0, 255];
        a.apply_premul(&mut px, Some(&[255, 0]));
        assert_eq!(px[0], 255);
        assert_eq!(px[4], 0);
    }

    #[test]
    fn blur_spreads_and_sharpen_keeps_alpha() {
        let (w, h) = (9usize, 1usize);
        let mut px = vec![0u8; w * h * 4];
        px[4 * 4..4 * 4 + 4].copy_from_slice(&[255, 255, 255, 255]);
        gaussian_blur(&mut px, w, h, 2.0);
        assert!(px[4 * 4 + 3] < 255 && px[3 * 4 + 3] > 0, "{px:?}");
        let mut px2 = px.clone();
        unsharp(&mut px2, w, h, 1.0, 1.0);
        for p in px2.chunks_exact(4) {
            assert!(p[0] <= p[3]);
        }
    }
}
