//! brush-core: GPU 非依存のブラシエンジン。
//!
//! 入力イベント列を受け取り、描画すべきブラシスタンプ列に変換する。
//! パイプライン: 生入力 → スタビライザー → Catmull-Rom 補間 → スタンプ生成
//!
//! GPU / OS に依存しないため、そのままユニットテストでき、
//! 将来 iOS / Android へ FFI 経由で移植する際もこのクレートが共有コアになる。

pub mod engine;
pub mod pressure;
pub mod spline;
pub mod stabilizer;
pub mod stamper;

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
}

/// 補間済みポリライン上の 1 点。スプライン補間の出力単位。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PolyPoint {
    pub x: f32,
    pub y: f32,
    pub pressure: f32,
}

/// レンダラに渡す最終出力。この位置・半径・不透明度でブラシチップを 1 回打つ。
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Stamp {
    pub x: f32,
    pub y: f32,
    pub radius: f32,
    /// このスタンプ 1 発の不透明度(flow × 筆圧)。ストローク全体の
    /// 不透明度はレンダラがストロークバッファ合成時に適用する。
    pub opacity: f32,
}

/// ブラシのパラメータ。データ駆動でブラシを定義できるよう、
/// エンジン本体とは分離して保持する。
#[derive(Clone, Copy, Debug)]
pub struct BrushParams {
    /// 筆圧最大時の半径 (px)
    pub radius: f32,
    /// スタンプ間隔。現在の半径に対する比率(0.25 = 半径の 1/4 ごと)
    pub spacing: f32,
    /// スタンプ 1 発ごとの不透明度(ストローク内での build-up 量)
    pub flow: f32,
    /// ストローク全体の不透明度。ストロークバッファをレイヤーへ
    /// 合成するときに適用する(SAI 的な「ストローク内で濃くならない」挙動)
    pub opacity: f32,
    /// エッジの硬さ 0.0..=1.0(レンダラのシェーダが使用)
    pub hardness: f32,
    /// 筆圧カーブのガンマ値。1.0 で線形、>1 で硬い立ち上がり
    pub pressure_gamma: f32,
    /// 筆圧最小時の半径比率(0.0 なら筆圧 0 で半径 0)
    pub min_radius_ratio: f32,
    /// 筆圧が不透明度へ影響する度合い 0.0..=1.0
    pub pressure_affects_opacity: f32,
}

impl Default for BrushParams {
    fn default() -> Self {
        Self {
            radius: 12.0,
            spacing: 0.2,
            flow: 0.9,
            opacity: 1.0,
            hardness: 0.7,
            pressure_gamma: 1.4,
            min_radius_ratio: 0.05,
            pressure_affects_opacity: 0.6,
        }
    }
}
