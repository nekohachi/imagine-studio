// アプリの状態。UI はここを見て描き、変更は emit で知らせる。
import type { AdjustParams, BrushJson, BrushPreset, LayerInfo, Stats, View } from "./protocol";
import type { Rgb } from "./ui/color";

export interface Settings {
  predict: boolean;
  fingerDraw: boolean;
  hud: boolean;
  /** お気に入りのブラシ名(輪の 8 方位)。空なら既定の並び */
  favorites: string[];
  recentColors: string[];
  lastBrush: string;
  color: string;
  sub: string;
}

const SETTINGS_KEY = "imagine.settings";

const DEFAULT_SETTINGS: Settings = {
  predict: true,
  fingerDraw: false,
  hud: false,
  favorites: [],
  recentColors: [],
  lastBrush: "ペン",
  color: "#1a1a1a",
  sub: "#ffffff",
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    /* 保存が壊れていても既定値で始める */
  }
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
}

export type StateEvent = "brush" | "color" | "layers" | "view" | "doc" | "stats" | "settings" | "tool" | "transform";

export class AppState {
  settings = loadSettings();
  presets: BrushPreset[] = [];
  /** 合成モードの名前(添字がワーカーの番号) */
  blendNames: string[] = ["normal"];
  /** 今のブラシ定義(JSON オブジェクト)。消しゴムは eraser フラグ */
  brush: BrushJson = { name: "ブラシ", size: 6, stabilizer: 8, hardness: 0.7, opacity: 1, eraser: false };
  /** 消しゴムに切り替える前のブラシ名(戻すため) */
  brushBeforeEraser: string | null = null;
  color: Rgb = [0.1, 0.1, 0.1];
  sub: Rgb = [1, 1, 1];
  layers: LayerInfo[] = [];
  active = 0;
  docW = 2048;
  docH = 2048;
  view: View = { scale: 1, tx: 0, ty: 0, rot: 0 };
  stats: Stats | null = null;
  ready = { version: "", renderer: "", desynchronized: false, restored: false };
  /** 次のタップでスポイト(輪から) */
  eyedropOnce = false;
  uiHidden = false;
  /** 今のツール。brush 以外はキャンバスのタップが描画にならない */
  tool: "brush" | "select" | "fill" | "transform" = "brush";
  /** 変形中: 持ち上げた矩形(doc)と、今の行列 [a, b, c, d, e, f] */
  transform: { rect: [number, number, number, number]; m: [number, number, number, number, number, number] } | null = null;
  selectTool: "rect" | "lasso" | "wand" = "rect";
  /** 自動選択と塗りの許容値 0..255 */
  tolerance = 32;
  contiguous = true;
  /** 自動選択と塗りで見えている絵を参照する(偽なら編集中レイヤー) */
  sampleMerged = true;
  hasSelection = false;
  /** 調整パネルで仮表示中のパラメータ。閉じたら null */
  adjust: AdjustParams | null = null;
  /** フィルタの半径(px)とシャープの強さ */
  filterRadius = 4;
  filterAmount = 1;
  /** キャンバスサイズ変更の寄せ(0..1 × 0..1) */
  resizeAnchor: [number, number] = [0.5, 0.5];

  private listeners = new Map<StateEvent, Set<() => void>>();

  on(ev: StateEvent, fn: () => void): () => void {
    let s = this.listeners.get(ev);
    if (!s) {
      s = new Set();
      this.listeners.set(ev, s);
    }
    s.add(fn);
    return () => s!.delete(fn);
  }

  emit(ev: StateEvent): void {
    for (const fn of this.listeners.get(ev) ?? []) fn();
  }

  save(): void {
    saveSettings(this.settings);
    this.emit("settings");
  }

  presetByName(name: string): BrushPreset | undefined {
    return this.presets.find((p) => p.name === name);
  }

  /** 輪に並べる 8 本。お気に入りが足りなければプリセットの先頭から埋める */
  ringBrushes(): BrushPreset[] {
    const out: BrushPreset[] = [];
    for (const n of this.settings.favorites) {
      const p = this.presetByName(n);
      if (p && !out.includes(p)) out.push(p);
    }
    for (const p of this.presets) {
      if (out.length >= 8) break;
      if (!out.includes(p)) out.push(p);
    }
    return out.slice(0, 8);
  }

  activeLayer(): LayerInfo | undefined {
    return this.layers.find((l) => l.id === this.active);
  }
}
