import { describe, expect, it } from "vitest";
import { TwoFingerGesture, docToScreen, fitView, screenToDoc, zoomAt } from "./view";

describe("view 変換", () => {
  it("doc → 画面 → doc で戻る(回転あり)", () => {
    const v = { scale: 1.5, tx: 100, ty: 50, rot: 0.7 };
    const [sx, sy] = docToScreen(v, 300, 200);
    const [x, y] = screenToDoc(v, sx, sy);
    expect(x).toBeCloseTo(300, 6);
    expect(y).toBeCloseTo(200, 6);
  });

  it("fitView は中央に収める", () => {
    const v = fitView(2000, 1000, 1000, 1000);
    expect(v.scale).toBeCloseTo(0.46);
    const [cx, cy] = docToScreen(v, 1000, 500);
    expect(cx).toBeCloseTo(500);
    expect(cy).toBeCloseTo(500);
  });

  it("zoomAt は指定点を動かさない", () => {
    const v = { scale: 1, tx: 10, ty: 20, rot: 0 };
    const [dx, dy] = screenToDoc(v, 300, 300);
    const z = zoomAt(v, 300, 300, 2);
    const [sx, sy] = docToScreen(z, dx, dy);
    expect(sx).toBeCloseTo(300);
    expect(sy).toBeCloseTo(300);
    expect(z.scale).toBe(2);
  });
});

describe("TwoFingerGesture", () => {
  it("10px 未満では確定しない", () => {
    const g = new TwoFingerGesture();
    g.start({ scale: 1, tx: 0, ty: 0, rot: 0 }, 0, 0, 100, 0);
    expect(g.update(3, 0, 103, 0)).toBeNull();
    expect(g.confirmed).toBe(false);
  });

  it("平行移動はそのまま tx, ty に乗る", () => {
    const g = new TwoFingerGesture();
    g.start({ scale: 1, tx: 5, ty: 5, rot: 0 }, 0, 0, 100, 0);
    const v = g.update(20, 30, 120, 30)!;
    expect(v.tx).toBeCloseTo(25);
    expect(v.ty).toBeCloseTo(35);
    expect(v.scale).toBeCloseTo(1);
    expect(v.rot).toBe(0);
  });

  it("ピンチは重心を固定して拡大する", () => {
    const g = new TwoFingerGesture();
    const base = { scale: 1, tx: 0, ty: 0, rot: 0 };
    g.start(base, 100, 100, 200, 100);
    const v = g.update(50, 100, 250, 100)!;
    expect(v.scale).toBeCloseTo(2);
    const [cx, cy] = docToScreen(v, 150, 100);
    expect(cx).toBeCloseTo(150);
    expect(cy).toBeCloseTo(100);
  });

  it("小さな回転は 0 に吸着し、大きな回転は効く", () => {
    const g = new TwoFingerGesture();
    g.start({ scale: 1, tx: 0, ty: 0, rot: 0 }, 0, 0, 100, 0);
    // 14 度(重心は 12.5px 動くので確定はする)
    const small = g.update(0, 0, 100, 25)!;
    expect(small).not.toBeNull();
    expect(small.rot).toBe(0);
    const big = g.update(0, 0, 0, 100)!;
    expect(big.rot).toBeCloseTo(Math.PI / 2);
  });
});
