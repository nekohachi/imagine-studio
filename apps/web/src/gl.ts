// WebGL2 レンダラ(描画ワーカーの中で動く)。
//
// docs/02 の方針:
// - テクスチャは RGBA8 だけ。浮動小数は使わない。
// - 合成はプリマルチプライド src-over(ONE, ONE_MINUS_SRC_ALPHA)。
// - ストローク中は「レイヤー + ストロークバッファ(不透明度を掛けて) + 予測バッファ」の 3 枚で表示。
// - ストローク終了時にストロークバッファをレイヤーへ 1 回だけ焼く(同一ストローク内で濃くならない)。
// - 表示の最終段で微小なディザを足す(8bit のバンディング対策)。
//
// フェーズ 0 なのでレイヤーは 1 枚の全面テクスチャ。タイル化はフェーズ 1。

const DAB_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 corner;      // -1..1 の四角
layout(location=1) in vec4 dab;         // x, y, radius, opacity(インスタンス)
uniform vec2 uSize;                     // 描画先の px サイズ
out vec2 vUv;
out float vRadius;
out float vOpacity;
void main() {
  // AA のために半径より 1px 広く取る
  float r = dab.z + 1.0;
  vec2 p = dab.xy + corner * r;
  vec2 ndc = (p / uSize) * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, -ndc.y, 0.0, 1.0);
  vUv = corner * r;
  vRadius = dab.z;
  vOpacity = dab.w;
}`;

const DAB_FS = `#version 300 es
precision highp float;
in vec2 vUv;
in float vRadius;
in float vOpacity;
uniform vec3 uColor;
uniform float uHardness;
out vec4 o;
void main() {
  float d = length(vUv);
  float r = vRadius;
  // hardness=1 で 1.5px の AA、hardness=0 で中心から薄くなる
  float edge0 = min(r * uHardness, max(r - 1.5, 0.0));
  float a = (1.0 - smoothstep(edge0, r, d)) * vOpacity;
  o = vec4(uColor * a, a);
}`;

const BLIT_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 corner;
out vec2 vUv;
void main() {
  vUv = corner * 0.5 + 0.5;
  gl_Position = vec4(corner, 0.0, 1.0);
}`;

const BLIT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uOpacity;
uniform float uDither;   // 0 で無効、1 で ±0.5/255
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 c = texture(uTex, vUv) * uOpacity;
  if (uDither > 0.0) {
    float n = (hash(gl_FragCoord.xy) - 0.5) / 255.0 * uDither;
    c.rgb += n * c.a;
  }
  o = c;
}`;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private width = 1;
  private height = 1;
  private dabProg!: WebGLProgram;
  private blitProg!: WebGLProgram;
  private quadVbo!: WebGLBuffer;
  private dabVbo!: WebGLBuffer;
  private dabVao!: WebGLVertexArrayObject;
  private blitVao!: WebGLVertexArrayObject;
  private layer!: Target;
  private layerPrev!: Target;
  private stroke!: Target;
  private predict!: Target;
  private uDabSize!: WebGLUniformLocation;
  private uDabColor!: WebGLUniformLocation;
  private uDabHardness!: WebGLUniformLocation;
  private uBlitTex!: WebGLUniformLocation;
  private uBlitOpacity!: WebGLUniformLocation;
  private uBlitDither!: WebGLUniformLocation;
  drawCalls = 0;
  hasPrev = false;

  constructor(canvas: OffscreenCanvas, width: number, height: number) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      // Chrome の低遅延。Safari は無視する
      desynchronized: true,
      powerPreference: "high-performance",
    } as WebGLContextAttributes);
    if (!gl) throw new Error("WebGL2 が使えません");
    this.gl = gl;
    this.setup();
    this.resize(width, height);
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
    this.uDabSize = gl.getUniformLocation(this.dabProg, "uSize")!;
    this.uDabColor = gl.getUniformLocation(this.dabProg, "uColor")!;
    this.uDabHardness = gl.getUniformLocation(this.dabProg, "uHardness")!;
    this.uBlitTex = gl.getUniformLocation(this.blitProg, "uTex")!;
    this.uBlitOpacity = gl.getUniformLocation(this.blitProg, "uOpacity")!;
    this.uBlitDither = gl.getUniformLocation(this.blitProg, "uDither")!;

    this.quadVbo = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.dabVbo = gl.createBuffer()!;

    this.dabVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabVbo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
    gl.vertexAttribDivisor(1, 1);

    this.blitVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.blitVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  }

  private program(vs: string, fs: string): WebGLProgram {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        throw new Error("シェーダ: " + gl.getShaderInfoLog(s));
      }
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error("リンク: " + gl.getProgramInfoLog(p));
    }
    return p;
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return { tex, fbo };
  }

  private drop(t: Target | undefined): void {
    if (!t) return;
    this.gl.deleteFramebuffer(t.fbo);
    this.gl.deleteTexture(t.tex);
  }

  /** サイズ変更。内容は捨てる(フェーズ 0)。 */
  resize(width: number, height: number): void {
    const gl = this.gl;
    this.width = Math.max(1, Math.floor(width));
    this.height = Math.max(1, Math.floor(height));
    gl.canvas.width = this.width;
    gl.canvas.height = this.height;
    this.drop(this.layer);
    this.drop(this.layerPrev);
    this.drop(this.stroke);
    this.drop(this.predict);
    this.layer = this.target(this.width, this.height);
    this.layerPrev = this.target(this.width, this.height);
    this.stroke = this.target(this.width, this.height);
    this.predict = this.target(this.width, this.height);
    this.hasPrev = false;
    this.present(1);
  }

  private clearTarget(t: Target): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** ストローク開始: 直前のレイヤーを控え(1 段 Undo)、ストロークバッファを空にする。 */
  beginStroke(): void {
    this.blit(this.layer, this.layerPrev, 1, false, true);
    this.hasPrev = true;
    this.clearTarget(this.stroke);
    this.clearTarget(this.predict);
  }

  /** 確定ダブをストロークバッファへ。 */
  drawDabs(dabs: Float32Array, color: [number, number, number], hardness: number): void {
    this.drawDabsTo(this.stroke, dabs, color, hardness);
  }

  /** 予測ダブを予測バッファへ(毎フレーム描き直す)。 */
  drawPredicted(dabs: Float32Array, color: [number, number, number], hardness: number): void {
    this.clearTarget(this.predict);
    if (dabs.length) this.drawDabsTo(this.predict, dabs, color, hardness);
  }

  private drawDabsTo(t: Target, dabs: Float32Array, color: [number, number, number], hardness: number): void {
    const n = (dabs.length / 4) | 0;
    if (n === 0) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.useProgram(this.dabProg);
    gl.uniform2f(this.uDabSize, this.width, this.height);
    gl.uniform3f(this.uDabColor, color[0], color[1], color[2]);
    gl.uniform1f(this.uDabHardness, hardness);
    gl.bindVertexArray(this.dabVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dabVbo);
    gl.bufferData(gl.ARRAY_BUFFER, dabs, gl.STREAM_DRAW);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);
    this.drawCalls++;
  }

  /** ストローク終了: 不透明度を掛けてレイヤーへ 1 回だけ焼く。 */
  endStroke(opacity: number): void {
    this.blit(this.stroke, this.layer, opacity, false, false);
    this.clearTarget(this.stroke);
    this.clearTarget(this.predict);
  }

  cancelStroke(): void {
    this.clearTarget(this.stroke);
    this.clearTarget(this.predict);
  }

  clearLayer(): void {
    this.blit(this.layer, this.layerPrev, 1, false, true);
    this.hasPrev = true;
    this.clearTarget(this.layer);
  }

  /** 1 段だけの Undo(フェーズ 0)。差分 Undo はフェーズ 1。 */
  undo(): boolean {
    if (!this.hasPrev) return false;
    const t = this.layer;
    this.layer = this.layerPrev;
    this.layerPrev = t;
    this.hasPrev = false;
    return true;
  }

  private blit(src: Target, dst: Target | null, opacity: number, dither: boolean, replace: boolean): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst ? dst.fbo : null);
    gl.viewport(0, 0, this.width, this.height);
    if (replace) {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.useProgram(this.blitProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform1i(this.uBlitTex, 0);
    gl.uniform1f(this.uBlitOpacity, opacity);
    gl.uniform1f(this.uBlitDither, dither ? 1 : 0);
    gl.bindVertexArray(this.blitVao);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.drawCalls++;
  }

  /** 画面へ: 白地 + レイヤー + ストローク(不透明度) + 予測。 */
  present(strokeOpacity: number, showStroke = false, showPredict = false): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.blit(this.layer, null, 1, true, false);
    if (showStroke) this.blit(this.stroke, null, strokeOpacity, true, false);
    if (showPredict) this.blit(this.predict, null, strokeOpacity, false, false);
  }

  /** テスト用: レイヤーで alpha > 0 の画素数。遅いので本番では呼ばない。 */
  countPainted(): number {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layer.fbo);
    const buf = new Uint8Array(this.width * this.height * 4);
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0;
    for (let i = 3; i < buf.length; i += 4) if (buf[i]! > 0) n++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return n;
  }
}
