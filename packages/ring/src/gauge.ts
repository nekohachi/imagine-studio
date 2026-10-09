/**
 * 左レールの縦ゲージ。macbeth の Gauge を単純にしたもの。
 * 0..1 のつまみ位置と実値の対応は `map` / `unmap` で渡す(太さは 2 乗のカーブなど)。
 */

export interface GaugeSpec {
  label: string;
  /** つまみ位置 0..1 → 値 */
  map: (t: number) => number;
  /** 値 → つまみ位置 0..1 */
  unmap: (v: number) => number;
  format: (v: number) => string;
  get: () => number;
  set: (v: number) => void;
  /** 指を離したとき */
  commit?: () => void;
}

export class Gauge {
  private fill: HTMLElement;
  private knob: HTMLElement;
  private label: HTMLElement;
  private value: HTMLElement;
  private active = false;

  constructor(
    private root: HTMLElement,
    private spec: GaugeSpec
  ) {
    root.classList.add("gauge");
    root.innerHTML =
      '<div class="gauge-label"></div><div class="gauge-track"><div class="fill"></div><div class="knob"></div></div><div class="gauge-value"></div>';
    this.label = root.querySelector(".gauge-label")!;
    this.value = root.querySelector(".gauge-value")!;
    this.fill = root.querySelector(".fill")!;
    this.knob = root.querySelector(".knob")!;
    this.attach();
    this.paint();
  }

  setSpec(spec: GaugeSpec): void {
    this.spec = spec;
    this.paint();
  }

  paint(): void {
    const v = this.spec.get();
    const t = Math.max(0, Math.min(1, this.spec.unmap(v)));
    this.label.textContent = this.spec.label;
    this.fill.style.height = `${t * 100}%`;
    this.knob.style.bottom = `calc(${t * 100}% - 1px)`;
    this.value.textContent = this.spec.format(v);
  }

  private ratio(clientY: number): number {
    const track = this.root.querySelector(".gauge-track") as HTMLElement;
    const r = track.getBoundingClientRect();
    return Math.max(0, Math.min(1, 1 - (clientY - r.top) / r.height));
  }

  private setFromY(clientY: number): void {
    this.spec.set(this.spec.map(this.ratio(clientY)));
    this.paint();
  }

  private attach(): void {
    const g = this.root;
    g.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    g.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      this.active = true;
      try {
        g.setPointerCapture(e.pointerId);
      } catch {
        /* 捕まえられなくても、その要素の上で動かす限りは届く */
      }
      this.setFromY(e.clientY);
    });
    g.addEventListener("pointermove", (e) => {
      if (this.active) this.setFromY(e.clientY);
    });
    for (const t of ["pointerup", "pointercancel"] as const) {
      g.addEventListener(t, () => {
        if (!this.active) return;
        this.active = false;
        this.spec.commit?.();
      });
    }
  }
}
