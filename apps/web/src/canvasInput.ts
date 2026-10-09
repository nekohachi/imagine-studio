// キャンバスの入力(docs/04)。
//   ペン / マウス: 描く。長押し(400ms、12px)で輪。SHF で直線、CTL で 45°、ALT でスポイト
//   指 1 本: 指描きを許可していれば描く。長押しで輪
//   指 2 本: パン・ズーム・回転。長押しでビューの輪
//   指 2 本ダブルタップ: 戻す、指 3 本ダブルタップ: やり直す、指 4 本タップ: UI 非表示
// rAF はストローク中とジェスチャ中だけ回す。

import {
  FingerTaps,
  LongPress,
  Modifiers,
  closeRadial,
  isRadialOpen,
  openRadial,
  type RadialItem,
  type RadialMenu,
} from "@imagine/ring";
import type { Bridge } from "./bridge";
import { PalmGuard, PointPacker, SpeedPressure, normalizePressure } from "./input";
import { POINT_STRIDE } from "./protocol";
import type { AppState } from "./state";
import { TwoFingerGesture, fitView, screenToDoc, zoomAt } from "./view";

export interface CanvasInputHooks {
  /** 1 本の長押し。画面座標(CSS px) */
  onRing: (x: number, y: number) => { menu: RadialMenu; list: RadialItem[] };
  onViewRing: (x: number, y: number) => RadialMenu;
  onTap: (fingers: number, double: boolean) => void;
  onEyedrop: (docX: number, docY: number) => void;
  /** 描き始めにパネルを閉じる。閉じたなら真(そのタップは描かない) */
  closePanels: () => boolean;
}

export interface InputStats {
  pointerType: string;
  pressure: number;
  tiltX: number;
  tiltY: number;
  eventsPerFrame: number;
  coalesced: number;
}

export class CanvasInput {
  readonly stats: InputStats = { pointerType: "-", pressure: 0, tiltX: 0, tiltY: 0, eventsPerFrame: 0, coalesced: 0 };
  readonly hasRawUpdate = "onpointerrawupdate" in window;
  readonly hasPredicted = typeof PointerEvent !== "undefined" && "getPredictedEvents" in PointerEvent.prototype;
  private readonly hasCoalesced = typeof PointerEvent !== "undefined" && "getCoalescedEvents" in PointerEvent.prototype;
  readonly dpr = Math.min(window.devicePixelRatio || 1, 3);

  private packer = new PointPacker();
  private palm = new PalmGuard(1500);
  private speedPressure = new SpeedPressure();
  private gesture = new TwoFingerGesture();
  private taps: FingerTaps;
  private longPress: LongPress;
  private viewLongPress: LongPress;
  private touches = new Map<number, [number, number]>();
  private activeId: number | null = null;
  private activeType = "";
  private predicted = new Float32Array(0);
  private rafId = 0;
  private viewDirty = false;
  private lastMove: { x: number; y: number; t: number } | null = null;
  /** SHF の直線: 始点(doc) */
  private line: { x: number; y: number; pressure: number } | null = null;
  private lineEnd: { x: number; y: number } | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly state: AppState,
    private readonly bridge: Bridge,
    private readonly mods: Modifiers,
    private readonly hooks: CanvasInputHooks
  ) {
    this.taps = new FingerTaps((n, d) => hooks.onTap(n, d));
    this.longPress = new LongPress((x, y) => this.fireRing(x, y));
    this.viewLongPress = new LongPress((x, y) => this.fireViewRing(x, y));
    this.attach();
  }

  backing(): [number, number] {
    return [Math.round(this.canvas.clientWidth * this.dpr), Math.round(this.canvas.clientHeight * this.dpr)];
  }

  fit(): void {
    const [w, h] = this.backing();
    this.state.view = fitView(this.state.docW, this.state.docH, w, h);
    this.bridge.send({ type: "view", view: this.state.view });
    this.state.emit("view");
  }

  private toScreen(e: { clientX: number; clientY: number }): [number, number] {
    const r = this.canvas.getBoundingClientRect();
    return [(e.clientX - r.left) * this.dpr, (e.clientY - r.top) * this.dpr];
  }

  toDoc(e: { clientX: number; clientY: number }): [number, number] {
    const [sx, sy] = this.toScreen(e);
    return screenToDoc(this.state.view, sx, sy);
  }

  private pressureOf(e: PointerEvent, x: number, y: number): number {
    if (e.pointerType === "touch") {
      const now = e.timeStamp;
      let speed = 0;
      if (this.lastMove) {
        const dt = Math.max(1, now - this.lastMove.t);
        speed = (Math.hypot(x - this.lastMove.x, y - this.lastMove.y) * this.state.view.scale) / this.dpr / dt;
      }
      this.lastMove = { x, y, t: now };
      return this.speedPressure.feed(speed);
    }
    return normalizePressure(e.pointerType, e.pressure);
  }

  private addPoint(e: PointerEvent): void {
    const [x, y] = this.toDoc(e);
    this.packer.push(x, y, this.pressureOf(e, x, y), e.timeStamp, e.tiltX, e.tiltY);
  }

  private flush = (): void => {
    if (this.viewDirty) {
      this.viewDirty = false;
      this.bridge.send({ type: "view", view: this.state.view });
      this.state.emit("view");
    }
    if (this.line && this.lineEnd && this.activeId !== null) {
      this.packer.take();
      const [x1, y1] = this.snapLine(this.lineEnd.x, this.lineEnd.y);
      this.bridge.send({ type: "line", x0: this.line.x, y0: this.line.y, x1, y1, pressure: this.line.pressure, commit: false });
    } else if (this.activeId !== null || this.packer.length > 0) {
      const data = this.packer.take();
      this.stats.eventsPerFrame = data.length / POINT_STRIDE;
      const pd = this.state.settings.predict ? this.predicted : new Float32Array(0);
      this.predicted = new Float32Array(0);
      this.bridge.send({ type: "points", data, predicted: pd, frameTime: performance.now() }, [data.buffer, pd.buffer]);
    }
    this.rafId = this.activeId !== null || this.gesture.active ? requestAnimationFrame(this.flush) : 0;
  };

  private ensureLoop(): void {
    if (!this.rafId) this.rafId = requestAnimationFrame(this.flush);
  }

  /** CTL なら 45° 刻みに吸着した終点。 */
  private snapLine(x: number, y: number): [number, number] {
    if (!this.line || !this.mods.on("ctrl")) return [x, y];
    const dx = x - this.line.x;
    const dy = y - this.line.y;
    const len = Math.hypot(dx, dy);
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    return [this.line.x + Math.cos(a) * len, this.line.y + Math.sin(a) * len];
  }

  private cancelStroke(): void {
    if (this.activeId === null) return;
    try {
      this.canvas.releasePointerCapture(this.activeId);
    } catch {
      /* 既に外れている */
    }
    this.activeId = null;
    this.line = null;
    this.lineEnd = null;
    this.packer.take();
    this.bridge.send({ type: "cancel" });
  }

  private fireRing(x: number, y: number): void {
    this.cancelStroke();
    const { menu, list } = this.hooks.onRing(x, y);
    openRadial(menu, x, y, list);
  }

  private fireViewRing(x: number, y: number): void {
    this.gesture.end();
    const menu = this.hooks.onViewRing(x, y);
    openRadial(menu, x, y, []);
  }

  private attach(): void {
    const c = this.canvas;
    c.addEventListener("contextmenu", (e) => e.preventDefault());

    c.addEventListener("pointerdown", (e) => {
      if (isRadialOpen()) return;
      if (e.pointerType === "pen") this.palm.sawPen(e.timeStamp);
      if (e.pointerType === "touch") {
        this.touches.set(e.pointerId, this.toScreen(e));
        this.taps.down(e.pointerId, e.clientX, e.clientY, e.timeStamp);
        if (this.touches.size === 2) {
          if (this.activeType === "touch") this.cancelStroke();
          this.longPress.cancel();
          const [a, b] = Array.from(this.touches.values()) as [[number, number], [number, number]];
          this.gesture.start(this.state.view, a[0], a[1], b[0], b[1]);
          const r = this.canvas.getBoundingClientRect();
          this.viewLongPress.begin(e.pointerId, (a[0] + b[0]) / 2 / this.dpr + r.left, (a[1] + b[1]) / 2 / this.dpr + r.top);
          this.ensureLoop();
          return;
        }
        if (this.touches.size > 2) {
          this.viewLongPress.cancel();
          return;
        }
        if (!this.palm.allowTouch(e.timeStamp, this.state.settings.fingerDraw)) {
          // 描かない指でも、長押しで輪は出す
          this.longPress.begin(e.pointerId, e.clientX, e.clientY);
          return;
        }
      }
      if (this.activeId !== null) return;
      if (e.pointerType === "mouse" && e.button === 2) {
        this.fireRing(e.clientX, e.clientY);
        return;
      }
      if (e.pointerType === "mouse" && e.button !== 0) return;
      if (this.hooks.closePanels()) return;

      // ALT または輪からの「次のタップ」はスポイト
      if (this.mods.on("alt") || this.state.eyedropOnce) {
        this.state.eyedropOnce = false;
        const [x, y] = this.toDoc(e);
        this.hooks.onEyedrop(x, y);
        return;
      }

      this.activeId = e.pointerId;
      this.activeType = e.pointerType;
      this.stats.pointerType = e.pointerType;
      this.speedPressure.reset();
      this.lastMove = null;
      c.setPointerCapture(e.pointerId);
      if (this.mods.on("shift")) {
        const [x, y] = this.toDoc(e);
        this.line = { x, y, pressure: normalizePressure(e.pointerType, e.pressure) };
        this.lineEnd = { x, y };
      } else {
        this.line = null;
        this.bridge.send({ type: "begin" });
        this.addPoint(e);
      }
      this.longPress.begin(e.pointerId, e.clientX, e.clientY);
      this.ensureLoop();
    });

    const collect = (e: PointerEvent) => {
      if (e.pointerId !== this.activeId) return;
      if (this.line) {
        const [x, y] = this.toDoc(e);
        this.lineEnd = { x, y };
        this.ensureLoop();
        return;
      }
      const list: PointerEvent[] = this.hasCoalesced ? e.getCoalescedEvents() : [];
      if (list.length === 0) list.push(e);
      this.stats.coalesced = list.length;
      for (const p of list) this.addPoint(p);
      this.stats.pressure = e.pressure;
      this.stats.tiltX = e.tiltX;
      this.stats.tiltY = e.tiltY;
      this.ensureLoop();
    };

    if (this.hasRawUpdate) {
      (c as unknown as { addEventListener(t: string, l: (e: PointerEvent) => void): void }).addEventListener(
        "pointerrawupdate",
        (e) => {
          this.longPress.update(e.pointerId, e.clientX, e.clientY);
          collect(e);
        }
      );
    }

    c.addEventListener("pointermove", (e) => {
      if (e.pointerType === "touch") {
        this.taps.move(e.pointerId, e.clientX, e.clientY);
        if (this.touches.has(e.pointerId)) {
          this.touches.set(e.pointerId, this.toScreen(e));
          if (this.gesture.active && this.touches.size >= 2) {
            const [a, b] = Array.from(this.touches.values()) as [[number, number], [number, number]];
            const v = this.gesture.update(a[0], a[1], b[0], b[1]);
            if (v) {
              this.viewLongPress.cancel();
              this.state.view = v;
              this.viewDirty = true;
              this.ensureLoop();
            }
            return;
          }
        }
      }
      if (this.longPress.update(e.pointerId, e.clientX, e.clientY)) {
        /* 動いたので輪は出ない */
      }
      if (e.pointerId !== this.activeId) return;
      if (!this.hasRawUpdate) collect(e);
      if (this.hasPredicted && !this.line) {
        const ps = e.getPredictedEvents();
        const out = new Float32Array(ps.length * POINT_STRIDE);
        ps.forEach((p, i) => {
          const [x, y] = this.toDoc(p);
          out[i * POINT_STRIDE] = x;
          out[i * POINT_STRIDE + 1] = y;
          out[i * POINT_STRIDE + 2] = normalizePressure(this.activeType, p.pressure);
          out[i * POINT_STRIDE + 3] = p.timeStamp;
        });
        this.predicted = out;
      }
    });

    const finish = (e: PointerEvent, cancel: boolean) => {
      this.longPress.end(e.pointerId);
      if (e.pointerType === "touch") {
        this.touches.delete(e.pointerId);
        this.taps.up(e.pointerId, e.timeStamp, cancel);
        if (this.gesture.active && this.touches.size < 2) {
          this.gesture.end();
          this.viewLongPress.cancel();
        }
      }
      if (e.pointerId !== this.activeId) return;
      const wasLine = this.line;
      this.activeId = null;
      if (wasLine) {
        const end = this.lineEnd ?? { x: wasLine.x, y: wasLine.y };
        const [x1, y1] = this.snapLine(end.x, end.y);
        this.line = null;
        this.lineEnd = null;
        if (cancel) this.bridge.send({ type: "cancel" });
        else this.bridge.send({ type: "line", x0: wasLine.x, y0: wasLine.y, x1, y1, pressure: wasLine.pressure, commit: true });
      } else {
        if (!cancel) this.addPoint(e);
        if (this.packer.length) {
          const data = this.packer.take();
          this.bridge.send({ type: "points", data, predicted: new Float32Array(0), frameTime: performance.now() }, [data.buffer]);
        }
        this.bridge.send({ type: cancel ? "cancel" : "end" });
      }
      try {
        c.releasePointerCapture(e.pointerId);
      } catch {
        /* 既に外れている */
      }
    };
    c.addEventListener("pointerup", (e) => finish(e, false));
    c.addEventListener("pointercancel", (e) => finish(e, true));

    // マウスのホイールでズーム(Windows)
    c.addEventListener(
      "wheel",
      (e) => {
        e.preventDefault();
        const [sx, sy] = this.toScreen(e);
        this.state.view = zoomAt(this.state.view, sx, sy, Math.exp(-e.deltaY * 0.0015));
        this.viewDirty = true;
        this.ensureLoop();
      },
      { passive: false }
    );

    window.addEventListener("resize", () => {
      const [w, h] = this.backing();
      this.bridge.send({ type: "resize", viewW: w, viewH: h });
    });
    // 輪が閉じたら取り残しが無いように
    window.addEventListener("pointerup", () => {
      if (!isRadialOpen()) closeRadial();
    });
  }
}
