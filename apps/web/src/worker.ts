// 描画ワーカー。OffscreenCanvas + WebGL2 + wasm(brush-core / canvas-core)がここで閉じる。
// メインスレッドからはフレームごとに入力点の束(ドキュメント座標)が来る。描画はその受信ごとに 1 回。

import init, { Brush, Doc, Stroke, version } from "./wasm/imagine_wasm.js";
import wasmUrl from "./wasm/imagine_wasm_bg.wasm?url";
import { Renderer } from "./gl";
import type { Affine } from "./affine";
import { extrapolateDabs } from "./input";
import type { DabLook } from "./gl";
import {
  DAB_STRIDE,
  POINT_STRIDE,
  type BrushPreset,
  type FromWorker,
  type ToneParams,
  type LayerInfo,
  type Stats,
  type ToWorker,
  type View,
} from "./protocol";
import { NO_RULER, Snapper, symmetryTransforms, transformPoints, type Ruler } from "./ruler";
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
// 進行中のストローク。対称定規では写しの数だけ並ぶ(0 番が本体)
let strokes: Stroke[] = [];
let lastDabs: Array<number[] | null> = [];
let ruler: Ruler = NO_RULER;
let snapper: Snapper | null = null;
let lastStrokeDabs = 0;
let lastBakeMs = 0;
// このストロークで触った矩形(ドキュメント px)
let bbox: { x0: number; y0: number; x1: number; y1: number } | null = null;
// 変形中の行列(持ち上げていなければ null)
let floatM: number[] | null = null;
// このストロークの入力点(ベクターレイヤーでは線として保存し、CPU で焼く)
let strokePts: number[][] = [];
let vectorErase = 0;

let copies: Affine[] = [[1, 0, 0, 1, 0, 0]];

function freeStrokes(): void {
  for (const s of strokes) s.free();
  strokes = [];
  lastDabs = [];
  snapper = null;
}

function activeIsVector(): boolean {
  return doc ? doc.layer_vector(active) : false;
}

/** 画素だけを変える操作はベクターレイヤーでは線とずれるので断る。 */
function refuseOnVector(what: string): boolean {
  if (!activeIsVector()) return false;
  post({ type: "toast", message: `${what}はベクターレイヤーでは使えません(レイヤーパネルの「ラスタライズ」で画素にすると使えます)` });
  return true;
}

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
    vector: doc!.layer_vector(id),
    tone: parseTone(doc!.layer_tone(id)),
  }));
}

function parseTone(json: string): ToneParams | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as ToneParams;
  } catch {
    return null;
  }
}

function stats(frameStart: number, dabs: number, lastInputTime: number): Stats {
  const now = performance.now();
  return {
    frameMs: now - frameStart,
    dabs,
    strokeDabs: strokes.length ? strokes[0]!.dab_count : lastStrokeDabs,
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
  renderer?.setTone(doc && doc.layer_format(active) === 1 ? parseTone(doc.layer_tone(active)) : null);
  renderer?.present(view, brushOpacity(), showStroke, showPredict, op, vis, mode, clip, floatM);
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

/** ベクターレイヤーのストローク終了: 入力点を線として足す(か、ベクター消しゴムを掛ける)。
 *  GPU のストロークバッファは見ず、CPU で同じ式で焼く(描き直しと同じ絵になるように)。 */
function bakeVector(): void {
  if (!doc || !brush) return;
  const lists = strokePts.filter((p) => p.length >= POINT_STRIDE);
  if (!lists.length) return;
  const t0 = performance.now();
  if (brush.eraser) {
    // 写しごとに消す(履歴は写しの数だけ積まれる)
    for (const p of lists) {
      uploadActiveTiles(doc.vector_erase(active, Float32Array.from(p), Math.max(0.5, brush.size), vectorErase));
    }
  } else {
    const [r, g, b] = rgb255();
    if (lists.length === 1) {
      uploadActiveTiles(doc.vector_add_stroke(active, brushJson, r, g, b, Float32Array.from(lists[0]!)));
    } else {
      const flat = Float32Array.from(lists.flat());
      const counts = Uint32Array.from(lists.map((p) => p.length / POINT_STRIDE));
      uploadActiveTiles(doc.vector_add_strokes(active, brushJson, r, g, b, flat, counts));
    }
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
      present(strokes.length > 0, strokes.length > 0);
      return;
    case "view":
      view = m.view;
      present(strokes.length > 0, strokes.length > 0);
      return;
    case "brush":
      brushJson = m.brush.json;
      colorRgb = m.brush.color;
      vectorErase = m.brush.vectorErase | 0;
      applyBrush();
      return;
    case "begin": {
      if (!renderer || !brush || !doc) return;
      freeStrokes();
      // 定規: 吸着(1 本)と対称(写し)
      snapper = new Snapper(ruler);
      copies = symmetryTransforms(ruler);
      strokes = copies.map(() => new Stroke(brush!, colorRgb[0], colorRgb[1], colorRgb[2]));
      lastDabs = copies.map(() => null);
      strokePts = copies.map(() => []);
      bbox = null;
      renderer.beginStroke();
      return;
    }
    case "points": {
      if (!renderer || !strokes.length || !doc) return;
      const t0 = performance.now();
      renderer.drawCalls = 0;
      const lk = look();
      const mapped = snapper ? snapper.feed(m.data) : m.data;
      let n = 0;
      for (let k = 0; k < strokes.length; k++) {
        const pk = k === 0 ? mapped : transformPoints(mapped, copies[k]!);
        for (let i = 0; i < pk.length; i++) strokePts[k]!.push(pk[i]!);
        const dabs = strokes[k]!.add_points(pk, doc, active);
        if (dabs.length) {
          renderer.drawDabs(dabs, lk);
          growBbox(dabs);
          lastDabs[k] = Array.from(dabs.subarray(dabs.length - DAB_STRIDE));
          n += dabs.length / DAB_STRIDE;
        }
      }
      // 予測は本体だけ(写しは次のフレームで追いつく)
      const pred = snapper && m.predicted.length ? snapper.map(m.predicted) : m.predicted;
      if (lastDabs[0] && pred.length) {
        const pd = extrapolateDabs(lastDabs[0]!, brush?.spacing ?? 0.2, pred);
        renderer.drawPredicted(pd, lk);
      } else {
        renderer.drawPredicted(new Float32Array(0), lk);
      }
      present(true, true);
      const lastT = m.data.length >= 4 ? m.data[m.data.length - 1]! : 0;
      post({ type: "stats", stats: stats(t0, n, lastT) });
      return;
    }
    case "end": {
      if (!renderer || !strokes.length || !doc) return;
      const t0 = performance.now();
      renderer.drawCalls = 0;
      // 向きが決まらないまま終わった(短いタップ)なら貯めた点をそのまま流す
      const rest = snapper ? snapper.finish() : new Float32Array(0);
      let n = 0;
      for (let k = 0; k < strokes.length; k++) {
        if (rest.length) {
          const pk = k === 0 ? rest : transformPoints(rest, copies[k]!);
          for (let i = 0; i < pk.length; i++) strokePts[k]!.push(pk[i]!);
          const d0 = strokes[k]!.add_points(pk, doc, active);
          if (d0.length) {
            renderer.drawDabs(d0, look());
            growBbox(d0);
          }
        }
        const dabs = strokes[k]!.finish(doc, active);
        if (dabs.length) {
          renderer.drawDabs(dabs, look());
          growBbox(dabs);
          n += dabs.length / DAB_STRIDE;
        }
      }
      lastStrokeDabs = strokes[0]!.dab_count;
      freeStrokes();
      if (activeIsVector()) bakeVector();
      else bake();
      strokePts = [];
      bbox = null;
      renderer.endStroke();
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(t0, n, 0) });
      return;
    }
    case "cancel": {
      if (!renderer) return;
      freeStrokes();
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
      active = m.vector ? doc.add_vector_layer(m.a8, m.name) : doc.add_layer(m.a8, m.name);
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
        case "rasterize":
          ok = doc.rasterize_layer(m.id);
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
      if (!doc || refuseOnVector("塗りつぶし")) return;
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
    case "fillEnclosed": {
      if (!doc || refuseOnVector("囲って塗る")) return;
      const t0 = performance.now();
      const [r, g, b] = rgb255();
      uploadActiveTiles(doc.fill_enclosed(active, m.merged ? 0 : active, m.points, m.threshold, r, g, b));
      lastBakeMs = performance.now() - t0;
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(t0, 0, 0) });
      return;
    }
    case "setLayerTone": {
      if (!doc) return;
      doc.set_layer_tone(m.id, m.tone ? JSON.stringify(m.tone) : "");
      if (m.id !== active) rebuildMerged();
      present();
      scheduleAutosave();
      post({ type: "layers", layers: layerInfos(), active });
      return;
    }
    case "fillSelection": {
      if (!doc || refuseOnVector("塗り")) return;
      const [r, g, b] = rgb255();
      uploadActiveTiles(doc.fill_selection(active, r, g, b));
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "deleteSelection": {
      if (!doc || refuseOnVector("消去")) return;
      uploadActiveTiles(doc.delete_selection(active));
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "transformBegin": {
      if (!doc || !renderer) return;
      if (refuseOnVector("変形")) {
        post({ type: "floating", rect: null, failed: true });
        return;
      }
      if (doc.has_floating()) return;
      const r = doc.begin_transform(active);
      if (r.length < 4) {
        post({ type: "floating", rect: null, failed: true });
        return;
      }
      const [x, y, w, h] = [r[0]!, r[1]!, r[2]!, r[3]!];
      renderer.uploadFloating(x, y, w, h, doc.floating_pixels());
      floatM = [1, 0, 0, 1, 0, 0];
      // 持ち上げた分が消えたレイヤーを転送
      uploadActiveAll();
      present();
      post({ type: "floating", rect: [x, y, w, h] });
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
      return;
    }
    case "transformPreview": {
      if (!floatM) return;
      floatM = m.m.slice(0, 6);
      present();
      return;
    }
    case "transformCommit": {
      if (!doc || !renderer || !floatM) return;
      const t0 = performance.now();
      const mm = m.m;
      const changed = doc.commit_transform(mm[0]!, mm[1]!, mm[2]!, mm[3]!, mm[4]!, mm[5]!);
      floatM = null;
      renderer.clearFloating();
      uploadActiveTiles(changed);
      syncSelection();
      lastBakeMs = performance.now() - t0;
      present();
      scheduleAutosave();
      post({ type: "floating", rect: null });
      post({ type: "stats", stats: stats(t0, 0, 0) });
      return;
    }
    case "transformCancel": {
      if (!doc || !renderer) return;
      const changed = doc.cancel_transform();
      floatM = null;
      renderer.clearFloating();
      uploadActiveTiles(changed);
      present();
      post({ type: "floating", rect: null });
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
      freeStrokes();
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
        if (activeIsVector()) {
          strokePts = [Array.from(pts)];
          bakeVector();
          strokePts = [];
        } else {
          bake();
        }
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
    case "ruler":
      ruler = m.ruler;
      return;
    case "vectorWidth":
    case "vectorUniform": {
      if (!doc || !activeIsVector()) return;
      const t0 = performance.now();
      const changed = m.type === "vectorWidth" ? doc.vector_scale_width(active, m.factor) : doc.vector_uniform_width(active);
      uploadActiveTiles(changed);
      lastBakeMs = performance.now() - t0;
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(t0, 0, 0) });
      return;
    }
    case "adjustPreview": {
      // GPU で仮表示。確定(adjustCommit)まで画素は変えない
      if (!renderer) return;
      const a = m.adjust;
      renderer.setAdjust(Doc.adjust_lut(JSON.stringify(a)), [a.hue / 360, a.saturation, a.lightness]);
      present();
      return;
    }
    case "adjustCommit": {
      if (!doc || !renderer) return;
      if (refuseOnVector("色調補正")) {
        renderer.setAdjust(null);
        present();
        return;
      }
      const t0 = performance.now();
      renderer.setAdjust(null);
      uploadActiveTiles(doc.adjust_layer(active, JSON.stringify(m.adjust)));
      lastBakeMs = performance.now() - t0;
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(t0, 0, 0) });
      return;
    }
    case "adjustCancel":
      renderer?.setAdjust(null);
      present();
      return;
    case "filter": {
      if (!doc || refuseOnVector("フィルタ")) return;
      const t0 = performance.now();
      const changed = m.kind === "blur" ? doc.blur_layer(active, m.radius) : doc.sharpen_layer(active, m.radius, m.amount);
      uploadActiveTiles(changed);
      lastBakeMs = performance.now() - t0;
      present();
      scheduleAutosave();
      post({ type: "stats", stats: stats(t0, 0, 0) });
      return;
    }
    case "resizeCanvas":
    case "resizeImage": {
      if (!doc || !renderer) return;
      if (floatM) {
        uploadActiveTiles(doc.cancel_transform());
        floatM = null;
        renderer.clearFloating();
        post({ type: "floating", rect: null });
      }
      if (m.type === "resizeCanvas") doc.resize_canvas(m.w, m.h, m.ax, m.ay);
      else doc.resize_image(m.w, m.h);
      renderer.setDocSize(doc.width, doc.height, doc.layer_format(active) === 1);
      uploadActiveAll();
      rebuildMerged();
      syncSelection();
      present();
      scheduleAutosave();
      post({ type: "doc", docW: doc.width, docH: doc.height, layers: layerInfos(), active });
      post({ type: "stats", stats: stats(performance.now(), 0, 0) });
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
