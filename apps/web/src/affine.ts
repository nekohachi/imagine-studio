// 2×3 のアフィン行列 [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f(canvas-core と同じ並び)。
export type Affine = [number, number, number, number, number, number];

export const IDENTITY: Affine = [1, 0, 0, 1, 0, 0];

/** p · q(先に q、次に p) */
export function mul(p: Affine, q: Affine): Affine {
  return [
    p[0] * q[0] + p[2] * q[1],
    p[1] * q[0] + p[3] * q[1],
    p[0] * q[2] + p[2] * q[3],
    p[1] * q[2] + p[3] * q[3],
    p[0] * q[4] + p[2] * q[5] + p[4],
    p[1] * q[4] + p[3] * q[5] + p[5],
  ];
}

export function translate(x: number, y: number): Affine {
  return [1, 0, 0, 1, x, y];
}
export function scale(sx: number, sy: number): Affine {
  return [sx, 0, 0, sy, 0, 0];
}
export function rotate(rad: number): Affine {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}
export function apply(m: Affine, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}
export function inverse(m: Affine): Affine | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}
/** 点 p を中心に m を掛ける: T(p) · m · T(-p) */
export function about(px: number, py: number, m: Affine): Affine {
  return mul(translate(px, py), mul(m, translate(-px, -py)));
}
