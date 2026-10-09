// メインスレッドと描画ワーカーの間の約束。
// 入力点は [x, y, pressure, time] の 4 要素ずつ、ダブは [x, y, radius, opacity] の 4 要素ずつ。
// 座標はドキュメント px(キャンバスの画素)。画面との変換は View で行う。

export const POINT_STRIDE = 4;
export const DAB_STRIDE = 4;

/** 画面(backing px)= scale · R(rot) · doc + (tx, ty) */
export interface View {
  scale: number;
  tx: number;
  ty: number;
  rot: number;
}

export interface BrushSettings {
  radius: number;
  stabilizer: number;
  hardness: number;
  opacity: number;
  flow: number;
  spacing: number;
  color: [number, number, number];
  eraser: boolean;
}

export interface LayerInfo {
  id: number;
  name: string;
  visible: boolean;
  a8: boolean;
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
  | { type: "addLayer"; a8: boolean; name: string }
  | { type: "setLayerVisible"; id: number; visible: boolean }
  | { type: "clear" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "exportPng"; id: number }
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
}

export type FromWorker =
  | {
      type: "ready";
      version: string;
      renderer: string;
      desynchronized: boolean;
      layers: LayerInfo[];
      active: number;
    }
  | { type: "layers"; layers: LayerInfo[]; active: number }
  | { type: "stats"; stats: Stats }
  | { type: "png"; id: number; blob: Blob }
  | { type: "readback"; id: number; painted: number }
  | { type: "error"; message: string };
