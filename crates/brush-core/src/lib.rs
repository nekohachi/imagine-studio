//! brush-core: GPU 非依存のブラシエンジン。
//!
//! 入力イベント列を受け取り、描画すべきブラシスタンプ(ダブ)列に変換する。
//! パイプライン(docs/05):
//!   生入力 → 移動平均 → ひも(スタビライザー)→ Catmull-Rom 補間 → ダブ生成(筆圧カーブ、傾き、速度、入り抜き、散布)
//!
//! GPU / OS に依存しないため、そのままユニットテストできる。
//! ブラシの定義(`BrushDef`)は JSON で保存できるデータ駆動。

pub mod brush;
pub mod engine;
pub mod spline;
pub mod stabilizer;
pub mod stamper;

pub use brush::{AngleMode, BrushDef, Curve};
pub use engine::StrokeEngine;

/// OS から受け取る生の入力イベント。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct InputPoint {
    /// キャンバス座標 (px)
    pub x: f32,
    pub y: f32,
    /// 筆圧 0.0..=1.0(筆圧非対応デバイスは 1.0)
    pub pressure: f32,
    /// イベント時刻 (秒)
    pub time: f64,
    /// 傾き(度、-90..=90)。取れないデバイスは 0
    pub tilt_x: f32,
    pub tilt_y: f32,
}

impl InputPoint {
    pub fn new(x: f32, y: f32, pressure: f32, time: f64) -> Self {
        Self {
            x,
            y,
            pressure,
            time,
            tilt_x: 0.0,
            tilt_y: 0.0,
        }
    }
}

/// 補間済みポリライン上の 1 点。スプライン補間の出力単位。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PolyPoint {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
    pub tilt_x: f32,
    pub tilt_y: f32,
    /// 速度 (px/秒)
    pub speed: f32,
}

impl PolyPoint {
    pub fn new(x: f32, y: f32, pressure: f32) -> Self {
        Self {
            x,
            y,
            pressure,
            tilt_x: 0.0,
            tilt_y: 0.0,
            speed: 0.0,
        }
    }
}

/// レンダラに渡す最終出力。この位置・半径・不透明度・向き・扁平でブラシチップを 1 回打つ。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stamp {
    pub x: f32,
    pub y: f32,
    pub radius: f32,
    /// このスタンプ 1 発の不透明度(flow × 筆圧 × 入り抜き)。ストローク全体の
    /// 不透明度はレンダラがストロークバッファ合成時に適用する。
    pub opacity: f32,
    /// チップの向き(ラジアン)
    pub angle: f32,
    /// 短軸 / 長軸(1 = 円)
    pub aspect: f32,
}
