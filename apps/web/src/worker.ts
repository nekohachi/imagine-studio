// 描画ワーカー。OffscreenCanvas + WebGL2 + wasm(brush-core / canvas-core)がここで閉じる。
// メインスレッドからはフレームごとに入力点の束(ドキュメント座標)が来る。描画はその受信ごとに 1 回。

import init, { Brush, Doc, Stroke, version } from "./wasm/imagine_wasm.js";
import wasmUrl from "./wasm/imagine_wasm_bg.wasm?url";
import { Renderer } from "./gl";
import { extrapolateDabs } from "./input";
import type { BrushSettings, FromWorker, LayerInfo, Stats, ToWorker, View } from "./protocol";

const HISTORY_MB = 64;

let renderer: Renderer | null = null;
let doc: Doc | null = null;
let brush: Brush | null = null;
let settings: BrushSettings = {
  radius: 6,
  stabilizer: 8,
  hardness: 0.7,
  opacity: 1,
  flow: 0.9,
  spacing: 0.2,
  color: [0.1, 0.1, 0.1],
  eraser: false,
};
let view: View = { scale: 1, tx: 0, ty: 0, rot: 0 };
let active = 0;
let stroke: Stroke | null = null;
let lastDab: [number, number] | null = null;
let lastStrokeDabs = 0;
let lastBakeMs = 0;
// このストロークで触った矩形(ドキュメント px)
let bbox: { x0: number; y0: number; x1: number; y1: number } | null = null;

function post(m: FromWorker, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(m, transfer);
}

function applyBrush(): void {
  if (!brush) return;
  brush.radius = settings.radius;
  brush.stabilizer = settings.stabilizer;
  brush.hardness = settings.hardness;
  brush.opacity = settings.opacity;
  brush.flow = settings.flow;
  brush.spacing = settings.spacing;
}

function layerInfos(): LayerInfo[] {
  if (!doc) return [];
  const ids = Array.from(doc.layer_ids());
  return ids.map((id) => ({
    id,
    name: doc!.layer_name(id),
    visible: doc!.layer_visible(id),
    a8: doc!.layer_format(id) === 1,
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
  };
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
  renderer.uploadMerged("below", doc.flatten_range(0, Math.max(idx, 0), 0, 0, w, h));
  renderer.uploadMerged("above", doc.flatten_range(idx + 1, n, 0, 0, w, h));
}

function present(showStroke = false, showPredict = false): void {
  renderer?.present(view, settings.opacity, showStroke, showPredict);
}

function growBbox(dabs: Float32Array): void {
  for (let i = 0; i + 3 < dabs.length; i += 4) {
    const x = dabs[i]!;
    const y = dabs[i + 1]!;
    const r = dabs[i + 2]! + 2;
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
    const changed = doc.composite_stroke(active, x, y, w, h, px, settings.opacity, settings.eraser);
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
      brush = new Brush();
      applyBrush();
      doc = new Doc(m.docW, m.docH, HISTORY_MB);
      doc.add_layer(false, "レイヤー 1");
      active = doc.add_layer(false, "レイヤー 2");
      view = m.view;
      renderer = new Renderer(m.canvas, m.viewW, m.viewH);
      renderer.setDocSize(m.docW, m.docH, false);
      uploadActiveAll();
      rebuildMerged();
      present();
      post({
        type: "ready",
        version: version(),
        renderer: renderer.rendererName,
        desynchronized: renderer.desynchronized,
        layers: layerInfos(),
        active,
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
      settings = m.brush;
      applyBrush();
      return;
    case "begin": {
      if (!renderer || !brush) return;
      if (stroke) {
        stroke.finish();
        stroke.free();
      }
      stroke = new Stroke(brush);
      lastDab = null;
      bbox = null;
      renderer.beginStroke();
      return;
    }
    case "points": {
      if (!renderer || !stroke) return;
      const t0 = performance.now();
      renderer.drawCalls = 0;
      const dabs = stroke.add_points(m.data);
      if (dabs.length) {
        renderer.drawDabs(dabs, settings.color, settings.hardness);
        growBbox(dabs);
        lastDab = [dabs[dabs.length - 4]!, dabs[dabs.length - 3]!];
      }
      if (lastDab && m.predicted.length) {
        const pd = extrapolateDabs(lastDab[0], lastDab[1], settings.radius, settings.flow, settings.spacing, m.predicted);
        renderer.drawPredicted(pd, settings.color, settings.hardness);
      } else {
        renderer.drawPredicted(new Float32Array(0), settings.color, settings.hardness);
      }
      present(true, true);
      const lastT = m.data.length >= 4 ? m.data[m.data.length - 1]! : 0;
      post({ type: "stats", stats: stats(t0, dabs.length / 4, lastT) });
      return;
    }
    case "end": {
      if (!renderer || !stroke) return;
      const t0 = performance.now();
      renderer.drawCalls = 0;
      const dabs = stroke.finish();
      if (dabs.length) {
        renderer.drawDabs(dabs, settings.color, settings.hardness);
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
      post({ type: "stats", stats: stats(t0, dabs.length / 4, 0) });
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
      post({ type: "layers", layers: layerInfos(), active });
      return;
    }
    case "setLayerVisible": {
      if (!doc) return;
      doc.set_layer_visible(m.id, m.visible);
      if (m.id !== active) rebuildMerged();
      present();
      post({ type: "layers", layers: layerInfos(), active });
      return;
    }
    case "clear": {
      if (!doc || !renderer) return;
      doc.clear_layer(active);
      renderer.clearActive();
      renderer.finishActiveUpload();
      present();
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
      }
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "exportPng":
      await exportPng(m.id);
      return;
    case "readback":
      post({ type: "readback", id: m.id, painted: renderer ? renderer.countPainted() : -1 });
      return;
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  handle(e.data).catch((err: unknown) => {
    post({ type: "error", message: err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err) });
  });
};
