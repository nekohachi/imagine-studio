//! canvas-core の Document を JS から使う結合。
//!
//! タイルの画素は `tile_view` で wasm メモリへの「眺め」を返す(コピーしない)。
//! 眺めは wasm メモリが伸びると無効になるので、受け取ったらすぐ texSubImage2D に渡し、
//! 持ち越さないこと。

use canvas_core::{Blend, Document, PixelFormat, Rect, TileKey};
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
