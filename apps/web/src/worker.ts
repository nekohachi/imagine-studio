// 描画ワーカー。OffscreenCanvas + WebGL2 + wasm(brush-core / canvas-core)がここで閉じる。
// メインスレッドからはフレームごとに入力点の束(ドキュメント座標)が来る。描画はその受信ごとに 1 回。

import init, { Brush, Doc, Stroke, version } from "./wasm/imagine_wasm.js";
import wasmUrl from "./wasm/imagine_wasm_bg.wasm?url";
import { Renderer } from "./gl";
import { extrapolateDabs } from "./input";
import type { DabLook } from "./gl";
import {
  DAB_STRIDE,
  type BrushPreset,
  type FromWorker,
  type LayerInfo,
  type Stats,
  type ToWorker,
  type View,
} from "./protocol";
import { idbGet, idbPut } from "./storage";

const HISTORY_MB = 64;
const AUTOSAVE_KEY = "autosave";
const AUTOSAVE_DELAY_MS = 2000;

let renderer: Renderer | null = null;
let doc: Doc | null = null;
let brush: Brush | null = null;
let brushJson = "{}";
let colorRgb: [number, number, number] = [0.1, 0.1, 0.1];
let view: View = { scale: 1, tx: 0, ty: 0, rot: 0 };
let active = 0;
let stroke: Stroke | null = null;
let lastDab: number[] | null = null;
let lastStrokeDabs = 0;
let lastBakeMs = 0;
// このストロークで触った矩形(ドキュメント px)
let bbox: { x0: number; y0: number; x1: number; y1: number } | null = null;

function post(m: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(m, transfer);
}

/** JSON からブラシを作り直す。壊れた JSON なら前のブラシを保つ。 */
function applyBrush(): void {
  try {
    const next = Brush.from_json(brushJson);
    brush?.free();
    brush = next;
  } catch (e) {
    post({ type: "error", message: "ブラシ定義が読めない: " + String(e) });
    if (!brush) brush = new Brush();
  }
}

function presets(): BrushPreset[] {
  const list = JSON.parse(Brush.presets_json()) as Array<{ name: string }>;
  return list.map((p) => ({ name: p.name, json: JSON.stringify(p) }));
}

function brushOpacity(): number {
  return brush ? brush.opacity : 1;
}

function look(): DabLook {
  return {
    hardness: brush?.hardness ?? 0.7,
    grain: brush?.grain ?? 0,
    grainScale: brush?.grain_scale ?? 3,
  };
}

function layerInfos(): LayerInfo[] {
  if (!doc) return [];
  const ids = Array.from(doc.layer_ids());
  return ids.map((id) => ({
    id,
    name: doc!.layer_name(id),
    visible: doc!.layer_visible(id),
    a8: doc!.layer_format(id) === 1,
    opacity: doc!.layer_opacity(id),
    blend: doc!.layer_blend(id),
    clip: doc!.layer_clip(id),
  }));
}

function stats(frameStart: number, dabs: number, lastInputTime: number): Stats {
  const now = performance.now();
  return {
    frameMs: now - frameStart,
    dabs,
    strokeDabs: stroke ? stroke.dab_count : lastStrokeDabs,
    inputToDrawMs: lastInputTime > 0 ? now - lastInputTime : 0,
    drawCalls: renderer ? renderer.drawCalls : 0,
    bakeMs: lastBakeMs,
    memoryBytes: doc ? doc.memory_bytes() : 0,
    historyBytes: doc ? doc.history_bytes() : 0,
    tiles: doc ? doc.tile_count() : 0,
    canUndo: doc ? doc.can_undo() : false,
    canRedo: doc ? doc.can_redo() : false,
    hasSelection: doc ? doc.has_selection() : false,
  };
}

/** 選択範囲を GPU に反映する。 */
function syncSelection(): void {
  if (!renderer || !doc) return;
  renderer.uploadSelection(doc.has_selection() ? doc.selection_mask() : null);
}

/** 色(0..1)を 0..255 に。 */
function rgb255(): [number, number, number] {
  return [Math.round(colorRgb[0] * 255), Math.round(colorRgb[1] * 255), Math.round(colorRgb[2] * 255)];
}

/** 編集中レイヤーのタイルを全部 GPU へ。 */
function uploadActiveAll(): void {
  if (!renderer || !doc) return;
  renderer.setActiveFormat(doc.layer_format(active) === 1);
  renderer.clearActive();
  const keys = doc.tile_keys(active);
  for (let i = 0; i + 1 < keys.length; i += 2) {
    renderer.uploadActiveTile(keys[i]!, keys[i + 1]!, doc.tile_view(active, keys[i]!, keys[i + 1]!));
  }
  renderer.finishActiveUpload();
}

/** 変わったタイルだけ GPU へ。 */
function uploadActiveTiles(keys: Int32Array): void {
  if (!renderer || !doc) return;
  for (let i = 0; i + 1 < keys.length; i += 2) {
    renderer.uploadActiveTile(keys[i]!, keys[i + 1]!, doc.tile_view(active, keys[i]!, keys[i + 1]!));
  }
  renderer.finishActiveUpload();
}

/** 編集中レイヤーの下と上をそれぞれ 1 枚にまとめて GPU へ(レイヤー切替や可視切替のときだけ)。 */
function rebuildMerged(): void {
  if (!renderer || !doc) return;
  const idx = doc.layer_index(active);
  const n = doc.layer_ids().length;
  const w = doc.width;
  const h = doc.height;
  // 下は紙の上で不透明に(合成モードが紙の上で正しく見える)。上は透明の上に
  renderer.uploadMerged("below", doc.flatten_range_on_white(0, Math.max(idx, 0), 0, 0, w, h));
  renderer.uploadMerged("above", doc.flatten_range(idx + 1, n, 0, 0, w, h));
  // 編集中レイヤーがクリッピングなら、土台のアルファを GPU へ
  const base = doc.clip_base(active);
  renderer.uploadClip(base ? doc.layer_alpha(base) : null);
}

function present(showStroke = false, showPredict = false): void {
  const op = doc ? doc.layer_opacity(active) : 1;
  const vis = doc ? doc.layer_visible(active) : true;
  const mode = doc ? doc.layer_blend(active) : 0;
  const clip = doc ? doc.layer_clip(active) && doc.clip_base(active) !== 0 : false;
  renderer?.present(view, brushOpacity(), showStroke, showPredict, op, vis, mode, clip);
}

// ---- 自動保存(変更から 2 秒後、連続する変更はまとめる) ----
let autosaveTimer = 0;
let autosaveBusy = false;
let autosaveAgain = false;

async function autosaveNow(): Promise<void> {
  if (!doc) return;
  if (autosaveBusy) {
    autosaveAgain = true;
    return;
  }
  autosaveBusy = true;
  try {
    await idbPut(AUTOSAVE_KEY, doc.save());
  } catch (e) {
    post({ type: "error", message: "自動保存に失敗: " + String(e) });
  } finally {
    autosaveBusy = false;
    if (autosaveAgain) {
      autosaveAgain = false;
      scheduleAutosave();
    }
  }
}

function scheduleAutosave(): void {
  if (autosaveTimer) clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    autosaveTimer = 0;
    void autosaveNow();
  }, AUTOSAVE_DELAY_MS) as unknown as number;
}

/** 作品を差し替えて、GPU に載せ直す。 */
function mountDoc(next: Doc): void {
  if (doc && doc !== next) doc.free();
  doc = next;
  const ids = Array.from(doc.layer_ids());
  if (ids.length === 0) doc.add_layer(false, "レイヤー 1");
  active = Array.from(doc.layer_ids()).at(-1)!;
  renderer?.setDocSize(doc.width, doc.height, doc.layer_format(active) === 1);
  uploadActiveAll();
  rebuildMerged();
  syncSelection();
  present();
}

function growBbox(dabs: Float32Array): void {
  for (let i = 0; i + 3 < dabs.length; i += DAB_STRIDE) {
    const x = dabs[i]!;
    const y = dabs[i + 1]!;
    const r = Math.max(dabs[i + 2]!, 0.75) + 2;
    if (!bbox) bbox = { x0: x - r, y0: y - r, x1: x + r, y1: y + r };
    else {
      bbox.x0 = Math.min(bbox.x0, x - r);
      bbox.y0 = Math.min(bbox.y0, y - r);
      bbox.x1 = Math.max(bbox.x1, x + r);
      bbox.y1 = Math.max(bbox.y1, y + r);
    }
  }
}

/** ストローク終了: 読み戻し → wasm で焼く → 変わったタイルを転送。 */
function bake(): void {
  if (!renderer || !doc || !bbox) return;
  const t0 = performance.now();
  const x = Math.max(0, Math.floor(bbox.x0));
  const y = Math.max(0, Math.floor(bbox.y0));
  const x1 = Math.min(doc.width, Math.ceil(bbox.x1));
  const y1 = Math.min(doc.height, Math.ceil(bbox.y1));
  const w = x1 - x;
  const h = y1 - y;
  if (w > 0 && h > 0) {
    const px = renderer.readStroke(x, y, w, h);
    const changed = doc.composite_stroke(active, x, y, w, h, px, brushOpacity(), brush?.eraser ?? false);
    uploadActiveTiles(changed);
  }
  lastBakeMs = performance.now() - t0;
}

/** Undo / Redo の結果 [layer, tx, ty, ...] を GPU に反映する。 */
function applyChanged(changed: Int32Array): void {
  if (!renderer || !doc) return;
  let activeKeys: number[] = [];
  let others = false;
  for (let i = 0; i + 2 < changed.length; i += 3) {
    if (changed[i] === active) activeKeys.push(changed[i + 1]!, changed[i + 2]!);
    else others = true;
  }
  if (activeKeys.length) uploadActiveTiles(Int32Array.from(activeKeys));
  if (others) rebuildMerged();
  activeKeys = [];
}

async function exportPng(id: number): Promise<void> {
  if (!doc) return;
  const w = doc.width;
  const h = doc.height;
  const pre = doc.flatten(0, 0, w, h);
  // プリマルチを戻す(PNG はストレートアルファ)
  const out = new Uint8ClampedArray(pre.length);
  for (let i = 0; i < pre.length; i += 4) {
    const a = pre[i + 3]!;
    if (a === 0) continue;
    out[i] = Math.min(255, Math.round((pre[i]! * 255) / a));
    out[i + 1] = Math.min(255, Math.round((pre[i + 1]! * 255) / a));
    out[i + 2] = Math.min(255, Math.round((pre[i + 2]! * 255) / a));
    out[i + 3] = a;
  }
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext("2d")!;
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
  const blob = await c.convertToBlob({ type: "image/png" });
  post({ type: "png", id, blob });
}

async function handle(m: ToWorker): Promise<void> {
  switch (m.type) {
    case "init": {
      await init({ module_or_path: wasmUrl });
      applyBrush();
      view = m.view;
      renderer = new Renderer(m.canvas, m.viewW, m.viewH);
      let restored = false;
      let next: Doc | null = null;
      try {
        const saved = await idbGet(AUTOSAVE_KEY);
        if (saved && saved.length) {
          next = Doc.load(saved, HISTORY_MB);
          restored = true;
        }
      } catch (e) {
        post({ type: "error", message: "自動保存の読み込みに失敗(新規で始めます): " + String(e) });
      }
      if (!next) {
        next = new Doc(m.docW, m.docH, HISTORY_MB);
        next.add_layer(false, "レイヤー 1");
        next.add_layer(false, "レイヤー 2");
      }
      mountDoc(next);
      post({
        type: "ready",
        version: version(),
        renderer: renderer.rendererName,
        desynchronized: renderer.desynchronized,
        layers: layerInfos(),
        active,
        docW: doc!.width,
        docH: doc!.height,
        restored,
        presets: presets(),
        blendNames: Array.from(Doc.blend_names()) as string[],
      });
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "resize":
      renderer?.resize(m.viewW, m.viewH);
      present(stroke !== null, stroke !== null);
      return;
    case "view":
      view = m.view;
      present(stroke !== null, stroke !== null);
      return;
    case "brush":
      brushJson = m.brush.json;
      colorRgb = m.brush.color;
      applyBrush();
      return;
    case "begin": {
      if (!renderer || !brush || !doc) return;
      if (stroke) {
        stroke.finish(doc, active);
        stroke.free();
      }
      stroke = new Stroke(brush, colorRgb[0], colorRgb[1], colorRgb[2]);
      lastDab = null;
      bbox = null;
      renderer.beginStroke();
      return;
    }
    case "points": {
      if (!renderer || !stroke || !doc) return;
      const t0 = performance.now();
      renderer.drawCalls = 0;
      const lk = look();
      const dabs = stroke.add_points(m.data, doc, active);
      if (dabs.length) {
        renderer.drawDabs(dabs, lk);
        growBbox(dabs);
        lastDab = Array.from(dabs.subarray(dabs.length - DAB_STRIDE));
      }
      if (lastDab && m.predicted.length) {
        const pd = extrapolateDabs(lastDab, brush?.spacing ?? 0.2, m.predicted);
        renderer.drawPredicted(pd, lk);
      } else {
        renderer.drawPredicted(new Float32Array(0), lk);
      }
      present(true, true);
      const lastT = m.data.length >= 4 ? m.data[m.data.length - 1]! : 0;
      post({ type: "stats", stats: stats(t0, dabs.length / DAB_STRIDE, lastT) });
      return;
    }
    case "end": {
      if (!renderer || !stroke || !doc) return;
      const t0 = performance.now();
      renderer.drawCalls = 0;
      const dabs = stroke.finish(doc, active);
      if (dabs.length) {
        renderer.drawDabs(dabs, look());
        growBbox(dabs);
      }
      lastStrokeDabs = stroke.dab_count;
      stroke.free();
      stroke = null;
      lastDab = null;
      bake();
      bbox = null;
      renderer.endStroke();
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(t0, dabs.length / DAB_STRIDE, 0) });
      return;
    }
    case "cancel": {
      if (!renderer) return;
      if (stroke) {
        stroke.free();
        stroke = null;
      }
      bbox = null;
      renderer.endStroke();
      present();
      return;
    }
    case "setLayer": {
      if (!doc || doc.layer_index(m.id) < 0) return;
      active = m.id;
      uploadActiveAll();
      rebuildMerged();
      present();
      post({ type: "layers", layers: layerInfos(), active });
      return;
    }
    case "addLayer": {
      if (!doc) return;
      active = doc.add_layer(m.a8, m.name);
      uploadActiveAll();
      rebuildMerged();
      present();
      scheduleAutosave();
      post({ type: "layers", layers: layerInfos(), active });
      return;
    }
    case "setLayerVisible": {
      if (!doc) return;
      doc.set_layer_visible(m.id, m.visible);
      if (m.id !== active) rebuildMerged();
      present();
      scheduleAutosave();
      post({ type: "layers", layers: layerInfos(), active });
      return;
    }
    case "clear": {
      if (!doc || !renderer) return;
      doc.clear_layer(active);
      renderer.clearActive();
      renderer.finishActiveUpload();
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "undo":
    case "redo": {
      if (!doc) return;
      const changed = m.type === "undo" ? doc.undo() : doc.redo();
      if (changed.length) {
        applyChanged(changed);
        present();
        scheduleAutosave();
      }
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "layerOp": {
      if (!doc || !renderer) return;
      const ids = Array.from(doc.layer_ids());
      const idx = ids.indexOf(m.id);
      if (idx < 0) return;
      let ok = true;
      switch (m.op) {
        case "remove":
          ok = doc.remove_layer(m.id);
          if (ok && active === m.id) active = Array.from(doc.layer_ids())[Math.max(0, idx - 1)]!;
          break;
        case "duplicate": {
          const nid = doc.duplicate_layer(m.id);
          if (nid) active = nid;
          else ok = false;
          break;
        }
        case "mergeDown": {
          const r = doc.merge_down(m.id);
          if (r.length) {
            if (active === m.id) active = r[0]!;
          } else ok = false;
          break;
        }
        case "moveUp":
          ok = doc.move_layer(m.id, idx + 1);
          break;
        case "moveDown":
          ok = idx > 0 && doc.move_layer(m.id, idx - 1);
          break;
      }
      if (ok) {
        uploadActiveAll();
        rebuildMerged();
        present();
        scheduleAutosave();
      }
      post({ type: "layers", layers: layerInfos(), active });
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "renameLayer":
      doc?.set_layer_name(m.id, m.name);
      scheduleAutosave();
      post({ type: "layers", layers: layerInfos(), active });
      return;
    case "setLayerOpacity": {
      if (!doc) return;
      doc.set_layer_opacity(m.id, m.opacity);
      if (m.id !== active) rebuildMerged();
      present();
      scheduleAutosave();
      post({ type: "layers", layers: layerInfos(), active });
      return;
    }
    case "select": {
      if (!doc) return;
      switch (m.kind) {
        case "rect":
          doc.select_rect(Math.round(m.x), Math.round(m.y), Math.round(m.w), Math.round(m.h), m.mode);
          break;
        case "polygon":
          doc.select_polygon(m.points, m.mode);
          break;
        case "wand":
          doc.select_wand(m.merged ? 0 : active, Math.round(m.x), Math.round(m.y), m.tolerance, m.contiguous, m.mode);
          break;
        case "all":
          doc.select_all();
          break;
        case "none":
          doc.select_none();
          break;
        case "invert":
          doc.select_invert();
          break;
      }
      syncSelection();
      present();
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "fill": {
      if (!doc) return;
      const t0 = performance.now();
      const [r, g, b] = rgb255();
      const changed = doc.fill(active, m.merged ? 0 : active, Math.round(m.x), Math.round(m.y), r, g, b, m.tolerance, m.contiguous);
      uploadActiveTiles(changed);
      lastBakeMs = performance.now() - t0;
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(t0, 0, 0) });
      return;
    }
    case "fillSelection": {
      if (!doc) return;
      const [r, g, b] = rgb255();
      uploadActiveTiles(doc.fill_selection(active, r, g, b));
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "deleteSelection": {
      if (!doc) return;
      uploadActiveTiles(doc.delete_selection(active));
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "setLayerBlend": {
      if (!doc) return;
      doc.set_layer_blend(m.id, m.blend);
      if (m.id !== active) rebuildMerged();
      present();
      scheduleAutosave();
      post({ type: "layers", layers: layerInfos(), active });
      return;
    }
    case "setLayerClip": {
      if (!doc) return;
      doc.set_layer_clip(m.id, m.clip);
      rebuildMerged();
      present();
      scheduleAutosave();
      post({ type: "layers", layers: layerInfos(), active });
      return;
    }
    case "thumbnails": {
      if (!doc) return;
      const size = Math.max(16, Math.min(256, m.size | 0));
      const w = doc.width;
      const h = doc.height;
      const tw = w >= h ? size : Math.max(1, Math.round((size * w) / h));
      const th = w >= h ? Math.max(1, Math.round((size * h) / w)) : size;
      const items: Array<{ id: number; bitmap: ImageBitmap }> = [];
      const c = new OffscreenCanvas(tw, th);
      const ctx = c.getContext("2d")!;
      for (const id of Array.from(doc.layer_ids())) {
        const pre = doc.thumbnail(id, tw, th);
        const out = new Uint8ClampedArray(pre.length);
        for (let i = 0; i < pre.length; i += 4) {
          const a = pre[i + 3]!;
          if (a === 0) continue;
          out[i] = Math.min(255, Math.round((pre[i]! * 255) / a));
          out[i + 1] = Math.min(255, Math.round((pre[i + 1]! * 255) / a));
          out[i + 2] = Math.min(255, Math.round((pre[i + 2]! * 255) / a));
          out[i + 3] = a;
        }
        ctx.clearRect(0, 0, tw, th);
        ctx.putImageData(new ImageData(out, tw, th), 0, 0);
        items.push({ id, bitmap: c.transferToImageBitmap() });
      }
      post({ type: "thumbnails", size, items }, items.map((i) => i.bitmap));
      return;
    }
    case "sample": {
      if (!doc) return;
      const c = doc.sample(Math.round(m.x), Math.round(m.y));
      post({ type: "sample", id: m.id, rgb: [c[0]!, c[1]!, c[2]!], alpha: c[3]! });
      return;
    }
    case "line": {
      // 直線(SHF)。毎回ストロークを作り直して 2 点だけ流す。commit で焼く
      if (!renderer || !brush || !doc) return;
      if (stroke) {
        stroke.free();
        stroke = null;
      }
      renderer.beginStroke();
      bbox = null;
      const s = new Stroke(brush, colorRgb[0], colorRgb[1], colorRgb[2]);
      const pts = Float32Array.from([m.x0, m.y0, m.pressure, 0, 0, 0, m.x1, m.y1, m.pressure, 16, 0, 0]);
      const a = s.add_points(pts, doc, active);
      const b = s.finish(doc, active);
      s.free();
      for (const d of [a, b]) {
        if (d.length) {
          renderer.drawDabs(d, look());
          growBbox(d);
        }
      }
      if (m.commit) {
        bake();
        bbox = null;
        renderer.endStroke();
        present();
        scheduleAutosave();
        post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      } else {
        renderer.drawPredicted(new Float32Array(0), look());
        present(true, false);
      }
      return;
    }
    case "exportPng":
      await exportPng(m.id);
      return;
    case "save": {
      if (!doc) return;
      const bytes = doc.save();
      // Uint8Array は wasm メモリの外へのコピーなので、そのまま転送できる
      post({ type: "file", id: m.id, bytes: bytes.buffer as ArrayBuffer }, [bytes.buffer as ArrayBuffer]);
      return;
    }
    case "open": {
      if (!renderer) return;
      const next = Doc.load(new Uint8Array(m.bytes), HISTORY_MB);
      mountDoc(next);
      scheduleAutosave();
      post({ type: "doc", docW: doc!.width, docH: doc!.height, layers: layerInfos(), active });
      return;
    }
    case "newDoc": {
      if (!renderer) return;
      const next = new Doc(m.docW, m.docH, HISTORY_MB);
      next.add_layer(false, "レイヤー 1");
      next.add_layer(false, "レイヤー 2");
      mountDoc(next);
      scheduleAutosave();
      post({ type: "doc", docW: doc!.width, docH: doc!.height, layers: layerInfos(), active });
      return;
    }
    case "readback":
      post({ type: "readback", id: m.id, painted: renderer ? renderer.countPainted() : -1 });
      return;
  }
}

// init(wasm の読み込み)が終わるまでは、他のメッセージを順番どおりに待たせる
let initialized = false;
const pending: ToWorker[] = [];

function fail(err: unknown): void {
  post({ type: "error", message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data;
  if (!initialized) {
    if (m.type !== "init") {
      pending.push(m);
      return;
    }
    handle(m)
      .then(async () => {
        initialized = true;
        for (const q of pending.splice(0)) {
          await handle(q).catch(fail);
        }
      })
      .catch(fail);
    return;
  }
  handle(m).catch(fail);
};
