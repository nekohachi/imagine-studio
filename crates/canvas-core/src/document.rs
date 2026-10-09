//! Document: レイヤーの並びと履歴。フェーズ 1 ではラスターレイヤーだけ、フレームは 1 つ。
//! グループ、マスク、ベクターなどの種別は docs/03 に沿って後で足す。

use crate::cel::{Blend, Cel, Snapshot};
use crate::history::{Entry, History};
use crate::tile::{PixelFormat, Rect, TileKey};

pub type LayerId = u32;

pub struct Layer {
    pub id: LayerId,
    pub name: String,
    pub visible: bool,
    pub opacity: f32,
    pub cel: Cel,
}

pub struct Document {
    width: u32,
    height: u32,
    /// 下から上の順
    layers: Vec<Layer>,
    next_id: LayerId,
    history: History,
}

/// 変わったタイル(GPU が再転送すべきもの)。
pub type Changed = Vec<(LayerId, TileKey)>;

impl Document {
    pub fn new(width: u32, height: u32, history_limit_bytes: usize) -> Self {
        Self {
            width,
            height,
            layers: Vec::new(),
            next_id: 1,
            history: History::new(history_limit_bytes),
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }
    pub fn height(&self) -> u32 {
        self.height
    }
    pub fn bounds(&self) -> Rect {
        Rect::new(0, 0, self.width as i32, self.height as i32)
    }
    pub fn layers(&self) -> &[Layer] {
        &self.layers
    }
    pub fn history(&self) -> &History {
        &self.history
    }
    pub fn history_mut(&mut self) -> &mut History {
        &mut self.history
    }

    /// 一番上に足す。フェーズ 1 ではレイヤー構造の変更は履歴に積まない。
    pub fn add_layer(&mut self, format: PixelFormat, name: &str) -> LayerId {
        let id = self.next_id;
        self.next_id += 1;
        self.layers.push(Layer {
            id,
            name: name.to_string(),
            visible: true,
            opacity: 1.0,
            cel: Cel::new(format, self.width, self.height),
        });
        id
    }

    /// 読み込み用: id と属性を指定して足す(履歴には積まない)。id が既にあれば None。
    pub fn add_layer_with(
        &mut self,
        id: LayerId,
        format: PixelFormat,
        name: &str,
        visible: bool,
        opacity: f32,
    ) -> Option<&mut Layer> {
        if self.index_of(id).is_some() {
            return None;
        }
        self.next_id = self.next_id.max(id + 1);
        self.layers.push(Layer {
            id,
            name: name.to_string(),
            visible,
            opacity: opacity.clamp(0.0, 1.0),
            cel: Cel::new(format, self.width, self.height),
        });
        self.layers.last_mut()
    }

    /// レイヤーを消す。履歴のうちこのレイヤーに触れる項目はそのまま残るが、
    /// 入れ替え先が無いので無視される(フェーズ 3。構造の Undo は後で)。
    pub fn remove_layer(&mut self, id: LayerId) -> bool {
        let Some(i) = self.index_of(id) else { return false };
        if self.layers.len() <= 1 {
            return false;
        }
        self.layers.remove(i);
        true
    }

    /// 複製して、元のすぐ上に置く。新しい id を返す。
    pub fn duplicate_layer(&mut self, id: LayerId) -> Option<LayerId> {
        let i = self.index_of(id)?;
        let src = &self.layers[i];
        let new_id = self.next_id;
        self.next_id += 1;
        let mut cel = Cel::new(src.cel.format(), self.width, self.height);
        for k in src.cel.keys() {
            if let Some(t) = src.cel.tile(k) {
                cel.restore(k, Some(t.clone()));
            }
        }
        cel.take_dirty();
        let layer = Layer {
            id: new_id,
            name: format!("{} のコピー", src.name),
            visible: src.visible,
            opacity: src.opacity,
            cel,
        };
        self.layers.insert(i + 1, layer);
        Some(new_id)
    }

    /// 並びを変える。`to` は移動後の添字(下から)。
    pub fn move_layer(&mut self, id: LayerId, to: usize) -> bool {
        let Some(i) = self.index_of(id) else { return false };
        let to = to.min(self.layers.len() - 1);
        if i == to {
            return true;
        }
        let l = self.layers.remove(i);
        self.layers.insert(to, l);
        true
    }

    pub fn set_layer_name(&mut self, id: LayerId, name: &str) {
        if let Some(l) = self.layer_mut(id) {
            l.name = name.to_string();
        }
    }

    /// 下のレイヤーへ結合する(通常合成、不透明度込み)。下のレイヤーの画素変更は履歴に積む。
    /// 結合先が A8 なら、上のレイヤーのアルファだけを使う。戻り値は変わったタイル(下のレイヤー)。
    pub fn merge_down(&mut self, id: LayerId) -> Option<(LayerId, Vec<TileKey>)> {
        let i = self.index_of(id)?;
        if i == 0 {
            return None;
        }
        let upper = self.layers.remove(i);
        let lower_id = self.layers[i - 1].id;
        if !upper.visible || upper.opacity <= 0.0 {
            return Some((lower_id, Vec::new()));
        }
        let mut all_changed = Vec::new();
        for k in upper.cel.keys() {
            let Some(t) = upper.cel.tile(k) else { continue };
            // タイルをプリマルチ RGBA8 の矩形にして、通常合成で焼く
            let rect = k.rect().intersect(&self.bounds());
            if rect.is_empty() {
                continue;
            }
            let src = match t.format {
                PixelFormat::Rgba8 => upper.cel.read_rect(rect),
                PixelFormat::A8 => upper
                    .cel
                    .read_rect(rect)
                    .into_iter()
                    .flat_map(|a| [0, 0, 0, a])
                    .collect(),
            };
            let lower = &mut self.layers[i - 1];
            let snap = lower.cel.composite(rect, &src, upper.opacity, Blend::Normal);
            let keys: Vec<_> = snap.iter().map(|(k, _)| *k).collect();
            self.history.push(Entry {
                label: "結合".into(),
                layer: lower_id,
                tiles: snap,
            });
            all_changed.extend(keys);
        }
        all_changed.sort();
        all_changed.dedup();
        Some((lower_id, all_changed))
    }

    pub fn index_of(&self, id: LayerId) -> Option<usize> {
        self.layers.iter().position(|l| l.id == id)
    }
    pub fn layer(&self, id: LayerId) -> Option<&Layer> {
        self.layers.iter().find(|l| l.id == id)
    }
    pub fn layer_mut(&mut self, id: LayerId) -> Option<&mut Layer> {
        self.layers.iter_mut().find(|l| l.id == id)
    }

    fn record(&mut self, layer: LayerId, label: &str, snap: Snapshot) -> Vec<TileKey> {
        let keys: Vec<_> = snap.iter().map(|(k, _)| *k).collect();
        self.history.push(Entry {
            label: label.to_string(),
            layer,
            tiles: snap,
        });
        keys
    }

    /// ストロークを焼く(docs/05: 1 ストロークに 1 回)。戻り値は変わったタイル。
    pub fn composite_stroke(
        &mut self,
        layer: LayerId,
        rect: Rect,
        src: &[u8],
        opacity: f32,
        blend: Blend,
    ) -> Vec<TileKey> {
        let Some(l) = self.layer_mut(layer) else { return Vec::new() };
        let snap = l.cel.composite(rect, src, opacity, blend);
        self.record(layer, "ストローク", snap)
    }

    pub fn clear_layer(&mut self, layer: LayerId) -> Vec<TileKey> {
        let Some(l) = self.layer_mut(layer) else { return Vec::new() };
        let snap = l.cel.clear();
        self.record(layer, "消去", snap)
    }

    pub fn write_rect(&mut self, layer: LayerId, rect: Rect, src: &[u8]) -> Vec<TileKey> {
        let Some(l) = self.layer_mut(layer) else { return Vec::new() };
        let snap = l.cel.write_rect(rect, src);
        self.record(layer, "書き込み", snap)
    }

    fn swap_entry(&mut self, mut e: Entry) -> (Entry, Changed) {
        let mut changed = Vec::with_capacity(e.tiles.len());
        if let Some(l) = self.layer_mut(e.layer) {
            for (key, other) in e.tiles.iter_mut() {
                let cur = l.cel.restore(*key, other.take());
                *other = cur;
                changed.push((e.layer, *key));
            }
        }
        (e, changed)
    }

    pub fn undo(&mut self) -> Option<Changed> {
        let e = self.history.pop_undo()?;
        let (e, changed) = self.swap_entry(e);
        self.history.push_redo(e);
        Some(changed)
    }

    pub fn redo(&mut self) -> Option<Changed> {
        let e = self.history.pop_redo()?;
        let (e, changed) = self.swap_entry(e);
        self.history.push_undo_back(e);
        Some(changed)
    }

    /// 1 画素を、下から `upto`(含む)までのレイヤーで合成し、白い紙の上に置いた色と、
    /// 紙を含まない絵の具の濃さ(アルファ)を返す(0..1)。
    /// 混色ブラシが「見えている色」を拾うのに使う。紙の部分は白でアルファ 0。範囲外も同じ。
    pub fn sample_over_white(&self, upto: usize, x: i32, y: i32) -> [f32; 4] {
        let mut acc = [0u32; 4]; // プリマルチ RGBA、0..255
        if x >= 0 && y >= 0 && (x as u32) < self.width && (y as u32) < self.height {
            let r = Rect::new(x, y, 1, 1);
            for l in self.layers.iter().take(upto + 1) {
                if !l.visible || l.opacity <= 0.0 {
                    continue;
                }
                let opq = (l.opacity.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
                let px = l.cel.read_rect(r);
                let (sr, sg, sb, sa) = match l.cel.format() {
                    PixelFormat::Rgba8 => (px[0] as u32, px[1] as u32, px[2] as u32, px[3] as u32),
                    PixelFormat::A8 => (0, 0, 0, px[0] as u32),
                };
                let sa = (sa * opq + 127) / 255;
                if sa == 0 {
                    continue;
                }
                let f = 255 - sa;
                let src = [sr, sg, sb, sa];
                for c in 0..4 {
                    let sc = if c == 3 { sa } else { (src[c] * opq + 127) / 255 };
                    acc[c] = (sc + (acc[c] * f + 127) / 255).min(255);
                }
            }
        }
        let a = acc[3] as f32 / 255.0;
        let w = 1.0 - a;
        [
            acc[0] as f32 / 255.0 + w,
            acc[1] as f32 / 255.0 + w,
            acc[2] as f32 / 255.0 + w,
            a,
        ]
    }

    /// 全レイヤーの画素のメモリ(履歴は含まない)。
    pub fn memory_bytes(&self) -> usize {
        self.layers.iter().map(|l| l.cel.memory_bytes()).sum()
    }

    /// 表示レイヤーを通常合成で 1 枚にまとめる(書き出し用、プリマルチプライド RGBA8)。
    /// A8 レイヤーは黒インクとして扱う。
    pub fn flatten_rgba8(&self, rect: Rect) -> Vec<u8> {
        self.flatten_range(0, self.layers.len(), rect)
    }

    /// 並び `from..to`(下から数えた添字)のレイヤーだけをまとめる。
    /// 編集中レイヤーの「下」「上」をそれぞれ 1 枚にするのに使う(docs/02 の 3 枚方式)。
    pub fn flatten_range(&self, from: usize, to: usize, rect: Rect) -> Vec<u8> {
        let n = rect.w.max(0) as usize * rect.h.max(0) as usize;
        let mut out = vec![0u8; n * 4];
        let to = to.min(self.layers.len());
        if from >= to {
            return out;
        }
        for l in &self.layers[from..to] {
            if !l.visible || l.opacity <= 0.0 {
                continue;
            }
            let opq = (l.opacity.clamp(0.0, 1.0) * 255.0 + 0.5) as u32;
            let px = l.cel.read_rect(rect);
            match l.cel.format() {
                PixelFormat::Rgba8 => {
                    for (s, d) in px.chunks_exact(4).zip(out.chunks_exact_mut(4)) {
                        let sa = (s[3] as u32 * opq + 127) / 255;
                        if sa == 0 {
                            continue;
                        }
                        let f = 255 - sa;
                        for c in 0..4 {
                            let sc = (s[c] as u32 * opq + 127) / 255;
                            d[c] = (sc + (d[c] as u32 * f + 127) / 255).min(255) as u8;
                        }
                    }
                }
                PixelFormat::A8 => {
                    for (s, d) in px.iter().zip(out.chunks_exact_mut(4)) {
                        let sa = (*s as u32 * opq + 127) / 255;
                        if sa == 0 {
                            continue;
                        }
                        let f = 255 - sa;
                        for c in 0..3 {
                            d[c] = ((d[c] as u32 * f + 127) / 255) as u8;
                        }
                        d[3] = (sa + (d[3] as u32 * f + 127) / 255).min(255) as u8;
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(rect: Rect, rgba: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::new();
        for _ in 0..rect.w * rect.h {
            v.extend_from_slice(&rgba);
        }
        v
    }

    #[test]
    fn stroke_undo_redo_roundtrip() {
        let mut doc = Document::new(512, 512, 64 << 20);
        let a = doc.add_layer(PixelFormat::Rgba8, "a");
        let r = Rect::new(10, 10, 300, 10);
        let changed = doc.composite_stroke(a, r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Normal);
        assert_eq!(changed.len(), 2);
        assert_eq!(doc.layer(a).unwrap().cel.tile_count(), 2);
        assert!(doc.history().can_undo());

        let back = doc.undo().unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(doc.layer(a).unwrap().cel.tile_count(), 0);
        assert!(doc.history().can_redo());
        assert!(doc.undo().is_none());

        doc.redo().unwrap();
        assert_eq!(doc.layer(a).unwrap().cel.tile_count(), 2);
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(10, 10, 1, 1))[3], 255);
        assert!(doc.redo().is_none());
    }

    #[test]
    fn undo_restores_exact_pixels_after_overlapping_strokes() {
        let mut doc = Document::new(256, 256, 64 << 20);
        let a = doc.add_layer(PixelFormat::Rgba8, "a");
        let r = Rect::new(0, 0, 8, 8);
        doc.composite_stroke(a, r, &solid(r, [255, 0, 0, 255]), 0.5, Blend::Normal);
        let mid = doc.layer(a).unwrap().cel.read_rect(r);
        doc.composite_stroke(a, r, &solid(r, [0, 255, 0, 255]), 0.7, Blend::Normal);
        doc.undo();
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(r), mid);
        doc.undo();
        assert_eq!(doc.layer(a).unwrap().cel.tile_count(), 0);
    }

    #[test]
    fn new_stroke_drops_redo() {
        let mut doc = Document::new(256, 256, 64 << 20);
        let a = doc.add_layer(PixelFormat::Rgba8, "a");
        let r = Rect::new(0, 0, 2, 2);
        doc.composite_stroke(a, r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Normal);
        doc.undo();
        doc.composite_stroke(a, r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Normal);
        assert!(!doc.history().can_redo());
    }

    #[test]
    fn flatten_composites_layers_in_order() {
        let mut doc = Document::new(256, 256, 64 << 20);
        let lo = doc.add_layer(PixelFormat::Rgba8, "lo");
        let hi = doc.add_layer(PixelFormat::A8, "ink");
        let r = Rect::new(0, 0, 1, 1);
        doc.composite_stroke(lo, r, &solid(r, [255, 0, 0, 255]), 1.0, Blend::Normal);
        doc.composite_stroke(hi, r, &solid(r, [0, 0, 0, 128]), 1.0, Blend::Normal);
        let px = doc.flatten_rgba8(r);
        // 赤の上に 50% の黒インク: 赤が半分、アルファは 255 のまま
        assert!((px[0] as i32 - 127).abs() <= 1, "{px:?}");
        assert_eq!(px[3], 255);
        doc.layer_mut(hi).unwrap().visible = false;
        assert_eq!(doc.flatten_rgba8(r)[0], 255);
    }

    #[test]
    fn sample_over_white_sees_layers_below_and_paper() {
        let mut doc = Document::new(64, 64, 1 << 20);
        let lo = doc.add_layer(PixelFormat::Rgba8, "lo");
        let hi = doc.add_layer(PixelFormat::Rgba8, "hi");
        let r = Rect::new(0, 0, 1, 1);
        doc.composite_stroke(lo, r, &solid(r, [255, 0, 0, 255]), 1.0, Blend::Normal);
        doc.composite_stroke(hi, r, &solid(r, [0, 0, 255, 255]), 0.5, Blend::Normal);
        // 紙(透明)は白で、絵の具の濃さは 0
        assert_eq!(doc.sample_over_white(1, 5, 5), [1.0, 1.0, 1.0, 0.0]);
        assert_eq!(doc.sample_over_white(1, -1, 0), [1.0, 1.0, 1.0, 0.0]);
        // 下だけ見ると赤
        let lo_only = doc.sample_over_white(0, 0, 0);
        assert!((lo_only[0] - 1.0).abs() < 0.01 && lo_only[2] < 0.01, "{lo_only:?}");
        assert_eq!(lo_only[3], 1.0);
        // 上まで見ると赤と青の半々
        let both = doc.sample_over_white(1, 0, 0);
        assert!((both[0] - 0.5).abs() < 0.02 && (both[2] - 0.5).abs() < 0.02, "{both:?}");
    }

    #[test]
    fn layer_ops_remove_duplicate_move_merge() {
        let mut doc = Document::new(256, 256, 1 << 20);
        let a = doc.add_layer(PixelFormat::Rgba8, "a");
        let b = doc.add_layer(PixelFormat::Rgba8, "b");
        let r = Rect::new(0, 0, 2, 2);
        doc.composite_stroke(b, r, &solid(r, [0, 0, 255, 255]), 1.0, Blend::Normal);
        // 複製は元のすぐ上、画素も同じ
        let c = doc.duplicate_layer(b).unwrap();
        assert_eq!(doc.index_of(c), Some(2));
        assert_eq!(doc.layer(c).unwrap().cel.read_rect(r), doc.layer(b).unwrap().cel.read_rect(r));
        // 並び替え
        assert!(doc.move_layer(c, 0));
        assert_eq!(doc.layers().iter().map(|l| l.id).collect::<Vec<_>>(), vec![c, a, b]);
        // 結合: b を a に
        doc.layer_mut(b).unwrap().opacity = 0.5;
        let (lower, changed) = doc.merge_down(b).unwrap();
        assert_eq!(lower, a);
        assert_eq!(changed.len(), 1);
        assert!(doc.layer(b).is_none());
        let px = doc.layer(a).unwrap().cel.read_rect(r);
        assert!((px[3] as i32 - 128).abs() <= 1, "{px:?}");
        // 結合の画素変更は戻せる
        doc.undo();
        assert_eq!(doc.layer(a).unwrap().cel.tile_count(), 0);
        // 最後の 1 枚は消せない
        assert!(doc.remove_layer(c));
        assert!(!doc.remove_layer(a));
        doc.set_layer_name(a, "下地");
        assert_eq!(doc.layer(a).unwrap().name, "下地");
    }

    #[test]
    fn thumbnail_samples_center() {
        let mut doc = Document::new(512, 512, 1 << 20);
        let a = doc.add_layer(PixelFormat::A8, "ink");
        let r = Rect::new(0, 0, 256, 512);
        doc.composite_stroke(a, r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Normal);
        let th = doc.layer(a).unwrap().cel.thumbnail(4, 2);
        // 左半分は黒インク、右半分は透明
        assert_eq!(th[3], 255);
        assert_eq!(th[1 * 4 + 3], 255);
        assert_eq!(th[2 * 4 + 3], 0);
        assert_eq!(th[3 * 4 + 3], 0);
    }

    #[test]
    fn clear_is_undoable() {
        let mut doc = Document::new(256, 256, 64 << 20);
        let a = doc.add_layer(PixelFormat::Rgba8, "a");
        let r = Rect::new(0, 0, 2, 2);
        doc.composite_stroke(a, r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Normal);
        doc.clear_layer(a);
        assert_eq!(doc.memory_bytes(), 0);
        doc.undo();
        assert_eq!(doc.layer(a).unwrap().cel.tile_count(), 1);
    }
}
