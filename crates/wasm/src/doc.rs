//! canvas-core の Document を JS から使う結合。
//!
//! タイルの画素は `tile_view` で wasm メモリへの「眺め」を返す(コピーしない)。
//! 眺めは wasm メモリが伸びると無効になるので、受け取ったらすぐ texSubImage2D に渡し、
//! 持ち越さないこと。

use canvas_core::{Blend, BlendMode, Document, PixelFormat, Rect, SelectMode, TileKey};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct Doc {
    inner: Document,
}

impl Doc {
    pub(crate) fn inner(&self) -> &Document {
        &self.inner
    }
}

fn keys_to_array(keys: &[TileKey]) -> js_sys::Int32Array {
    let mut v = Vec::with_capacity(keys.len() * 2);
    for k in keys {
        v.push(k.tx);
        v.push(k.ty);
    }
    js_sys::Int32Array::from(v.as_slice())
}

fn changed_to_array(changed: &[(u32, TileKey)]) -> js_sys::Int32Array {
    let mut v = Vec::with_capacity(changed.len() * 3);
    for (layer, k) in changed {
        v.push(*layer as i32);
        v.push(k.tx);
        v.push(k.ty);
    }
    js_sys::Int32Array::from(v.as_slice())
}

#[wasm_bindgen]
impl Doc {
    #[wasm_bindgen(constructor)]
    pub fn new(width: u32, height: u32, history_mb: u32) -> Doc {
        Doc {
            inner: Document::new(width, height, (history_mb as usize) << 20),
        }
    }

    /// `.imst` のバイト列から復元する。
    pub fn load(bytes: &[u8], history_mb: u32) -> Result<Doc, JsError> {
        canvas_core::io::imst::load(bytes, (history_mb as usize) << 20)
            .map(|inner| Doc { inner })
            .map_err(|e| JsError::new(&e))
    }

    /// `.imst` のバイト列にする。
    pub fn save(&self) -> js_sys::Uint8Array {
        let v = canvas_core::io::imst::save(&self.inner);
        js_sys::Uint8Array::from(v.as_slice())
    }

    #[wasm_bindgen(getter)]
    pub fn width(&self) -> u32 {
        self.inner.width()
    }
    #[wasm_bindgen(getter)]
    pub fn height(&self) -> u32 {
        self.inner.height()
    }

    /// 一番上にレイヤーを足す。`a8` が真ならモノクロ 1 チャンネル。
    pub fn add_layer(&mut self, a8: bool, name: &str) -> u32 {
        let f = if a8 { PixelFormat::A8 } else { PixelFormat::Rgba8 };
        self.inner.add_layer(f, name)
    }

    /// レイヤー id の並び(下から上)。
    pub fn layer_ids(&self) -> js_sys::Uint32Array {
        let v: Vec<u32> = self.inner.layers().iter().map(|l| l.id).collect();
        js_sys::Uint32Array::from(v.as_slice())
    }

    pub fn layer_name(&self, id: u32) -> String {
        self.inner.layer(id).map(|l| l.name.clone()).unwrap_or_default()
    }

    pub fn layer_index(&self, id: u32) -> i32 {
        self.inner.index_of(id).map_or(-1, |i| i as i32)
    }

    /// 0 = RGBA8、1 = A8、-1 = 無い。
    pub fn layer_format(&self, id: u32) -> i32 {
        match self.inner.layer(id).map(|l| l.cel.format()) {
            Some(PixelFormat::Rgba8) => 0,
            Some(PixelFormat::A8) => 1,
            None => -1,
        }
    }

    pub fn set_layer_visible(&mut self, id: u32, visible: bool) {
        if let Some(l) = self.inner.layer_mut(id) {
            l.visible = visible;
        }
    }
    pub fn layer_visible(&self, id: u32) -> bool {
        self.inner.layer(id).is_some_and(|l| l.visible)
    }
    pub fn set_layer_opacity(&mut self, id: u32, opacity: f32) {
        if let Some(l) = self.inner.layer_mut(id) {
            l.opacity = opacity.clamp(0.0, 1.0);
        }
    }
    pub fn layer_opacity(&self, id: u32) -> f32 {
        self.inner.layer(id).map_or(1.0, |l| l.opacity)
    }

    pub fn set_layer_name(&mut self, id: u32, name: &str) {
        self.inner.set_layer_name(id, name);
    }
    /// 合成モード(BlendMode::ALL の添字)。
    pub fn layer_blend(&self, id: u32) -> u32 {
        self.inner.layer(id).map_or(0, |l| l.blend.index())
    }
    pub fn set_layer_blend(&mut self, id: u32, index: u32) {
        self.inner.set_layer_blend(id, BlendMode::from_index(index));
    }
    /// 合成モードの名前の一覧(添字順)。
    pub fn blend_names() -> js_sys::Array {
        BlendMode::ALL.iter().map(|m| JsValue::from_str(m.name())).collect()
    }
    pub fn layer_clip(&self, id: u32) -> bool {
        self.inner.layer(id).is_some_and(|l| l.clip)
    }
    pub fn set_layer_clip(&mut self, id: u32, clip: bool) {
        self.inner.set_layer_clip(id, clip);
    }
    /// クリッピングの土台の id(無ければ 0)。
    pub fn clip_base(&self, id: u32) -> u32 {
        self.inner.clip_base_of(id).unwrap_or(0)
    }
    /// レイヤーのアルファ(A8、全面)。
    pub fn layer_alpha(&self, id: u32) -> js_sys::Uint8Array {
        js_sys::Uint8Array::from(self.inner.layer_alpha(id).as_slice())
    }
    /// 白い紙の上にまとめた RGBA8(表示用、不透明)。
    pub fn flatten_range_on_white(&self, from: u32, to: u32, x: i32, y: i32, w: i32, h: i32) -> js_sys::Uint8Array {
        let v = self
            .inner
            .flatten_range_on_white(from as usize, to as usize, Rect::new(x, y, w, h));
        js_sys::Uint8Array::from(v.as_slice())
    }
    pub fn remove_layer(&mut self, id: u32) -> bool {
        self.inner.remove_layer(id)
    }
    /// 複製して元のすぐ上に置く。新しい id(失敗は 0)。
    pub fn duplicate_layer(&mut self, id: u32) -> u32 {
        self.inner.duplicate_layer(id).unwrap_or(0)
    }
    pub fn move_layer(&mut self, id: u32, to: u32) -> bool {
        self.inner.move_layer(id, to as usize)
    }
    /// 下へ結合。戻り値は [下のレイヤー id, tx, ty, ...]。失敗は長さ 0。
    pub fn merge_down(&mut self, id: u32) -> js_sys::Int32Array {
        match self.inner.merge_down(id) {
            Some((lower, keys)) => {
                let mut v = vec![lower as i32];
                for k in keys {
                    v.push(k.tx);
                    v.push(k.ty);
                }
                js_sys::Int32Array::from(v.as_slice())
            }
            None => js_sys::Int32Array::new_with_length(0),
        }
    }
    /// 縮小見本(プリマルチ RGBA8、tw × th)。
    pub fn thumbnail(&self, id: u32, tw: u32, th: u32) -> js_sys::Uint8Array {
        match self.inner.layer(id) {
            Some(l) => js_sys::Uint8Array::from(l.cel.thumbnail(tw, th).as_slice()),
            None => js_sys::Uint8Array::new_with_length(0),
        }
    }
    /// 1 画素の見えている色 [r, g, b, 絵の具の濃さ](0..1)。スポイト用。
    pub fn sample(&self, x: i32, y: i32) -> js_sys::Float32Array {
        let n = self.inner.layers().len();
        let c = if n == 0 {
            [1.0, 1.0, 1.0, 0.0]
        } else {
            self.inner.sample_over_white(n - 1, x, y)
        };
        js_sys::Float32Array::from(&c[..])
    }

    // ---- 選択範囲 ----

    pub fn has_selection(&self) -> bool {
        self.inner.has_selection()
    }
    pub fn select_none(&mut self) {
        self.inner.select_none();
    }
    pub fn select_all(&mut self) {
        self.inner.select_all();
    }
    pub fn select_invert(&mut self) {
        self.inner.select_invert();
    }
    /// mode: 0 置換、1 足す、2 引く
    pub fn select_rect(&mut self, x: i32, y: i32, w: i32, h: i32, mode: u32) {
        self.inner.select_rect(Rect::new(x, y, w, h), SelectMode::from_index(mode));
    }
    /// 点は [x, y, x, y, ...]
    pub fn select_polygon(&mut self, points: &[f32], mode: u32) {
        let pts: Vec<(f32, f32)> = points.chunks_exact(2).map(|p| (p[0], p[1])).collect();
        self.inner.select_polygon(&pts, SelectMode::from_index(mode));
    }
    /// layer が 0 なら見えている絵で判定。
    pub fn select_wand(&mut self, layer: u32, x: i32, y: i32, tolerance: u8, contiguous: bool, mode: u32) {
        let l = if layer == 0 { None } else { Some(layer) };
        self.inner
            .select_wand(l, x, y, tolerance, contiguous, SelectMode::from_index(mode));
    }
    /// 選択範囲の A8(全面)。無ければ長さ 0。
    pub fn selection_mask(&self) -> js_sys::Uint8Array {
        match self.inner.selection() {
            Some(c) => js_sys::Uint8Array::from(c.read_rect(c.bounds()).as_slice()),
            None => js_sys::Uint8Array::new_with_length(0),
        }
    }
    /// [x, y, w, h]
    pub fn selection_bounds(&self) -> js_sys::Int32Array {
        let b = self.inner.selection_bounds();
        js_sys::Int32Array::from(&[b.x, b.y, b.w, b.h][..])
    }

    // ---- 変形 ----

    /// 持ち上げる。戻り値は [x, y, w, h]。何も無ければ長さ 0。
    pub fn begin_transform(&mut self, layer: u32) -> js_sys::Int32Array {
        match self.inner.begin_transform(layer) {
            Some(r) => js_sys::Int32Array::from(&[r.x, r.y, r.w, r.h][..]),
            None => js_sys::Int32Array::new_with_length(0),
        }
    }
    /// 持ち上げた画素(プリマルチ RGBA8、矩形の並び)。コピー。
    pub fn floating_pixels(&self) -> js_sys::Uint8Array {
        match self.inner.floating() {
            Some(f) => js_sys::Uint8Array::from(f.data.as_slice()),
            None => js_sys::Uint8Array::new_with_length(0),
        }
    }
    pub fn has_floating(&self) -> bool {
        self.inner.floating().is_some()
    }
    /// 置く。行列は [a, b, c, d, e, f]。戻り値は変わったタイル。
    #[allow(clippy::too_many_arguments)]
    pub fn commit_transform(&mut self, a: f32, b: f32, c: f32, d: f32, e: f32, f: f32) -> js_sys::Int32Array {
        keys_to_array(&self.inner.commit_transform(canvas_core::Affine { a, b, c, d, e, f }))
    }
    pub fn cancel_transform(&mut self) -> js_sys::Int32Array {
        keys_to_array(&self.inner.cancel_transform())
    }

    // ---- 塗りつぶし ----

    /// バケツ。reference が 0 なら見えている絵で領域を決める。色は 0..255 のストレート RGB。
    #[allow(clippy::too_many_arguments)]
    pub fn fill(
        &mut self,
        layer: u32,
        reference: u32,
        x: i32,
        y: i32,
        r: u8,
        g: u8,
        b: u8,
        tolerance: u8,
        contiguous: bool,
    ) -> js_sys::Int32Array {
        let rf = if reference == 0 { None } else { Some(reference) };
        keys_to_array(&self.inner.fill(layer, rf, x, y, [r, g, b, 255], tolerance, contiguous))
    }
    pub fn fill_selection(&mut self, layer: u32, r: u8, g: u8, b: u8) -> js_sys::Int32Array {
        keys_to_array(&self.inner.fill_selection(layer, [r, g, b, 255]))
    }
    pub fn delete_selection(&mut self, layer: u32) -> js_sys::Int32Array {
        keys_to_array(&self.inner.delete_selection(layer))
    }

    /// GPU で描いたストロークバッファの矩形(プリマルチ RGBA8)を焼く。戻り値は変わったタイル [tx, ty, ...]。
    #[allow(clippy::too_many_arguments)]
    pub fn composite_stroke(
        &mut self,
        layer: u32,
        x: i32,
        y: i32,
        w: i32,
        h: i32,
        src: &[u8],
        opacity: f32,
        erase: bool,
    ) -> js_sys::Int32Array {
        let blend = if erase { Blend::Erase } else { Blend::Normal };
        let keys = self
            .inner
            .composite_stroke(layer, Rect::new(x, y, w, h), src, opacity, blend);
        keys_to_array(&keys)
    }

    pub fn clear_layer(&mut self, layer: u32) -> js_sys::Int32Array {
        keys_to_array(&self.inner.clear_layer(layer))
    }

    /// 戻り値は [layer, tx, ty, ...]。何も無ければ長さ 0。
    pub fn undo(&mut self) -> js_sys::Int32Array {
        changed_to_array(&self.inner.undo().unwrap_or_default())
    }
    pub fn redo(&mut self) -> js_sys::Int32Array {
        changed_to_array(&self.inner.redo().unwrap_or_default())
    }
    pub fn can_undo(&self) -> bool {
        self.inner.history().can_undo()
    }
    pub fn can_redo(&self) -> bool {
        self.inner.history().can_redo()
    }

    /// レイヤーが持つタイルのキー [tx, ty, ...]。
    pub fn tile_keys(&self, layer: u32) -> js_sys::Int32Array {
        match self.inner.layer(layer) {
            Some(l) => keys_to_array(&l.cel.keys()),
            None => js_sys::Int32Array::new_with_length(0),
        }
    }

    /// タイルの画素への眺め(コピーしない)。無ければ長さ 0。すぐ使って持ち越さない。
    pub fn tile_view(&self, layer: u32, tx: i32, ty: i32) -> js_sys::Uint8Array {
        match self
            .inner
            .layer(layer)
            .and_then(|l| l.cel.tile(TileKey::new(tx, ty)))
        {
            // SAFETY: 呼び出し側は返り値をすぐ消費する(モジュールの説明を参照)
            Some(t) => unsafe { js_sys::Uint8Array::view(&t.data) },
            None => js_sys::Uint8Array::new_with_length(0),
        }
    }

    /// 並び from..to(下から)のレイヤーを 1 枚にまとめた RGBA8(コピー)。
    pub fn flatten_range(&self, from: u32, to: u32, x: i32, y: i32, w: i32, h: i32) -> js_sys::Uint8Array {
        let v = self
            .inner
            .flatten_range(from as usize, to as usize, Rect::new(x, y, w, h));
        js_sys::Uint8Array::from(v.as_slice())
    }

    pub fn flatten(&self, x: i32, y: i32, w: i32, h: i32) -> js_sys::Uint8Array {
        let v = self.inner.flatten_rgba8(Rect::new(x, y, w, h));
        js_sys::Uint8Array::from(v.as_slice())
    }

    pub fn memory_bytes(&self) -> u32 {
        self.inner.memory_bytes() as u32
    }
    pub fn history_bytes(&self) -> u32 {
        self.inner.history().bytes() as u32
    }
    pub fn tile_count(&self) -> u32 {
        self.inner.layers().iter().map(|l| l.cel.tile_count() as u32).sum()
    }
}
