//! ブラシの定義。JSON で保存・読み込みできるデータ駆動(docs/05)。
//! 項目を増やすときは `#[serde(default)]` のおかげで古い JSON もそのまま読める。

use serde::{Deserialize, Serialize};

/// 折れ線のカーブ。x, y とも 0..1。点は x で昇順。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Curve {
    pub points: Vec<[f32; 2]>,
}

impl Default for Curve {
    fn default() -> Self {
        Self::linear()
    }
}

impl Curve {
    pub fn linear() -> Self {
        Self {
            points: vec![[0.0, 0.0], [1.0, 1.0]],
        }
    }

    /// `x^gamma` を 9 点で近似。1.0 で線形、大きいほど硬い立ち上がり。
    pub fn gamma(gamma: f32) -> Self {
        let g = gamma.max(0.05);
        Self {
            points: (0..=8)
                .map(|i| {
                    let x = i as f32 / 8.0;
                    [x, x.powf(g)]
                })
                .collect(),
        }
    }

    pub fn apply(&self, x: f32) -> f32 {
        let x = x.clamp(0.0, 1.0);
        let pts = &self.points;
        if pts.is_empty() {
            return x;
        }
        if pts.len() == 1 || x <= pts[0][0] {
            return pts[0][1].clamp(0.0, 1.0);
        }
        for w in pts.windows(2) {
            let (a, b) = (w[0], w[1]);
            if x <= b[0] {
                let span = b[0] - a[0];
                let t = if span <= 1e-6 { 1.0 } else { (x - a[0]) / span };
                return (a[1] + (b[1] - a[1]) * t).clamp(0.0, 1.0);
            }
        }
        pts[pts.len() - 1][1].clamp(0.0, 1.0)
    }
}

/// チップの向き。
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "mode", content = "deg", rename_all = "snake_case")]
pub enum AngleMode {
    /// 固定(度)
    Fixed(f32),
    /// 進行方向に合わせる
    Direction,
    /// ペンの傾きの方向に合わせる
    Tilt,
}

impl Default for AngleMode {
    fn default() -> Self {
        AngleMode::Fixed(0.0)
    }
}

/// ブラシの定義。単位は px と 0..1 の比。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct BrushDef {
    pub name: String,
    /// 筆圧最大時の半径 (px)
    pub size: f32,
    /// 筆圧最小時の半径比(0 で筆圧 0 のとき半径 0)
    pub size_min: f32,
    /// ダブ間隔。半径に対する比率
    pub spacing: f32,
    /// ダブ 1 発の不透明度(ストローク内の build-up 量)
    pub flow: f32,
    /// ストローク全体の不透明度(ストロークバッファをレイヤーへ合成するときに掛ける)
    pub opacity: f32,
    /// エッジの硬さ 0..1
    pub hardness: f32,
    /// 筆圧 → 半径のカーブ
    pub pressure_size: Curve,
    /// 筆圧 → 不透明度のカーブ
    pub pressure_opacity: Curve,
    /// 筆圧最小時の不透明度比(1 で筆圧が不透明度に効かない)
    pub opacity_min: f32,
    /// 入り(px)。この長さをかけて太くなる
    pub taper_in: f32,
    /// 抜き(px)。終端のこの長さで細くなる(表示は終端まで遅れる)
    pub taper_out: f32,
    /// 手ブレ補正(ひも)の長さ px。0 で無し
    pub stabilizer: f32,
    /// 移動平均の点数。0 か 1 で無し
    pub smoothing: u32,
    /// 傾きで太くする量 0..1(1 で最大 2 倍)
    pub tilt_size: f32,
    /// 傾きで潰す量 0..1
    pub tilt_flatten: f32,
    /// 速度で太さを変える -1..1(負で速いほど細く)
    pub speed_size: f32,
    /// 位置の散布(半径比)
    pub scatter_pos: f32,
    /// 大きさの散布 0..1
    pub scatter_size: f32,
    /// 不透明度の散布 0..1
    pub scatter_opacity: f32,
    /// チップの向き
    pub angle: AngleMode,
    /// チップの扁平(短軸 / 長軸)。1 で円
    pub roundness: f32,
    /// 消しゴムとして使う
    pub eraser: bool,
}

impl Default for BrushDef {
    fn default() -> Self {
        Self {
            name: "ブラシ".into(),
            size: 12.0,
            size_min: 0.05,
            spacing: 0.2,
            flow: 0.9,
            opacity: 1.0,
            hardness: 0.7,
            pressure_size: Curve::gamma(1.4),
            pressure_opacity: Curve::gamma(1.4),
            opacity_min: 0.4,
            taper_in: 0.0,
            taper_out: 0.0,
            stabilizer: 0.0,
            smoothing: 0,
            tilt_size: 0.0,
            tilt_flatten: 0.0,
            speed_size: 0.0,
            scatter_pos: 0.0,
            scatter_size: 0.0,
            scatter_opacity: 0.0,
            angle: AngleMode::Fixed(0.0),
            roundness: 1.0,
            eraser: false,
        }
    }
}

impl BrushDef {
    pub fn from_json(s: &str) -> Result<Self, String> {
        serde_json::from_str(s).map_err(|e| e.to_string())
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_default()
    }

    /// 値を安全な範囲に収める(JSON を手で書いたとき用)。
    pub fn sanitized(mut self) -> Self {
        self.size = self.size.clamp(0.1, 1000.0);
        self.size_min = self.size_min.clamp(0.0, 1.0);
        self.spacing = self.spacing.clamp(0.02, 4.0);
        self.flow = self.flow.clamp(0.0, 1.0);
        self.opacity = self.opacity.clamp(0.0, 1.0);
        self.hardness = self.hardness.clamp(0.0, 1.0);
        self.opacity_min = self.opacity_min.clamp(0.0, 1.0);
        self.taper_in = self.taper_in.clamp(0.0, 10_000.0);
        self.taper_out = self.taper_out.clamp(0.0, 10_000.0);
        self.stabilizer = self.stabilizer.clamp(0.0, 200.0);
        self.smoothing = self.smoothing.min(64);
        self.tilt_size = self.tilt_size.clamp(0.0, 1.0);
        self.tilt_flatten = self.tilt_flatten.clamp(0.0, 1.0);
        self.speed_size = self.speed_size.clamp(-1.0, 1.0);
        self.scatter_pos = self.scatter_pos.clamp(0.0, 10.0);
        self.scatter_size = self.scatter_size.clamp(0.0, 1.0);
        self.scatter_opacity = self.scatter_opacity.clamp(0.0, 1.0);
        self.roundness = self.roundness.clamp(0.05, 1.0);
        for p in &mut self.pressure_size.points {
            p[0] = p[0].clamp(0.0, 1.0);
            p[1] = p[1].clamp(0.0, 1.0);
        }
        for p in &mut self.pressure_opacity.points {
            p[0] = p[0].clamp(0.0, 1.0);
            p[1] = p[1].clamp(0.0, 1.0);
        }
        self.pressure_size.points.sort_by(|a, b| a[0].total_cmp(&b[0]));
        self.pressure_opacity.points.sort_by(|a, b| a[0].total_cmp(&b[0]));
        self
    }

    /// 組み込みのプリセット。
    pub fn presets() -> Vec<BrushDef> {
        let base = BrushDef::default();
        vec![
            BrushDef {
                name: "鉛筆".into(),
                size: 3.0,
                size_min: 0.2,
                spacing: 0.15,
                flow: 0.7,
                hardness: 0.5,
                pressure_size: Curve::gamma(1.2),
                pressure_opacity: Curve::gamma(1.0),
                opacity_min: 0.15,
                stabilizer: 4.0,
                tilt_size: 0.8,
                tilt_flatten: 0.6,
                scatter_pos: 0.15,
                scatter_opacity: 0.3,
                angle: AngleMode::Tilt,
                ..base.clone()
            },
            BrushDef {
                name: "ペン".into(),
                size: 4.0,
                size_min: 0.0,
                spacing: 0.1,
                flow: 1.0,
                hardness: 0.95,
                pressure_size: Curve::gamma(1.6),
                opacity_min: 1.0,
                taper_in: 12.0,
                taper_out: 16.0,
                stabilizer: 10.0,
                smoothing: 3,
                ..base.clone()
            },
            BrushDef {
                name: "G ペン".into(),
                size: 6.0,
                size_min: 0.0,
                spacing: 0.08,
                flow: 1.0,
                hardness: 1.0,
                pressure_size: Curve::gamma(2.2),
                opacity_min: 1.0,
                taper_in: 24.0,
                taper_out: 30.0,
                stabilizer: 14.0,
                smoothing: 4,
                ..base.clone()
            },
            BrushDef {
                name: "マーカー".into(),
                size: 16.0,
                size_min: 0.9,
                spacing: 0.1,
                flow: 1.0,
                opacity: 0.6,
                hardness: 0.9,
                opacity_min: 1.0,
                angle: AngleMode::Fixed(45.0),
                roundness: 0.35,
                ..base.clone()
            },
            BrushDef {
                name: "エアブラシ".into(),
                size: 60.0,
                size_min: 0.6,
                spacing: 0.1,
                flow: 0.08,
                hardness: 0.0,
                pressure_opacity: Curve::gamma(1.5),
                opacity_min: 0.0,
                ..base.clone()
            },
            BrushDef {
                name: "水彩(仮)".into(),
                size: 24.0,
                size_min: 0.5,
                spacing: 0.12,
                flow: 0.25,
                opacity: 0.8,
                hardness: 0.3,
                opacity_min: 0.2,
                tilt_size: 0.5,
                tilt_flatten: 0.4,
                scatter_opacity: 0.2,
                angle: AngleMode::Tilt,
                ..base.clone()
            },
            BrushDef {
                name: "消しゴム".into(),
                size: 20.0,
                size_min: 0.3,
                spacing: 0.15,
                flow: 1.0,
                hardness: 0.8,
                opacity_min: 1.0,
                eraser: true,
                ..base
            },
        ]
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn curve_linear_and_gamma() {
        let l = Curve::linear();
        assert!((l.apply(0.3) - 0.3).abs() < 1e-6);
        assert_eq!(l.apply(-1.0), 0.0);
        assert_eq!(l.apply(2.0), 1.0);
        let g = Curve::gamma(2.0);
        assert_eq!(g.apply(0.0), 0.0);
        assert!((g.apply(1.0) - 1.0).abs() < 1e-6);
        assert!(g.apply(0.5) < 0.5);
        let mut prev = -1.0;
        for i in 0..=100 {
            let v = g.apply(i as f32 / 100.0);
            assert!(v >= prev);
            prev = v;
        }
    }

    #[test]
    fn curve_custom_points() {
        let c = Curve {
            points: vec![[0.0, 0.2], [0.5, 0.9], [1.0, 1.0]],
        };
        assert!((c.apply(0.0) - 0.2).abs() < 1e-6);
        assert!((c.apply(0.25) - 0.55).abs() < 1e-6);
        assert!((c.apply(0.75) - 0.95).abs() < 1e-6);
    }

    #[test]
    fn json_roundtrip_and_partial() {
        let d = BrushDef::presets().remove(1);
        let s = d.to_json();
        let back = BrushDef::from_json(&s).unwrap();
        assert_eq!(d, back);
        // 一部だけの JSON は既定値で埋まる
        let partial = BrushDef::from_json(r#"{"name":"x","size":3}"#).unwrap();
        assert_eq!(partial.size, 3.0);
        assert_eq!(partial.spacing, BrushDef::default().spacing);
        // 角度の表現
        let a = BrushDef::from_json(r#"{"angle":{"mode":"direction"}}"#).unwrap();
        assert_eq!(a.angle, AngleMode::Direction);
        let f = BrushDef::from_json(r#"{"angle":{"mode":"fixed","deg":30}}"#).unwrap();
        assert_eq!(f.angle, AngleMode::Fixed(30.0));
        assert!(BrushDef::from_json("{").is_err());
    }

    #[test]
    fn sanitized_clamps() {
        let d = BrushDef::from_json(r#"{"size":99999,"flow":5,"roundness":0,"smoothing":1000}"#)
            .unwrap()
            .sanitized();
        assert_eq!(d.size, 1000.0);
        assert_eq!(d.flow, 1.0);
        assert_eq!(d.roundness, 0.05);
        assert_eq!(d.smoothing, 64);
    }

    #[test]
    fn presets_have_unique_names() {
        let p = BrushDef::presets();
        let mut names: Vec<_> = p.iter().map(|b| b.name.clone()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), p.len());
    }
}
