//! レイヤーの合成モード(Photoshop 互換の式。W3C Compositing and Blending に同じ)。
//! 計算は浮動小数、入出力はプリマルチプライド 8bit(docs/02)。

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    /// 覆い焼き(リニア)= 加算
    Add,
    Subtract,
    Difference,
    SoftLight,
    HardLight,
    ColorDodge,
    ColorBurn,
    Hue,
    Saturation,
    Color,
    Luminosity,
}

impl BlendMode {
    pub const ALL: [BlendMode; 17] = [
        BlendMode::Normal,
        BlendMode::Multiply,
        BlendMode::Screen,
        BlendMode::Overlay,
        BlendMode::Darken,
        BlendMode::Lighten,
        BlendMode::Add,
        BlendMode::Subtract,
        BlendMode::Difference,
        BlendMode::SoftLight,
        BlendMode::HardLight,
        BlendMode::ColorDodge,
        BlendMode::ColorBurn,
        BlendMode::Hue,
        BlendMode::Saturation,
        BlendMode::Color,
        BlendMode::Luminosity,
    ];

    pub fn name(self) -> &'static str {
        match self {
            BlendMode::Normal => "normal",
            BlendMode::Multiply => "multiply",
            BlendMode::Screen => "screen",
            BlendMode::Overlay => "overlay",
            BlendMode::Darken => "darken",
            BlendMode::Lighten => "lighten",
            BlendMode::Add => "add",
            BlendMode::Subtract => "subtract",
            BlendMode::Difference => "difference",
            BlendMode::SoftLight => "soft_light",
            BlendMode::HardLight => "hard_light",
            BlendMode::ColorDodge => "color_dodge",
            BlendMode::ColorBurn => "color_burn",
            BlendMode::Hue => "hue",
            BlendMode::Saturation => "saturation",
            BlendMode::Color => "color",
            BlendMode::Luminosity => "luminosity",
        }
    }

    pub fn parse(s: &str) -> Option<BlendMode> {
        BlendMode::ALL.iter().copied().find(|m| m.name() == s)
    }

    /// GPU のシェーダに渡す番号(ALL の添字)。
    pub fn index(self) -> u32 {
        BlendMode::ALL.iter().position(|m| *m == self).unwrap_or(0) as u32
    }

    pub fn from_index(i: u32) -> BlendMode {
        BlendMode::ALL.get(i as usize).copied().unwrap_or_default()
    }
}

fn lum(c: [f32; 3]) -> f32 {
    0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2]
}

fn clip_color(c: [f32; 3]) -> [f32; 3] {
    let l = lum(c);
    let n = c[0].min(c[1]).min(c[2]);
    let x = c[0].max(c[1]).max(c[2]);
    let mut out = c;
    if n < 0.0 {
        for v in &mut out {
            *v = l + (*v - l) * l / (l - n).max(1e-6);
        }
    }
    if x > 1.0 {
        for v in &mut out {
            *v = l + (*v - l) * (1.0 - l) / (x - l).max(1e-6);
        }
    }
    out
}

fn set_lum(c: [f32; 3], l: f32) -> [f32; 3] {
    let d = l - lum(c);
    clip_color([c[0] + d, c[1] + d, c[2] + d])
}

fn sat(c: [f32; 3]) -> f32 {
    c[0].max(c[1]).max(c[2]) - c[0].min(c[1]).min(c[2])
}

fn set_sat(c: [f32; 3], s: f32) -> [f32; 3] {
    let mut idx = [0usize, 1, 2];
    idx.sort_by(|a, b| c[*a].total_cmp(&c[*b]));
    let (imin, imid, imax) = (idx[0], idx[1], idx[2]);
    let mut out = [0.0f32; 3];
    let cmax = c[imax];
    let cmin = c[imin];
    let cmid = c[imid];
    if cmax > cmin {
        out[imid] = (cmid - cmin) * s / (cmax - cmin);
        out[imax] = s;
    }
    out[imin] = 0.0;
    out
}

/// 分離型の式(チャンネルごと)。cb = 下、cs = 上(どちらもストレート 0..1)。
fn separable(mode: BlendMode, cb: f32, cs: f32) -> f32 {
    match mode {
        BlendMode::Normal => cs,
        BlendMode::Multiply => cb * cs,
        BlendMode::Screen => cb + cs - cb * cs,
        BlendMode::Overlay => separable(BlendMode::HardLight, cs, cb),
        BlendMode::Darken => cb.min(cs),
        BlendMode::Lighten => cb.max(cs),
        BlendMode::Add => (cb + cs).min(1.0),
        BlendMode::Subtract => (cb - cs).max(0.0),
        BlendMode::Difference => (cb - cs).abs(),
        BlendMode::SoftLight => {
            if cs <= 0.5 {
                cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
            } else {
                let d = if cb <= 0.25 {
                    ((16.0 * cb - 12.0) * cb + 4.0) * cb
                } else {
                    cb.sqrt()
                };
                cb + (2.0 * cs - 1.0) * (d - cb)
            }
        }
        BlendMode::HardLight => {
            if cs <= 0.5 {
                cb * 2.0 * cs
            } else {
                separable(BlendMode::Screen, cb, 2.0 * cs - 1.0)
            }
        }
        BlendMode::ColorDodge => {
            if cb <= 0.0 {
                0.0
            } else if cs >= 1.0 {
                1.0
            } else {
                (cb / (1.0 - cs)).min(1.0)
            }
        }
        BlendMode::ColorBurn => {
            if cb >= 1.0 {
                1.0
            } else if cs <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - cb) / cs).min(1.0)
            }
        }
        _ => cs,
    }
}

/// B(Cb, Cs): 下の色と上の色(ストレート)から、混ぜた色を返す。
pub fn blend_rgb(mode: BlendMode, cb: [f32; 3], cs: [f32; 3]) -> [f32; 3] {
    match mode {
        BlendMode::Hue => set_lum(set_sat(cs, sat(cb)), lum(cb)),
        BlendMode::Saturation => set_lum(set_sat(cb, sat(cs)), lum(cb)),
        BlendMode::Color => set_lum(cs, lum(cb)),
        BlendMode::Luminosity => set_lum(cb, lum(cs)),
        _ => [
            separable(mode, cb[0], cs[0]),
            separable(mode, cb[1], cs[1]),
            separable(mode, cb[2], cs[2]),
        ],
    }
}

/// プリマルチ RGBA8 の 1 画素を、合成モードと不透明度で dst に重ねる。
/// co = (1 − αb)·αs·Cs + αb·αs·B(Cb, Cs) + (1 − αs)·αb·Cb、αo = αs + αb(1 − αs)
#[inline]
pub fn composite_pixel(mode: BlendMode, dst: &mut [u8], src: &[u8], opacity: f32) {
    let a_s = src[3] as f32 / 255.0 * opacity;
    if a_s <= 0.0 {
        return;
    }
    let a_b = dst[3] as f32 / 255.0;
    if mode == BlendMode::Normal || a_b <= 0.0 {
        // 通常、または下が無い所は src-over(モードは下がある所だけに効く)
        let f = 1.0 - a_s;
        for c in 0..3 {
            let sc = src[c] as f32 / 255.0 * opacity;
            dst[c] = ((sc + dst[c] as f32 / 255.0 * f) * 255.0 + 0.5).min(255.0) as u8;
        }
        dst[3] = ((a_s + a_b * f) * 255.0 + 0.5).min(255.0) as u8;
        return;
    }
    let cs = [
        src[0] as f32 / 255.0 / (src[3] as f32 / 255.0).max(1e-6),
        src[1] as f32 / 255.0 / (src[3] as f32 / 255.0).max(1e-6),
        src[2] as f32 / 255.0 / (src[3] as f32 / 255.0).max(1e-6),
    ];
    let cb = [
        dst[0] as f32 / 255.0 / a_b,
        dst[1] as f32 / 255.0 / a_b,
        dst[2] as f32 / 255.0 / a_b,
    ];
    let b = blend_rgb(mode, cb, cs);
    let a_o = a_s + a_b * (1.0 - a_s);
    for c in 0..3 {
        let co = (1.0 - a_b) * a_s * cs[c] + a_b * a_s * b[c] + (1.0 - a_s) * a_b * cb[c];
        dst[c] = (co.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
    }
    dst[3] = (a_o.clamp(0.0, 1.0) * 255.0 + 0.5) as u8;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_roundtrip() {
        for m in BlendMode::ALL {
            assert_eq!(BlendMode::parse(m.name()), Some(m));
            assert_eq!(BlendMode::from_index(m.index()), m);
        }
        assert_eq!(BlendMode::parse("nope"), None);
    }

    #[test]
    fn multiply_and_screen() {
        let mut d = [255, 128, 0, 255];
        composite_pixel(BlendMode::Multiply, &mut d, &[128, 128, 128, 255], 1.0);
        assert!((d[0] as i32 - 128).abs() <= 1 && (d[1] as i32 - 64).abs() <= 1 && d[2] == 0, "{d:?}");
        let mut d = [0, 0, 0, 255];
        composite_pixel(BlendMode::Screen, &mut d, &[128, 128, 128, 255], 1.0);
        assert!((d[0] as i32 - 128).abs() <= 1, "{d:?}");
        let mut d = [100, 100, 100, 255];
        composite_pixel(BlendMode::Add, &mut d, &[200, 200, 200, 255], 1.0);
        assert_eq!(d[0], 255);
    }

    #[test]
    fn mode_falls_back_to_normal_over_transparent() {
        let mut d = [0, 0, 0, 0];
        composite_pixel(BlendMode::Multiply, &mut d, &[200, 100, 50, 255], 1.0);
        assert_eq!(d, [200, 100, 50, 255]);
    }

    #[test]
    fn opacity_scales_source() {
        let mut d = [255, 255, 255, 255];
        composite_pixel(BlendMode::Normal, &mut d, &[0, 0, 0, 255], 0.5);
        assert!((d[0] as i32 - 128).abs() <= 1, "{d:?}");
        let mut d = [255, 255, 255, 255];
        composite_pixel(BlendMode::Multiply, &mut d, &[0, 0, 0, 255], 0.5);
        assert!((d[0] as i32 - 128).abs() <= 1, "{d:?}");
    }

    #[test]
    fn luminosity_keeps_hue() {
        let mut d = [255, 0, 0, 255];
        composite_pixel(BlendMode::Luminosity, &mut d, &[255, 255, 255, 255], 1.0);
        // 赤の色相のまま明るくなる(白に近づく)
        assert!(d[0] == 255 && d[1] > 200 && d[2] > 200, "{d:?}");
        let mut d = [128, 128, 128, 255];
        composite_pixel(BlendMode::Color, &mut d, &[255, 0, 0, 255], 1.0);
        assert!(d[0] > d[1] && d[1] == d[2], "{d:?}");
    }
}
