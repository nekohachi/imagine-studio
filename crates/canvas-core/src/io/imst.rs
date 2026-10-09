//! `.imst`: Imagine Studio の作品ファイル。
//!
//! zip の中身:
//!   manifest.json                     形式と版
//!   pages/0/page.json                 大きさ、レイヤーの並びと属性、持っているタイルの一覧
//!   pages/0/cels/<layerId>/<tx>_<ty>.bin   タイルの画素(deflate)
//!
//! フェーズ 1 はページ 1 つ、フレーム 1 つ。ページとフレームは docs/03 の形で後から増やす。

use serde::{Deserialize, Serialize};

use super::zip::{ZipReader, ZipWriter};
use crate::document::Document;
use crate::tile::{PixelFormat, Tile, TileKey};

pub const FORMAT: &str = "imst";
pub const VERSION: u32 = 1;

#[derive(Serialize, Deserialize)]
struct Manifest {
    format: String,
    version: u32,
    app: String,
}

#[derive(Serialize, Deserialize)]
struct LayerJson {
    id: u32,
    name: String,
    visible: bool,
    opacity: f32,
    format: String,
    #[serde(default)]
    blend: String,
    #[serde(default)]
    clip: bool,
    tiles: Vec<[i32; 2]>,
}

#[derive(Serialize, Deserialize)]
struct PageJson {
    width: u32,
    height: u32,
    layers: Vec<LayerJson>,
}

fn fmt_name(f: PixelFormat) -> &'static str {
    match f {
        PixelFormat::Rgba8 => "rgba8",
        PixelFormat::A8 => "a8",
    }
}

fn fmt_parse(s: &str) -> Result<PixelFormat, String> {
    match s {
        "rgba8" => Ok(PixelFormat::Rgba8),
        "a8" => Ok(PixelFormat::A8),
        other => Err(format!("未知の画素形式 {other}")),
    }
}

fn tile_path(layer: u32, k: TileKey) -> String {
    format!("pages/0/cels/{layer}/{}_{}.bin", k.tx, k.ty)
}

pub fn save(doc: &Document) -> Vec<u8> {
    let mut w = ZipWriter::new();
    let manifest = Manifest {
        format: FORMAT.into(),
        version: VERSION,
        app: "Imagine Studio".into(),
    };
    w.add("manifest.json", serde_json::to_string_pretty(&manifest).unwrap().as_bytes(), false);
    let mut page = PageJson {
        width: doc.width(),
        height: doc.height(),
        layers: Vec::new(),
    };
    for l in doc.layers() {
        let keys = l.cel.keys();
        page.layers.push(LayerJson {
            id: l.id,
            name: l.name.clone(),
            visible: l.visible,
            opacity: l.opacity,
            format: fmt_name(l.cel.format()).into(),
            blend: l.blend.name().into(),
            clip: l.clip,
            tiles: keys.iter().map(|k| [k.tx, k.ty]).collect(),
        });
        for k in keys {
            if let Some(t) = l.cel.tile(k) {
                w.add(&tile_path(l.id, k), &t.data, true);
            }
        }
    }
    w.add("pages/0/page.json", serde_json::to_string_pretty(&page).unwrap().as_bytes(), false);
    w.finish()
}

pub fn load(bytes: &[u8], history_limit_bytes: usize) -> Result<Document, String> {
    let r = ZipReader::new(bytes)?;
    let manifest: Manifest = serde_json::from_slice(&r.read("manifest.json")?)
        .map_err(|e| format!("manifest.json: {e}"))?;
    if manifest.format != FORMAT {
        return Err(format!("形式が違う: {}", manifest.format));
    }
    if manifest.version > VERSION {
        return Err(format!("新しい版のファイル({})。アプリを更新してください", manifest.version));
    }
    let page: PageJson = serde_json::from_slice(&r.read("pages/0/page.json")?)
        .map_err(|e| format!("page.json: {e}"))?;
    if page.width == 0 || page.height == 0 {
        return Err("大きさが 0".into());
    }
    let mut doc = Document::new(page.width, page.height, history_limit_bytes);
    for lj in &page.layers {
        let format = fmt_parse(&lj.format)?;
        let layer = doc
            .add_layer_with(lj.id, format, &lj.name, lj.visible, lj.opacity)
            .ok_or_else(|| format!("レイヤー id {} が重複", lj.id))?;
        layer.blend = crate::blend::BlendMode::parse(&lj.blend).unwrap_or_default();
        layer.clip = lj.clip;
        for [tx, ty] in &lj.tiles {
            let k = TileKey::new(*tx, *ty);
            let data = r.read(&tile_path(lj.id, k))?;
            if data.len() != format.tile_bytes() {
                return Err(format!("タイル {}_{} の大きさが違う", tx, ty));
            }
            layer.cel.restore(
                k,
                Some(Tile {
                    format,
                    data: data.into_boxed_slice(),
                }),
            );
        }
        layer.cel.take_dirty();
    }
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cel::Blend;
    use crate::tile::Rect;

    fn solid(rect: Rect, rgba: [u8; 4]) -> Vec<u8> {
        let mut v = Vec::new();
        for _ in 0..rect.w * rect.h {
            v.extend_from_slice(&rgba);
        }
        v
    }

    #[test]
    fn roundtrip() {
        let mut doc = Document::new(600, 400, 1 << 20);
        let a = doc.add_layer(PixelFormat::Rgba8, "下");
        let b = doc.add_layer(PixelFormat::A8, "線画");
        doc.layer_mut(b).unwrap().opacity = 0.5;
        doc.layer_mut(a).unwrap().visible = false;
        let r = Rect::new(250, 100, 20, 20);
        doc.composite_stroke(a, r, &solid(r, [200, 10, 10, 255]), 1.0, Blend::Normal);
        doc.composite_stroke(b, r, &solid(r, [0, 0, 0, 128]), 1.0, Blend::Normal);

        let bytes = save(&doc);
        let back = load(&bytes, 1 << 20).unwrap();
        assert_eq!(back.width(), 600);
        assert_eq!(back.height(), 400);
        assert_eq!(back.layers().len(), 2);
        let la = back.layer(a).unwrap();
        assert_eq!(la.name, "下");
        assert!(!la.visible);
        assert_eq!(la.cel.tile_count(), 2);
        assert_eq!(la.cel.read_rect(r), doc.layer(a).unwrap().cel.read_rect(r));
        let lb = back.layer(b).unwrap();
        assert_eq!(lb.cel.format(), PixelFormat::A8);
        assert!((lb.opacity - 0.5).abs() < 1e-6);
        assert_eq!(lb.cel.read_rect(r), doc.layer(b).unwrap().cel.read_rect(r));
        // 読み込み直後はダーティ無し、履歴も無し
        assert!(!back.history().can_undo());
        // 次に足すレイヤーの id は既存とぶつからない
        let mut back = back;
        let c = back.add_layer(PixelFormat::Rgba8, "c");
        assert!(c > b);
    }

    #[test]
    fn rejects_wrong_format() {
        let mut w = ZipWriter::new();
        w.add("manifest.json", br#"{"format":"other","version":1,"app":"x"}"#, false);
        let bytes = w.finish();
        assert!(load(&bytes, 1).is_err());
        assert!(load(b"junk", 1).is_err());
    }
}
