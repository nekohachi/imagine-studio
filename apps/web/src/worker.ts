// 描画ワーカー。OffscreenCanvas + WebGL2 + wasm(brush-core)がここで閉じる。
// メインスレッドからはフレームごとに入力点の束が来る。描画はその受信ごとに 1 回。

import init, { Brush, Stroke, version } from "./wasm/imagine_wasm.js";
import wasmUrl from "./wasm/imagine_wasm_bg.wasm?url";
import { Renderer } from "./gl";
import { extrapolateDabs } from "./input";
import type { BrushSettings, FromWorker, Stats, ToWorker } from "./protocol";

let renderer: Renderer | null = null;
let brush: Brush | null = null;
let settings: BrushSettings = {
  radius: 6,
  stabilizer: 8,
  hardness: 0.7,
  opacity: 1,
  flow: 0.9,
  spacing: 0.2,
  color: [0.1, 0.1, 0.1],
};
let stroke: Stroke | null = null;
let lastDab: [number, number] | null = null;
let lastStrokeDabs = 0;

function post(m: FromWorker): void {
  (self as unknown as Worker).postMessage(m);
}

function applyBrush(): void {
  if (!brush) return;
  brush.radius = settings.radius;
  brush.stabilizer = settings.stabilizer;
  brush.hardness = settings.hardness;
  brush.opacity = settings.opacity;
  brush.flow = settings.flow;
  brush.spacing = settings.spacing;
}

function stats(frameStart: number, dabs: number, lastInputTime: number): Stats {
  const now = performance.now();
  return {
    frameMs: now - frameStart,
    dabs,
    strokeDabs: stroke ? stroke.dab_count : lastStrokeDabs,
    inputToDrawMs: lastInputTime > 0 ? now - lastInputTime : 0,
    drawCalls: renderer ? renderer.drawCalls : 0,
  };
}

async function handle(m: ToWorker): Promise<void> {
  switch (m.type) {
    case "init": {
      await init({ module_or_path: wasmUrl });
      brush = new Brush();
      applyBrush();
      renderer = new Renderer(m.canvas, m.width, m.height);
      post({
        type: "ready",
        version: version(),
        renderer: renderer.rendererName,
        desynchronized: renderer.desynchronized,
      });
      return;
    }
    case "resize":
      renderer?.resize(m.width, m.height);
      return;
    case "brush":
      settings = m.brush;
      applyBrush();
      return;
    case "begin": {
      if (!renderer || !brush) return;
      if (stroke) {
        stroke.finish();
        stroke.free();
      }
      stroke = new Stroke(brush);
      lastDab = null;
      renderer.beginStroke();
      return;
    }
    case "points": {
      if (!renderer || !stroke) return;
      const t0 = performance.now();
      renderer.drawCalls = 0;
      const dabs = stroke.add_points(m.data);
      if (dabs.length) {
        renderer.drawDabs(dabs, settings.color, settings.hardness);
        lastDab = [dabs[dabs.length - 4]!, dabs[dabs.length - 3]!];
      }
      if (lastDab && m.predicted.length) {
        const r = settings.radius;
        const pd = extrapolateDabs(
          lastDab[0],
          lastDab[1],
          r,
          settings.flow,
          settings.spacing,
          m.predicted
        );
        renderer.drawPredicted(pd, settings.color, settings.hardness);
      } else {
        renderer.drawPredicted(new Float32Array(0), settings.color, settings.hardness);
      }
      renderer.present(settings.opacity, true, true);
      const lastT = m.data.length >= 4 ? m.data[m.data.length - 1]! : 0;
      post({ type: "stats", stats: stats(t0, dabs.length / 4, lastT) });
      return;
    }
    case "end": {
      if (!renderer || !stroke) return;
      const t0 = performance.now();
      renderer.drawCalls = 0;
      const dabs = stroke.finish();
      if (dabs.length) renderer.drawDabs(dabs, settings.color, settings.hardness);
      renderer.endStroke(settings.opacity);
      lastStrokeDabs = stroke.dab_count;
      stroke.free();
      stroke = null;
      lastDab = null;
      renderer.present(1);
      post({ type: "stats", stats: stats(t0, dabs.length / 4, 0) });
      return;
    }
    case "cancel": {
      if (!renderer) return;
      if (stroke) {
        stroke.free();
        stroke = null;
      }
      renderer.cancelStroke();
      renderer.present(1);
      return;
    }
    case "clear":
      renderer?.clearLayer();
      renderer?.present(1);
      return;
    case "undo":
      if (renderer?.undo()) renderer.present(1);
      return;
    case "readback":
      post({ type: "readback", id: m.id, painted: renderer ? renderer.countPainted() : -1 });
      return;
  }
}

self.onmessage = (e: MessageEvent<ToWorker>) => {
  handle(e.data).catch((err: unknown) => {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  });
};
