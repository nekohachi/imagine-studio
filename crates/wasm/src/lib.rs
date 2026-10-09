//! JS から brush-core を使うための結合。
//!
//! 設計(docs/02, docs/05):
//! - 描画ワーカーの中で動く。メインスレッドとはやり取りしない。
//! - 入力は [x, y, pressure, time] の 4 要素ずつ詰めた Float32Array でまとめて渡す
//!   (呼び出し回数を減らすため、フレームごとに 1 回)。
//! - 出力は [x, y, radius, opacity] の 4 要素ずつ詰めた Float32Array。
//!   レンダラはこれをそのままインスタンス属性にする。

mod doc;
pub use doc::Doc;

use brush_core::{BrushParams, InputPoint, StrokeEngine};
use wasm_bindgen::prelude::*;

/// ブラシのパラメータ。JS からは setter で個別に触る。
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct Brush {
    params: BrushParams,
    stabilizer: f32,
}

#[wasm_bindgen]
impl Brush {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Brush {
        Brush {
            params: BrushParams::default(),
            stabilizer: 0.0,
        }
    }

    #[wasm_bindgen(getter)]
    pub fn radius(&self) -> f32 {
        self.params.radius
    }
    #[wasm_bindgen(setter)]
    pub fn set_radius(&mut self, v: f32) {
        self.params.radius = v.max(0.25);
    }

    #[wasm_bindgen(getter)]
    pub fn spacing(&self) -> f32 {
        self.params.spacing
    }
    #[wasm_bindgen(setter)]
    pub fn set_spacing(&mut self, v: f32) {
        self.params.spacing = v.clamp(0.02, 2.0);
    }

    #[wasm_bindgen(getter)]
    pub fn flow(&self) -> f32 {
        self.params.flow
    }
    #[wasm_bindgen(setter)]
    pub fn set_flow(&mut self, v: f32) {
        self.params.flow = v.clamp(0.0, 1.0);
    }

    #[wasm_bindgen(getter)]
    pub fn opacity(&self) -> f32 {
        self.params.opacity
    }
    #[wasm_bindgen(setter)]
    pub fn set_opacity(&mut self, v: f32) {
        self.params.opacity = v.clamp(0.0, 1.0);
    }

    #[wasm_bindgen(getter)]
    pub fn hardness(&self) -> f32 {
        self.params.hardness
    }
    #[wasm_bindgen(setter)]
    pub fn set_hardness(&mut self, v: f32) {
        self.params.hardness = v.clamp(0.0, 1.0);
    }

    #[wasm_bindgen(getter)]
    pub fn pressure_gamma(&self) -> f32 {
        self.params.pressure_gamma
    }
    #[wasm_bindgen(setter)]
    pub fn set_pressure_gamma(&mut self, v: f32) {
        self.params.pressure_gamma = v.clamp(0.2, 5.0);
    }

    #[wasm_bindgen(getter)]
    pub fn min_radius_ratio(&self) -> f32 {
        self.params.min_radius_ratio
    }
    #[wasm_bindgen(setter)]
    pub fn set_min_radius_ratio(&mut self, v: f32) {
        self.params.min_radius_ratio = v.clamp(0.0, 1.0);
    }

    #[wasm_bindgen(getter)]
    pub fn pressure_affects_opacity(&self) -> f32 {
        self.params.pressure_affects_opacity
    }
    #[wasm_bindgen(setter)]
    pub fn set_pressure_affects_opacity(&mut self, v: f32) {
        self.params.pressure_affects_opacity = v.clamp(0.0, 1.0);
    }

    /// 手ブレ補正(ひも)の強さ。px。0 で無し。
    #[wasm_bindgen(getter)]
    pub fn stabilizer(&self) -> f32 {
        self.stabilizer
    }
    #[wasm_bindgen(setter)]
    pub fn set_stabilizer(&mut self, v: f32) {
        self.stabilizer = v.clamp(0.0, 100.0);
    }
}

impl Default for Brush {
    fn default() -> Self {
        Self::new()
    }
}

/// 1 本のストローク。begin で作り、add_points を繰り返し、finish で閉じる。
#[wasm_bindgen]
pub struct Stroke {
    engine: StrokeEngine,
    out: Vec<f32>,
    dab_count: u32,
}

#[wasm_bindgen]
impl Stroke {
    #[wasm_bindgen(constructor)]
    pub fn new(brush: &Brush) -> Stroke {
        Stroke {
            engine: StrokeEngine::begin(brush.params, brush.stabilizer),
            out: Vec::with_capacity(1024),
            dab_count: 0,
        }
    }

    /// [x, y, pressure, time] × n を受け取り、[x, y, radius, opacity] × m を返す。
    /// 返り値は呼び出しごとに作り直す Float32Array(コピー)。
    pub fn add_points(&mut self, points: &[f32]) -> js_sys::Float32Array {
        self.out.clear();
        for p in points.chunks_exact(4) {
            let stamps = self.engine.add_point(InputPoint {
                x: p[0],
                y: p[1],
                pressure: p[2],
                time: p[3] as f64,
            });
            for s in stamps {
                self.out.extend_from_slice(&[s.x, s.y, s.radius, s.opacity]);
            }
        }
        self.dab_count += (self.out.len() / 4) as u32;
        js_sys::Float32Array::from(self.out.as_slice())
    }

    /// 終端を実ペン位置まで届かせ、残りを吐き出す。
    pub fn finish(&mut self) -> js_sys::Float32Array {
        self.out.clear();
        if self.engine.is_active() {
            for s in self.engine.finish() {
                self.out.extend_from_slice(&[s.x, s.y, s.radius, s.opacity]);
            }
        }
        self.dab_count += (self.out.len() / 4) as u32;
        js_sys::Float32Array::from(self.out.as_slice())
    }

    /// このストロークで生成したダブの総数(ベンチ表示用)。
    #[wasm_bindgen(getter)]
    pub fn dab_count(&self) -> u32 {
        self.dab_count
    }
}

/// ビルドが本当に読み込めたかを確かめるための印。
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stroke_outputs_quads() {
        let mut b = Brush::new();
        b.set_radius(8.0);
        let mut s = Stroke::new(&b);
        // wasm 外では js_sys を呼べないので engine を直接叩く
        let stamps = s.engine.add_point(InputPoint {
            x: 10.0,
            y: 10.0,
            pressure: 1.0,
            time: 0.0,
        });
        let tail = s.engine.finish();
        assert!(!stamps.is_empty() || !tail.is_empty());
    }
}
