/**
 * 指のタップ判定(macbeth の値)。
 *   指 2 本ダブルタップ = Undo、指 3 本ダブルタップ = Redo、指 4 本タップ = UI 非表示
 *   着地は 120ms 以内にそろう、12px 以内、300ms 以内に離す。ダブルは 350ms 以内。
 * DOM に触らない純粋な判定。時刻は呼び出し側が渡す(テストしやすいように)。
 */

export const LAND_MS = 120;
export const MOVE_PX = 12;
export const RELEASE_MS = 300;
export const DOUBLE_MS = 350;

interface Finger {
  x: number;
  y: number;
  t: number;
  moved: boolean;
}

export class FingerTaps {
  private fingers = new Map<number, Finger>();
  /** 今の着地群の最大本数と、最初の着地時刻 */
  private group = { n: 0, t0: 0, dirty: false };
  private lastTap: { n: number; t: number } | null = null;

  constructor(private readonly onTap: (fingers: number, double: boolean) => void) {}

  get count(): number {
    return this.fingers.size;
  }

  down(id: number, x: number, y: number, t: number): void {
    if (this.fingers.size === 0) this.group = { n: 0, t0: t, dirty: false };
    else if (t - this.group.t0 > LAND_MS) this.group.dirty = true; // ばらばらに着地した
    this.fingers.set(id, { x, y, t, moved: false });
    this.group.n = Math.max(this.group.n, this.fingers.size);
  }

  move(id: number, x: number, y: number): void {
    const f = this.fingers.get(id);
    if (!f) return;
    if (Math.hypot(x - f.x, y - f.y) > MOVE_PX) {
      f.moved = true;
      this.group.dirty = true;
    }
  }

  up(id: number, t: number, cancelled = false): void {
    const f = this.fingers.get(id);
    if (!f) return;
    this.fingers.delete(id);
    if (cancelled || f.moved || t - this.group.t0 > RELEASE_MS) this.group.dirty = true;
    if (this.fingers.size > 0) return;
    // 全部離れた
    const n = this.group.n;
    const ok = !this.group.dirty && n >= 2;
    if (!ok) {
      this.lastTap = null;
      return;
    }
    const double = this.lastTap !== null && this.lastTap.n === n && t - this.lastTap.t <= DOUBLE_MS;
    this.onTap(n, double);
    this.lastTap = double ? null : { n, t };
  }

  reset(): void {
    this.fingers.clear();
    this.lastTap = null;
    this.group = { n: 0, t0: 0, dirty: false };
  }
}
