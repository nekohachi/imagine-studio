// 入力まわりの純粋な部品。DOM に触らないのでそのまま vitest で試せる。
import { POINT_STRIDE } from "./protocol";

/** フレームごとに入力点を溜めて、まとめてワーカーへ転送するための袋。 */
export class PointPacker {
  private buf = new Float32Array(POINT_STRIDE * 256);
  private n = 0;

  push(x: number, y: number, pressure: number, time: number): void {
    if ((this.n + 1) * POINT_STRIDE > this.buf.length) {
      const next = new Float32Array(this.buf.length * 2);
      next.set(this.buf);
      this.buf = next;
    }
    const o = this.n * POINT_STRIDE;
    this.buf[o] = x;
    this.buf[o + 1] = y;
    this.buf[o + 2] = pressure;
    this.buf[o + 3] = time;
    this.n++;
  }

  get length(): number {
    return this.n;
  }

  /** 溜めた点を取り出して空にする。返す配列は転送してよい(内部では使い回さない)。 */
  take(): Float32Array {
    const out = this.buf.slice(0, this.n * POINT_STRIDE);
    this.n = 0;
    return out;
  }
}

/**
 * パームリジェクション。ペンを見た直後は指を描画に使わない。
 * 指描きを明示的に許可しているときだけ指でも描く。
 */
export class PalmGuard {
  private lastPen = -Infinity;
  constructor(private readonly windowMs = 1500) {}

  sawPen(now: number): void {
    this.lastPen = now;
  }

  allowTouch(now: number, fingerDraw: boolean): boolean {
    if (!fingerDraw) return false;
    return now - this.lastPen > this.windowMs;
  }
}

/**
 * 指で描くときの筆圧。速いほど細く(DESIGN.md の知見: EMA 0.3)。
 * `speedPxPerMs` が 0 のとき 1.0、`fullSpeed` 以上で `minPressure`。
 */
export class SpeedPressure {
  private ema = 1.0;
  constructor(
    private readonly fullSpeed = 2.0,
    private readonly minPressure = 0.25,
    private readonly alpha = 0.3
  ) {}

  reset(): void {
    this.ema = 1.0;
  }

  feed(speedPxPerMs: number): number {
    const target = Math.max(this.minPressure, 1 - speedPxPerMs / this.fullSpeed);
    this.ema += (target - this.ema) * this.alpha;
    return this.ema;
  }
}

/** ポインタ種別ごとの筆圧の正規化。マウスは 0.5 固定で来るので 1.0 にする。 */
export function normalizePressure(pointerType: string, raw: number): number {
  if (pointerType === "pen") return raw > 0 ? raw : 0.5;
  if (pointerType === "mouse") return 1.0;
  return raw > 0 ? raw : 0.5;
}

/**
 * 予測点の仮描画用。最後に確定したダブから予測点まで、間隔どおりに円を並べる。
 * brush-core を通さない(予測点でエンジンの状態を汚さないため)。
 * 戻り値は [x, y, radius, opacity] × n。
 */
export function extrapolateDabs(
  fromX: number,
  fromY: number,
  radius: number,
  opacity: number,
  spacing: number,
  predicted: Float32Array,
  maxDabs = 64
): Float32Array {
  const step = Math.max(0.5, radius * spacing);
  const out: number[] = [];
  let px = fromX;
  let py = fromY;
  let carry = step;
  for (let i = 0; i + 1 < predicted.length; i += POINT_STRIDE) {
    const qx = predicted[i]!;
    const qy = predicted[i + 1]!;
    const dx = qx - px;
    const dy = qy - py;
    const len = Math.hypot(dx, dy);
    if (len < 1e-3) continue;
    let d = carry;
    while (d <= len) {
      const t = d / len;
      out.push(px + dx * t, py + dy * t, radius, opacity);
      d += step;
      if (out.length / 4 >= maxDabs) return Float32Array.from(out);
    }
    carry = d - len;
    px = qx;
    py = qy;
  }
  return Float32Array.from(out);
}
