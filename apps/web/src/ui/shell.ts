// 常駐 UI の骨組み(docs/04): 上バー、左レール、左下の修飾ボタン、パネル、トースト。
// 中身(パネルの内容)は panels.ts。ここは置き場所と開閉だけ。
import { svgIcon, type IconName } from "./icons";

export type PanelName = "gallery" | "actions" | "adjust" | "select" | "transform" | "brush" | "layers" | "color" | "fill" | "ruler";

export interface Shell {
  top: HTMLElement;
  rail: HTMLElement;
  mods: HTMLElement;
  panel: HTMLElement;
  panelBody: HTMLElement;
  buttons: Record<string, HTMLButtonElement>;
  gauges: { size: HTMLElement; opacity: HTMLElement };
  toast: (msg: string, ms?: number) => void;
  /** onClose は閉じるとき(別のパネルに替わるときも)に 1 回呼ぶ */
  openPanel: (name: PanelName, render: (body: HTMLElement) => void, onClose?: () => void) => void;
  closePanel: () => void;
  rerender: () => void;
  panelOpen: () => PanelName | null;
  setHidden: (hidden: boolean) => void;
}

function iconButton(id: string, icon: IconName, label: string, extraClass = ""): HTMLButtonElement {
  const b = document.createElement("button");
  b.id = id;
  b.className = `ibtn ${extraClass}`.trim();
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = svgIcon(icon) + `<span class="ibtn-label">${label}</span>`;
  // touchstart の preventDefault(iOS の長押しメニューと二度押しズームを止める)は、
  // 指とペンの click も止めてしまう。pointer でタップを見て click を自分で起こす
  b.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  b.addEventListener("contextmenu", (e) => e.preventDefault());
  let pid: number | null = null;
  let sx = 0;
  let sy = 0;
  b.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse") return;
    pid = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    try {
      b.setPointerCapture(e.pointerId);
    } catch {
      /* 取れなくても動く */
    }
  });
  let suppressUntil = 0;
  b.addEventListener("pointerup", (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    if (b.disabled) return;
    if (Math.hypot(e.clientX - sx, e.clientY - sy) < 14) {
      // 環境によっては本物の click も続けて来る(Windows のペンなど)。二重にしない
      suppressUntil = performance.now() + 500;
      b.click();
    }
  });
  b.addEventListener(
    "click",
    (e) => {
      if (e.isTrusted && performance.now() < suppressUntil) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    },
    { capture: true }
  );
  b.addEventListener("pointercancel", () => {
    pid = null;
  });
  return b;
}

export function buildShell(root: HTMLElement): Shell {
  const top = document.createElement("div");
  top.id = "top";
  const left = document.createElement("div");
  left.className = "group";
  const right = document.createElement("div");
  right.className = "group";
  top.append(left, right);

  const buttons: Record<string, HTMLButtonElement> = {};
  const add = (host: HTMLElement, id: string, icon: IconName, label: string, cls = "") => {
    const b = iconButton(id, icon, label, cls);
    buttons[id] = b;
    host.appendChild(b);
    return b;
  };
  add(left, "gallery", "menu", "ギャラリー");
  add(left, "actions", "wrench", "アクション");
  add(left, "adjust", "adjust", "調整");
  add(left, "select", "select", "選択");
  add(left, "transform", "transform", "変形");
  add(right, "brush", "brush", "ブラシ", "tool");
  add(right, "smudge", "smudge", "指先", "tool");
  add(right, "eraser", "eraser", "消しゴム", "tool");
  add(right, "layers", "layers", "レイヤー");
  const color = add(right, "color", "color", "カラー", "swatch");
  color.innerHTML = '<span class="swatch-main"></span><span class="swatch-sub"></span>';

  const rail = document.createElement("div");
  rail.id = "rail";
  const gSize = document.createElement("div");
  gSize.id = "gaugeSize";
  const gOpacity = document.createElement("div");
  gOpacity.id = "gaugeOpacity";
  const undo = iconButton("undo", "undo", "戻す", "rail-btn");
  const redo = iconButton("redo", "redo", "やり直す", "rail-btn");
  buttons.undo = undo;
  buttons.redo = redo;
  rail.append(gSize, gOpacity, undo, redo);

  const mods = document.createElement("div");
  mods.id = "mods";
  mods.innerHTML =
    '<div class="mod-row"><button class="mod" id="modShift">SHF</button><button class="mod" id="modF">F</button><button class="mod" id="modCtrl">CTL</button><button class="mod" id="modAlt">ALT</button></div>' +
    '<div class="mod-row right"><button class="mod" id="modDel">DEL</button></div>';

  const panel = document.createElement("div");
  panel.id = "panel";
  panel.hidden = true;
  const panelBody = document.createElement("div");
  panelBody.id = "panelBody";
  panel.appendChild(panelBody);

  const toastEl = document.createElement("div");
  toastEl.id = "toast";
  toastEl.hidden = true;

  root.append(top, rail, mods, panel, toastEl);

  let open: PanelName | null = null;
  let renderFn: ((body: HTMLElement) => void) | null = null;
  let closeFn: (() => void) | null = null;
  let toastTimer = 0;

  const shell: Shell = {
    top,
    rail,
    mods,
    panel,
    panelBody,
    buttons,
    gauges: { size: gSize, opacity: gOpacity },
    toast(msg, ms = 1800) {
      toastEl.textContent = msg;
      toastEl.hidden = false;
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        toastEl.hidden = true;
      }, ms) as unknown as number;
    },
    openPanel(name, render, onClose) {
      if (open === name) {
        shell.closePanel();
        return;
      }
      if (closeFn) {
        const f = closeFn;
        closeFn = null;
        f();
      }
      open = name;
      renderFn = render;
      closeFn = onClose ?? null;
      panel.dataset.name = name;
      panel.classList.toggle("left", ["gallery", "actions", "adjust", "select", "transform"].includes(name));
      panel.hidden = false;
      for (const [id, b] of Object.entries(buttons)) b.classList.toggle("open", id === name);
      shell.rerender();
    },
    closePanel() {
      open = null;
      renderFn = null;
      if (closeFn) {
        const f = closeFn;
        closeFn = null;
        f();
      }
      panel.hidden = true;
      panelBody.innerHTML = "";
      for (const b of Object.values(buttons)) b.classList.remove("open");
    },
    rerender() {
      if (!open || !renderFn) return;
      // スクロール位置を保つ
      const y = panelBody.scrollTop;
      panelBody.innerHTML = "";
      renderFn(panelBody);
      panelBody.scrollTop = y;
    },
    panelOpen: () => open,
    setHidden(hidden) {
      root.classList.toggle("ui-hidden", hidden);
      if (hidden) shell.closePanel();
    },
  };
  return shell;
}

/** パネルの小さな部品。 */
export const el = {
  row(...children: Array<HTMLElement | string>): HTMLElement {
    const d = document.createElement("div");
    d.className = "prow";
    for (const c of children) d.append(c);
    return d;
  },
  title(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "ptitle";
    d.textContent = text;
    return d;
  },
  button(label: string, onClick: () => void, icon?: IconName, cls = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.className = `pbtn ${cls}`.trim();
    b.innerHTML = (icon ? svgIcon(icon, 18) : "") + `<span>${label}</span>`;
    b.addEventListener("click", onClick);
    return b;
  },
  toggle(label: string, value: boolean, onChange: (v: boolean) => void): HTMLElement {
    const l = document.createElement("label");
    l.className = "ptoggle";
    const i = document.createElement("input");
    i.type = "checkbox";
    i.checked = value;
    i.addEventListener("change", () => onChange(i.checked));
    l.append(i, document.createTextNode(label));
    return l;
  },
  slider(label: string, min: number, max: number, step: number, value: number, onInput: (v: number, final: boolean) => void): HTMLElement {
    const l = document.createElement("label");
    l.className = "pslider";
    const i = document.createElement("input");
    i.type = "range";
    i.min = String(min);
    i.max = String(max);
    i.step = String(step);
    i.value = String(value);
    const v = document.createElement("span");
    v.textContent = String(value);
    i.addEventListener("input", () => {
      v.textContent = i.value;
      onInput(Number(i.value), false);
    });
    i.addEventListener("change", () => onInput(Number(i.value), true));
    l.append(document.createTextNode(label), i, v);
    return l;
  },
};
