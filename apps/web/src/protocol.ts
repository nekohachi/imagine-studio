// メインスレッドと描画ワーカーの間の約束。
// 入力点は [x, y, pressure, time] の 4 要素ずつ、ダブは [x, y, radius, opacity] の 4 要素ずつ。
// 座標はキャンバスの backing px(CSS px × devicePixelRatio)。

export const POINT_STRIDE = 4;
export const DAB_STRIDE = 4;

export interface BrushSettings {
  radius: number;
  stabilizer: number;
  hardness: number;
  opacity: number;
  flow: number;
  spacing: number;
  color: [number, number, number];
}

export type ToWorker =
  | { type: "init"; canvas: OffscreenCanvas; width: number; height: number }
  | { type: "resize"; width: number; height: number }
  | { type: "brush"; brush: BrushSettings }
  | { type: "begin" }
  | { type: "points"; data: Float32Array; predicted: Float32Array; frameTime: number }
  | { type: "end" }
  | { type: "cancel" }
  | { type: "clear" }
  | { type: "undo" }
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
}

export type FromWorker =
  | { type: "ready"; version: string; renderer: string; desynchronized: boolean }
  | { type: "stats"; stats: Stats }
  | { type: "readback"; id: number; painted: number }
  | { type: "error"; message: string };
