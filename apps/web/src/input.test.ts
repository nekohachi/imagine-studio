import { describe, expect, it } from "vitest";
import { PalmGuard, PointPacker, SpeedPressure, extrapolateDabs, normalizePressure } from "./input";

describe("PointPacker", () => {
  it("詰めた順に取り出せて、取り出すと空になる", () => {
    const p = new PointPacker();
    p.push(1, 2, 0.5, 10);
    p.push(3, 4, 0.75, 20);
    expect(p.length).toBe(2);
    const a = p.take();
    expect(Array.from(a)).toEqual([1, 2, 0.5, 10, 3, 4, 0.75, 20]);
    expect(p.length).toBe(0);
    expect(p.take().length).toBe(0);
  });

  it("容量を超えても壊れない", () => {
    const p = new PointPacker();
    for (let i = 0; i < 5000; i++) p.push(i, i, 1, i);
    const a = p.take();
    expect(a.length).toBe(5000 * 4);
    expect(a[4 * 4999]).toBe(4999);
  });
});

describe("PalmGuard", () => {
  it("指描き許可が無ければ指は常に拒否", () => {
    const g = new PalmGuard(1500);
    expect(g.allowTouch(0, false)).toBe(false);
  });
  it("ペンを見た直後は指描き許可があっても拒否、時間が経てば許可", () => {
    const g = new PalmGuard(1500);
    g.sawPen(1000);
    expect(g.allowTouch(1500, true)).toBe(false);
    expect(g.allowTouch(2600, true)).toBe(true);
  });
});

describe("SpeedPressure", () => {
  it("止まっていれば 1 に近づき、速いと下がる", () => {
    const s = new SpeedPressure(2, 0.25, 0.3);
    let v = 1;
    for (let i = 0; i < 20; i++) v = s.feed(4);
    expect(v).toBeLessThan(0.3);
    for (let i = 0; i < 40; i++) v = s.feed(0);
    expect(v).toBeGreaterThan(0.95);
  });
});

describe("normalizePressure", () => {
  it("マウスは 1、ペンは生の値", () => {
    expect(normalizePressure("mouse", 0.5)).toBe(1);
    expect(normalizePressure("pen", 0.3)).toBe(0.3);
    expect(normalizePressure("touch", 0)).toBe(0.5);
  });
});

describe("extrapolateDabs", () => {
  it("予測点まで間隔どおりに並ぶ", () => {
    const predicted = Float32Array.from([10, 0, 0.5, 0, 20, 0, 0.5, 0]);
    const dabs = extrapolateDabs(0, 0, 4, 1, 0.5, predicted);
    const xs: number[] = [];
    for (let i = 0; i < dabs.length; i += 4) xs.push(dabs[i]!);
    expect(xs).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(dabs[2]).toBe(4);
  });
  it("上限で止まる", () => {
    const predicted = Float32Array.from([1000, 0, 0.5, 0]);
    const dabs = extrapolateDabs(0, 0, 1, 1, 0.5, predicted, 10);
    expect(dabs.length).toBe(40);
  });
  it("空の予測なら空", () => {
    expect(extrapolateDabs(0, 0, 4, 1, 0.5, new Float32Array(0)).length).toBe(0);
  });
});
