// メインスレッドと描画ワーカーの間の約束。
// 入力点は [x, y, pressure, time] の 4 要素ずつ、ダブは [x, y, radius, opacity] の 4 要素ずつ。
// 座標はドキュメント px(キャンバスの画素)。画面との変換は View で行う。

/** 入力点: x, y, pressure, time, tiltX, tiltY */
export const POINT_STRIDE = 6;
/** ダブ: x, y, radius, opacity, angle, aspect, colorPacked, 予備 */
export const DAB_STRIDE = 8;

/** RGB(0..1)を 1 つの float に詰める(24bit なので f32 で正確に持てる)。 */
export function packColor(c: [number, number, number]): number {
  const r = Math.round(Math.min(1, Math.max(0, c[0])) * 255);
  const g = Math.round(Math.min(1, Math.max(0, c[1])) * 255);
  const b = Math.round(Math.min(1, Math.max(0, c[2])) * 255);
  return r * 65536 + g * 256 + b;
}

/** ブラシ定義の JSON のうち、UI が直接触る項目。残りは brush-core が解釈する。 */
export interface BrushJson {
  name: string;
  size: number;
  stabilizer: number;
  hardness: number;
  opacity: number;
  eraser: boolean;
  [key: string]: unknown;
}

/** 画面(backing px)= scale · R(rot) · doc + (tx, ty) */
export interface View {
  scale: number;
  tx: number;
  ty: number;
  rot: number;
}

export interface BrushSettings {
  /** brush-core の BrushDef の JSON */
  json: string;
  color: [number, number, number];
  /** ベクターレイヤーでの消しゴム: 0 通常(触れた所を切る)、1 触れた線を消す、2 交点まで消す */
  vectorErase: number;
}

export interface BrushPreset {
  name: string;
  json: string;
}

export interface LayerInfo {
  id: number;
  name: string;
  visible: boolean;
  a8: boolean;
  opacity: number;
  /** 合成モード(blendNames の添字) */
  blend: number;
  clip: boolean;
  /** ベクターレイヤー(線を持ち、消しゴムは線単位) */
  vector: boolean;
}

/** 色調補正のパラメータ(canvas-core の Adjust と同じ形。省いた項目は「変化なし」)。 */
export interface AdjustParams {
  brightness: number;
  contrast: number;
  hue: number;
  saturation: number;
  lightness: number;
  in_black: number;
  in_white: number;
  gamma: number;
  out_black: number;
  out_white: number;
}

export const ADJUST_IDENTITY: AdjustParams = {
  brightness: 0,
  contrast: 0,
  hue: 0,
  saturation: 0,
  lightness: 0,
  in_black: 0,
  in_white: 1,
  gamma: 1,
  out_black: 0,
  out_white: 1,
};

export function isAdjustIdentity(a: AdjustParams): boolean {
  return (Object.keys(ADJUST_IDENTITY) as Array<keyof AdjustParams>).every((k) => a[k] === ADJUST_IDENTITY[k]);
}

export type ToWorker =
  | {
      type: "init";
      canvas: OffscreenCanvas;
      viewW: number;
      viewH: number;
      docW: number;
      docH: number;
      view: View;
    }
  | { type: "resize"; viewW: number; viewH: number }
  | { type: "view"; view: View }
  | { type: "brush"; brush: BrushSettings }
  | { type: "begin" }
  | { type: "points"; data: Float32Array; predicted: Float32Array; frameTime: number }
  | { type: "end" }
  | { type: "cancel" }
  | { type: "setLayer"; id: number }
  | { type: "addLayer"; a8: boolean; name: string; vector?: boolean }
  | { type: "ruler"; ruler: import("./ruler").Ruler }
  | { type: "vectorWidth"; factor: number }
  | { type: "vectorUniform" }
  | { type: "setLayerVisible"; id: number; visible: boolean }
  | { type: "layerOp"; op: "remove" | "duplicate" | "mergeDown" | "moveUp" | "moveDown" | "rasterize"; id: number }
  | { type: "renameLayer"; id: number; name: string }
  | { type: "setLayerOpacity"; id: number; opacity: number }
  | { type: "setLayerBlend"; id: number; blend: number }
  | { type: "setLayerClip"; id: number; clip: boolean }
  | { type: "thumbnails"; size: number }
  | { type: "sample"; id: number; x: number; y: number }
  | { type: "select"; kind: "rect"; x: number; y: number; w: number; h: number; mode: number }
  | { type: "select"; kind: "polygon"; points: Float32Array; mode: number }
  | { type: "select"; kind: "wand"; x: number; y: number; tolerance: number; contiguous: boolean; merged: boolean; mode: number }
  | { type: "select"; kind: "all" | "none" | "invert" }
  | { type: "fill"; x: number; y: number; tolerance: number; contiguous: boolean; merged: boolean }
  | { type: "fillSelection" }
  | { type: "deleteSelection" }
  | { type: "transformBegin" }
  | { type: "transformPreview"; m: number[] }
  | { type: "transformCommit"; m: number[] }
  | { type: "transformCancel" }
  | { type: "line"; x0: number; y0: number; x1: number; y1: number; pressure: number; commit: boolean }
  | { type: "adjustPreview"; adjust: AdjustParams }
  | { type: "adjustCommit"; adjust: AdjustParams }
  | { type: "adjustCancel" }
  | { type: "filter"; kind: "blur" | "sharpen"; radius: number; amount: number }
  | { type: "resizeCanvas"; w: number; h: number; ax: number; ay: number }
  | { type: "resizeImage"; w: number; h: number }
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "exportPng"; id: number }
  | { type: "save"; id: number }
  | { type: "open"; bytes: ArrayBuffer }
  | { type: "newDoc"; docW: number; docH: number }
  | { type: "readback"; id: number };

export interface Stats {
  /** ワーカー側の 1 フレーム処理時間(ms)。入力の受信から present まで */
  frameMs: number;
  /** 直近フレームで描いたダブ数 */
  dabs: number;
  /** 現在(または直前)のストロークのダブ総数 */
  strokeDabs: number;
  /** 最後の入力イベント時刻から present までの経過(ms)。ソフトウェア側の遅延 */
  inputToDrawMs: number;
  /** 直近フレームの描画呼び出し数 */
  drawCalls: number;
  /** ストローク終了時の焼き込み(読み戻し + 合成 + タイル転送)にかかった ms */
  bakeMs: number;
  /** 画素のメモリ(wasm 側、履歴は含まない) */
  memoryBytes: number;
  historyBytes: number;
  tiles: number;
  canUndo: boolean;
  canRedo: boolean;
  hasSelection: boolean;
}

export type FromWorker =
  | {
      type: "ready";
      version: string;
      renderer: string;
      desynchronized: boolean;
      layers: LayerInfo[];
      active: number;
      docW: number;
      docH: number;
      restored: boolean;
      presets: BrushPreset[];
      blendNames: string[];
    }
  | { type: "doc"; docW: number; docH: number; layers: LayerInfo[]; active: number }
  | { type: "layers"; layers: LayerInfo[]; active: number }
  | { type: "stats"; stats: Stats }
  | { type: "png"; id: number; blob: Blob }
  | { type: "file"; id: number; bytes: ArrayBuffer }
  | { type: "thumbnails"; size: number; items: Array<{ id: number; bitmap: ImageBitmap }> }
  | { type: "floating"; rect: [number, number, number, number] | null; failed?: boolean }
  | { type: "sample"; id: number; rgb: [number, number, number]; alpha: number }
  | { type: "readback"; id: number; painted: number }
  | { type: "toast"; message: string }
  | { type: "error"; message: string };
