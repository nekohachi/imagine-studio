import { describe, expect, it } from "vitest";
import { apply } from "./affine";
import { Snapper, symmetryTransforms, transformPoints, type Ruler } from "./ruler";

const pt = (x: number, y: number, t = 0) => [x, y, 1, t, 0, 0];
const xy = (a: Float32Array, i: number) => [a[i * 6]!, a[i * 6 + 1]!];

describe("Snapper", () => {
  it("直線: 2 点を通る線に射影する", () => {
    const s = new Snapper({ kind: "line", ax: 0, ay: 100, bx: 100, by: 100 });
    const out = s.feed(Float32Array.from([...pt(10, 90), ...pt(50, 130)]));
    expect(xy(out, 0)).toEqual([10, 100]);
    expect(xy(out, 1)).toEqual([50, 100]);
  });

  it("平行線: 始点を通る角度の線", () => {
    const s = new Snapper({ kind: "parallel", angle: Math.PI / 2 });
    const out = s.feed(Float32Array.from([...pt(30, 10), ...pt(45, 60)]));
    expect(xy(out, 1)[0]).toBeCloseTo(30);
    expect(xy(out, 1)[1]).toBeCloseTo(60);
  });

  it("放射線と同心円", () => {
    const r = new Snapper({ kind: "radial", cx: 0, cy: 0 });
    const o = r.feed(Float32Array.from([...pt(10, 10), ...pt(30, 10)]));
    // 中心から (10,10) 方向の線に乗る
    expect(xy(o, 1)[0]).toBeCloseTo(20);
    expect(xy(o, 1)[1]).toBeCloseTo(20);
    const c = new Snapper({ kind: "concentric", cx: 0, cy: 0 });
    const o2 = c.feed(Float32Array.from([...pt(10, 0), ...pt(0, 30)]));
    expect(Math.hypot(...(xy(o2, 1) as [number, number]))).toBeCloseTo(10);
  });

  it("パース: 最初の動きで消失点を選ぶ。決まるまで点を貯める", () => {
    const rul: Ruler = { kind: "perspective", vps: [[1000, 100]] };
    const s = new Snapper(rul);
    const a = s.feed(Float32Array.from([...pt(100, 300)]));
    expect(a.length).toBe(0);
    // 消失点の方向(ほぼ右、少し上)へ動く
    const b = s.feed(Float32Array.from([...pt(120, 296), ...pt(200, 300)]));
    expect(b.length).toBe(18);
    // 消失点へ向かう線上: y は x に応じて 300 → 100 へ
    const [x1, y1] = xy(b, 2);
    expect(x1).toBeGreaterThan(190);
    expect(y1).toBeLessThan(300);
    // 1 点なら垂直と水平も候補
    const s2 = new Snapper(rul);
    s2.feed(Float32Array.from([...pt(100, 300)]));
    const v = s2.feed(Float32Array.from([...pt(101, 320), ...pt(103, 400)]));
    expect(xy(v, 2)[0]).toBeCloseTo(100);
  });

  it("短いタップは finish で貯めた点を返す", () => {
    const s = new Snapper({ kind: "perspective", vps: [[0, 0]] });
    s.feed(Float32Array.from([...pt(50, 50), ...pt(51, 50)]));
    expect(s.finish().length).toBe(12);
  });
});

describe("symmetryTransforms", () => {
  it("copies × (mirror ? 2 : 1) 個で、最初は恒等", () => {
    const r: Ruler = { kind: "symmetry", cx: 100, cy: 100, angle: Math.PI / 2, copies: 1, mirror: true };
    const ts = symmetryTransforms(r);
    expect(ts.length).toBe(2);
    expect(apply(ts[0]!, 130, 80)).toEqual([130, 80]);
    // 縦軸(x = 100)の鏡像
    const [x, y] = apply(ts[1]!, 130, 80);
    expect(x).toBeCloseTo(70);
    expect(y).toBeCloseTo(80);
    expect(symmetryTransforms({ ...r, copies: 4, mirror: false }).length).toBe(4);
    const rot = symmetryTransforms({ ...r, copies: 2, mirror: false })[1]!;
    const [rx, ry] = apply(rot, 130, 80);
    expect(rx).toBeCloseTo(70);
    expect(ry).toBeCloseTo(120);
  });

  it("transformPoints は x, y だけ変える", () => {
    const out = transformPoints(Float32Array.from(pt(1, 2, 7)), [2, 0, 0, 2, 0, 0]);
    expect(Array.from(out)).toEqual([2, 4, 1, 7, 0, 0]);
  });
});
