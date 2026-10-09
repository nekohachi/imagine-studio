// 色の変換と、HSV の色選び(SV の四角 + 色相の帯)。DOM の部品だが状態は持たない。

export type Rgb = [number, number, number];

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

export function rgbToHsv([r, g, b]: Rgb): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 1e-6) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
    if (h < 0) h += 1;
  }
  return [h, max > 1e-6 ? d / max : 0, max];
}

export function rgbToHex(c: Rgb): string {
  const q = (v: number) =>
    Math.round(Math.min(1, Math.max(0, v)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${q(c[0])}${q(c[1])}${q(c[2])}`;
}

export function hexToRgb(hex: string): Rgb | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 既定のパレット(24 色)。ドット絵アプリの固定パレットに近い並び。 */
export const DEFAULT_PALETTE = [
  "#000000", "#4a4a4a", "#9a9a9a", "#ffffff",
  "#c0392b", "#e74c3c", "#e67e22", "#f1c40f",
  "#2ecc71", "#27ae60", "#16a085", "#1abc9c",
  "#3498db", "#2980b9", "#8e44ad", "#9b59b6",
  "#f5cba7", "#e8b796", "#c68642", "#8d5524",
  "#fadbd8", "#f9e79f", "#d5f5e3", "#d6eaf8",
];

export class ColorPicker {
  private h = 0;
  private s = 0;
  private v = 0;
  private sv: HTMLElement;
  private svKnob: HTMLElement;
  private hue: HTMLElement;
  private hueKnob: HTMLElement;

  constructor(
    root: HTMLElement,
    private readonly onChange: (rgb: Rgb, final: boolean) => void
  ) {
    root.classList.add("cpick");
    root.innerHTML =
      '<div class="cpick-sv"><div class="cpick-knob"></div></div><div class="cpick-hue"><div class="cpick-knob"></div></div>';
    this.sv = root.querySelector(".cpick-sv")!;
    this.svKnob = this.sv.querySelector(".cpick-knob")!;
    this.hue = root.querySelector(".cpick-hue")!;
    this.hueKnob = this.hue.querySelector(".cpick-knob")!;
    this.drag(this.sv, (x, y, final) => {
      this.s = x;
      this.v = 1 - y;
      this.paint();
      this.onChange(hsvToRgb(this.h, this.s, this.v), final);
    });
    this.drag(this.hue, (_x, y, final) => {
      this.h = y;
      this.paint();
      this.onChange(hsvToRgb(this.h, this.s, this.v), final);
    });
    this.paint();
  }

  set(rgb: Rgb): void {
    const [h, s, v] = rgbToHsv(rgb);
    if (s > 1e-3 && v > 1e-3) this.h = h;
    this.s = s;
    this.v = v;
    this.paint();
  }

  private paint(): void {
    const base = rgbToHex(hsvToRgb(this.h, 1, 1));
    this.sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${base})`;
    this.svKnob.style.left = `${this.s * 100}%`;
    this.svKnob.style.top = `${(1 - this.v) * 100}%`;
    this.hueKnob.style.top = `${this.h * 100}%`;
  }

  private drag(el: HTMLElement, fn: (x: number, y: number, final: boolean) => void): void {
    let active = false;
    const at = (e: PointerEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      return [
        Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
        Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
      ];
    };
    el.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      active = true;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* 捕まえられなくても動く */
      }
      const [x, y] = at(e);
      fn(x, y, false);
    });
    el.addEventListener("pointermove", (e) => {
      if (!active) return;
      const [x, y] = at(e);
      fn(x, y, false);
    });
    for (const t of ["pointerup", "pointercancel"] as const) {
      el.addEventListener(t, (e) => {
        if (!active) return;
        active = false;
        const [x, y] = at(e);
        fn(x, y, true);
      });
    }
  }
}
