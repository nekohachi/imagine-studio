// メインスレッド: DOM と入力だけ。描画は worker.ts に任せる。
//
// 入力の流れ(docs/04):
//   pointer イベント → getCoalescedEvents で全点を取る → PointPacker に溜める
//   → rAF ごとに 1 回ワーカーへ転送 → ワーカーが描く
// rAF はストローク中だけ回す。何もしていないときは止める(docs/02 の原則 4)。

import { PalmGuard, PointPacker, SpeedPressure, normalizePressure } from "./input";
import { POINT_STRIDE, type BrushSettings, type FromWorker, type Stats, type ToWorker } from "./protocol";

declare const __BUILD__: string;

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

const offscreen = canvas.transferControlToOffscreen();
function backing(): [number, number] {
  return [Math.round(canvas.clientWidth * dpr), Math.round(canvas.clientHeight * dpr)];
}
{
  const [w, h] = backing();
  send({ type: "init", canvas: offscreen, width: w, height: h }, [offscreen]);
}
window.addEventListener("resize", () => {
  const [w, h] = backing();
  send({ type: "resize", width: w, height: h });
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
  color: $<HTMLInputElement>("color"),
};

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function readBrush(): BrushSettings {
  return {
    radius: Number(inputs.radius.value) * dpr,
    stabilizer: Number(inputs.stab.value) * dpr,
    hardness: Number(inputs.hard.value),
    opacity: Number(inputs.opacity.value),
    flow: 0.9,
    spacing: 0.2,
    color: hexToRgb(inputs.color.value),
  };
}

function pushBrush(): void {
  $("radiusV").textContent = inputs.radius.value;
  $("stabV").textContent = inputs.stab.value;
  $("hardV").textContent = inputs.hard.value;
  $("opacityV").textContent = inputs.opacity.value;
  send({ type: "brush", brush: readBrush() });
}
for (const el of [inputs.radius, inputs.stab, inputs.hard, inputs.opacity, inputs.color]) {
  el.addEventListener("input", pushBrush);
}
pushBrush();
$("undo").addEventListener("click", () => send({ type: "undo" }));
$("clear").addEventListener("click", () => send({ type: "clear" }));

// ---- 入力 ----
const packer = new PointPacker();
const palm = new PalmGuard(1500);
const speedPressure = new SpeedPressure();
const hasRawUpdate = "onpointerrawupdate" in window;
const hasPredicted = typeof PointerEvent !== "undefined" && "getPredictedEvents" in PointerEvent.prototype;
const hasCoalesced = typeof PointerEvent !== "undefined" && "getCoalescedEvents" in PointerEvent.prototype;

let activeId: number | null = null;
let activeType = "";
let predicted = new Float32Array(0);
let rafId = 0;
let lastMove: { x: number; y: number; t: number } | null = null;

const inputStats = {
  events: 0,
  coalesced: 0,
  pointerType: "-",
  pressure: 0,
  tiltX: 0,
  tiltY: 0,
  eventsPerFrame: 0,
};

function toCanvas(e: PointerEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [(e.clientX - r.left) * dpr, (e.clientY - r.top) * dpr];
}

function pressureOf(e: PointerEvent, x: number, y: number): number {
  if (e.pointerType === "touch") {
    const now = e.timeStamp;
    let speed = 0;
    if (lastMove) {
      const dt = Math.max(1, now - lastMove.t);
      speed = Math.hypot(x - lastMove.x, y - lastMove.y) / dpr / dt;
    }
    lastMove = { x, y, t: now };
    return speedPressure.feed(speed);
  }
  return normalizePressure(e.pointerType, e.pressure);
}

function addPoint(e: PointerEvent): void {
  const [x, y] = toCanvas(e);
  packer.push(x, y, pressureOf(e, x, y), e.timeStamp);
  inputStats.events++;
}

function flush(): void {
  if (activeId === null && packer.length === 0) {
    rafId = 0;
    return;
  }
  const data = packer.take();
  inputStats.eventsPerFrame = data.length / POINT_STRIDE;
  const pd = inputs.predict.checked ? predicted : new Float32Array(0);
  predicted = new Float32Array(0);
  send({ type: "points", data, predicted: pd, frameTime: performance.now() }, [data.buffer, pd.buffer]);
  rafId = activeId !== null ? requestAnimationFrame(flush) : 0;
}

function ensureLoop(): void {
  if (!rafId) rafId = requestAnimationFrame(flush);
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.pointerType === "pen") palm.sawPen(e.timeStamp);
  if (e.pointerType === "touch" && !palm.allowTouch(e.timeStamp, inputs.finger.checked)) return;
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
  if (e.pointerId !== activeId) return;
  if (!hasRawUpdate) collect(e);
  if (hasPredicted) {
    const ps = e.getPredictedEvents();
    const out = new Float32Array(ps.length * POINT_STRIDE);
    ps.forEach((p, i) => {
      const [x, y] = toCanvas(p);
      out[i * POINT_STRIDE] = x;
      out[i * POINT_STRIDE + 1] = y;
      out[i * POINT_STRIDE + 2] = normalizePressure(activeType, p.pressure);
      out[i * POINT_STRIDE + 3] = p.timeStamp;
    });
    predicted = out;
  }
});

function finish(e: PointerEvent, cancel: boolean): void {
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

// ---- HUD ----
let ready = { version: "", renderer: "", desynchronized: false };
let last: Stats | null = null;
const frameHist: number[] = [];

function renderHud(): void {
  const avg = frameHist.length ? frameHist.reduce((a, b) => a + b, 0) / frameHist.length : 0;
  const max = frameHist.length ? Math.max(...frameHist) : 0;
  hud.textContent = [
    `Imagine Studio · Phase 0 · ${__BUILD__}`,
    `wasm ${ready.version}  ${ready.renderer.slice(0, 40)}`,
    `desync ${ready.desynchronized ? "on" : "off"}  raw ${hasRawUpdate ? "on" : "off"}  predict ${hasPredicted ? "on" : "off"}  dpr ${dpr}`,
    `pointer ${inputStats.pointerType}  p ${inputStats.pressure.toFixed(2)}  tilt ${inputStats.tiltX},${inputStats.tiltY}`,
    `events/frame ${inputStats.eventsPerFrame}  coalesced ${inputStats.coalesced}`,
    `frame ${last ? last.frameMs.toFixed(2) : "-"} ms  avg ${avg.toFixed(2)}  max ${max.toFixed(2)}`,
    `input→draw ${last ? last.inputToDrawMs.toFixed(1) : "-"} ms  draws ${last?.drawCalls ?? "-"}`,
    `dabs/frame ${last?.dabs ?? "-"}  stroke dabs ${last?.strokeDabs ?? "-"}`,
  ].join("\n");
}

const readbacks = new Map<number, (n: number) => void>();
let readbackId = 0;

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const m = e.data;
  switch (m.type) {
    case "ready":
      ready = m;
      renderHud();
      break;
    case "stats":
      last = m.stats;
      frameHist.push(m.stats.frameMs);
      if (frameHist.length > 120) frameHist.shift();
      renderHud();
      break;
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
};

// ---- PWA ----
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
}
