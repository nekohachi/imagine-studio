//! Document: レイヤーの並びと履歴。フェーズ 1 ではラスターレイヤーだけ、フレームは 1 つ。
//! グループ、マスク、ベクターなどの種別は docs/03 に沿って後で足す。

use crate::adjust::{gaussian_blur, unsharp, Adjust};
use crate::blend::{composite_pixel, BlendMode};
use crate::cel::{Blend, Cel, Snapshot};
use crate::history::{Entry, History, Splice};
use crate::selection::{region_by_color, Mask, SelectMode};
use crate::tile::{PixelFormat, Rect, TileKey};
use crate::transform::{resample, Affine, Floating};
use crate::vector::{DabBuf, EraseMode, VStroke};

pub type LayerId = u32;

/// 2 つ目の差分を 1 つ目に足す。同じタイルは先にあった(より古い)状態を残す。
fn merge_snapshot(into: &mut Snapshot, more: Snapshot) {
    for (k, t) in more {
        if !into.iter().any(|(k2, _)| *k2 == k) {
            into.push((k, t));
        }
    }
}

pub struct Layer {
    pub id: LayerId,
    pub name: String,
    pub visible: bool,
    pub opacity: f32,
    /// 合成モード
    pub blend: BlendMode,
    /// 下のレイヤーでクリッピング(下の絵の具がある所だけに描かれる)
    pub clip: bool,
    pub cel: Cel,
    /// ベクターレイヤーなら線の列(cel はその描画キャッシュ)
    pub vector: Option<Vec<VStroke>>,
}

impl Layer {
    fn new(id: LayerId, name: &str, format: PixelFormat, width: u32, height: u32) -> Self {
        Self {
            id,
            name: name.to_string(),
            visible: true,
            opacity: 1.0,
            blend: BlendMode::Normal,
            clip: false,
            cel: Cel::new(format, width, height),
            vector: None,
        }
    }

    pub fn is_vector(&self) -> bool {
        self.vector.is_some()
    }

    /// プリマルチ RGBA8 で矩形を読む(A8 は黒インク)。
    fn read_rgba(&self, rect: Rect) -> Vec<u8> {
        match self.cel.format() {
            PixelFormat::Rgba8 => self.cel.read_rect(rect),
            PixelFormat::A8 => self
                .cel
                .read_rect(rect)
                .into_iter()
                .flat_map(|a| [0, 0, 0, a])
                .collect(),
        }
    }
}

pub struct Document {
    width: u32,
    height: u32,
    /// 下から上の順
    layers: Vec<Layer>,
    next_id: LayerId,
    history: History,
    /// 選択範囲(A8 全面)。None は「全部」
    selection: Option<Cel>,
    /// 変形中に持ち上げている画素
    floating: Option<(LayerId, Floating)>,
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
            selection: None,
            floating: None,
        }
    }

    // ---- 変形 ----

    pub fn floating(&self) -> Option<&Floating> {
        self.floating.as_ref().map(|(_, f)| f)
    }

    /// 選択範囲(無ければ絵のある範囲)を持ち上げる。レイヤーからはその分を消す(履歴に積む)。
    /// 戻り値は持ち上げた矩形。何も無ければ None。
    pub fn begin_transform(&mut self, layer: LayerId) -> Option<Rect> {
        if self.floating.is_some() {
            return None;
        }
        let l = self.layer(layer)?;
        let rect = match &self.selection {
            Some(c) => Mask::from_cel(c).bounds(),
            None => {
                // タイルの範囲から、絵のある所だけに詰める
                let keys = l.cel.keys();
                let mut b = Rect::default();
                for k in keys {
                    b = b.union(&k.rect().intersect(&self.bounds()));
                }
                if b.is_empty() {
                    b
                } else {
                    let px = l.read_rgba(b);
                    let mut m = Mask::new(b.w as u32, b.h as u32);
                    for (d, p) in m.data.iter_mut().zip(px.chunks_exact(4)) {
                        *d = p[3];
                    }
                    let t = m.bounds();
                    if t.is_empty() {
                        t
                    } else {
                        Rect::new(b.x + t.x, b.y + t.y, t.w, t.h)
                    }
                }
            }
        };
        if rect.is_empty() {
            return None;
        }
        let mut data = l.read_rgba(rect);
        let mask = self.selection.as_ref().map(|c| c.read_rect(rect));
        if let Some(m) = &mask {
            for (p, &k) in data.chunks_exact_mut(4).zip(m) {
                if k == 255 {
                    continue;
                }
                for c in 0..4 {
                    p[c] = ((p[c] as u32 * k as u32 + 127) / 255) as u8;
                }
            }
        }
        // 持ち上げた分を消す(マスクの濃さぶんだけ)
        let erase: Vec<u8> = match &mask {
            Some(m) => m.iter().flat_map(|&k| [0, 0, 0, k]).collect(),
            None => vec![255u8; rect.w as usize * rect.h as usize * 4],
        };
        let lm = self.layer_mut(layer)?;
        let snap = lm.cel.composite(rect, &erase, 1.0, Blend::Erase);
        self.record(layer, "変形(持ち上げ)", snap);
        self.floating = Some((layer, Floating { rect, data, mask }));
        Some(rect)
    }

    /// 変形して置く。選択範囲も一緒に動かす。戻り値は変わったタイル。
    pub fn commit_transform(&mut self, m: Affine) -> Vec<TileKey> {
        let Some((layer, f)) = self.floating.take() else { return Vec::new() };
        let dst = m.bounds_of(f.rect).intersect(&self.bounds());
        let mut changed = Vec::new();
        if !dst.is_empty() {
            let px = resample(&f.data, f.rect, 4, &m, dst);
            if let Some(l) = self.layer_mut(layer) {
                let snap = l.cel.composite(dst, &px, 1.0, Blend::Normal);
                changed = self.record(layer, "変形", snap);
            }
            if let Some(mask) = &f.mask {
                let mv = resample(mask, f.rect, 1, &m, dst);
                let mut sel = Mask::new(self.width, self.height);
                for y in 0..dst.h as usize {
                    let row = (dst.y as usize + y) * self.width as usize + dst.x as usize;
                    sel.data[row..row + dst.w as usize]
                        .copy_from_slice(&mv[y * dst.w as usize..(y + 1) * dst.w as usize]);
                }
                self.set_selection_mask(sel);
            }
        } else if f.mask.is_some() {
            self.selection = None;
        }
        changed
    }

    /// 変形をやめて元の場所へ戻す。
    pub fn cancel_transform(&mut self) -> Vec<TileKey> {
        let Some((layer, f)) = self.floating.take() else { return Vec::new() };
        let Some(l) = self.layer_mut(layer) else { return Vec::new() };
        let snap = l.cel.composite(f.rect, &f.data, 1.0, Blend::Normal);
        self.record(layer, "変形(取消)", snap)
    }

    // ---- 選択範囲 ----

    pub fn selection(&self) -> Option<&Cel> {
        self.selection.as_ref()
    }
    pub fn has_selection(&self) -> bool {
        self.selection.is_some()
    }
    pub fn select_none(&mut self) {
        self.selection = None;
    }
    pub fn select_all(&mut self) {
        let mut m = Mask::new(self.width, self.height);
        m.fill_rect(self.bounds(), 255);
        self.selection = Some(m.to_cel());
    }
    pub fn select_invert(&mut self) {
        let mut m = match &self.selection {
            Some(c) => Mask::from_cel(c),
            None => {
                let mut m = Mask::new(self.width, self.height);
                m.fill_rect(self.bounds(), 255);
                m
            }
        };
        m.invert();
        self.set_selection_mask(m);
    }
    fn current_mask(&self) -> Mask {
        match &self.selection {
            Some(c) => Mask::from_cel(c),
            None => Mask::new(self.width, self.height),
        }
    }
    fn set_selection_mask(&mut self, m: Mask) {
        self.selection = if m.is_empty() { None } else { Some(m.to_cel()) };
    }
    fn apply_selection(&mut self, new: Mask, mode: SelectMode) {
        let mut cur = if mode == SelectMode::Replace { Mask::new(self.width, self.height) } else { self.current_mask() };
        cur.combine(&new, if mode == SelectMode::Replace { SelectMode::Add } else { mode });
        self.set_selection_mask(cur);
    }
    pub fn select_rect(&mut self, rect: Rect, mode: SelectMode) {
        let mut m = Mask::new(self.width, self.height);
        m.fill_rect(rect, 255);
        self.apply_selection(m, mode);
    }
    pub fn select_polygon(&mut self, pts: &[(f32, f32)], mode: SelectMode) {
        let mut m = Mask::new(self.width, self.height);
        m.fill_polygon(pts, 255);
        self.apply_selection(m, mode);
    }
    /// 自動選択。`layer` が None なら見えている絵(全レイヤー)で判定する。
    pub fn select_wand(
        &mut self,
        layer: Option<LayerId>,
        x: i32,
        y: i32,
        tolerance: u8,
        contiguous: bool,
        mode: SelectMode,
    ) {
        let px = self.reference_pixels(layer);
        let m = region_by_color(&px, self.width, self.height, x, y, tolerance, contiguous);
        self.apply_selection(m, mode);
    }
    /// 選択範囲を囲む矩形(無ければ全面)。
    pub fn selection_bounds(&self) -> Rect {
        match &self.selection {
            Some(c) => Mask::from_cel(c).bounds(),
            None => self.bounds(),
        }
    }
    /// 塗りや自動選択が見る画素(プリマルチ RGBA8、全面)。
    fn reference_pixels(&self, layer: Option<LayerId>) -> Vec<u8> {
        match layer.and_then(|id| self.layer(id)) {
            Some(l) => l.read_rgba(self.bounds()),
            None => self.flatten_rgba8(self.bounds()),
        }
    }

    // ---- 色調補正とフィルタ(編集中レイヤーに直接。選択範囲があればその中だけ) ----

    /// レイヤーの画素を関数で書き換える(矩形は選択範囲か全面)。履歴に積む。
    fn rewrite_layer(
        &mut self,
        layer: LayerId,
        label: &str,
        f: impl FnOnce(&mut Vec<u8>, usize, usize, Option<&[u8]>),
    ) -> Vec<TileKey> {
        let rect = self.selection_bounds().intersect(&self.bounds());
        if rect.is_empty() {
            return Vec::new();
        }
        let mask = self.selection.as_ref().map(|c| c.read_rect(rect));
        let Some(l) = self.layer(layer) else { return Vec::new() };
        if l.cel.format() != PixelFormat::Rgba8 {
            // モノクロは A8 のまま扱えないので、いまは対象外
            return Vec::new();
        }
        let mut px = l.cel.read_rect(rect);
        let orig = mask.as_ref().map(|_| px.clone());
        f(&mut px, rect.w as usize, rect.h as usize, mask.as_deref());
        // マスクのある所だけ差し替える(フィルタがマスクを無視しても外へ漏れないように)
        if let (Some(m), Some(o)) = (&mask, &orig) {
            for ((p, q), &k) in px.chunks_exact_mut(4).zip(o.chunks_exact(4)).zip(m.iter()) {
                if k == 255 {
                    continue;
                }
                for c in 0..4 {
                    p[c] = ((q[c] as u32 * (255 - k as u32) + p[c] as u32 * k as u32 + 127) / 255) as u8;
                }
            }
        }
        let Some(l) = self.layer_mut(layer) else { return Vec::new() };
        let snap = l.cel.write_rect(rect, &px);
        self.record(layer, label, snap)
    }

    pub fn adjust_layer(&mut self, layer: LayerId, adj: &Adjust) -> Vec<TileKey> {
        if adj.is_identity() {
            return Vec::new();
        }
        self.rewrite_layer(layer, "色調補正", |px, _w, _h, mask| adj.apply_premul(px, mask))
    }

    pub fn blur_layer(&mut self, layer: LayerId, radius: f32) -> Vec<TileKey> {
        self.rewrite_layer(layer, "ぼかし", |px, w, h, _| gaussian_blur(px, w, h, radius))
    }

    pub fn sharpen_layer(&mut self, layer: LayerId, radius: f32, amount: f32) -> Vec<TileKey> {
        self.rewrite_layer(layer, "シャープ", |px, w, h, _| unsharp(px, w, h, radius, amount))
    }

    // ---- 大きさの変更(履歴は捨てる) ----

    /// キャンバスの大きさを変える(画素はそのまま、anchor 0..1 で寄せる)。
    pub fn resize_canvas(&mut self, w: u32, h: u32, ax: f32, ay: f32) {
        let w = w.max(1);
        let h = h.max(1);
        let dx = ((w as f32 - self.width as f32) * ax.clamp(0.0, 1.0)).round() as i32;
        let dy = ((h as f32 - self.height as f32) * ay.clamp(0.0, 1.0)).round() as i32;
        let old = self.bounds();
        for l in &mut self.layers {
            let px = l.cel.read_rect(old);
            let mut cel = Cel::new(l.cel.format(), w, h);
            cel.write_rect(Rect::new(dx, dy, old.w, old.h), &px);
            cel.take_dirty();
            l.cel = cel;
            if let Some(v) = l.vector.as_mut() {
                for s in v.iter_mut() {
                    s.translate(dx as f32, dy as f32);
                }
            }
        }
        self.width = w;
        self.height = h;
        self.selection = None;
        self.floating = None;
        self.history.clear();
    }

    /// 画像の大きさを変える(全レイヤーを再標本化)。
    pub fn resize_image(&mut self, w: u32, h: u32) {
        let w = w.max(1);
        let h = h.max(1);
        let old = self.bounds();
        let m = Affine {
            a: w as f32 / self.width as f32,
            b: 0.0,
            c: 0.0,
            d: h as f32 / self.height as f32,
            e: 0.0,
            f: 0.0,
        };
        let dst = Rect::new(0, 0, w as i32, h as i32);
        for l in &mut self.layers {
            let bpp = l.cel.format().bytes_per_pixel();
            let px = l.cel.read_rect(old);
            let out = resample(&px, old, bpp, &m, dst);
            let mut cel = Cel::new(l.cel.format(), w, h);
            cel.write_rect(dst, &out);
            cel.take_dirty();
            l.cel = cel;
            if let Some(v) = l.vector.as_mut() {
                for s in v.iter_mut() {
                    s.scale(m.a, m.d);
                }
            }
        }
        self.width = w;
        self.height = h;
        self.selection = None;
        self.floating = None;
        self.history.clear();
    }

    // ---- 塗りつぶし ----

    /// バケツ塗り。`reference` が None なら見えている絵で領域を決め、`layer` に塗る。
    #[allow(clippy::too_many_arguments)]
    pub fn fill(
        &mut self,
        layer: LayerId,
        reference: Option<LayerId>,
        x: i32,
        y: i32,
        color: [u8; 4],
        tolerance: u8,
        contiguous: bool,
    ) -> Vec<TileKey> {
        let px = self.reference_pixels(reference);
        let region = region_by_color(&px, self.width, self.height, x, y, tolerance, contiguous);
        self.fill_mask(layer, &region, color)
    }

    /// 選択範囲(無ければ全面)を 1 色で塗る。
    pub fn fill_selection(&mut self, layer: LayerId, color: [u8; 4]) -> Vec<TileKey> {
        let m = match &self.selection {
            Some(c) => Mask::from_cel(c),
            None => {
                let mut m = Mask::new(self.width, self.height);
                m.fill_rect(self.bounds(), 255);
                m
            }
        };
        self.fill_mask(layer, &m, color)
    }

    fn fill_mask(&mut self, layer: LayerId, region: &Mask, color: [u8; 4]) -> Vec<TileKey> {
        let b = region.bounds();
        if b.is_empty() {
            return Vec::new();
        }
        // 領域のアルファ × 色(プリマルチ)の矩形を作って焼く。選択範囲でも絞る
        let mut src = vec![0u8; b.w as usize * b.h as usize * 4];
        for y in 0..b.h as usize {
            for x in 0..b.w as usize {
                let k = region.data[(b.y as usize + y) * region.width as usize + b.x as usize + x] as u32;
                if k == 0 {
                    continue;
                }
                let o = (y * b.w as usize + x) * 4;
                for c in 0..4 {
                    src[o + c] = ((color[c] as u32 * k + 127) / 255) as u8;
                }
            }
        }
        let sel = self.selection.take();
        let Some(l) = self.layer_mut(layer) else {
            self.selection = sel;
            return Vec::new();
        };
        let snap = l.cel.composite_masked(b, &src, 1.0, Blend::Normal, sel.as_ref());
        self.selection = sel;
        self.record(layer, "塗りつぶし", snap)
    }

    /// 選択範囲の中を消す。選択が無ければ何もしない(全部消すのは clear_layer)。
    pub fn delete_selection(&mut self, layer: LayerId) -> Vec<TileKey> {
        if self.selection.is_none() {
            return Vec::new();
        }
        let b = self.selection_bounds();
        if b.is_empty() {
            return Vec::new();
        }
        let src = vec![255u8; b.w as usize * b.h as usize * 4];
        let sel = self.selection.take();
        let Some(l) = self.layer_mut(layer) else {
            self.selection = sel;
            return Vec::new();
        };
        let snap = l.cel.composite_masked(b, &src, 1.0, Blend::Erase, sel.as_ref());
        self.selection = sel;
        self.record(layer, "消去", snap)
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
        self.layers
            .push(Layer::new(id, name, format, self.width, self.height));
        id
    }

    pub fn set_layer_blend(&mut self, id: LayerId, blend: BlendMode) {
        if let Some(l) = self.layer_mut(id) {
            l.blend = blend;
        }
    }

    pub fn set_layer_clip(&mut self, id: LayerId, clip: bool) {
        if let Some(l) = self.layer_mut(id) {
            l.clip = clip;
        }
    }

    /// クリッピングの土台(このレイヤーの下で、最初のクリッピングでないレイヤー)。
    pub fn clip_base_of(&self, id: LayerId) -> Option<LayerId> {
        let i = self.index_of(id)?;
        if !self.layers[i].clip {
            return None;
        }
        self.layers[..i].iter().rev().find(|l| !l.clip).map(|l| l.id)
    }

    /// レイヤーのアルファだけ(A8、全面)。GPU でクリッピングの土台に使う。
    pub fn layer_alpha(&self, id: LayerId) -> Vec<u8> {
        let n = self.width as usize * self.height as usize;
        let Some(l) = self.layer(id) else { return vec![0; n] };
        let rect = self.bounds();
        match l.cel.format() {
            PixelFormat::A8 => l.cel.read_rect(rect),
            PixelFormat::Rgba8 => l.cel.read_rect(rect).chunks_exact(4).map(|p| p[3]).collect(),
        }
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
        let mut l = Layer::new(id, name, format, self.width, self.height);
        l.visible = visible;
        l.opacity = opacity.clamp(0.0, 1.0);
        self.layers.push(l);
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
            blend: src.blend,
            clip: src.clip,
            cel,
            vector: src.vector.clone(),
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
        // 結合先がベクターなら: 上もベクターで通常合成なら線を足す、そうでなければラスターになる
        if self.layers[i - 1].vector.is_some() {
            let same = upper.vector.is_some() && upper.blend == BlendMode::Normal && !upper.clip && upper.opacity >= 1.0;
            if same && upper.visible {
                let strokes = upper.vector.clone().unwrap_or_default();
                self.layers[i - 1].vector.as_mut().unwrap().extend(strokes);
            } else if !(same && !upper.visible) {
                self.layers[i - 1].vector = None;
            }
        }
        if !upper.visible || upper.opacity <= 0.0 {
            return Some((lower_id, Vec::new()));
        }
        let mut all_changed = Vec::new();
        for k in upper.cel.keys() {
            if upper.cel.tile(k).is_none() {
                continue;
            }
            // タイルをプリマルチ RGBA8 の矩形にして、上のレイヤーの合成モードで焼く
            let rect = k.rect().intersect(&self.bounds());
            if rect.is_empty() {
                continue;
            }
            let src = upper.read_rgba(rect);
            let lower = &mut self.layers[i - 1];
            let snap = if upper.blend == BlendMode::Normal && !upper.clip && lower.cel.format() == PixelFormat::Rgba8 {
                lower.cel.composite(rect, &src, upper.opacity, Blend::Normal)
            } else {
                // モード付き: 下の画素を読んで画素ごとに合成し、書き戻す
                let mut dst = lower.read_rgba(rect);
                for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
                    let op = if upper.clip { upper.opacity * d[3] as f32 / 255.0 } else { upper.opacity };
                    composite_pixel(upper.blend, d, s, op);
                }
                match lower.cel.format() {
                    PixelFormat::Rgba8 => lower.cel.write_rect(rect, &dst),
                    PixelFormat::A8 => {
                        let a: Vec<u8> = dst.chunks_exact(4).map(|p| p[3]).collect();
                        lower.cel.write_rect(rect, &a)
                    }
                }
            };
            let keys: Vec<_> = snap.iter().map(|(k, _)| *k).collect();
            self.history.push(Entry {
                label: "結合".into(),
                layer: lower_id,
                tiles: snap,
                vector: None,
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
            vector: None,
        });
        keys
    }

    // ---- ベクターレイヤー ----

    /// 一番上にベクターレイヤーを足す。
    pub fn add_vector_layer(&mut self, format: PixelFormat, name: &str) -> LayerId {
        let id = self.add_layer(format, name);
        if let Some(l) = self.layer_mut(id) {
            l.vector = Some(Vec::new());
        }
        id
    }

    pub fn vector_strokes(&self, layer: LayerId) -> Option<&[VStroke]> {
        self.layer(layer)?.vector.as_deref()
    }

    /// 線を 1 本足して、そのダブ列を焼く。`hardness` と `opacity` はブラシのもの。
    /// 選択範囲は見ない(線は丸ごと持つので、画素だけ絞ると描き直しで戻ってしまう)。
    pub fn vector_add_stroke(
        &mut self,
        layer: LayerId,
        stroke: VStroke,
        dabs: &[f32],
        hardness: f32,
        opacity: f32,
    ) -> Vec<TileKey> {
        let bounds = self.bounds();
        let Some(l) = self.layer_mut(layer) else { return Vec::new() };
        let Some(v) = l.vector.as_mut() else { return Vec::new() };
        let at = v.len();
        v.push(stroke);
        let rect = DabBuf::dabs_bounds(dabs).intersect(&bounds);
        let snap = if rect.is_empty() {
            Vec::new()
        } else {
            let mut buf = DabBuf::new(rect);
            buf.stamp(dabs, hardness);
            l.cel.composite_masked(rect, &buf.data, opacity, Blend::Normal, None)
        };
        let keys: Vec<_> = snap.iter().map(|(k, _)| *k).collect();
        self.history.push(Entry {
            label: "線".into(),
            layer,
            tiles: snap,
            vector: Some(Splice { at, len: 1, old: Vec::new() }),
        });
        keys
    }

    /// `rect` の画素を消して、そこに掛かる線を順に描き直す。`dabs_of` は線からダブ列と
    /// (硬さ, 不透明度)を作る(ブラシエンジンは呼び出し側)。戻り値はタイルの差分。
    fn vector_redraw<F>(&mut self, layer: LayerId, rect: Rect, dabs_of: &mut F) -> Snapshot
    where
        F: FnMut(&VStroke) -> (Vec<f32>, f32, f32),
    {
        let rect = rect.intersect(&self.bounds());
        let Some(l) = self.layer_mut(layer) else { return Vec::new() };
        let Some(v) = l.vector.as_ref() else { return Vec::new() };
        if rect.is_empty() {
            return Vec::new();
        }
        let bpp = l.cel.format().bytes_per_pixel();
        let zero = vec![0u8; rect.w as usize * rect.h as usize * bpp];
        let mut snap = l.cel.write_rect(rect, &zero);
        let strokes: Vec<&VStroke> = v.iter().filter(|s| !s.paint_bounds().intersect(&rect).is_empty()).collect();
        let mut extra = Vec::new();
        for s in strokes {
            let (dabs, hardness, opacity) = dabs_of(s);
            if dabs.is_empty() {
                continue;
            }
            let mut buf = DabBuf::new(rect);
            buf.stamp(&dabs, hardness);
            extra.push(l.cel.composite_masked(rect, &buf.data, opacity, Blend::Normal, None));
        }
        for more in extra {
            merge_snapshot(&mut snap, more);
        }
        snap
    }

    /// ベクター消しゴム。何も触れなければ None。
    pub fn vector_erase<F>(
        &mut self,
        layer: LayerId,
        path: &[f32],
        radius: f32,
        mode: EraseMode,
        mut dabs_of: F,
    ) -> Option<Vec<TileKey>>
    where
        F: FnMut(&VStroke) -> (Vec<f32>, f32, f32),
    {
        let strokes = self.layer(layer)?.vector.as_ref()?;
        let r = crate::vector::erase(strokes, path, radius, mode)?;
        let v = self.layer_mut(layer)?.vector.as_mut()?;
        let old: Vec<VStroke> = v.splice(r.range.clone(), r.replaced.iter().cloned()).collect();
        let snap = self.vector_redraw(layer, r.dirty, &mut dabs_of);
        let keys: Vec<_> = snap.iter().map(|(k, _)| *k).collect();
        self.history.push(Entry {
            label: "ベクター消去".into(),
            layer,
            tiles: snap,
            vector: Some(Splice {
                at: r.range.start,
                len: r.replaced.len(),
                old,
            }),
        });
        Some(keys)
    }

    /// 線を書き換えて(`edit`)、全部描き直す。線幅の後編集などに使う。
    pub fn vector_edit_all<E, F>(&mut self, layer: LayerId, label: &str, edit: E, mut dabs_of: F) -> Vec<TileKey>
    where
        E: Fn(&mut VStroke),
        F: FnMut(&VStroke) -> (Vec<f32>, f32, f32),
    {
        let Some(l) = self.layer_mut(layer) else { return Vec::new() };
        let Some(v) = l.vector.as_mut() else { return Vec::new() };
        if v.is_empty() {
            return Vec::new();
        }
        let old = v.clone();
        let mut dirty = old[0].paint_bounds();
        for s in v.iter_mut() {
            dirty = dirty.union(&s.paint_bounds());
            edit(s);
            dirty = dirty.union(&s.paint_bounds());
        }
        let n = v.len();
        let snap = self.vector_redraw(layer, dirty, &mut dabs_of);
        let keys: Vec<_> = snap.iter().map(|(k, _)| *k).collect();
        self.history.push(Entry {
            label: label.to_string(),
            layer,
            tiles: snap,
            vector: Some(Splice { at: 0, len: n, old }),
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
        let sel = self.selection.take();
        let Some(l) = self.layer_mut(layer) else {
            self.selection = sel;
            return Vec::new();
        };
        let snap = l.cel.composite_masked(rect, src, opacity, blend, sel.as_ref());
        self.selection = sel;
        self.record(layer, "ストローク", snap)
    }

    pub fn clear_layer(&mut self, layer: LayerId) -> Vec<TileKey> {
        let Some(l) = self.layer_mut(layer) else { return Vec::new() };
        let snap = l.cel.clear();
        // ベクターなら線も消す(履歴で一緒に戻る)
        let vector = l.vector.as_mut().map(|v| Splice {
            at: 0,
            len: 0,
            old: std::mem::take(v),
        });
        let keys: Vec<_> = snap.iter().map(|(k, _)| *k).collect();
        self.history.push(Entry {
            label: "消去".into(),
            layer,
            tiles: snap,
            vector,
        });
        keys
    }

    /// ベクターレイヤーをラスターにする(線を捨てて画素だけ残す)。履歴は捨てる。
    pub fn rasterize_layer(&mut self, layer: LayerId) -> bool {
        let Some(l) = self.layer_mut(layer) else { return false };
        if l.vector.take().is_none() {
            return false;
        }
        self.history.clear();
        true
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
            if let (Some(sp), Some(v)) = (e.vector.take(), l.vector.as_mut()) {
                let end = (sp.at + sp.len).min(v.len());
                let at = sp.at.min(end);
                let n = sp.old.len();
                let removed: Vec<VStroke> = v.splice(at..end, sp.old).collect();
                e.vector = Some(Splice { at, len: n, old: removed });
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

    /// 並び `from..to`(下から数えた添字)のレイヤーだけをまとめる(透明の上に)。
    /// 編集中レイヤーの「下」「上」をそれぞれ 1 枚にするのに使う(docs/02 の 3 枚方式)。
    /// 合成モードは下に絵の具がある所だけに効く。クリッピングは土台のアルファで絞る。
    pub fn flatten_range(&self, from: usize, to: usize, rect: Rect) -> Vec<u8> {
        self.flatten_onto(from, to, rect, None)
    }

    /// 白い紙の上にまとめる(表示用。乗算などが紙の上で正しく見える)。
    pub fn flatten_range_on_white(&self, from: usize, to: usize, rect: Rect) -> Vec<u8> {
        self.flatten_onto(from, to, rect, Some([255, 255, 255, 255]))
    }

    fn flatten_onto(&self, from: usize, to: usize, rect: Rect, base: Option<[u8; 4]>) -> Vec<u8> {
        let n = rect.w.max(0) as usize * rect.h.max(0) as usize;
        let mut out = vec![0u8; n * 4];
        if let Some(b) = base {
            for p in out.chunks_exact_mut(4) {
                p.copy_from_slice(&b);
            }
        }
        let to = to.min(self.layers.len());
        if from >= to {
            return out;
        }
        let mut i = from;
        while i < to {
            let l = &self.layers[i];
            // クリッピングのかたまり: 土台 + その上に続くクリップ付きレイヤー
            let mut j = i + 1;
            while j < to && self.layers[j].clip {
                j += 1;
            }
            if l.visible && l.opacity > 0.0 {
                if j == i + 1 {
                    let px = l.read_rgba(rect);
                    for (d, s) in out.chunks_exact_mut(4).zip(px.chunks_exact(4)) {
                        composite_pixel(l.blend, d, s, l.opacity);
                    }
                } else {
                    // 土台をコピーし、クリップ付きを土台のアルファで絞って重ね、かたまりごと合成する
                    let mut group = l.read_rgba(rect);
                    for c in &self.layers[i + 1..j] {
                        if !c.visible || c.opacity <= 0.0 {
                            continue;
                        }
                        let px = c.read_rgba(rect);
                        let base_alpha: Vec<u8> = group.chunks_exact(4).map(|p| p[3]).collect();
                        for ((d, s), ba) in group.chunks_exact_mut(4).zip(px.chunks_exact(4)).zip(base_alpha.iter()) {
                            // 土台の無い所には描かれない
                            composite_pixel(c.blend, d, s, c.opacity * (*ba as f32 / 255.0));
                        }
                    }
                    // クリップ付きが土台の外へはみ出さないように、土台の元のアルファで切る
                    let base_px = l.read_rgba(rect);
                    for (g, b) in group.chunks_exact_mut(4).zip(base_px.chunks_exact(4)) {
                        if g[3] > b[3] {
                            let k = b[3] as f32 / g[3] as f32;
                            for c in 0..4 {
                                g[c] = (g[c] as f32 * k + 0.5) as u8;
                            }
                        }
                    }
                    for (d, s) in out.chunks_exact_mut(4).zip(group.chunks_exact(4)) {
                        composite_pixel(l.blend, d, s, l.opacity);
                    }
                }
            }
            i = j;
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
    fn flatten_with_blend_mode_and_clipping() {
        let mut doc = Document::new(64, 64, 1 << 20);
        let base = doc.add_layer(PixelFormat::Rgba8, "base");
        let shade = doc.add_layer(PixelFormat::Rgba8, "shade");
        let r_base = Rect::new(0, 0, 2, 1); // 土台は左 2 画素だけ
        let r_all = Rect::new(0, 0, 4, 1);
        doc.composite_stroke(base, r_base, &solid(r_base, [255, 255, 255, 255]), 1.0, Blend::Normal);
        doc.composite_stroke(shade, r_all, &solid(r_all, [128, 128, 128, 255]), 1.0, Blend::Normal);
        doc.set_layer_blend(shade, BlendMode::Multiply);
        doc.set_layer_clip(shade, true);
        assert_eq!(doc.clip_base_of(shade), Some(base));
        assert_eq!(doc.clip_base_of(base), None);
        let px = doc.flatten_rgba8(r_all);
        // 土台のある所: 白 × 灰 = 灰。土台の無い所: クリップで何も無い
        assert!((px[0] as i32 - 128).abs() <= 1 && px[3] == 255, "{px:?}");
        assert_eq!(px[2 * 4 + 3], 0, "{px:?}");
        // クリップを外すと、土台の無い所は通常で描かれる
        doc.set_layer_clip(shade, false);
        let px = doc.flatten_rgba8(r_all);
        assert_eq!(px[2 * 4 + 3], 255);
        assert!((px[2 * 4] as i32 - 128).abs() <= 1);
        // 紙の上では乗算が白に効く
        let on_white = doc.flatten_range_on_white(0, 2, r_all);
        assert!((on_white[2 * 4] as i32 - 128).abs() <= 1, "{on_white:?}");
        // アルファのマスク
        let a = doc.layer_alpha(base);
        assert_eq!(a.len(), 64 * 64);
        assert_eq!(a[0], 255);
        assert_eq!(a[3], 0);
        // モード付きの結合も同じ見た目になる
        doc.set_layer_clip(shade, true);
        let before = doc.flatten_rgba8(r_all);
        doc.merge_down(shade).unwrap();
        assert_eq!(doc.flatten_rgba8(r_all), before);
    }

    #[test]
    fn selection_limits_strokes_and_fill_and_delete() {
        let mut doc = Document::new(64, 64, 1 << 20);
        let a = doc.add_layer(PixelFormat::Rgba8, "a");
        // 左半分だけ選ぶ
        doc.select_rect(Rect::new(0, 0, 32, 64), SelectMode::Replace);
        assert!(doc.has_selection());
        assert_eq!(doc.selection_bounds(), Rect::new(0, 0, 32, 64));
        let r = Rect::new(0, 0, 64, 1);
        doc.composite_stroke(a, r, &solid(r, [0, 0, 0, 255]), 1.0, Blend::Normal);
        let px = doc.layer(a).unwrap().cel.read_rect(r);
        assert_eq!(px[3], 255, "選択の中は描ける");
        assert_eq!(px[40 * 4 + 3], 0, "選択の外は描けない");
        // 足す・引く・反転
        doc.select_rect(Rect::new(32, 0, 32, 32), SelectMode::Add);
        assert_eq!(doc.selection_bounds().w, 64);
        doc.select_rect(Rect::new(0, 0, 64, 32), SelectMode::Subtract);
        assert_eq!(doc.selection_bounds(), Rect::new(0, 32, 32, 32));
        doc.select_invert();
        assert_eq!(doc.selection_bounds(), Rect::new(0, 0, 64, 64));
        doc.select_none();
        assert!(!doc.has_selection());
        // 自動選択: 黒い線の上を選ぶと線だけ、透明を選ぶと残り全部
        doc.select_wand(Some(a), 5, 0, 0, true, SelectMode::Replace);
        assert_eq!(doc.selection_bounds(), Rect::new(0, 0, 32, 1));
        doc.select_wand(Some(a), 40, 40, 0, true, SelectMode::Replace);
        assert_eq!(doc.selection_bounds(), Rect::new(0, 0, 64, 64));
        // 塗りつぶし: 透明の所に赤。線は残る
        doc.select_none();
        let changed = doc.fill(a, Some(a), 40, 40, [255, 0, 0, 255], 0, true);
        assert!(!changed.is_empty());
        let px = doc.layer(a).unwrap().cel.read_rect(Rect::new(0, 0, 64, 2));
        assert_eq!(&px[0..4], &[0, 0, 0, 255], "線はそのまま");
        assert_eq!(&px[64 * 4..64 * 4 + 4], &[255, 0, 0, 255], "2 行目は赤");
        // 戻せる
        doc.undo();
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(0, 1, 1, 1))[3], 0);
        // 選択範囲を塗る、消す
        doc.select_rect(Rect::new(10, 10, 4, 4), SelectMode::Replace);
        doc.fill_selection(a, [0, 255, 0, 255]);
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(12, 12, 1, 1)), vec![0, 255, 0, 255]);
        doc.delete_selection(a);
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(12, 12, 1, 1))[3], 0);
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(0, 0, 1, 1))[3], 255, "選択の外は残る");
    }

    #[test]
    fn transform_lifts_moves_and_cancels() {
        let mut doc = Document::new(64, 64, 1 << 20);
        let a = doc.add_layer(PixelFormat::Rgba8, "a");
        let r = Rect::new(10, 10, 4, 4);
        doc.composite_stroke(a, r, &solid(r, [0, 0, 255, 255]), 1.0, Blend::Normal);
        // 全体を持ち上げると元は消える
        let lifted = doc.begin_transform(a).unwrap();
        assert_eq!(lifted, r, "選択が無ければ絵のある範囲");
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(r)[3], 0);
        assert!(doc.floating().is_some());
        assert!(doc.begin_transform(a).is_none(), "二重には持ち上げない");
        // 右へ 20 動かして置く
        let m = Affine { e: 20.0, ..Affine::IDENTITY };
        let changed = doc.commit_transform(m);
        assert!(!changed.is_empty());
        assert!(doc.floating().is_none());
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(30, 10, 1, 1)), vec![0, 0, 255, 255]);
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(10, 10, 1, 1))[3], 0);
        // 戻すと 2 段階(置く、持ち上げ)で元に戻る
        doc.undo();
        doc.undo();
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(10, 10, 1, 1))[3], 255);
        // 選択範囲つき: 選択だけ持ち上がり、選択も一緒に動く
        doc.select_rect(Rect::new(10, 10, 2, 4), SelectMode::Replace);
        let lifted = doc.begin_transform(a).unwrap();
        assert_eq!(lifted, Rect::new(10, 10, 2, 4));
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(12, 10, 1, 1))[3], 255, "選択の外は残る");
        doc.commit_transform(Affine { f: 30.0, ..Affine::IDENTITY });
        assert_eq!(doc.selection_bounds(), Rect::new(10, 40, 2, 4));
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(10, 40, 1, 1))[3], 255);
        // 取消は元の場所へ戻す
        doc.select_none();
        doc.begin_transform(a).unwrap();
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(10, 40, 1, 1))[3], 0);
        doc.cancel_transform();
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(10, 40, 1, 1))[3], 255);
    }

    #[test]
    fn adjust_blur_and_resize() {
        let mut doc = Document::new(32, 32, 1 << 20);
        let a = doc.add_layer(PixelFormat::Rgba8, "a");
        let r = Rect::new(0, 0, 32, 32);
        doc.composite_stroke(a, r, &solid(r, [100, 100, 100, 255]), 1.0, Blend::Normal);
        // 明るさ(選択範囲の中だけ)
        doc.select_rect(Rect::new(0, 0, 16, 32), SelectMode::Replace);
        let adj = Adjust { brightness: 0.5, ..Default::default() };
        assert!(!doc.adjust_layer(a, &adj).is_empty());
        let px = doc.layer(a).unwrap().cel.read_rect(Rect::new(0, 0, 32, 1));
        assert!(px[0] > 200, "{}", px[0]);
        assert_eq!(px[20 * 4], 100, "選択の外は変わらない");
        doc.undo();
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(0, 0, 1, 1))[0], 100);
        doc.select_none();
        // ぼかし: 境界が滑らかになる
        doc.clear_layer(a);
        let half = Rect::new(0, 0, 16, 32);
        doc.composite_stroke(a, half, &solid(half, [0, 0, 0, 255]), 1.0, Blend::Normal);
        doc.blur_layer(a, 4.0);
        let px = doc.layer(a).unwrap().cel.read_rect(Rect::new(14, 5, 4, 1));
        assert!(px[3] > px[3 * 4 + 3] && px[3 * 4 + 3] > 0, "{px:?}");
        // キャンバスの大きさ: 右下に寄せる
        doc.resize_canvas(64, 64, 1.0, 1.0);
        assert_eq!(doc.width(), 64);
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(32, 40, 1, 1))[3], 255);
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(0, 0, 1, 1))[3], 0);
        // 画像の大きさ: 半分にしても左上の黒は残る
        doc.resize_image(32, 32);
        assert_eq!(doc.height(), 32);
        assert_eq!(doc.layer(a).unwrap().cel.read_rect(Rect::new(17, 20, 1, 1))[3], 255);
        assert!(!doc.history().can_undo());
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

    /// 線 1 本ぶんのダブ列(等間隔の円)。ブラシエンジンの代わり。
    fn dabs_of_line(s: &VStroke) -> (Vec<f32>, f32, f32) {
        let r = s.size();
        let mut out = Vec::new();
        for i in 0..s.len().saturating_sub(1) {
            let (ax, ay) = s.point(i);
            let (bx, by) = s.point(i + 1);
            let n = (((bx - ax).hypot(by - ay)) / (r * 0.3)).ceil().max(1.0) as usize;
            for k in 0..n {
                let t = k as f32 / n as f32;
                out.extend_from_slice(&[ax + (bx - ax) * t, ay + (by - ay) * t, r, 1.0, 0.0, 1.0, 0.0, 0.0]);
            }
        }
        (out, 1.0, 1.0)
    }

    fn vline(x0: f32, y0: f32, x1: f32, y1: f32) -> VStroke {
        let mut points = Vec::new();
        for i in 0..11 {
            let t = i as f32 / 10.0;
            points.extend_from_slice(&[x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, 1.0, i as f32 * 8.0, 0.0, 0.0]);
        }
        VStroke { brush: r#"{"size":3}"#.into(), color: [0, 0, 0], points }
    }

    #[test]
    fn vector_layer_add_erase_undo_roundtrip() {
        let mut doc = Document::new(300, 300, 8 << 20);
        let v = doc.add_vector_layer(PixelFormat::Rgba8, "線画");
        assert!(doc.layer(v).unwrap().is_vector());
        let s = vline(20.0, 150.0, 280.0, 150.0);
        let (dabs, h, o) = dabs_of_line(&s);
        let keys = doc.vector_add_stroke(v, s, &dabs, h, o);
        assert!(!keys.is_empty());
        let px = |d: &Document, x: i32, y: i32| d.layer(v).unwrap().cel.read_rect(Rect::new(x, y, 1, 1))[3];
        assert_eq!(px(&doc, 150, 150), 255);
        assert_eq!(doc.vector_strokes(v).unwrap().len(), 1);
        // 真ん中を消す → 画素が消え、線が 2 本になる
        let path = [150.0, 140.0, 1.0, 0.0, 0.0, 0.0, 150.0, 160.0, 1.0, 8.0, 0.0, 0.0];
        let keys = doc.vector_erase(v, &path, 4.0, EraseMode::Normal, dabs_of_line).unwrap();
        assert!(!keys.is_empty());
        assert_eq!(px(&doc, 150, 150), 0, "消えた所");
        assert_eq!(px(&doc, 40, 150), 255, "残った所は描き直されている");
        assert_eq!(doc.vector_strokes(v).unwrap().len(), 2);
        // Undo で線も画素も戻る
        doc.undo();
        assert_eq!(px(&doc, 150, 150), 255);
        assert_eq!(doc.vector_strokes(v).unwrap().len(), 1);
        doc.redo();
        assert_eq!(doc.vector_strokes(v).unwrap().len(), 2);
        assert_eq!(px(&doc, 150, 150), 0);
        doc.undo();
        doc.undo();
        assert_eq!(doc.vector_strokes(v).unwrap().len(), 0);
        assert_eq!(doc.layer(v).unwrap().cel.tile_count(), 0);
        doc.redo();
        // 線幅を倍に → 太くなる
        doc.vector_edit_all(v, "太く", |s| { let z = s.size(); s.set_brush_number("size", z * 2.0); }, dabs_of_line);
        assert!((doc.vector_strokes(v).unwrap()[0].size() - 6.0).abs() < 1e-5);
        assert_eq!(px(&doc, 150, 153), 255);
        doc.undo();
        assert_eq!(px(&doc, 150, 153), 0);
        // 保存と読み込み
        let bytes = crate::io::imst::save(&doc);
        let back = crate::io::imst::load(&bytes, 1 << 20).unwrap();
        assert_eq!(back.vector_strokes(v).unwrap(), doc.vector_strokes(v).unwrap());
        assert_eq!(px(&back, 150, 150), 255);
        // 触れた線を消す / 複製はベクターを引き継ぐ
        let d = doc.duplicate_layer(v).unwrap();
        assert!(doc.layer(d).unwrap().is_vector());
        assert!(doc.vector_erase(d, &path, 4.0, EraseMode::Touch, dabs_of_line).is_some());
        assert_eq!(doc.vector_strokes(d).unwrap().len(), 0);
        assert_eq!(doc.layer(d).unwrap().cel.tile_count(), 0);
    }
}
