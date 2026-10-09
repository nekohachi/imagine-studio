// メインスレッド: DOM と入力だけ。描画は worker.ts に任せる。
//
// 入力の流れ(docs/04):
//   pointer イベント → getCoalescedEvents で全点を取る → 画面 px をドキュメント px に直す
//   → PointPacker に溜める → rAF ごとに 1 回ワーカーへ転送 → ワーカーが描く
// 指 2 本はパン・ズーム・回転。rAF はストローク中とジェスチャ中だけ回す。

import { PalmGuard, PointPacker, SpeedPressure, normalizePressure } from "./input";
import {
  POINT_STRIDE,
  type BrushSettings,
  type FromWorker,
  type LayerInfo,
  type Stats,
  type ToWorker,
  type View,
} from "./protocol";
import { TwoFingerGesture, fitView, screenToDoc, zoomAt } from "./view";

declare const __BUILD__: string;

const DOC_W = 2048;
const DOC_H = 2048;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const errBox = document.getElementById("err")!;

function showError(msg: string): void {
  errBox.style.display = "block";
  errBox.textContent = msg;
}

const dpr = Math.min(window.devicePixelRatio || 1, 3);
const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
const send = (m: ToWorker, transfer: Transferable[] = []) => worker.postMessage(m, transfer);

function backing(): [number, number] {
  return [Math.round(canvas.clientWidth * dpr), Math.round(canvas.clientHeight * dpr)];
}

let view: View;
{
  const [w, h] = backing();
  view = fitView(DOC_W, DOC_H, w, h);
  const offscreen = canvas.transferControlToOffscreen();
  send({ type: "init", canvas: offscreen, viewW: w, viewH: h, docW: DOC_W, docH: DOC_H, view }, [offscreen]);
}
window.addEventListener("resize", () => {
  const [w, h] = backing();
  send({ type: "resize", viewW: w, viewH: h });
});

// ---- ブラシ設定 ----
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const inputs = {
  radius: $<HTMLInputElement>("radius"),
  stab: $<HTMLInputElement>("stab"),
  hard: $<HTMLInputElement>("hard"),
  opacity: $<HTMLInputElement>("opacity"),
  predict: $<HTMLInputElement>("predict"),
  finger: $<HTMLInputElement>("finger"),
  eraser: $<HTMLInputElement>("eraser"),
  color: $<HTMLInputElement>("color"),
  layer: $<HTMLSelectElement>("layer"),
  visible: $<HTMLInputElement>("visible"),
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function readBrush(): BrushSettings {
  return {
    radius: Number(inputs.radius.value),
    stabilizer: Number(inputs.stab.value),
    hardness: Number(inputs.hard.value),
    opacity: Number(inputs.opacity.value),
    flow: 0.9,
    spacing: 0.2,
    color: hexToRgb(inputs.color.value),
    eraser: inputs.eraser.checked,
  };
}

function pushBrush(): void {
  $("radiusV").textContent = inputs.radius.value;
  $("stabV").textContent = inputs.stab.value;
  $("hardV").textContent = inputs.hard.value;
  $("opacityV").textContent = inputs.opacity.value;
  send({ type: "brush", brush: readBrush() });
}
for (const el of [inputs.radius, inputs.stab, inputs.hard, inputs.opacity, inputs.color, inputs.eraser]) {
  el.addEventListener("input", pushBrush);
}
pushBrush();
$("undo").addEventListener("click", () => send({ type: "undo" }));
$("redo").addEventListener("click", () => send({ type: "redo" }));
$("clear").addEventListener("click", () => send({ type: "clear" }));
$("fit").addEventListener("click", () => {
  const [w, h] = backing();
  view = fitView(DOC_W, DOC_H, w, h);
  send({ type: "view", view });
});
$("addLayer").addEventListener("click", () => {
  send({ type: "addLayer", a8: false, name: `レイヤー ${inputs.layer.options.length + 1}` });
});
inputs.layer.addEventListener("change", () => send({ type: "setLayer", id: Number(inputs.layer.value) }));
inputs.visible.addEventListener("change", () =>
  send({ type: "setLayerVisible", id: Number(inputs.layer.value), visible: inputs.visible.checked })
);

let pngId = 0;
$("png").addEventListener("click", () => send({ type: "exportPng", id: ++pngId }));

function applyLayers(layers: LayerInfo[], active: number): void {
  inputs.layer.innerHTML = "";
  // 上が先に見えるように逆順で並べる
  for (const l of [...layers].reverse()) {
    const o = document.createElement("option");
    o.value = String(l.id);
    o.textContent = (l.visible ? "" : "(非表示) ") + l.name;
    if (l.id === active) o.selected = true;
    inputs.layer.appendChild(o);
  }
  const cur = layers.find((l) => l.id === active);
  inputs.visible.checked = cur ? cur.visible : true;
}

// ---- 入力 ----
const packer = new PointPacker();
const palm = new PalmGuard(1500);
const speedPressure = new SpeedPressure();
const gesture = new TwoFingerGesture();
const hasRawUpdate = "onpointerrawupdate" in window;
const hasPredicted = typeof PointerEvent !== "undefined" && "getPredictedEvents" in PointerEvent.prototype;
const hasCoalesced = typeof PointerEvent !== "undefined" && "getCoalescedEvents" in PointerEvent.prototype;

let activeId: number | null = null;
let activeType = "";
let predicted = new Float32Array(0);
let rafId = 0;
let viewDirty = false;
let lastMove: { x: number; y: number; t: number } | null = null;
const touches = new Map<number, [number, number]>();

const inputStats = {
  events: 0,
  coalesced: 0,
  pointerType: "-",
  pressure: 0,
  tiltX: 0,
  tiltY: 0,
  eventsPerFrame: 0,
};

function toScreen(e: { clientX: number; clientY: number }): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
}

function toDoc(e: { clientX: number; clientY: number }): [number, number] {
  const [sx, sy] = toScreen(e);
  return screenToDoc(view, sx, sy);
}

function pressureOf(e: PointerEvent, x: number, y: number): number {
  if (e.pointerType === "touch") {
    const now = e.timeStamp;
    let speed = 0;
    if (lastMove) {
      const dt = Math.max(1, now - lastMove.t);
      speed = (Math.hypot(x - lastMove.x, y - lastMove.y) * view.scale) / dpr / dt;
    }
    lastMove = { x, y, t: now };
    return speedPressure.feed(speed);
  }
  return normalizePressure(e.pointerType, e.pressure);
}

function addPoint(e: PointerEvent): void {
  const [x, y] = toDoc(e);
  packer.push(x, y, pressureOf(e, x, y), e.timeStamp);
  inputStats.events++;
}

function flush(): void {
  if (viewDirty) {
    viewDirty = false;
    send({ type: "view", view });
  }
  if (activeId !== null || packer.length > 0) {
    const data = packer.take();
    inputStats.eventsPerFrame = data.length / POINT_STRIDE;
    const pd = inputs.predict.checked ? predicted : new Float32Array(0);
    predicted = new Float32Array(0);
    send({ type: "points", data, predicted: pd, frameTime: performance.now() }, [data.buffer, pd.buffer]);
  }
  rafId = activeId !== null || gesture.active ? requestAnimationFrame(flush) : 0;
}

function ensureLoop(): void {
  if (!rafId) rafId = requestAnimationFrame(flush);
}

function cancelStroke(): void {
  if (activeId === null) return;
  try {
    canvas.releasePointerCapture(activeId);
  } catch {
    /* 既に外れている */
  }
  activeId = null;
  packer.take();
  send({ type: "cancel" });
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "pen") palm.sawPen(e.timeStamp);
  if (e.pointerType === "touch") {
    touches.set(e.pointerId, toScreen(e));
    if (touches.size === 2) {
      // 2 本目が乗ったらジェスチャ。指で描いていたら取り消す
      if (activeType === "touch") cancelStroke();
      const [a, b] = Array.from(touches.values()) as [[number, number], [number, number]];
      gesture.start(view, a[0], a[1], b[0], b[1]);
      ensureLoop();
      return;
    }
    if (touches.size > 2) return;
    if (!palm.allowTouch(e.timeStamp, inputs.finger.checked)) return;
  }
  if (activeId !== null) return;
  if (e.pointerType === "mouse" && e.button !== 0) return;
  activeId = e.pointerId;
  activeType = e.pointerType;
  inputStats.pointerType = e.pointerType;
  speedPressure.reset();
  lastMove = null;
  canvas.setPointerCapture(e.pointerId);
  send({ type: "begin" });
  addPoint(e);
  ensureLoop();
});

function collect(e: PointerEvent): void {
  if (e.pointerId !== activeId) return;
  const list: PointerEvent[] = hasCoalesced ? e.getCoalescedEvents() : [];
  if (list.length === 0) list.push(e);
  inputStats.coalesced = list.length;
  for (const c of list) addPoint(c);
  inputStats.pressure = e.pressure;
  inputStats.tiltX = e.tiltX;
  inputStats.tiltY = e.tiltY;
  ensureLoop();
}

if (hasRawUpdate) {
  // Chrome: 間引かれる前の生イベント。点はこちらで集め、pointermove は予測だけに使う
  (canvas as unknown as { addEventListener(t: string, l: (e: PointerEvent) => void): void }).addEventListener(
    "pointerrawupdate",
    collect
  );
}

canvas.addEventListener("pointermove", (e) => {
  if (e.pointerType === "touch" && touches.has(e.pointerId)) {
    touches.set(e.pointerId, toScreen(e));
    if (gesture.active && touches.size >= 2) {
      const [a, b] = Array.from(touches.values()) as [[number, number], [number, number]];
      const v = gesture.update(a[0], a[1], b[0], b[1]);
      if (v) {
        view = v;
        viewDirty = true;
        ensureLoop();
      }
      return;
    }
  }
  if (e.pointerId !== activeId) return;
  if (!hasRawUpdate) collect(e);
  if (hasPredicted) {
    const ps = e.getPredictedEvents();
    const out = new Float32Array(ps.length * POINT_STRIDE);
    ps.forEach((p, i) => {
      const [x, y] = toDoc(p);
      out[i * POINT_STRIDE] = x;
      out[i * POINT_STRIDE + 1] = y;
      out[i * POINT_STRIDE + 2] = normalizePressure(activeType, p.pressure);
      out[i * POINT_STRIDE + 3] = p.timeStamp;
    });
    predicted = out;
  }
});

function finish(e: PointerEvent, cancel: boolean): void {
  if (e.pointerType === "touch") {
    touches.delete(e.pointerId);
    if (gesture.active && touches.size < 2) gesture.end();
  }
  if (e.pointerId !== activeId) return;
  if (!cancel) addPoint(e);
  activeId = null;
  // 残りの点を先に送ってから終了を送る(順序を保つ)
  if (packer.length) {
    const data = packer.take();
    send({ type: "points", data, predicted: new Float32Array(0), frameTime: performance.now() }, [data.buffer]);
  }
  send({ type: cancel ? "cancel" : "end" });
  try {
    canvas.releasePointerCapture(e.pointerId);
  } catch {
    /* 既に外れている */
  }
}
canvas.addEventListener("pointerup", (e) => finish(e, false));
canvas.addEventListener("pointercancel", (e) => finish(e, true));
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// マウスのホイールでズーム(Windows)
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const [sx, sy] = toScreen(e);
    view = zoomAt(view, sx, sy, Math.exp(-e.deltaY * 0.0015));
    viewDirty = true;
    ensureLoop();
  },
  { passive: false }
);

// ---- HUD ----
let ready = { version: "", renderer: "", desynchronized: false };
let last: Stats | null = null;
const frameHist: number[] = [];
const mb = (n: number) => (n / 1048576).toFixed(1);

function renderHud(): void {
  const avg = frameHist.length ? frameHist.reduce((a, b) => a + b, 0) / frameHist.length : 0;
  const max = frameHist.length ? Math.max(...frameHist) : 0;
  hud.textContent = [
    `Imagine Studio · Phase 1 · ${__BUILD__}`,
    `wasm ${ready.version}  ${ready.renderer.slice(0, 40)}`,
    `desync ${ready.desynchronized ? "on" : "off"}  raw ${hasRawUpdate ? "on" : "off"}  predict ${hasPredicted ? "on" : "off"}  dpr ${dpr}`,
    `doc ${DOC_W}×${DOC_H}  zoom ${(view.scale * 100).toFixed(0)}%  rot ${((view.rot * 180) / Math.PI).toFixed(0)}°`,
    `pointer ${inputStats.pointerType}  p ${inputStats.pressure.toFixed(2)}  tilt ${inputStats.tiltX},${inputStats.tiltY}`,
    `events/frame ${inputStats.eventsPerFrame}  coalesced ${inputStats.coalesced}`,
    `frame ${last ? last.frameMs.toFixed(2) : "-"} ms  avg ${avg.toFixed(2)}  max ${max.toFixed(2)}`,
    `input→draw ${last ? last.inputToDrawMs.toFixed(1) : "-"} ms  draws ${last?.drawCalls ?? "-"}  bake ${last ? last.bakeMs.toFixed(1) : "-"} ms`,
    `dabs/frame ${last?.dabs ?? "-"}  stroke dabs ${last?.strokeDabs ?? "-"}`,
    `tiles ${last?.tiles ?? "-"}  pixels ${last ? mb(last.memoryBytes) : "-"} MB  history ${last ? mb(last.historyBytes) : "-"} MB`,
  ].join("\n");
}

const readbacks = new Map<number, (n: number) => void>();
let readbackId = 0;

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "ready":
      ready = m;
      applyLayers(m.layers, m.active);
      renderHud();
      break;
    case "layers":
      applyLayers(m.layers, m.active);
      break;
    case "stats":
      last = m.stats;
      if (m.stats.dabs > 0) {
        frameHist.push(m.stats.frameMs);
        if (frameHist.length > 120) frameHist.shift();
      }
      renderHud();
      break;
    case "png": {
      const url = URL.createObjectURL(m.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `imagine-${Date.now()}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      break;
    }
    case "readback":
      readbacks.get(m.id)?.(m.painted);
      readbacks.delete(m.id);
      break;
    case "error":
      showError(m.message);
      break;
  }
};
worker.onerror = (e) => showError(String(e.message ?? e));
renderHud();

// ---- テストと計測のための入口 ----
declare global {
  interface Window {
    __imagine: {
      readback(): Promise<number>;
      stats(): Stats | null;
      ready(): typeof ready;
      view(): View;
    };
  }
}
window.__imagine = {
  readback: () =>
    new Promise<number>((resolve) => {
      const id = ++readbackId;
      readbacks.set(id, resolve);
      send({ type: "readback", id });
    }),
  stats: () => last,
  ready: () => ready,
  view: () => view,
};

// ---- PWA ----
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
}
