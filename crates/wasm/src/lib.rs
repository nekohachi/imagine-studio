//! JS から brush-core / canvas-core を使うための結合。
//!
//! 設計(docs/02, docs/05):
//! - 描画ワーカーの中で動く。メインスレッドとはやり取りしない。
//! - 入力は [x, y, pressure, time, tilt_x, tilt_y] の 6 要素ずつ詰めた Float32Array でまとめて渡す
//!   (呼び出し回数を減らすため、フレームごとに 1 回)。
//! - 出力は [x, y, radius, opacity, angle, aspect, 0, 0] の 8 要素ずつ詰めた Float32Array。
//!   7 番目(色)は JS 側が詰める。レンダラはこれをそのままインスタンス属性にする。

mod doc;
pub use doc::Doc;

use brush_core::{BrushDef, InputPoint, StrokeEngine};
use wasm_bindgen::prelude::*;

pub const POINT_STRIDE: usize = 6;
pub const DAB_STRIDE: usize = 8;

/// ブラシの定義。JSON で出し入れする。
#[wasm_bindgen]
#[derive(Clone)]
pub struct Brush {
    def: BrushDef,
}

#[wasm_bindgen]
impl Brush {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Brush {
        Brush {
            def: BrushDef::default(),
        }
    }

    /// JSON から作る。足りない項目は既定値、範囲外の値は丸める。
    pub fn from_json(json: &str) -> Result<Brush, JsError> {
        BrushDef::from_json(json)
            .map(|d| Brush { def: d.sanitized() })
            .map_err(|e| JsError::new(&e))
    }

    pub fn to_json(&self) -> String {
        self.def.to_json()
    }

    /// 組み込みプリセットの JSON 配列。
    pub fn presets_json() -> String {
        serde_json::to_string(&BrushDef::presets()).unwrap_or_else(|_| "[]".into())
    }

    #[wasm_bindgen(getter)]
    pub fn name(&self) -> String {
        self.def.name.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn size(&self) -> f32 {
        self.def.size
    }
    #[wasm_bindgen(getter)]
    pub fn opacity(&self) -> f32 {
        self.def.opacity
    }
    #[wasm_bindgen(getter)]
    pub fn hardness(&self) -> f32 {
        self.def.hardness
    }
    #[wasm_bindgen(getter)]
    pub fn flow(&self) -> f32 {
        self.def.flow
    }
    #[wasm_bindgen(getter)]
    pub fn spacing(&self) -> f32 {
        self.def.spacing
    }
    #[wasm_bindgen(getter)]
    pub fn eraser(&self) -> bool {
        self.def.eraser
    }
    #[wasm_bindgen(getter)]
    pub fn mix(&self) -> f32 {
        self.def.mix
    }
    #[wasm_bindgen(getter)]
    pub fn wet(&self) -> f32 {
        self.def.wet
    }
    #[wasm_bindgen(getter)]
    pub fn grain(&self) -> f32 {
        self.def.grain
    }
    #[wasm_bindgen(getter)]
    pub fn grain_scale(&self) -> f32 {
        self.def.grain_scale
    }
}

impl Default for Brush {
    fn default() -> Self {
        Self::new()
    }
}

/// 1 本のストローク。begin で作り、add_points を繰り返し、finish で閉じる。
///
/// 混色(docs/05): ダブごとにキャンバスの「見えている色」を拾い、持っている色に混ぜる。
/// 拾うのは CPU 側のタイル(下のレイヤーと編集中レイヤー)。描いている途中の
/// ストローク自身は、持ち越す色(wet)で近似する。
#[wasm_bindgen]
pub struct Stroke {
    engine: StrokeEngine,
    out: Vec<f32>,
    dab_count: u32,
    /// 元の色(0..1)
    base: [f32; 3],
    /// 今の色(混色で変わる)
    color: [f32; 3],
    mix: f32,
    wet: f32,
}

fn pack(c: [f32; 3]) -> f32 {
    let q = |v: f32| (v.clamp(0.0, 1.0) * 255.0).round();
    q(c[0]) * 65536.0 + q(c[1]) * 256.0 + q(c[2])
}

#[wasm_bindgen]
impl Stroke {
    /// `r, g, b` は 0..1 のブラシ色。
    #[wasm_bindgen(constructor)]
    pub fn new(brush: &Brush, r: f32, g: f32, b: f32) -> Stroke {
        Stroke {
            engine: StrokeEngine::begin(&brush.def),
            out: Vec::with_capacity(2048),
            dab_count: 0,
            base: [r, g, b],
            color: [r, g, b],
            mix: brush.def.mix,
            wet: brush.def.wet,
        }
    }

    fn push_stamps(&mut self, stamps: &[brush_core::Stamp], doc: &Doc, layer: u32) {
        let sampler = doc.inner().index_of(layer).map(|idx| (doc.inner(), idx));
        for s in stamps {
            if self.mix > 0.0 {
                if let Some((inner, idx)) = sampler {
                    // 中心と、半径の 6 割の位置 4 点の平均
                    let r = s.radius * 0.6;
                    let pts = [
                        (s.x, s.y),
                        (s.x + r, s.y),
                        (s.x - r, s.y),
                        (s.x, s.y + r),
                        (s.x, s.y - r),
                    ];
                    let mut acc = [0.0f32; 4];
                    for (px, py) in pts {
                        let c = inner.sample_over_white(idx, px.round() as i32, py.round() as i32);
                        for k in 0..4 {
                            acc[k] += c[k] / 5.0;
                        }
                    }
                    // 絵の具がある所だけ拾う(紙の白は混ぜない)。少しずつ元の色へ戻す
                    let pull = self.mix * 0.5 * acc[3];
                    let back = (1.0 - self.wet) * 0.08;
                    for k in 0..3 {
                        let mixed = self.color[k] + (acc[k] - self.color[k]) * pull;
                        self.color[k] = mixed + (self.base[k] - mixed) * back;
                    }
                }
            }
            self.out.extend_from_slice(&[
                s.x,
                s.y,
                s.radius,
                s.opacity,
                s.angle,
                s.aspect,
                pack(self.color),
                0.0,
            ]);
        }
    }

    /// [x, y, pressure, time, tilt_x, tilt_y] × n を受け取り、ダブ × m を返す。
    /// `doc` と `layer` は混色の色拾い用(混色しないブラシでは無視する)。
    /// 返り値は呼び出しごとに作り直す Float32Array(コピー)。
    pub fn add_points(&mut self, points: &[f32], doc: &Doc, layer: u32) -> js_sys::Float32Array {
        self.out.clear();
        for p in points.chunks_exact(POINT_STRIDE) {
            let stamps = self.engine.add_point(InputPoint {
                x: p[0],
                y: p[1],
                pressure: p[2],
                time: p[3] as f64,
                tilt_x: p[4],
                tilt_y: p[5],
            });
            self.push_stamps(&stamps, doc, layer);
        }
        self.dab_count += (self.out.len() / DAB_STRIDE) as u32;
        js_sys::Float32Array::from(self.out.as_slice())
    }

    /// 終端を実ペン位置まで届かせ、残り(抜きの保留分を含む)を吐き出す。
    pub fn finish(&mut self, doc: &Doc, layer: u32) -> js_sys::Float32Array {
        self.out.clear();
        if self.engine.is_active() {
            let stamps = self.engine.finish();
            self.push_stamps(&stamps, doc, layer);
        }
        self.dab_count += (self.out.len() / DAB_STRIDE) as u32;
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
    fn stroke_outputs_stamps() {
        let b = Brush::from_json(r#"{"size":8}"#).unwrap();
        let mut s = Stroke::new(&b, 0.0, 0.0, 0.0);
        // wasm 外では js_sys を呼べないので engine を直接叩く
        let stamps = s.engine.add_point(InputPoint::new(10.0, 10.0, 1.0, 0.0));
        let tail = s.engine.finish();
        assert!(!stamps.is_empty() || !tail.is_empty());
    }

    #[test]
    fn presets_are_json_array() {
        let s = Brush::presets_json();
        assert!(s.starts_with('['));
        assert!(s.contains("鉛筆"));
    }
}
