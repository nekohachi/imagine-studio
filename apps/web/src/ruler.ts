// 定規(docs/06): 直線 / 平行 / 放射 / 同心円 / パース / 対称。
// 入力点(doc 座標)を定規に吸着させる純関数。描画ワーカーがストロークの前段で使い、
// メインスレッドは同じ定義を SVG に描く。
import { apply, mul, rotate, translate, type Affine } from "./affine";
import { POINT_STRIDE } from "./protocol";

export type Ruler =
  | { kind: "none" }
  /** 2 点を通る直線に吸着 */
  | { kind: "line"; ax: number; ay: number; bx: number; by: number }
  /** 始点を通る、角度 angle(ラジアン)の直線に吸着 */
  | { kind: "parallel"; angle: number }
  /** 中心から始点を通る半直線に吸着 */
  | { kind: "radial"; cx: number; cy: number }
  /** 中心を中心に始点を通る円に吸着 */
  | { kind: "concentric"; cx: number; cy: number }
  /** 消失点(1〜3)へ向かう直線に吸着。最初の動きで向きを選ぶ。2 点以下なら垂直も、1 点なら水平も候補 */
  | { kind: "perspective"; vps: Array<[number, number]> }
  /** 対称: 中心のまわりに copies 回対称、mirror なら角度 angle の軸で鏡像も(合計 copies か 2·copies 本) */
  | { kind: "symmetry"; cx: number; cy: number; angle: number; copies: number; mirror: boolean };

export const NO_RULER: Ruler = { kind: "none" };

type Guide = { kind: "line"; x: number; y: number; dx: number; dy: number } | { kind: "circle"; cx: number; cy: number; r: number };

/** 向きを決めるのに要る動き(doc px) */
const DECIDE_PX = 6;

function norm(dx: number, dy: number): [number, number] {
  const l = Math.hypot(dx, dy) || 1;
  return [dx / l, dy / l];
}

function mapTo(g: Guide, x: number, y: number): [number, number] {
  if (g.kind === "line") {
    const t = (x - g.x) * g.dx + (y - g.y) * g.dy;
    return [g.x + g.dx * t, g.y + g.dy * t];
  }
  const [nx, ny] = norm(x - g.cx, y - g.cy);
  return [g.cx + nx * g.r, g.cy + ny * g.r];
}

/** 1 ストロークぶんの吸着。begin → feed × n → finish。 */
export class Snapper {
  private guide: Guide | null = null;
  private first: [number, number] | null = null;
  private buf: number[] = [];

  constructor(private readonly ruler: Ruler) {}

  /** 吸着が効いているか(定規なし以外) */
  get active(): boolean {
    return this.ruler.kind !== "none" && this.ruler.kind !== "symmetry";
  }

  /** 点列(POINT_STRIDE ずつ)を吸着して返す。向きが決まるまでの点は貯めて、決まったときにまとめて返す。 */
  feed(pts: Float32Array | number[]): Float32Array {
    if (!this.active) return pts instanceof Float32Array ? pts : Float32Array.from(pts);
    const out: number[] = [];
    for (let i = 0; i + POINT_STRIDE <= pts.length; i += POINT_STRIDE) {
      const x = pts[i]!;
      const y = pts[i + 1]!;
      if (!this.first) this.first = [x, y];
      if (!this.guide) this.guide = this.decide(x, y);
      if (!this.guide) {
        for (let k = 0; k < POINT_STRIDE; k++) this.buf.push(pts[i + k]!);
        continue;
      }
      if (this.buf.length) {
        for (let j = 0; j < this.buf.length; j += POINT_STRIDE) {
          const [mx, my] = mapTo(this.guide, this.buf[j]!, this.buf[j + 1]!);
          out.push(mx, my, this.buf[j + 2]!, this.buf[j + 3]!, this.buf[j + 4]!, this.buf[j + 5]!);
        }
        this.buf = [];
      }
      const [mx, my] = mapTo(this.guide, x, y);
      out.push(mx, my, pts[i + 2]!, pts[i + 3]!, pts[i + 4]!, pts[i + 5]!);
    }
    return Float32Array.from(out);
  }

  /** 予測点など、貯めずに写すだけ(向きが未決なら空)。 */
  map(pts: Float32Array): Float32Array {
    if (!this.active) return pts;
    if (!this.guide) return new Float32Array(0);
    const out = new Float32Array(pts.length);
    out.set(pts);
    for (let i = 0; i + POINT_STRIDE <= pts.length; i += POINT_STRIDE) {
      const [mx, my] = mapTo(this.guide, pts[i]!, pts[i + 1]!);
      out[i] = mx;
      out[i + 1] = my;
    }
    return out;
  }

  /** 終わり: 向きが決まらないまま(短いタップ)なら貯めた点をそのまま返す。 */
  finish(): Float32Array {
    const rest = Float32Array.from(this.buf);
    this.buf = [];
    return rest;
  }

  private decide(x: number, y: number): Guide | null {
    const r = this.ruler;
    const f = this.first!;
    switch (r.kind) {
      case "line": {
        const [dx, dy] = norm(r.bx - r.ax, r.by - r.ay);
        return { kind: "line", x: r.ax, y: r.ay, dx, dy };
      }
      case "parallel":
        return { kind: "line", x: f[0], y: f[1], dx: Math.cos(r.angle), dy: Math.sin(r.angle) };
      case "radial": {
        const d = Math.hypot(x - r.cx, y - r.cy);
        if (d < 2) return null;
        const [dx, dy] = norm(x - r.cx, y - r.cy);
        return { kind: "line", x: r.cx, y: r.cy, dx, dy };
      }
      case "concentric": {
        const d = Math.hypot(f[0] - r.cx, f[1] - r.cy);
        if (d < 1) return null;
        return { kind: "circle", cx: r.cx, cy: r.cy, r: d };
      }
      case "perspective": {
        const mx = x - f[0];
        const my = y - f[1];
        if (Math.hypot(mx, my) < DECIDE_PX) return null;
        const [ux, uy] = norm(mx, my);
        const cands: Array<[number, number]> = r.vps.map(([vx, vy]) => norm(vx - f[0], vy - f[1]));
        if (r.vps.length <= 2) cands.push([0, 1]);
        if (r.vps.length <= 1) cands.push([1, 0]);
        let best = cands[0]!;
        let bestDot = -1;
        for (const c of cands) {
          const d = Math.abs(c[0] * ux + c[1] * uy);
          if (d > bestDot) {
            bestDot = d;
            best = c;
          }
        }
        return { kind: "line", x: f[0], y: f[1], dx: best[0], dy: best[1] };
      }
      default:
        return null;
    }
  }
}

/** 対称定規の写像(最初は恒等)。それ以外は恒等 1 つ。 */
export function symmetryTransforms(r: Ruler): Affine[] {
  if (r.kind !== "symmetry") return [[1, 0, 0, 1, 0, 0]];
  const n = Math.max(1, Math.min(8, Math.round(r.copies)));
  const out: Affine[] = [];
  const toC = translate(-r.cx, -r.cy);
  const back = translate(r.cx, r.cy);
  // 軸に沿った鏡像: 軸を x 軸に回して y を反転し、戻す
  const refl: Affine = mul(rotate(r.angle), mul([1, 0, 0, -1, 0, 0], rotate(-r.angle)));
  for (let k = 0; k < n; k++) {
    const rot = rotate((Math.PI * 2 * k) / n);
    out.push(mul(back, mul(rot, toC)));
    if (r.mirror) out.push(mul(back, mul(rot, mul(refl, toC))));
  }
  return out;
}

/** 点列(POINT_STRIDE ずつ)の x, y だけに写像を掛ける。 */
export function transformPoints(pts: Float32Array, m: Affine): Float32Array {
  const out = new Float32Array(pts.length);
  out.set(pts);
  for (let i = 0; i + POINT_STRIDE <= pts.length; i += POINT_STRIDE) {
    const [x, y] = apply(m, pts[i]!, pts[i + 1]!);
    out[i] = x;
    out[i + 1] = y;
  }
  return out;
}

export const RULER_LABELS: Record<Ruler["kind"], string> = {
  none: "なし",
  line: "直線",
  parallel: "平行線",
  radial: "放射線",
  concentric: "同心円",
  perspective: "パース",
  symmetry: "対称",
};
