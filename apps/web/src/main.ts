// メインスレッドの入口。ワーカーをつなぎ、シェルと入力とパネルを組み立てる。
import "@imagine/ring/ring.css";
import { Gauge, Modifiers, attachRadialButton, type RadialMenu } from "@imagine/ring";
import { Bridge } from "./bridge";
import { CanvasInput } from "./canvasInput";
import type { BrushJson, BrushPreset, LayerInfo, Stats } from "./protocol";
import { AppState } from "./state";
import { hexToRgb, rgbToHex, type Rgb } from "./ui/color";
import { ICONS } from "./ui/icons";
import {
  canvasMenu,
  canvasMenuList,
  renderActionsPanel,
  renderBrushPanel,
  renderColorPanel,
  renderFillPanel,
  renderLaterPanel,
  renderLayersPanel,
  renderSelectPanel,
  setThumbnails,
  viewMenu,
  type Ctx,
} from "./ui/panels";
import { buildShell } from "./ui/shell";

declare const __BUILD__: string;

const canvas = document.getElementById("canvas") as HTMLCanvasElement;
const hud = document.getElementById("hud")!;
const errBox = document.getElementById("err")!;
const fileInput = document.getElementById("file") as HTMLInputElement;

function showError(msg: string): void {
  errBox.style.display = "block";
  errBox.textContent = msg;
  setTimeout(() => {
    errBox.style.display = "none";
  }, 8000);
}

const state = new AppState();
state.color = hexToRgb(state.settings.color) ?? state.color;
state.sub = hexToRgb(state.settings.sub) ?? state.sub;
const bridge = new Bridge();
bridge.onError(showError);
const shell = buildShell(document.getElementById("ui")!);
const mods = new Modifiers();

// ---- ワーカーの起動 ----
{
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const w = Math.round(canvas.clientWidth * dpr);
  const h = Math.round(canvas.clientHeight * dpr);
  const offscreen = canvas.transferControlToOffscreen();
  state.view = { scale: 1, tx: 0, ty: 0, rot: 0 };
  bridge.send({ type: "init", canvas: offscreen, viewW: w, viewH: h, docW: state.docW, docH: state.docH, view: state.view }, [offscreen]);
}

// ---- ブラシと色 ----
function pushBrush(): void {
  bridge.send({ type: "brush", brush: { json: JSON.stringify(state.brush), color: state.color } });
  state.emit("brush");
}

function setBrush(p: BrushPreset): void {
  state.brush = JSON.parse(p.json) as BrushJson;
  state.brushBeforeEraser = null;
  state.settings.lastBrush = p.name;
  state.save();
  pushBrush();
  shell.toast(p.name);
}

function setBrushJson(b: BrushJson): void {
  state.brush = b;
  pushBrush();
}

function toggleEraser(): void {
  if (state.brush.eraser) {
    const back = state.presetByName(state.brushBeforeEraser ?? state.settings.lastBrush) ?? state.presets[0];
    if (back) setBrush(back);
    return;
  }
  const e = state.presets.find((p) => (JSON.parse(p.json) as BrushJson).eraser);
  if (!e) return;
  state.brushBeforeEraser = state.brush.name;
  // 太さは今のブラシを引き継ぐ
  const size = state.brush.size;
  state.brush = { ...(JSON.parse(e.json) as BrushJson), size };
  pushBrush();
}

function setColor(c: Rgb, remember = false): void {
  state.color = c;
  state.settings.color = rgbToHex(c);
  if (remember) {
    const hex = rgbToHex(c);
    state.settings.recentColors = [hex, ...state.settings.recentColors.filter((h) => h !== hex)].slice(0, 12);
  }
  state.save();
  bridge.send({ type: "brush", brush: { json: JSON.stringify(state.brush), color: state.color } });
  state.emit("color");
}

function swapColors(): void {
  const t = state.color;
  state.color = state.sub;
  state.sub = t;
  state.settings.color = rgbToHex(state.color);
  state.settings.sub = rgbToHex(state.sub);
  setColor(state.color);
}

// ---- ファイル ----
let fileId = 0;
function download(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (!f) return;
  const bytes = await f.arrayBuffer();
  bridge.send({ type: "open", bytes }, [bytes]);
});

function newDoc(): void {
  const ans = window.prompt("新しい作品の大きさ(幅x高さ、px)", `${state.docW}x${state.docH}`);
  if (!ans) return;
  const m = /^\s*(\d+)\s*[x×*,\s]\s*(\d+)\s*$/i.exec(ans);
  if (!m) return;
  const w = Math.min(8192, Math.max(16, Number(m[1])));
  const h = Math.min(8192, Math.max(16, Number(m[2])));
  if (!window.confirm(`今の作品を捨てて ${w}×${h} で始めますか?`)) return;
  bridge.send({ type: "newDoc", docW: w, docH: h });
}

// ---- 入力 ----
const ctx: Ctx = {
  state,
  bridge,
  shell,
  act: {
    setBrush,
    setBrushJson,
    setColor,
    swapColors,
    toggleEraser,
    setLayer: (id) => bridge.send({ type: "setLayer", id }),
    undo: () => bridge.send({ type: "undo" }),
    redo: () => bridge.send({ type: "redo" }),
    fit: () => input.fit(),
    newDoc,
    open: () => fileInput.click(),
    save: () => bridge.send({ type: "save", id: ++fileId }),
    exportPng: () => bridge.send({ type: "exportPng", id: ++fileId }),
    eyedropOnce: () => {
      state.eyedropOnce = true;
      shell.toast("次にタップした所の色を拾います");
    },
    thumbnails: () => requestThumbnails(),
    setTool: (tool) => {
      if (state.tool === tool) return;
      state.tool = tool;
      state.emit("tool");
    },
  },
};
state.on("tool", () => {
  shell.buttons.select!.classList.toggle("on", state.tool === "select");
  shell.buttons.brush!.classList.toggle("on", state.tool === "brush" && !state.brush.eraser);
  shell.buttons.eraser!.classList.toggle("on", state.tool === "brush" && Boolean(state.brush.eraser));
  if (state.tool === "fill") shell.toast("塗りつぶし: キャンバスをタップ");
});

let eyedropId = 0;
const input = new CanvasInput(canvas, state, bridge, mods, {
  onRing: () => ({ menu: canvasMenu(ctx), list: canvasMenuList(ctx) }),
  onViewRing: () => viewMenu(ctx),
  onTap: (n, double) => {
    if (n === 2 && double) ctx.act.undo();
    else if (n === 3 && double) ctx.act.redo();
    else if (n === 4 && !double) {
      state.uiHidden = !state.uiHidden;
      shell.setHidden(state.uiHidden);
    }
  },
  onEyedrop: (x, y) => {
    const id = ++eyedropId;
    bridge.request((rid) => ({ type: "sample", id: rid + id * 0, x, y }), "sample").then((m) => {
      setColor(m.rgb, true);
      shell.toast(rgbToHex(m.rgb));
    });
  },
  closePanels: () => {
    if (!shell.panelOpen()) return false;
    // 選択と塗りのパネルは開いたまま使う(タップが操作なので)
    const open = shell.panelOpen();
    if (open === "select" || open === "fill") return false;
    shell.closePanel();
    return true;
  },
  overlay: document.getElementById("overlay") as unknown as SVGSVGElement,
});

// ---- 上バー ----
const panels: Record<string, () => void> = {
  gallery: () => shell.openPanel("gallery", (b) => renderActionsPanel(b, ctx)),
  actions: () => shell.openPanel("actions", (b) => renderActionsPanel(b, ctx)),
  adjust: () => shell.openPanel("adjust", (b) => renderLaterPanel(b, "調整")),
  select: () => shell.openPanel("select", (b) => renderSelectPanel(b, ctx)),
  transform: () => shell.openPanel("transform", (b) => renderLaterPanel(b, "変形")),
  fill: () => shell.openPanel("fill", (b) => renderFillPanel(b, ctx)),
  brush: () => {
    ctx.act.setTool("brush");
    shell.openPanel("brush", (b) => renderBrushPanel(b, ctx));
  },
  layers: () => shell.openPanel("layers", (b) => renderLayersPanel(b, ctx)),
  color: () => shell.openPanel("color", (b) => renderColorPanel(b, ctx)),
};
for (const [id, fn] of Object.entries(panels)) {
  const b = shell.buttons[id];
  if (!b) continue;
  if (id === "brush") {
    // タップで一覧、長押しでお気に入りの輪(docs/04)
    attachRadialButton(b, () => brushRing(), fn, () => canvasMenuList(ctx));
  } else {
    b.addEventListener("click", fn);
  }
}
shell.buttons.smudge!.addEventListener("click", () => shell.toast("指先はフェーズ 4 で入ります"));
shell.buttons.eraser!.addEventListener("click", () => {
  ctx.act.setTool("brush");
  toggleEraser();
});
shell.buttons.undo!.addEventListener("click", ctx.act.undo);
shell.buttons.redo!.addEventListener("click", ctx.act.redo);

function brushRing(): RadialMenu {
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
  const menu: RadialMenu = {};
  state.ringBrushes().forEach((p, i) => {
    menu[dirs[i]!] = { label: p.name, icon: ICONS.brush, run: () => setBrush(p) };
  });
  return menu;
}

// ---- 左レール ----
const sizeGauge = new Gauge(shell.gauges.size, {
  label: "太さ",
  // 2 乗のカーブ(細いところを細かく)
  map: (t) => Math.max(0.5, Math.round(t * t * 200 * 2) / 2),
  unmap: (v) => Math.sqrt(v / 200),
  format: (v) => String(v),
  get: () => Number(state.brush.size),
  set: (v) => {
    state.brush.size = v;
    pushBrush();
  },
});
const opacityGauge = new Gauge(shell.gauges.opacity, {
  label: "濃さ",
  map: (t) => Math.round(Math.max(0.05, t) * 100) / 100,
  unmap: (v) => v,
  format: (v) => `${Math.round(v * 100)}`,
  get: () => Number(state.brush.opacity),
  set: (v) => {
    state.brush.opacity = v;
    pushBrush();
  },
});
state.on("brush", () => {
  sizeGauge.paint();
  opacityGauge.paint();
  shell.buttons.eraser!.classList.toggle("on", Boolean(state.brush.eraser));
  shell.buttons.brush!.classList.toggle("on", !state.brush.eraser);
  if (shell.panelOpen() === "brush") shell.rerender();
});

// ---- 修飾ボタン ----
mods.bind(document.getElementById("modShift")!, "shift", "SHF", shell.toast);
mods.bind(document.getElementById("modCtrl")!, "ctrl", "CTL", shell.toast);
mods.bind(document.getElementById("modAlt")!, "alt", "ALT", shell.toast);
mods.bind(document.getElementById("modF")!, "f", "F", shell.toast);
mods.listeners.add(() => {
  // F は押した瞬間に全体表示(押している間の矩形選択はフェーズ 4)
});
document.getElementById("modF")!.addEventListener("click", () => input.fit());
const delBtn = document.getElementById("modDel")!;
attachRadialButton(
  delBtn,
  () => ({
    N: { label: "レイヤーを消去", icon: ICONS.clear, run: () => bridge.send({ type: "clear" }) },
    E: { label: "選択範囲を消去", icon: ICONS.select, run: () => bridge.send({ type: "deleteSelection" }) },
    W: { label: "選択を解除", icon: ICONS.select, run: () => bridge.send({ type: "select", kind: "none" }) },
    S: {
      label: "レイヤーを削除",
      icon: ICONS.trash,
      run: () => bridge.send({ type: "layerOp", op: "remove", id: state.active }),
    },
  }),
  // タップ: 選択範囲があればその中だけ、無ければレイヤー全体を消す
  () => bridge.send(state.hasSelection ? { type: "deleteSelection" } : { type: "clear" })
);

// ---- 色見本 ----
function paintSwatch(): void {
  const b = shell.buttons.color!;
  (b.querySelector(".swatch-main") as HTMLElement).style.background = rgbToHex(state.color);
  (b.querySelector(".swatch-sub") as HTMLElement).style.background = rgbToHex(state.sub);
  if (shell.panelOpen() === "color") shell.rerender();
}
state.on("color", paintSwatch);
paintSwatch();

// ---- レイヤー ----
let thumbTimer = 0;
function requestThumbnails(): void {
  if (thumbTimer) return;
  thumbTimer = setTimeout(() => {
    thumbTimer = 0;
    bridge.send({ type: "thumbnails", size: 56 });
  }, 150) as unknown as number;
}
function applyLayers(layers: LayerInfo[], active: number): void {
  state.layers = layers;
  state.active = active;
  state.emit("layers");
  if (shell.panelOpen() === "layers") shell.rerender();
}
bridge.on("layers", (m) => applyLayers(m.layers, m.active));
bridge.on("thumbnails", (m) => {
  setThumbnails(m.size, m.items);
  if (shell.panelOpen() === "layers") shell.rerender();
});

// ---- ワーカーからの知らせ ----
bridge.on("ready", (m) => {
  state.ready = { version: m.version, renderer: m.renderer, desynchronized: m.desynchronized, restored: m.restored };
  state.presets = m.presets;
  state.blendNames = m.blendNames;
  const last = state.presetByName(state.settings.lastBrush) ?? state.presets[1] ?? state.presets[0];
  if (last) {
    state.brush = JSON.parse(last.json) as BrushJson;
    pushBrush();
  }
  state.docW = m.docW;
  state.docH = m.docH;
  input.fit();
  applyLayers(m.layers, m.active);
  if (m.restored) shell.toast("前回の続きから");
  renderHud();
});
bridge.on("doc", (m) => {
  state.docW = m.docW;
  state.docH = m.docH;
  input.fit();
  applyLayers(m.layers, m.active);
});
bridge.on("stats", (m) => {
  state.stats = m.stats;
  if (m.stats.dabs > 0) {
    frameHist.push(m.stats.frameMs);
    if (frameHist.length > 120) frameHist.shift();
  }
  shell.buttons.undo!.disabled = !m.stats.canUndo;
  shell.buttons.redo!.disabled = !m.stats.canRedo;
  state.hasSelection = m.stats.hasSelection;
  shell.buttons.select!.classList.toggle("open", state.hasSelection && shell.panelOpen() !== "select");
  renderHud();
  if (shell.panelOpen() === "layers" && m.stats.bakeMs > 0) requestThumbnails();
});
bridge.on("png", (m) => download(m.blob, `imagine-${Date.now()}.png`));
bridge.on("file", (m) => download(new Blob([m.bytes], { type: "application/zip" }), `imagine-${Date.now()}.imst`));

// ---- HUD(計測) ----
const frameHist: number[] = [];
const mb = (n: number) => (n / 1048576).toFixed(1);
function renderHud(): void {
  hud.hidden = !state.settings.hud;
  if (hud.hidden) return;
  const s = state.stats;
  const st = input.stats;
  const avg = frameHist.length ? frameHist.reduce((a, b) => a + b, 0) / frameHist.length : 0;
  const max = frameHist.length ? Math.max(...frameHist) : 0;
  hud.textContent = [
    `Imagine Studio · Phase 3 · ${__BUILD__}`,
    `wasm ${state.ready.version}  ${state.ready.renderer.slice(0, 40)}`,
    `desync ${state.ready.desynchronized ? "on" : "off"}  raw ${input.hasRawUpdate ? "on" : "off"}  predict ${input.hasPredicted ? "on" : "off"}  dpr ${input.dpr}`,
    `doc ${state.docW}×${state.docH}  zoom ${(state.view.scale * 100).toFixed(0)}%  rot ${((state.view.rot * 180) / Math.PI).toFixed(0)}°`,
    `pointer ${st.pointerType}  p ${st.pressure.toFixed(2)}  tilt ${st.tiltX},${st.tiltY}`,
    `events/frame ${st.eventsPerFrame}  coalesced ${st.coalesced}`,
    `frame ${s ? s.frameMs.toFixed(2) : "-"} ms  avg ${avg.toFixed(2)}  max ${max.toFixed(2)}`,
    `input→draw ${s ? s.inputToDrawMs.toFixed(1) : "-"} ms  draws ${s?.drawCalls ?? "-"}  bake ${s ? s.bakeMs.toFixed(1) : "-"} ms`,
    `dabs/frame ${s?.dabs ?? "-"}  stroke dabs ${s?.strokeDabs ?? "-"}`,
    `tiles ${s?.tiles ?? "-"}  pixels ${s ? mb(s.memoryBytes) : "-"} MB  history ${s ? mb(s.historyBytes) : "-"} MB`,
  ].join("\n");
}
state.on("settings", renderHud);
state.on("view", renderHud);
renderHud();

// ---- キーボード(Windows) ----
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement)?.tagName === "TEXTAREA" || (e.target as HTMLElement)?.tagName === "INPUT") return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === "z") {
    e.preventDefault();
    if (e.shiftKey) ctx.act.redo();
    else ctx.act.undo();
  } else if ((e.ctrlKey || e.metaKey) && k === "y") {
    e.preventDefault();
    ctx.act.redo();
  } else if ((e.ctrlKey || e.metaKey) && k === "d") {
    e.preventDefault();
    bridge.send({ type: "select", kind: "none" });
  } else if ((e.ctrlKey || e.metaKey) && k === "a") {
    e.preventDefault();
    bridge.send({ type: "select", kind: "all" });
  } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && k === "i") {
    e.preventDefault();
    bridge.send({ type: "select", kind: "invert" });
  } else if (k === "delete" || k === "backspace") {
    bridge.send(state.hasSelection ? { type: "deleteSelection" } : { type: "clear" });
  } else if (k === "m") {
    panels.select!();
  } else if (k === "g") {
    panels.fill!();
  } else if (k === "b") {
    ctx.act.setTool("brush");
    if (state.brush.eraser) toggleEraser();
  } else if (k === "e") {
    toggleEraser();
  } else if (k === "x") {
    swapColors();
  } else if (k === "[" || k === "]") {
    const v = Number(state.brush.size);
    state.brush.size = Math.max(0.5, k === "[" ? v / 1.2 : v * 1.2);
    pushBrush();
  } else if (k === "0") {
    input.fit();
  }
});

// ---- テストと計測のための入口 ----
declare global {
  interface Window {
    __imagine: {
      readback(): Promise<number>;
      stats(): Stats | null;
      ready(): typeof state.ready;
      view(): typeof state.view;
      setBrush(name: string): boolean;
      setColor(hex: string): void;
      undo(): void;
      presets(): string[];
      layers(): LayerInfo[];
      send(m: unknown): void;
    };
  }
}
let readbackId = 0;
window.__imagine = {
  readback: () =>
    bridge.request((id) => ({ type: "readback", id: id + ++readbackId * 0 }), "readback").then((m) => m.painted),
  stats: () => state.stats,
  ready: () => state.ready,
  view: () => state.view,
  setBrush: (name) => {
    const p = state.presetByName(name);
    if (p) setBrush(p);
    return Boolean(p);
  },
  setColor: (hex) => {
    const c = hexToRgb(hex);
    if (c) setColor(c, true);
  },
  undo: () => ctx.act.undo(),
  presets: () => state.presets.map((p) => p.name),
  layers: () => state.layers,
  send: (m) => bridge.send(m as never),
};

// ---- PWA ----
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
}
