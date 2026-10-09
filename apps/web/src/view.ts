// 表示変換と 2 本指ジェスチャ。DOM に触らない純粋な部品。
import type { View } from "./protocol";

/** 画面 px → ドキュメント px。 */
export function screenToDoc(v: View, sx: number, sy: number): [number, number] {
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  const dx = (sx - v.tx) / v.scale;
  const dy = (sy - v.ty) / v.scale;
  // R(-rot)
  return [c * dx + s * dy, -s * dx + c * dy];
}

/** ドキュメント px → 画面 px。 */
export function docToScreen(v: View, x: number, y: number): [number, number] {
  const c = Math.cos(v.rot);
  const s = Math.sin(v.rot);
  return [v.scale * (c * x - s * y) + v.tx, v.scale * (s * x + c * y) + v.ty];
}

/** ドキュメント全体が画面に収まるように(余白 8%)。 */
export function fitView(docW: number, docH: number, viewW: number, viewH: number): View {
  const scale = Math.min(viewW / docW, viewH / docH) * 0.92;
  return {
    scale,
    rot: 0,
    tx: (viewW - docW * scale) / 2,
    ty: (viewH - docH * scale) / 2,
  };
}

/** 画面上の点 (cx, cy) を固定したまま倍率を掛ける。 */
export function zoomAt(v: View, cx: number, cy: number, k: number, min = 0.02, max = 64): View {
  const scale = Math.min(max, Math.max(min, v.scale * k));
  const kk = scale / v.scale;
  return {
    scale,
    rot: v.rot,
    tx: cx + (v.tx - cx) * kk,
    ty: cy + (v.ty - cy) * kk,
  };
}

/**
 * 2 本指のパンとズームと回転(macbeth の値)。
 * 重心の移動とピンチ量の合計が 10px を超えたら確定。回転は 15 度未満なら 0 に吸着。
 * 開始時の View に、開始時の 2 点から今の 2 点への相似変換を掛けて新しい View を作る。
 */
export class TwoFingerGesture {
  private base: View | null = null;
  private a0 = [0, 0];
  private b0 = [0, 0];
  private armed = false;
  readonly threshold = 10;
  readonly rotSnap = (15 * Math.PI) / 180;

  get active(): boolean {
    return this.base !== null;
  }
  get confirmed(): boolean {
    return this.armed;
  }

  start(view: View, ax: number, ay: number, bx: number, by: number): void {
    this.base = { ...view };
    this.a0 = [ax, ay];
    this.b0 = [bx, by];
    this.armed = false;
  }

  end(): void {
    this.base = null;
    this.armed = false;
  }

  /** 今の 2 点から View を返す。まだ確定していなければ null。 */
  update(ax: number, ay: number, bx: number, by: number): View | null {
    if (!this.base) return null;
    const [ax0, ay0] = this.a0 as [number, number];
    const [bx0, by0] = this.b0 as [number, number];
    const c0 = [(ax0 + bx0) / 2, (ay0 + by0) / 2];
    const c1 = [(ax + bx) / 2, (ay + by) / 2];
    const d0 = Math.hypot(bx0 - ax0, by0 - ay0);
    const d1 = Math.hypot(bx - ax, by - ay);
    if (!this.armed) {
      const moved = Math.hypot(c1[0]! - c0[0]!, c1[1]! - c0[1]!) + Math.abs(d1 - d0);
      if (moved < this.threshold) return null;
      this.armed = true;
    }
    const k = d0 > 1 ? d1 / d0 : 1;
    let theta = Math.atan2(by - ay, bx - ax) - Math.atan2(by0 - ay0, bx0 - ax0);
    if (Math.abs(theta) < this.rotSnap) theta = 0;
    const b = this.base;
    const scale = Math.min(64, Math.max(0.02, b.scale * k));
    const kk = scale / b.scale;
    const c = Math.cos(theta) * kk;
    const s = Math.sin(theta) * kk;
    // new(doc) = c1 + k R(θ) (old(doc) - c0)
    const tx = c1[0]! + c * (b.tx - c0[0]!) - s * (b.ty - c0[1]!);
    const ty = c1[1]! + s * (b.tx - c0[0]!) + c * (b.ty - c0[1]!);
    return { scale, rot: b.rot + theta, tx, ty };
  }
}
