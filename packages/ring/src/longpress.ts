/**
 * ビューポートの長押し(400ms、12px 動いたら取消)。macbeth の値。
 * DOM に触らない純粋な判定。pointerdown で begin、move で update、up/cancel で end。
 */

export const LONG_PRESS_MS = 400;
export const LONG_PRESS_MOVE_PX = 12;

export class LongPress {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private x0 = 0;
  private y0 = 0;
  private id = -1;
  private fired = false;

  constructor(
    private readonly onFire: (x: number, y: number, pointerId: number) => void,
    private readonly ms = LONG_PRESS_MS,
    private readonly movePx = LONG_PRESS_MOVE_PX
  ) {}

  get pending(): boolean {
    return this.timer !== null;
  }
  get didFire(): boolean {
    return this.fired;
  }

  begin(pointerId: number, x: number, y: number): void {
    this.cancel();
    this.id = pointerId;
    this.x0 = x;
    this.y0 = y;
    this.fired = false;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fired = true;
      this.onFire(this.x0, this.y0, this.id);
    }, this.ms);
  }

  /** 動きすぎたら取り消す。取り消したら真。 */
  update(pointerId: number, x: number, y: number): boolean {
    if (pointerId !== this.id || this.timer === null) return false;
    if (Math.hypot(x - this.x0, y - this.y0) > this.movePx) {
      this.cancel();
      return true;
    }
    return false;
  }

  end(pointerId: number): void {
    if (pointerId !== this.id) return;
    this.cancel();
  }

  cancel(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
