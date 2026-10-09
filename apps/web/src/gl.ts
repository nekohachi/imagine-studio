// WebGL2 レンダラ(描画ワーカーの中で動く)。
//
// docs/02 の方針:
// - テクスチャは RGBA8 / R8 だけ。浮動小数は使わない。
// - 合成はプリマルチプライド src-over(ONE, ONE_MINUS_SRC_ALPHA)。
// - 毎フレーム合成するのは「下まとめ」「編集中レイヤー(+ストロークバッファ、予測)」「上まとめ」。
//   レイヤーが何枚あっても画面の合成コストは変わらない。
// - ストローク終了時にストロークバッファの汚れた矩形を読み戻し、CPU(wasm)で焼く。
//   GPU の編集中レイヤーは変わったタイルだけ再転送する。
// - 縮小表示はミップで描く。表示の最終段で微小なディザを足す。
//
// テクスチャの向きはドキュメントと同じ(行 0 = y 0)。画面への向きは present の行列で決める。

import type { View } from "./protocol";

export const TILE = 256;

/** ダブの見た目のうち、ブラシ単位で決まるもの(ダブごとに変わるものはインスタンス属性)。 */
export interface DabLook {
  hardness: number;
  grain: number;
  grainScale: number;
}

const DAB_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 corner;      // -1..1 の四角
layout(location=1) in vec4 dab;         // x, y, radius, opacity(インスタンス)
layout(location=2) in vec4 dab2;        // angle, aspect, colorPacked, 予備(インスタンス)
uniform vec2 uSize;                     // 描画先の px サイズ
out vec2 vUv;
out float vRadius;
out float vOpacity;
out vec3 vColor;
out vec2 vDoc;
void main() {
  // 1px 未満の細い線は、半径を 0.75 に留めて不透明度で面積を表す(点々にならない)
  float r0 = dab.z;
  float r = max(r0, 0.75);
  float cov = (r0 * r0) / (r * r);
  float rr = r + 1.0;                   // AA のために半径より 1px 広く取る
  vec2 local = vec2(corner.x, corner.y * dab2.y) * rr;
  float c = cos(dab2.x);
  float s = sin(dab2.x);
  vec2 p = dab.xy + vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  vec2 ndc = (p / uSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.0, 1.0);
  vDoc = p;
  vUv = corner * rr;                    // 扁平は形で表し、距離は円のまま測る
  vRadius = r;
  vOpacity = dab.w * cov;
  float packed = dab2.z;
  float cr = floor(packed / 65536.0);
  float cg = floor((packed - cr * 65536.0) / 256.0);
  float cb = packed - cr * 65536.0 - cg * 256.0;
  vColor = vec3(cr, cg, cb) / 255.0;
}`;

const DAB_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vRadius;
in float vOpacity;
in vec3 vColor;
in vec2 vDoc;
uniform float uHardness;
uniform float uGrain;        // 紙目の強さ 0..1
uniform float uGrainScale;   // 紙目の大きさ px
out vec4 o;
float hash2(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
// キャンバス固定の値ノイズ(2 オクターブ)。同じ場所は同じ目になる
float grain(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = mix(mix(hash2(i), hash2(i + vec2(1, 0)), u.x), mix(hash2(i + vec2(0, 1)), hash2(i + vec2(1, 1)), u.x), u.y);
  vec2 p2 = p * 2.3 + 17.0;
  vec2 i2 = floor(p2);
  vec2 f2 = fract(p2);
  vec2 u2 = f2 * f2 * (3.0 - 2.0 * f2);
  float b = mix(mix(hash2(i2), hash2(i2 + vec2(1, 0)), u2.x), mix(hash2(i2 + vec2(0, 1)), hash2(i2 + vec2(1, 1)), u2.x), u2.y);
  return a * 0.65 + b * 0.35;
}
void main() {
  float d = length(vUv);
  float r = vRadius;
  // hardness=1 で 1.5px の AA、hardness=0 で中心から薄くなる
  float edge0 = min(r * uHardness, max(r - 1.5, 0.0));
  float a = (1.0 - smoothstep(edge0, r, d)) * vOpacity;
  if (uGrain > 0.0) {
    float g = grain(vDoc / uGrainScale);
    a *= 1.0 - uGrain * g;
  }
  o = vec4(vColor * a, a);
}`;

const BLIT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 corner;     // 0..1
uniform vec2 uDoc;                     // 描く矩形の px サイズ
uniform mat3 uM;                       // px → NDC
out vec2 vUv;
void main() {
  vec3 p = uM * vec3(corner * uDoc, 1.0);
  vUv = corner;
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
uniform float uDither;   // 0 で無効、1 で ±0.5/255
uniform int uMode;       // 0: RGBA、1: R を黒インクのアルファとして、2: 単色(テクスチャを見ない)
uniform vec4 uSolid;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c;
  if (uMode == 2) {
    c = uSolid;
  } else {
    vec4 t = texture(uTex, vUv);
    c = (uMode == 1) ? vec4(0.0, 0.0, 0.0, t.r) : t;
  }
  c *= uOpacity;
  if (uDither > 0.0) {
    float n = (hash(gl_FragCoord.xy) - 0.5) / 255.0 * uDither;
    c.rgb += n * c.a;
  }
  o = c;
}`;

// 編集中レイヤーを、下まとめ(紙の上、不透明)に合成モードで重ねる。画面空間で 1 回。
// ストロークバッファと予測はレイヤーの一部として先に src-over し、クリップは土台のアルファで絞る。
const COMPOSE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 corner;     // 0..1
uniform vec2 uViewSize;                // 画面 px
uniform vec2 uDocSize;                 // doc px
uniform mat3 uInv;                     // 画面 px(y 下向き) → doc px
out vec2 vUv;
out vec2 vDocUv;
void main() {
  vUv = corner;
  vec2 screen = vec2(corner.x * uViewSize.x, (1.0 - corner.y) * uViewSize.y);
  vec3 d = uInv * vec3(screen, 1.0);
  vDocUv = d.xy / uDocSize;
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const COMPOSE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vDocUv;
uniform sampler2D uBack;
uniform sampler2D uActive;
uniform sampler2D uStroke;
uniform sampler2D uPredict;
uniform sampler2D uClip;
uniform int uMode;
uniform float uOpacity;
uniform float uStrokeOp;
uniform int uActiveA8;
uniform int uHasClip;
uniform int uShowStroke;
uniform int uShowPredict;
out vec4 o;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(c.r, min(c.g, c.b));
  float x = max(c.r, max(c.g, c.b));
  if (n < 0.0) c = l + (c - l) * l / max(l - n, 1e-6);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / max(x - l, 1e-6);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(c.r, max(c.g, c.b)) - min(c.r, min(c.g, c.b)); }
vec3 setSat(vec3 c, float s) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  if (mx <= mn) return vec3(0.0);
  return (c - mn) * s / (mx - mn);
}
float sep(int m, float cb, float cs) {
  if (m == 1) return cb * cs;
  if (m == 2) return cb + cs - cb * cs;
  if (m == 3) return cb <= 0.5 ? cs * 2.0 * cb : (cs + (2.0 * cb - 1.0) - cs * (2.0 * cb - 1.0));
  if (m == 4) return min(cb, cs);
  if (m == 5) return max(cb, cs);
  if (m == 6) return min(cb + cs, 1.0);
  if (m == 7) return max(cb - cs, 0.0);
  if (m == 8) return abs(cb - cs);
  if (m == 9) {
    if (cs <= 0.5) return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
    float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
    return cb + (2.0 * cs - 1.0) * (d - cb);
  }
  if (m == 10) return cs <= 0.5 ? cb * 2.0 * cs : (cb + (2.0 * cs - 1.0) - cb * (2.0 * cs - 1.0));
  if (m == 11) return cb <= 0.0 ? 0.0 : (cs >= 1.0 ? 1.0 : min(cb / (1.0 - cs), 1.0));
  if (m == 12) return cb >= 1.0 ? 1.0 : (cs <= 0.0 ? 0.0 : 1.0 - min((1.0 - cb) / cs, 1.0));
  return cs;
}
vec3 blendRgb(int m, vec3 cb, vec3 cs) {
  if (m == 13) return setLum(setSat(cs, sat(cb)), lum(cb));
  if (m == 14) return setLum(setSat(cb, sat(cs)), lum(cb));
  if (m == 15) return setLum(cs, lum(cb));
  if (m == 16) return setLum(cb, lum(cs));
  return vec3(sep(m, cb.r, cs.r), sep(m, cb.g, cs.g), sep(m, cb.b, cs.b));
}
void main() {
  vec4 back = texture(uBack, vUv);
  if (vDocUv.x < 0.0 || vDocUv.y < 0.0 || vDocUv.x > 1.0 || vDocUv.y > 1.0) { o = back; return; }
  vec4 act = uActiveA8 == 1 ? vec4(0.0, 0.0, 0.0, texture(uActive, vDocUv).r) : texture(uActive, vDocUv);
  if (uShowStroke == 1) { vec4 s = texture(uStroke, vDocUv) * uStrokeOp; act = s + act * (1.0 - s.a); }
  if (uShowPredict == 1) { vec4 p = texture(uPredict, vDocUv) * uStrokeOp; act = p + act * (1.0 - p.a); }
  if (uHasClip == 1) act *= texture(uClip, vDocUv).r;
  act *= uOpacity;
  float as = act.a;
  if (as <= 0.0) { o = back; return; }
  vec3 cs = act.rgb / as;
  // 下まとめは紙の上で不透明なので αb = 1
  vec3 b = uMode == 0 ? cs : blendRgb(uMode, back.rgb, cs);
  o = vec4(as * b + (1.0 - as) * back.rgb, 1.0);
}`;

// 選択範囲の表示: 境界に白黒の破線、外側を少し暗く。画面空間で 1 回(アニメはしない。rAF を止めるため)
const SEL_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vDocUv;
uniform sampler2D uSel;
uniform vec2 uDocSize;
uniform float uScale;      // 画面 px / doc px
out vec4 o;
void main() {
  bool inside = vDocUv.x >= 0.0 && vDocUv.y >= 0.0 && vDocUv.x <= 1.0 && vDocUv.y <= 1.0;
  float s = inside ? texture(uSel, vDocUv).r : 0.0;
  // 1 画面 px ぶん離れた所と比べて境界を出す
  vec2 d = vec2(1.0) / (uDocSize * max(uScale, 1e-3));
  float e = 0.0;
  e = max(e, abs(texture(uSel, vDocUv + vec2(d.x, 0.0)).r - s));
  e = max(e, abs(texture(uSel, vDocUv - vec2(d.x, 0.0)).r - s));
  e = max(e, abs(texture(uSel, vDocUv + vec2(0.0, d.y)).r - s));
  e = max(e, abs(texture(uSel, vDocUv - vec2(0.0, d.y)).r - s));
  if (e > 0.5) {
    float dash = step(0.5, fract((gl_FragCoord.x + gl_FragCoord.y) / 8.0));
    o = vec4(vec3(dash), 1.0);
    return;
  }
  // 外側は少し暗く(premultiplied の黒)
  o = inside && s < 0.5 ? vec4(0.0, 0.0, 0.0, 0.12) : vec4(0.0);
}`;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
  a8: boolean;
  mips: boolean;
}

/** 3×3 行列(列優先)。 */
type Mat3 = Float32Array;

function mat3(a: number, b: number, c: number, d: number, e: number, f: number): Mat3 {
  // [a c e]
  // [b d f]
  // [0 0 1]
  return new Float32Array([a, b, 0, c, d, 0, e, f, 1]);
}

/** FBO 用: px → NDC(行 0 が下)。 */
function fboMatrix(w: number, h: number): Mat3 {
  return mat3(2 / w, 0, 0, 2 / h, -1, -1);
}

/** 画面 px(y 下向き)→ doc px。View の逆。 */
export function inverseView(view: View): Mat3 {
  const c = Math.cos(view.rot) / view.scale;
  const s = Math.sin(view.rot) / view.scale;
  // doc = R(-rot)/scale · (screen - t)
  // x = c·sx + s·sy - (c·tx + s·ty) ; y = -s·sx + c·sy - (-s·tx + c·ty)
  return mat3(c, -s, s, c, -(c * view.tx + s * view.ty), -(-s * view.tx + c * view.ty));
}

/** 画面用: doc px → 画面 px(View)→ NDC(y 下向きを上向きへ)。 */
export function presentMatrix(view: View, viewW: number, viewH: number): Mat3 {
  const c = Math.cos(view.rot) * view.scale;
  const s = Math.sin(view.rot) * view.scale;
  // screen = [c -s; s c] doc + t
  // ndc.x = 2 sx / vw - 1 ; ndc.y = 1 - 2 sy / vh
  const ax = 2 / viewW;
  const ay = -2 / viewH;
  return mat3(ax * c, ay * s, ax * -s, ay * c, ax * view.tx - 1, ay * view.ty + 1);
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private viewW = 1;
  private viewH = 1;
  private docW = 1;
  private docH = 1;
  private dabProg!: WebGLProgram;
  private blitProg!: WebGLProgram;
  private composeProg!: WebGLProgram;
  private c = {} as Record<string, WebGLUniformLocation>;
  /** 画面サイズの作業用 2 枚(合成の往復) */
  private p0: Target | null = null;
  private p1: Target | null = null;
  /** クリッピングの土台のアルファ(R8、doc サイズ)。無ければ null */
  private clip: Target | null = null;
  /** 選択範囲(R8、doc サイズ)。無ければ null */
  private sel: Target | null = null;
  private selProg!: WebGLProgram;
  private s = {} as Record<string, WebGLUniformLocation>;
  private quadVbo!: WebGLBuffer;
  private unitVbo!: WebGLBuffer;
  private dabVbo!: WebGLBuffer;
  private dabVao!: WebGLVertexArrayObject;
  private blitVao!: WebGLVertexArrayObject;
  private active: Target | null = null;
  private below: Target | null = null;
  private above: Target | null = null;
  private stroke: Target | null = null;
  private predict: Target | null = null;
  private u = {} as Record<string, WebGLUniformLocation>;
  private zeroTile = new Uint8Array(TILE * TILE * 4);
  drawCalls = 0;

  constructor(canvas: OffscreenCanvas, viewW: number, viewH: number) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      desynchronized: true, // Chrome の低遅延。Safari は無視する
      powerPreference: "high-performance",
    } as WebGLContextAttributes);
    if (!gl) throw new Error("WebGL2 が使えません");
    this.gl = gl;
    this.setup();
    this.resize(viewW, viewH);
  }

  get rendererName(): string {
    const gl = this.gl;
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    const name = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    return String(name);
  }

  get desynchronized(): boolean {
    const a = this.gl.getContextAttributes() as (WebGLContextAttributes & { desynchronized?: boolean }) | null;
    return Boolean(a?.desynchronized);
  }

  private setup(): void {
    const gl = this.gl;
    this.dabProg = this.program(DAB_VS, DAB_FS);
    this.blitProg = this.program(BLIT_VS, BLIT_FS);
    for (const n of ["uSize", "uHardness", "uGrain", "uGrainScale"]) {
      this.u[n] = gl.getUniformLocation(this.dabProg, n)!;
    }
    for (const n of ["uDoc", "uM", "uTex", "uOpacity", "uDither", "uMode", "uSolid"]) {
      this.u[n] = gl.getUniformLocation(this.blitProg, n)!;
    }
    this.selProg = this.program(COMPOSE_VS, SEL_FS);
    for (const n of ["uViewSize", "uDocSize", "uInv", "uSel", "uScale"]) {
      this.s[n] = gl.getUniformLocation(this.selProg, n)!;
    }
    this.composeProg = this.program(COMPOSE_VS, COMPOSE_FS);
    for (const n of [
      "uViewSize",
      "uDocSize",
      "uInv",
      "uBack",
      "uActive",
      "uStroke",
      "uPredict",
      "uClip",
      "uMode",
      "uOpacity",
      "uStrokeOp",
      "uActiveA8",
      "uHasClip",
      "uShowStroke",
      "uShowPredict",
    ]) {
      this.c[n] = gl.getUniformLocation(this.composeProg, n)!;
    }

    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.unitVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    this.dabVbo = gl.createBuffer()!;

    this.dabVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabVbo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(2, 1);

    this.blitVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.blitVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.unitVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error("シェーダ: " + gl.getShaderInfoLog(s));
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error("リンク: " + gl.getProgramInfoLog(p));
    return p;
  }

  private target(w: number, h: number, a8: boolean, mips: boolean): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    const levels = mips ? Math.floor(Math.log2(Math.max(w, h))) + 1 : 1;
    gl.texStorage2D(gl.TEXTURE_2D, levels, a8 ? gl.R8 : gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo, w, h, a8, mips };
  }

  private drop(t: Target | null): null {
    if (t) {
      this.gl.deleteFramebuffer(t.fbo);
      this.gl.deleteTexture(t.tex);
    }
    return null;
  }

  resize(viewW: number, viewH: number): void {
    this.viewW = Math.max(1, Math.floor(viewW));
    this.viewH = Math.max(1, Math.floor(viewH));
    this.gl.canvas.width = this.viewW;
    this.gl.canvas.height = this.viewH;
    this.p0 = this.drop(this.p0);
    this.p1 = this.drop(this.p1);
    this.p0 = this.target(this.viewW, this.viewH, false, false);
    this.p1 = this.target(this.viewW, this.viewH, false, false);
  }

  /** 選択範囲(A8、doc 全面)。null か長さ 0 で解除。 */
  uploadSelection(mask: Uint8Array | null): void {
    const gl = this.gl;
    if (!mask || mask.length === 0) {
      this.sel = this.drop(this.sel);
      return;
    }
    if (!this.sel) this.sel = this.target(this.docW, this.docH, true, false);
    gl.bindTexture(gl.TEXTURE_2D, this.sel.tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.docW, this.docH, gl.RED, gl.UNSIGNED_BYTE, mask);
  }

  get hasSelection(): boolean {
    return this.sel !== null;
  }

  /** クリッピングの土台のアルファ(A8、doc 全面)。null で解除。 */
  uploadClip(alpha: Uint8Array | null): void {
    const gl = this.gl;
    if (!alpha) {
      this.clip = this.drop(this.clip);
      return;
    }
    if (!this.clip) this.clip = this.target(this.docW, this.docH, true, true);
    gl.bindTexture(gl.TEXTURE_2D, this.clip.tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.docW, this.docH, gl.RED, gl.UNSIGNED_BYTE, alpha);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** ドキュメントのサイズを決めて、5 枚のテクスチャを作り直す。 */
  setDocSize(w: number, h: number, activeA8: boolean): void {
    this.docW = Math.max(1, w | 0);
    this.docH = Math.max(1, h | 0);
    this.active = this.drop(this.active);
    this.below = this.drop(this.below);
    this.above = this.drop(this.above);
    this.stroke = this.drop(this.stroke);
    this.predict = this.drop(this.predict);
    this.clip = this.drop(this.clip);
    this.sel = this.drop(this.sel);
    this.active = this.target(this.docW, this.docH, activeA8, true);
    this.below = this.target(this.docW, this.docH, false, true);
    this.above = this.target(this.docW, this.docH, false, true);
    this.stroke = this.target(this.docW, this.docH, false, false);
    this.predict = this.target(this.docW, this.docH, false, false);
  }

  /** 編集中レイヤーの形式が変わったときだけ作り直す。 */
  setActiveFormat(a8: boolean): void {
    if (this.active && this.active.a8 === a8) return;
    this.active = this.drop(this.active);
    this.active = this.target(this.docW, this.docH, a8, true);
  }

  private clearTarget(t: Target | null): void {
    if (!t) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  clearActive(): void {
    this.clearTarget(this.active);
  }

  /** 編集中レイヤーのタイル 1 枚を転送する。data の長さ 0 は「タイルが無い」= 透明で埋める。 */
  uploadActiveTile(tx: number, ty: number, data: Uint8Array): void {
    const t = this.active;
    if (!t) return;
    const gl = this.gl;
    const x = tx * TILE;
    const y = ty * TILE;
    const w = Math.min(TILE, this.docW - x);
    const h = Math.min(TILE, this.docH - y);
    if (w <= 0 || h <= 0 || x < 0 || y < 0) return;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, TILE);
    const src = data.length ? data : this.zeroTile;
    if (t.a8) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RED, gl.UNSIGNED_BYTE, src);
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, src);
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
  }

  /** 下まとめ / 上まとめを丸ごと転送する(レイヤー切替時だけ)。 */
  uploadMerged(which: "below" | "above", rgba: Uint8Array): void {
    const t = which === "below" ? this.below : this.above;
    if (!t) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.docW, this.docH, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** 編集中レイヤーのミップを作り直す(転送をまとめた後に 1 回)。 */
  finishActiveUpload(): void {
    const t = this.active;
    if (!t) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  beginStroke(): void {
    this.clearTarget(this.stroke);
    this.clearTarget(this.predict);
  }

  /** ダブは DAB_STRIDE(8)要素ずつ。色は 7 番目に詰めてある。 */
  drawDabs(dabs: Float32Array, look: DabLook): void {
    this.drawDabsTo(this.stroke, dabs, look);
  }

  drawPredicted(dabs: Float32Array, look: DabLook): void {
    this.clearTarget(this.predict);
    if (dabs.length) this.drawDabsTo(this.predict, dabs, look);
  }

  private drawDabsTo(t: Target | null, dabs: Float32Array, look: DabLook): void {
    const n = (dabs.length / 8) | 0;
    if (!t || n === 0) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.w, t.h);
    gl.useProgram(this.dabProg);
    gl.uniform2f(this.u.uSize!, t.w, t.h);
    gl.uniform1f(this.u.uHardness!, look.hardness);
    gl.uniform1f(this.u.uGrain!, look.grain);
    gl.uniform1f(this.u.uGrainScale!, Math.max(0.5, look.grainScale));
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabVbo);
    gl.bufferData(gl.ARRAY_BUFFER, dabs, gl.STREAM_DRAW);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    this.drawCalls++;
  }

  /** ストロークバッファの矩形を読み戻す(プリマルチ RGBA8、行 0 = y)。 */
  readStroke(x: number, y: number, w: number, h: number): Uint8Array {
    const gl = this.gl;
    const out = new Uint8Array(w * h * 4);
    if (!this.stroke || w <= 0 || h <= 0) return out;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stroke.fbo);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  endStroke(): void {
    this.clearTarget(this.stroke);
    this.clearTarget(this.predict);
  }

  private blit(
    src: Target | null,
    dst: Target | null,
    m: Mat3,
    opacity: number,
    dither: boolean,
    mode: 0 | 1 | 2,
    solid: [number, number, number, number] = [0, 0, 0, 0]
  ): void {
    const gl = this.gl;
    if (dst) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
      gl.viewport(0, 0, dst.w, dst.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.viewW, this.viewH);
    }
    gl.useProgram(this.blitProg);
    gl.uniform2f(this.u.uDoc!, this.docW, this.docH);
    gl.uniformMatrix3fv(this.u.uM!, false, m);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src ? src.tex : null);
    gl.uniform1i(this.u.uTex!, 0);
    gl.uniform1f(this.u.uOpacity!, opacity);
    gl.uniform1f(this.u.uDither!, dither ? 1 : 0);
    gl.uniform1i(this.u.uMode!, mode);
    gl.uniform4f(this.u.uSolid!, solid[0], solid[1], solid[2], solid[3]);
    gl.bindVertexArray(this.blitVao);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.drawCalls++;
  }

  /**
   * 画面へ。
   *   P0 = 灰の外側 + 紙の上にまとめた「下」(不透明)
   *   P1 = P0 に編集中レイヤー(+ ストローク + 予測、クリップ、不透明度)を合成モードで重ねる
   *   P1 += 「上」まとめ(src-over)
   *   画面 = P1(ディザ)
   */
  present(
    view: View,
    strokeOpacity: number,
    showStroke: boolean,
    showPredict: boolean,
    activeOpacity = 1,
    activeVisible = true,
    blendMode = 0,
    useClip = false
  ): void {
    const gl = this.gl;
    const p0 = this.p0;
    const p1 = this.p1;
    if (!p0 || !p1) return;
    const m = presentMatrix(view, this.viewW, this.viewH);
    const fm = fboMatrix(this.viewW, this.viewH);

    // P0: 外側の灰 + 紙 + 下まとめ
    gl.bindFramebuffer(gl.FRAMEBUFFER, p0.fbo);
    gl.viewport(0, 0, this.viewW, this.viewH);
    gl.clearColor(0.2, 0.2, 0.22, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.blit(null, p0, m, 1, false, 2, [1, 1, 1, 1]);
    this.blit(this.below, p0, m, 1, false, 0);

    // P1: 編集中レイヤーを合成モードで
    gl.bindFramebuffer(gl.FRAMEBUFFER, p1.fbo);
    gl.viewport(0, 0, this.viewW, this.viewH);
    gl.disable(gl.BLEND);
    gl.useProgram(this.composeProg);
    gl.uniform2f(this.c.uViewSize!, this.viewW, this.viewH);
    gl.uniform2f(this.c.uDocSize!, this.docW, this.docH);
    gl.uniformMatrix3fv(this.c.uInv!, false, inverseView(view));
    const bind = (unit: number, t: Target | null, name: string) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, t ? t.tex : null);
      gl.uniform1i(this.c[name]!, unit);
    };
    bind(0, p0, "uBack");
    bind(1, this.active, "uActive");
    bind(2, this.stroke, "uStroke");
    bind(3, this.predict, "uPredict");
    bind(4, this.clip, "uClip");
    gl.uniform1i(this.c.uMode!, blendMode | 0);
    gl.uniform1f(this.c.uOpacity!, activeVisible ? activeOpacity : 0);
    gl.uniform1f(this.c.uStrokeOp!, strokeOpacity);
    gl.uniform1i(this.c.uActiveA8!, this.active?.a8 ? 1 : 0);
    gl.uniform1i(this.c.uHasClip!, useClip && this.clip ? 1 : 0);
    gl.uniform1i(this.c.uShowStroke!, showStroke ? 1 : 0);
    gl.uniform1i(this.c.uShowPredict!, showPredict ? 1 : 0);
    gl.bindVertexArray(this.blitVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.drawCalls++;
    gl.enable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);

    // 上まとめ
    this.blit(this.above, p1, m, 1, false, 0);

    // 画面へ(ディザ)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.viewW, this.viewH);
    gl.clearColor(0.2, 0.2, 0.22, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.blitFull(p1, fm, true);

    // 選択範囲の表示
    if (this.sel) {
      gl.useProgram(this.selProg);
      gl.uniform2f(this.s.uViewSize!, this.viewW, this.viewH);
      gl.uniform2f(this.s.uDocSize!, this.docW, this.docH);
      gl.uniformMatrix3fv(this.s.uInv!, false, inverseView(view));
      gl.uniform1f(this.s.uScale!, view.scale);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sel.tex);
      gl.uniform1i(this.s.uSel!, 0);
      gl.bindVertexArray(this.blitVao);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this.drawCalls++;
    }
  }

  /** 画面サイズのテクスチャをそのまま画面(または FBO)へ。 */
  private blitFull(src: Target, m: Mat3, dither: boolean): void {
    const gl = this.gl;
    gl.useProgram(this.blitProg);
    gl.uniform2f(this.u.uDoc!, this.viewW, this.viewH);
    gl.uniformMatrix3fv(this.u.uM!, false, m);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.u.uTex!, 0);
    gl.uniform1f(this.u.uOpacity!, 1);
    gl.uniform1f(this.u.uDither!, dither ? 1 : 0);
    gl.uniform1i(this.u.uMode!, 0);
    gl.bindVertexArray(this.blitVao);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.drawCalls++;
  }

  /** テスト用: 編集中レイヤーで alpha > 0 の画素数。遅いので本番では呼ばない。 */
  countPainted(): number {
    const t = this.active;
    if (!t) return 0;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    const buf = new Uint8Array(t.w * t.h * 4);
    gl.readPixels(0, 0, t.w, t.h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0;
    const ch = t.a8 ? 0 : 3;
    for (let i = ch; i < buf.length; i += 4) if (buf[i]! > 0) n++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return n;
  }

  /** FBO 同士の等倍コピー用の行列(今は使っていないが、タイル合成で使う)。 */
  static fboMatrix(w: number, h: number): Mat3 {
    return fboMatrix(w, h);
  }
}
