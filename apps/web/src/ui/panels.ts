// パネルの中身: ブラシ、レイヤー、カラー、アクション。輪のメニューもここで組む。
import { attachRadialButton, openRadial, type RadialItem, type RadialMenu } from "@imagine/ring";
import type { Bridge } from "../bridge";
import type { BrushJson, BrushPreset, LayerInfo } from "../protocol";
import type { AppState } from "../state";
import { ColorPicker, DEFAULT_PALETTE, hexToRgb, rgbToHex, type Rgb } from "./color";
import { ICONS, svgIcon } from "./icons";
import { el, type Shell } from "./shell";

export interface Ctx {
  state: AppState;
  bridge: Bridge;
  shell: Shell;
  act: {
    setBrush: (p: BrushPreset) => void;
    setBrushJson: (b: BrushJson) => void;
    setColor: (c: Rgb, remember?: boolean) => void;
    swapColors: () => void;
    toggleEraser: () => void;
    setLayer: (id: number) => void;
    undo: () => void;
    redo: () => void;
    fit: () => void;
    newDoc: () => void;
    open: () => void;
    save: () => void;
    exportPng: () => void;
    eyedropOnce: () => void;
    thumbnails: () => void;
    setTool: (tool: "brush" | "select" | "fill") => void;
  };
}

// ---- 選択 ----

export function renderSelectPanel(body: HTMLElement, ctx: Ctx): void {
  const { state, bridge, act } = ctx;
  act.setTool("select");
  body.append(el.title("選択"));
  const tools = el.row();
  for (const [key, label, icon] of [
    ["rect", "矩形", "select"],
    ["lasso", "投げ縄", "pen"],
    ["wand", "自動選択", "dropper"],
  ] as const) {
    const b = el.button(label, () => {
      state.selectTool = key;
      ctx.shell.rerender();
    }, icon, state.selectTool === key ? "on" : "");
    tools.append(b);
  }
  body.append(tools);
  if (state.selectTool === "wand") {
    body.append(
      el.slider("許容値", 0, 255, 1, state.tolerance, (v) => {
        state.tolerance = v;
      }),
      el.toggle("つながった所だけ", state.contiguous, (v) => {
        state.contiguous = v;
      }),
      el.toggle("見えている絵で判定(全レイヤー)", state.sampleMerged, (v) => {
        state.sampleMerged = v;
      })
    );
  }
  const help = document.createElement("div");
  help.className = "phelp";
  help.textContent = "SHF を押しながらで足す、CTL を押しながらで引く。動かさずに離すと解除。";
  body.append(help);
  body.append(el.title("範囲"));
  body.append(
    el.row(
      el.button("全て", () => bridge.send({ type: "select", kind: "all" })),
      el.button("解除", () => bridge.send({ type: "select", kind: "none" })),
      el.button("反転", () => bridge.send({ type: "select", kind: "invert" }))
    )
  );
  body.append(el.title("範囲に対して"));
  body.append(
    el.row(
      el.button("今の色で塗る", () => bridge.send({ type: "fillSelection" }), "grid"),
      el.button("消去", () => bridge.send({ type: "deleteSelection" }), "clear")
    )
  );
  body.append(el.title("ツールを戻す"));
  body.append(el.button("ブラシへ", () => {
    act.setTool("brush");
    ctx.shell.closePanel();
  }, "brush"));
}

// ---- 塗りつぶし ----

export function renderFillPanel(body: HTMLElement, ctx: Ctx): void {
  const { state, act } = ctx;
  act.setTool("fill");
  body.append(el.title("塗りつぶし(バケツ)"));
  const help = document.createElement("div");
  help.className = "phelp";
  help.textContent = "キャンバスをタップした所から、似た色の範囲を今の色で塗ります。選択範囲があればその中だけ。";
  body.append(help);
  body.append(
    el.slider("許容値", 0, 255, 1, state.tolerance, (v) => {
      state.tolerance = v;
    }),
    el.toggle("つながった所だけ", state.contiguous, (v) => {
      state.contiguous = v;
    }),
    el.toggle("見えている絵で判定(線画が別レイヤーでも塗れる)", state.sampleMerged, (v) => {
      state.sampleMerged = v;
    })
  );
  body.append(el.title("ツールを戻す"));
  body.append(el.button("ブラシへ", () => {
    act.setTool("brush");
    ctx.shell.closePanel();
  }, "brush"));
}

// ---- ブラシ ----

export function renderBrushPanel(body: HTMLElement, ctx: Ctx): void {
  const { state, act } = ctx;
  body.append(el.title("ブラシ"));
  const list = document.createElement("div");
  list.className = "plist";
  for (const p of state.presets) {
    const row = document.createElement("button");
    row.className = "prow-btn" + (p.name === state.brush.name ? " on" : "");
    const fav = state.settings.favorites.includes(p.name);
    row.innerHTML = `<span class="pname">${p.name}</span><span class="pfav${fav ? " on" : ""}">${svgIcon("star", 16)}</span>`;
    attachRadialButton(row, () => brushRowMenu(ctx, p), () => act.setBrush(p));
    list.appendChild(row);
  }
  body.append(list);

  // 今のブラシの主な数値
  const b = state.brush;
  body.append(el.title(`${b.name} の設定`));
  const num = (key: string, label: string, min: number, max: number, step: number) => {
    const v = Number(b[key] ?? 0);
    body.append(
      el.slider(label, min, max, step, v, (val) => {
        act.setBrushJson({ ...state.brush, [key]: val });
      })
    );
  };
  num("size", "半径", 0.5, 200, 0.5);
  num("stabilizer", "手ブレ", 0, 40, 1);
  num("hardness", "硬さ", 0, 1, 0.05);
  num("opacity", "不透明度", 0.05, 1, 0.05);
  num("flow", "流量", 0.02, 1, 0.02);
  num("spacing", "間隔", 0.02, 1, 0.02);
  num("taper_in", "入り", 0, 100, 1);
  num("taper_out", "抜き", 0, 100, 1);
  num("mix", "混色", 0, 1, 0.05);
  num("wet", "水分", 0, 1, 0.05);
  num("grain", "紙目", 0, 1, 0.05);

  // JSON(ブラシスタジオの代わり)
  const details = document.createElement("details");
  details.className = "pjson";
  details.innerHTML = "<summary>JSON で全部の項目を編集</summary>";
  const ta = document.createElement("textarea");
  ta.value = JSON.stringify(state.brush, null, 2);
  ta.spellcheck = false;
  const apply = el.button("適用", () => {
    try {
      act.setBrushJson(JSON.parse(ta.value) as BrushJson);
      ctx.shell.toast("ブラシを更新しました");
    } catch (e) {
      ctx.shell.toast("JSON が読めません: " + String(e));
    }
  });
  details.append(ta, apply);
  body.append(details);
}

function brushRowMenu(ctx: Ctx, p: BrushPreset): RadialMenu {
  const { state, act } = ctx;
  const fav = state.settings.favorites.includes(p.name);
  return {
    N: { label: "使う", icon: ICONS.brush, run: () => act.setBrush(p) },
    E: {
      label: fav ? "お気に入り解除" : "お気に入り",
      sub: "輪に出す",
      icon: ICONS.star,
      run: () => {
        const f = state.settings.favorites.filter((n) => n !== p.name);
        if (!fav) f.push(p.name);
        state.settings.favorites = f.slice(-8);
        state.save();
        ctx.shell.rerender();
      },
    },
    S: {
      label: "JSON をコピー",
      icon: ICONS.json,
      run: () => {
        void navigator.clipboard?.writeText(p.json);
        ctx.shell.toast("コピーしました");
      },
    },
  };
}

/** キャンバス長押しの輪(docs/04: ブラシ / 消しゴム / 選択 / 変形 / 塗り / 図形 / スポイト / レイヤー)。 */
export function canvasMenu(ctx: Ctx): RadialMenu {
  const { act, shell } = ctx;
  const later = (label: string) => ({ label, sub: "フェーズ 4", icon: ICONS.grid, run: () => shell.toast(`${label}はフェーズ 4 で入ります`) });
  return {
    N: {
      label: "ブラシ",
      sub: "一覧",
      icon: ICONS.brush,
      run: () => {
        act.setTool("brush");
        shell.openPanel("brush", (b) => renderBrushPanel(b, ctx));
      },
    },
    NE: { label: "消しゴム", sub: "切替", icon: ICONS.eraser, run: () => act.toggleEraser() },
    E: {
      label: "選択",
      sub: ctx.state.hasSelection ? "範囲あり" : undefined,
      icon: ICONS.select,
      run: () => shell.openPanel("select", (b) => renderSelectPanel(b, ctx)),
    },
    SE: later("変形"),
    S: {
      label: "塗り",
      sub: "バケツ",
      icon: ICONS.grid,
      run: () => shell.openPanel("fill", (b) => renderFillPanel(b, ctx)),
    },
    SW: later("図形"),
    W: { label: "スポイト", sub: "次のタップ", icon: ICONS.dropper, run: () => act.eyedropOnce() },
    NW: { label: "レイヤー", icon: ICONS.layers, run: () => shell.openPanel("layers", (b) => renderLayersPanel(b, ctx)) },
  };
}

/** キャンバスの輪の下の一覧: お気に入りのブラシ。 */
export function canvasMenuList(ctx: Ctx): RadialItem[] {
  return ctx.state.ringBrushes().map((p) => ({
    label: p.name,
    sub: p.name === ctx.state.brush.name ? "いま" : undefined,
    run: () => ctx.act.setBrush(p),
  }));
}

/** 2 本指長押し: ビューの輪。 */
export function viewMenu(ctx: Ctx): RadialMenu {
  const { act, state, bridge } = ctx;
  const setView = (patch: Partial<typeof state.view>) => {
    state.view = { ...state.view, ...patch };
    bridge.send({ type: "view", view: state.view });
    state.emit("view");
  };
  return {
    N: { label: "全体表示", icon: ICONS.fit, run: () => act.fit() },
    E: { label: "回転リセット", sub: "0°", icon: ICONS.transform, run: () => setView({ rot: 0 }) },
    S: { label: "原寸", sub: "100%", icon: ICONS.grid, run: () => setView({ scale: 1 }) },
    W: { label: "戻す", icon: ICONS.undo, run: () => act.undo() },
    SW: { label: "やり直す", icon: ICONS.redo, run: () => act.redo() },
  };
}

// ---- レイヤー ----

const thumbs = new Map<number, ImageBitmap>();
let thumbSize = 56;

export function setThumbnails(size: number, items: Array<{ id: number; bitmap: ImageBitmap }>): void {
  thumbSize = size;
  for (const b of thumbs.values()) b.close();
  thumbs.clear();
  for (const it of items) thumbs.set(it.id, it.bitmap);
}

export function renderLayersPanel(body: HTMLElement, ctx: Ctx): void {
  const { state, bridge, act } = ctx;
  const head = el.row(el.title("レイヤー"));
  const addBtn = el.button("追加", () => bridge.send({ type: "addLayer", a8: false, name: `レイヤー ${state.layers.length + 1}` }), "plus");
  head.append(addBtn);
  body.append(head);

  const list = document.createElement("div");
  list.className = "lylist";
  for (const l of [...state.layers].reverse()) {
    const row = document.createElement("div");
    row.className = "lyrow" + (l.id === state.active ? " on" : "") + (l.visible ? "" : " off");
    const c = document.createElement("canvas");
    c.className = "lythumb";
    c.width = thumbSize;
    c.height = thumbSize;
    const bm = thumbs.get(l.id);
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    if (bm) g.drawImage(bm, (thumbSize - bm.width) / 2, (thumbSize - bm.height) / 2);
    const name = document.createElement("span");
    name.className = "lyname";
    const modeName = BLEND_LABELS[state.blendNames[l.blend] ?? "normal"] ?? state.blendNames[l.blend];
    name.innerHTML =
      `<span>${l.clip ? "↳ " : ""}${l.name}${l.a8 ? "(モノクロ)" : ""}</span>` +
      `<span class="lysub">${l.blend ? modeName : ""}${l.opacity < 1 ? ` ${Math.round(l.opacity * 100)}%` : ""}</span>`;
    const eye = document.createElement("button");
    eye.className = "lyeye";
    eye.innerHTML = svgIcon(l.visible ? "eye" : "eyeOff", 18);
    eye.addEventListener("click", (e) => {
      e.stopPropagation();
      bridge.send({ type: "setLayerVisible", id: l.id, visible: !l.visible });
    });
    row.append(c, name, eye);
    attachRadialButton(
      row,
      () => layerMenu(ctx, l),
      () => act.setLayer(l.id),
      () => layerMenuList(ctx, l)
    );
    list.appendChild(row);
  }
  body.append(list);

  const cur = state.activeLayer();
  if (cur) {
    body.append(
      el.slider("不透明度", 0, 100, 1, Math.round(cur.opacity * 100), (v) => {
        bridge.send({ type: "setLayerOpacity", id: cur.id, opacity: v / 100 });
      })
    );
  }
  act.thumbnails();
}

/** 合成モードの表示名(Photoshop / CLIP STUDIO の呼び方)。 */
export const BLEND_LABELS: Record<string, string> = {
  normal: "通常",
  multiply: "乗算",
  screen: "スクリーン",
  overlay: "オーバーレイ",
  darken: "比較(暗)",
  lighten: "比較(明)",
  add: "加算(発光)",
  subtract: "減算",
  difference: "差の絶対値",
  soft_light: "ソフトライト",
  hard_light: "ハードライト",
  color_dodge: "覆い焼きカラー",
  color_burn: "焼き込みカラー",
  hue: "色相",
  saturation: "彩度",
  color: "カラー",
  luminosity: "輝度",
};

/** レイヤー行の長押しの輪の下に並べる: 合成モードの一覧。 */
export function layerMenuList(ctx: Ctx, l: LayerInfo): RadialItem[] {
  return ctx.state.blendNames.map((n, i) => ({
    label: BLEND_LABELS[n] ?? n,
    sub: i === l.blend ? "いま" : undefined,
    run: () => ctx.bridge.send({ type: "setLayerBlend", id: l.id, blend: i }),
  }));
}

function layerMenu(ctx: Ctx, l: LayerInfo): RadialMenu {
  const { bridge, state, shell } = ctx;
  const op = (op: "remove" | "duplicate" | "mergeDown" | "moveUp" | "moveDown") => () =>
    bridge.send({ type: "layerOp", op, id: l.id });
  return {
    N: { label: "複製", icon: ICONS.copy, run: op("duplicate") },
    NE: {
      label: l.clip ? "クリップ解除" : "クリッピング",
      sub: "下のレイヤーで",
      icon: ICONS.down,
      run: () => bridge.send({ type: "setLayerClip", id: l.id, clip: !l.clip }),
    },
    E: { label: "下と結合", icon: ICONS.merge, run: op("mergeDown") },
    SE: { label: "下へ", icon: ICONS.down, run: op("moveDown") },
    S: {
      label: "削除",
      icon: ICONS.trash,
      run: () => {
        if (state.layers.length <= 1) {
          shell.toast("最後のレイヤーは消せません");
          return;
        }
        op("remove")();
      },
    },
    W: {
      label: "名前",
      icon: ICONS.rename,
      run: () => {
        const n = window.prompt("レイヤー名", l.name);
        if (n) bridge.send({ type: "renameLayer", id: l.id, name: n });
      },
    },
    NW: { label: "上へ", icon: ICONS.up, run: op("moveUp") },
    SW: {
      label: "消去",
      sub: "このレイヤー",
      icon: ICONS.clear,
      run: () => {
        ctx.act.setLayer(l.id);
        bridge.send({ type: "clear" });
      },
    },
  };
}

// ---- カラー ----

export function renderColorPanel(body: HTMLElement, ctx: Ctx): void {
  const { state, act } = ctx;
  body.append(el.title("カラー"));
  const pick = document.createElement("div");
  const picker = new ColorPicker(pick, (rgb, final) => act.setColor(rgb, final));
  picker.set(state.color);
  body.append(pick);

  const sw = el.row();
  sw.className = "prow cswatches";
  const main = document.createElement("span");
  main.className = "cbig";
  main.style.background = rgbToHex(state.color);
  const sub = document.createElement("span");
  sub.className = "cbig sub";
  sub.style.background = rgbToHex(state.sub);
  const hex = document.createElement("input");
  hex.className = "chex";
  hex.value = rgbToHex(state.color);
  hex.addEventListener("change", () => {
    const c = hexToRgb(hex.value);
    if (c) act.setColor(c, true);
    else ctx.shell.toast("16 進の色(#rrggbb)で入力してください");
  });
  sw.append(main, el.button("", act.swapColors, "swap", "icon-only"), sub, hex);
  body.append(sw);

  const pal = (title: string, colors: string[]) => {
    if (!colors.length) return;
    body.append(el.title(title));
    const grid = document.createElement("div");
    grid.className = "cgrid";
    for (const h of colors) {
      const b = document.createElement("button");
      b.className = "ccell";
      b.style.background = h;
      b.title = h;
      b.addEventListener("click", () => {
        const c = hexToRgb(h);
        if (c) act.setColor(c, true);
      });
      grid.appendChild(b);
    }
    body.append(grid);
  };
  pal("履歴", state.settings.recentColors);
  pal("パレット", DEFAULT_PALETTE);
}

// ---- アクション ----

export function renderActionsPanel(body: HTMLElement, ctx: Ctx): void {
  const { state, act, shell } = ctx;
  body.append(el.title("ファイル"));
  body.append(
    el.row(
      el.button("新規", act.newDoc, "file"),
      el.button("開く", act.open, "folder"),
      el.button("保存 (.imst)", act.save, "save"),
      el.button("PNG 書き出し", act.exportPng, "image")
    )
  );
  body.append(el.title("キャンバス"));
  body.append(el.row(el.button("全体表示", act.fit, "fit"), el.button("消去(編集中レイヤー)", () => ctx.bridge.send({ type: "clear" }), "clear")));
  body.append(el.title("設定"));
  body.append(
    el.toggle("予測で先に描く(Chrome)", state.settings.predict, (v) => {
      state.settings.predict = v;
      state.save();
    }),
    el.toggle("指でも描く(ペンの直後は無効)", state.settings.fingerDraw, (v) => {
      state.settings.fingerDraw = v;
      state.save();
    }),
    el.toggle("計測を表示(HUD)", state.settings.hud, (v) => {
      state.settings.hud = v;
      state.save();
    })
  );
  body.append(el.title("操作"));
  const help = document.createElement("div");
  help.className = "phelp";
  help.innerHTML =
    "キャンバス長押し: 輪 · 2 本指長押し: ビューの輪 · 2 本指ダブルタップ: 戻す · 3 本指ダブルタップ: やり直す · 4 本指タップ: UI を隠す<br>" +
    "SHF: 直線 · CTL: 45° · ALT: スポイト · F: 全体表示 · DEL: 消去 · 修飾は長押しで効き、左へずらして離すとロック";
  body.append(help);
  body.append(el.title("この版"));
  const info = document.createElement("div");
  info.className = "phelp";
  info.textContent = `${__BUILD__} · wasm ${state.ready.version} · ${state.ready.renderer.slice(0, 60)}`;
  body.append(info);
  void shell;
}

declare const __BUILD__: string;

/** 選択・変形・調整・指先はフェーズ 4。 */
export function renderLaterPanel(body: HTMLElement, label: string): void {
  body.append(el.title(label));
  const p = document.createElement("div");
  p.className = "phelp";
  p.textContent = `${label}はフェーズ 4(Photoshop 機能)で入ります。`;
  body.append(p);
}

export function openRingAt(menu: RadialMenu, x: number, y: number, list: RadialItem[] = []): void {
  openRadial(menu, x, y, list);
}
