/**
 * 修飾ボタン(SHF / CTL / ALT / F)の長押し判定。macbeth の bindHoldButton の移植。
 *
 *   タップ                 ロックの入り切り(ロック中のタップで解除)
 *   長押し(200ms〜)       押している間だけ効く。離せば消える
 *   長押し → 左へ 24px 以上ずらして離す   ロック
 *
 * 長押し中は「説明だけの輪」を出す。選ばせる輪ではないので、指は下の画面へ素通りする。
 */
import { closeRadial, highlightRadial, openRadial, type RadialMenu } from "./radial";

export const HOLD_MS = 200;
export const MOD_LOCK_PX = 24;

export type ModLook = "off" | "on" | "held";

export interface HoldHooks {
  /** 押した瞬間(F のように押した時点から効かせたいもの用) */
  down?: () => void;
  tap: () => void;
  hold: () => void;
  release: (lock: boolean) => void;
  look: () => ModLook;
  /** 長押し中に出す説明だけの輪 */
  legend?: () => RadialMenu;
  /** pointercancel でロックに変えたときの知らせ */
  toast?: (msg: string) => void;
}

export function bindHoldButton(button: HTMLElement, label: string, h: HoldHooks): void {
  let pointer = -1;
  let x0 = 0;
  let held = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const sync = () => {
    button.dataset.state = h.look();
  };
  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const finish = (e: PointerEvent, cancelled: boolean) => {
    if (e.pointerId !== pointer) return;
    pointer = -1;
    clearTimer();
    closeRadial();
    if (!held) {
      if (!cancelled) h.tap();
    } else if (cancelled) {
      // iPad はペンが近づくと押している指の合図を取り消す。ここで消すと
      // ペンで描こうとした瞬間に修飾が外れるので、ロックに変えて残す
      h.release(true);
      h.toast?.(`${label} はロックにしました(タップで解除)`);
    } else {
      h.release(x0 - e.clientX >= MOD_LOCK_PX);
    }
    held = false;
    sync();
  };

  button.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  button.addEventListener("contextmenu", (e) => e.preventDefault());
  button.addEventListener("pointerdown", (e) => {
    if (pointer >= 0) return;
    pointer = e.pointerId;
    x0 = e.clientX;
    held = false;
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      /* 捕まえられなくても、離した合図は届く */
    }
    h.down?.();
    sync();
    timer = setTimeout(() => {
      timer = null;
      held = true;
      h.hold();
      navigator.vibrate?.(6);
      sync();
      const legend = h.legend?.();
      if (legend) {
        const r = button.getBoundingClientRect();
        openRadial(legend, r.left + r.width / 2, r.top + r.height / 2, [], {
          passive: true,
          hub: "押している間だけ",
        });
      }
    }, HOLD_MS);
  });
  button.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointer || !held) return;
    highlightRadial(x0 - e.clientX >= MOD_LOCK_PX ? "W" : null);
  });
  button.addEventListener("pointerup", (e) => finish(e, false));
  button.addEventListener("pointercancel", (e) => finish(e, true));
  // キーボードの Enter / Space と `.click()` は pointer の合図が来ない(detail 0)。そのときだけタップ
  button.addEventListener("click", (e) => {
    if (e.detail !== 0 || pointer >= 0) return;
    h.tap();
    sync();
  });
  sync();
}

/** 修飾ボタンの標準の説明の輪。 */
export function modLegend(label: string, locked: boolean): RadialMenu {
  return {
    N: { label: `${label} 効いています`, sub: locked ? "ロック中" : "押している間だけ", run: () => {} },
    W: { label: "ロック", sub: "← 左へずらして離す", run: () => {} },
    E: { label: "解除", sub: "このまま離す →", run: () => {} },
  };
}

/**
 * 修飾の状態を 1 か所で持つ。`held` は押している間だけ、`locked` はロック。
 * `on(name)` はどちらかが立っていれば真。
 */
export class Modifiers {
  private held = new Set<string>();
  private locked = new Set<string>();
  readonly listeners = new Set<() => void>();

  on(name: string): boolean {
    return this.held.has(name) || this.locked.has(name);
  }
  look(name: string): ModLook {
    return this.held.has(name) ? "held" : this.locked.has(name) ? "on" : "off";
  }
  isLocked(name: string): boolean {
    return this.locked.has(name);
  }
  setHeld(name: string, v: boolean): void {
    if (v) this.held.add(name);
    else this.held.delete(name);
    this.emit();
  }
  setLocked(name: string, v: boolean): void {
    if (v) this.locked.add(name);
    else this.locked.delete(name);
    this.emit();
  }
  toggleLocked(name: string): void {
    this.setLocked(name, !this.locked.has(name));
  }
  private emit(): void {
    for (const l of this.listeners) l();
  }

  /** ボタンにこの修飾を結びつける。 */
  bind(button: HTMLElement, name: string, label: string, toast?: (m: string) => void): void {
    bindHoldButton(button, label, {
      tap: () => this.toggleLocked(name),
      hold: () => this.setHeld(name, true),
      release: (lock) => {
        this.setHeld(name, false);
        this.setLocked(name, lock);
      },
      look: () => this.look(name),
      legend: () => modLegend(label, this.locked.has(name)),
      toast,
    });
    this.listeners.add(() => {
      button.dataset.state = this.look(name);
    });
  }
}
