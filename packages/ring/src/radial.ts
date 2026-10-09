/**
 * マーキングメニュー（8 方位固定のサークルメニュー）。
 *
 * Maya と同じで方位は固定。指を出した向きで候補が決まり、離した時点で決定する。
 * 中心へ戻して離せばキャンセル。方位が固定なので、慣れれば見ないで出せる。
 */

export const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface RadialItem {
  label: string;
  /** 英語名やショートカット。小さく併記する。 */
  sub?: string;
  /** 24×24 の SVG フラグメント（ui/icons.ts の値）。 */
  icon?: string;
  run(): void;
}

export type RadialMenu = Partial<Record<Direction, RadialItem>>;

const NS = "http://www.w3.org/2000/svg";
// 指 2 本・3 本で開くので、指と手のひらで隠れないだけの大きさが要る（実機の要望）
const RING_OUTER = 176;
const RING_INNER = 56;
/** 中心からこれ以内はキャンセル扱い。 */
const DEAD_RADIUS = 42;
/** これだけ動くまでは何も選ばない（寄せた輪での誤爆よけ）。 */
const MOVE_MIN = 14;
/** ボタンからこれだけ引いたら、長押しを待たずに輪を開く。 */
const OPEN_DRAG = 24;
/**
 * 開いた時に指が乗っていた区画を解くまでの距離（`53`）。
 * 長押し中の指のぶれ（10px ほど）では解けず、狙って動かせば解ける。
 */
const PARK_RELEASE = 25;


interface Slice {
  path: SVGPathElement;
  icon: SVGGElement;
  item: RadialItem;
  index: number;
}

/** 輪の下に並べる一覧の 1 行。カメラのように数が決まらないものに使う。 */
interface Row {
  rect: SVGRectElement;
  label: SVGTextElement;
  item: RadialItem;
  top: number;
}

const ROW_WIDTH = 208;
const ROW_HEIGHT = 32;
/** 輪の下端から一覧までの間。 */
const ROW_GAP = 14;

let open: {
  host: HTMLElement;
  /** 選ばせない「説明だけ」の輪（`50`）。指はこの下の画面へ素通りする。 */
  passive: boolean;
  slices: Array<Slice | null>;
  rows: Row[];
  /** 輪の中心。**向きはここから測る**（`52`）。 */
  cx: number;
  cy: number;
  /** 押した点。「指が動いたか」だけをここで測る。 */
  px: number;
  py: number;
  /** 縮めたあとの寸法（`52`）。端では 1 倍より小さい。 */
  outer: number;
  dead: number;
  rowWidth: number;
  /**
   * 開いた時点で**指がもう乗っていた区画**（`52`）。寄せた輪で起きる。
   * ここから一度出るまでは何も選ばない。指を置いたまま離しただけで
   * 「オブジェクトを削除」が走る、を防ぐ。
   */
  parked: number;
  /** 一度 `parked` から出たか。出たあとはふつうに選べる。 */
  armed: boolean;
  selected: number;
  /** 一覧の選択。方位とは排他。 */
  selectedRow: number;
} | null = null;

function arcPath(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): string {
  const x0 = cx + Math.cos(a0) * r1;
  const y0 = cy + Math.sin(a0) * r1;
  const x1 = cx + Math.cos(a1) * r1;
  const y1 = cy + Math.sin(a1) * r1;
  const x2 = cx + Math.cos(a1) * r0;
  const y2 = cy + Math.sin(a1) * r0;
  const x3 = cx + Math.cos(a0) * r0;
  const y3 = cy + Math.sin(a0) * r0;
  return `M${x0},${y0}A${r1},${r1} 0 0 1 ${x1},${y1}L${x2},${y2}A${r0},${r0} 0 0 0 ${x3},${y3}Z`;
}

function text(cls: string | null, x: number, y: number, content: string): SVGTextElement {
  const t = document.createElementNS(NS, "text");
  if (cls) t.setAttribute("class", cls);
  t.setAttribute("x", String(x));
  t.setAttribute("y", String(y));
  t.setAttribute("text-anchor", "middle");
  t.textContent = content;
  return t;
}

/**
 * サークルメニューを開く。
 * `list` を渡すと輪の下に一覧を並べる（数が決まらないもの。カメラなど）。
 */
export interface RadialOptions {
  /**
   * **選ばせない輪**（`50` の修飾ボタン）。指の合図を受け取らず、下の画面へ素通りさせる。
   * 光らせるのは呼び出し側（`highlightRadial`）。
   */
  passive?: boolean;
  /** 真ん中に出す言葉。既定は「キャンセル」。 */
  hub?: string;
}

export function openRadial(
  menu: RadialMenu,
  clientX: number,
  clientY: number,
  list: RadialItem[] = [],
  opts: RadialOptions = {},
): void {
  closeRadial();
  // **大きさはそのまま、画面に入る所まで寄せる**（`53`）。
  //
  // `52` では端で輪を縮めていたが、実機では**小さくて読みにくい**と言われた。
  // 縮めるのはやめ、寄せだけで画面に入れる（左のツール列なら右へ 70px ほど）。
  //
  // 寄せても食い違わないのは、`52` で**向きを輪の中心から読む 1 本立て**にしたから
  // （下の `onMove`）。見えている通りに選べる。ビューポートの指のジェスチャは
  // 画面の真ん中で開くので寄せは 0 で、見ないで振り抜く使い方もそのまま効く。
  //
  // 縮めるのは、画面そのものが輪より狭いときだけ（縦持ちの細い端末）。
  const scale = Math.min(1, (window.innerWidth - 12) / (RING_OUTER * 2));
  const outer = RING_OUTER * scale;
  const inner = RING_INNER * scale;
  const dead = DEAD_RADIUS * scale;
  const rowWidth = Math.min(ROW_WIDTH, window.innerWidth - 16);
  // 一覧がある分だけ下の余白も見る
  const below = list.length ? ROW_GAP + list.length * ROW_HEIGHT : 0;
  const edgeX = outer + 6;
  const edgeY = outer + 12;
  const cx = Math.max(edgeX, Math.min(Math.max(edgeX, window.innerWidth - edgeX), clientX));
  const cy = Math.max(edgeY, Math.min(Math.max(edgeY, window.innerHeight - edgeY - below), clientY));
  /** 文字が画面から出ないよう、x を内側へ寄せる。返すのは寄せたぶん。 */
  const clampText = (t: SVGTextElement, x: number): number => {
    const half = (t.getComputedTextLength?.() ?? 0) / 2 + 6;
    const at = Math.max(half + 4, Math.min(window.innerWidth - half - 4, x));
    if (at !== x) t.setAttribute("x", String(at));
    return at - x;
  };

  const host = document.createElement("div");
  host.className = "radial";
  // 説明だけの輪は、指を下の画面へ通す（押しながら反対の手で触れるように）
  if (opts.passive) host.style.pointerEvents = "none";
  host.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  host.addEventListener("touchmove", (e) => e.preventDefault(), { passive: false });
  const svg = document.createElementNS(NS, "svg");
  host.appendChild(svg);
  document.body.appendChild(host);

  const slices: Array<Slice | null> = [];
  for (let i = 0; i < 8; i++) {
    const item = menu[DIRECTIONS[i]!];
    const a0 = ((i * 45 - 22.5 - 90) * Math.PI) / 180;
    const a1 = ((i * 45 + 22.5 - 90) * Math.PI) / 180;
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", arcPath(cx, cy, inner, outer, a0, a1));
    path.setAttribute("fill", item ? "#2c3238" : "#23272c");
    path.setAttribute("stroke", "#171a1e");
    path.setAttribute("stroke-width", "1");
    path.setAttribute("opacity", item ? "1" : ".45");
    svg.appendChild(path);
    if (!item) {
      slices.push(null);
      continue;
    }
    const mid = (a0 + a1) / 2;
    const tr = (inner + outer) / 2;
    const tx = cx + Math.cos(mid) * tr;
    const ty = cy + Math.sin(mid) * tr;

    const g = document.createElementNS(NS, "g");
    g.setAttribute("transform", `translate(${tx - 12},${ty - 28}) scale(1)`);
    g.setAttribute("fill", "none");
    g.setAttribute("stroke", "#dfe5ea");
    g.setAttribute("stroke-width", "1.6");
    g.setAttribute("stroke-linecap", "round");
    g.setAttribute("stroke-linejoin", "round");
    g.innerHTML = item.icon ?? "";
    svg.appendChild(g);
    const label = text(null, tx, ty + 12, item.label);
    const sub = text("sub", tx, ty + 26, item.sub ?? "");
    svg.appendChild(label);
    svg.appendChild(sub);
    // 画面から出そうな文字は内側へ。アイコンも同じだけ動かして、離れないようにする
    const shift = clampText(label, tx);
    clampText(sub, tx);
    if (shift) g.setAttribute("transform", `translate(${tx - 12 + shift},${ty - 28}) scale(1)`);
    slices.push({ path, icon: g, item, index: i });
  }

  // 押した点と輪を細い線でつなぐ。「ここから引く」が見える（`41` の T3）
  if (Math.hypot(cx - clientX, cy - clientY) > 1) {
    const link = document.createElementNS(NS, "line");
    link.setAttribute("x1", String(clientX));
    link.setAttribute("y1", String(clientY));
    link.setAttribute("x2", String(cx));
    link.setAttribute("y2", String(cy));
    link.setAttribute("stroke", "#4f9fd1");
    link.setAttribute("stroke-width", "1");
    link.setAttribute("opacity", ".5");
    svg.appendChild(link);
    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("cx", String(clientX));
    dot.setAttribute("cy", String(clientY));
    dot.setAttribute("r", "4");
    dot.setAttribute("fill", "#4f9fd1");
    svg.appendChild(dot);
  }

  const hub = document.createElementNS(NS, "circle");
  hub.setAttribute("cx", String(cx));
  hub.setAttribute("cy", String(cy));
  hub.setAttribute("r", String(inner - 2));
  hub.setAttribute("fill", "#20242a");
  hub.setAttribute("stroke", "#3d454e");
  svg.appendChild(hub);
  svg.appendChild(text("sub", cx, cy + 4, opts.hub ?? "キャンセル"));

  // 輪の下の一覧
  const rows: Row[] = [];
  const listTop = cy + outer + ROW_GAP;
  list.forEach((item, i) => {
    const top = listTop + i * ROW_HEIGHT;
    const rect = document.createElementNS(NS, "rect");
    rect.setAttribute("x", String(cx - rowWidth / 2));
    rect.setAttribute("y", String(top));
    rect.setAttribute("width", String(rowWidth));
    rect.setAttribute("height", String(ROW_HEIGHT));
    rect.setAttribute("fill", "#2c3238");
    rect.setAttribute("stroke", "#171a1e");
    svg.appendChild(rect);
    // `sub` があれば 2 段にする（段ごとの面数と推定メモリ。`32` の T3）
    const label = text(null, cx, top + ROW_HEIGHT / 2 + (item.sub ? -1 : 5), item.label);
    svg.appendChild(label);
    if (item.sub) svg.appendChild(text("sub", cx, top + ROW_HEIGHT / 2 + 12, item.sub));
    rows.push({ rect, label, item, top });
  });

  open = {
    host,
    passive: !!opts.passive,
    slices,
    rows,
    cx,
    cy,
    px: clientX,
    py: clientY,
    outer,
    dead,
    rowWidth,
    parked: -1,
    armed: true,
    selected: -1,
    selectedRow: -1,
  };
  // 開いた時点で指が区画の上に居るか（寄せた輪でだけ起きる）
  const ox = clientX - cx;
  const oy = clientY - cy;
  if (Math.hypot(ox, oy) >= dead) {
    open.parked = sliceAt(ox, oy);
    open.armed = open.parked < 0;
  }
  if (opts.passive) return;
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}

/** 区画の色を塗り直す。 */
function paintSlices(sel: number): void {
  if (!open) return;
  for (const s of open.slices) {
    if (!s) continue;
    const on = s.index === sel;
    s.path.setAttribute("fill", on ? "#2f5f7d" : "#2c3238");
    s.path.setAttribute("stroke", on ? "#4f9fd1" : "#171a1e");
    s.icon.setAttribute("stroke", on ? "#ffffff" : "#dfe5ea");
  }
  open.selected = sel;
}

/** 説明だけの輪で、いまの向きを光らせる（`50`）。 */
export function highlightRadial(dir: Direction | null): void {
  if (!open) return;
  const sel = dir ? DIRECTIONS.indexOf(dir) : -1;
  if (sel === open.selected) return;
  paintSlices(open.slices[sel] ? sel : -1);
  if (sel >= 0) navigator.vibrate?.(6);
}

/** その向きの方位（北が 0）。区画が無ければ −1。 */
function sliceAt(dx: number, dy: number): number {
  // 北を 0 にして 45° ごとに割る。22.5° 足してから割ると境界が方位の真ん中に来る
  const deg = ((Math.atan2(dy, dx) * 180) / Math.PI + 90 + 360 + 22.5) % 360;
  const i = Math.floor(deg / 45);
  return open?.slices[i] ? i : -1;
}

/**
 * 指の位置から選ぶものを決める（`52` で 1 本にした）。
 *
 * **向きは輪の中心から測る。それだけ**。描いてあるものと読み方が必ず一致する。
 *
 * `50` は「押した点から測る」と「輪の帯の上なら中心から測る」の 2 本立てだった。
 * 輪を 150px も横へ寄せていたので、どちらか一方では必ず食い違ったからだ。
 * `52` で**縮めてから寄せる**ようにして寄せが小さくなり、2 本立てが要らなくなった。
 *
 * 見ないで振り抜く使い方（`41` の T3）はそのまま効く。ビューポートの指の
 * ジェスチャは画面の真ん中で開くので寄せが 0 で、中心 = 押した点になる。
 */
function onMove(e: PointerEvent): void {
  if (!open) return;
  const ax = e.clientX - open.cx;
  const ay = e.clientY - open.cy;
  const toRing = Math.hypot(ax, ay);
  // 押した点から少しでも動くまでは何も選ばない。寄せた輪では、押した瞬間の指が
  // 既にどこかの区画の上に居るので、動いていないうちに当てると誤爆する（`41` の T3）
  const moved = Math.hypot(e.clientX - open.px, e.clientY - open.py) > MOVE_MIN;

  // 一覧の上に居るならそちらが優先。方位の選択は外す
  let row = -1;
  if (moved && Math.abs(ax) <= open.rowWidth / 2) {
    row = open.rows.findIndex((r) => e.clientY >= r.top && e.clientY < r.top + ROW_HEIGHT);
  }
  if (row !== open.selectedRow) {
    open.rows.forEach((r, i) => r.rect.setAttribute("fill", i === row ? "#2f5f7d" : "#2c3238"));
    open.selectedRow = row;
    if (row >= 0) navigator.vibrate?.(6);
  }

  // 輪の真ん中（ハブ）に指が乗っている = キャンセル。見たままの意味にする。
  // 外へ振り抜いた先は、輪の外でもその方位のまま（マーキングメニュー）
  const here = toRing >= open.dead ? sliceAt(ax, ay) : -1;
  // 開いた時に指が乗っていた区画からは、一度出るまで何も選ばない（`52`）。
  // 寄せた輪では指が最初からどこかの区画の上に居るので、置いたまま離しただけで
  // そこが走ってしまう。削除の輪では取り返しがつかない
  // 別の区画へ移ったか、はっきり動かしたら解ける（`53`）。
  // 寄せた輪では指の下の区画も選べないと困るので、距離でも解けるようにした
  if (!open.armed && (here !== open.parked || Math.hypot(e.clientX - open.px, e.clientY - open.py) > PARK_RELEASE)) {
    open.armed = true;
  }
  const sel = row < 0 && moved && open.armed ? here : -1;
  if (sel === open.selected) return;
  paintSlices(sel);
  if (sel >= 0) navigator.vibrate?.(6);
}

function onUp(e?: PointerEvent): void {
  if (!open) return;
  const { selected, selectedRow, slices, rows } = open;
  closeRadial();
  // **`pointercancel` では決めない**（`41` の T4）。一覧のスクロールにさらわれた
  // ときなどに飛んでくるので、選んでいたものを実行すると誤爆になる
  if (e?.type === "pointercancel") return;
  if (selectedRow >= 0) rows[selectedRow]?.item.run();
  else if (selected >= 0) slices[selected]?.item.run();
}

export function closeRadial(): void {
  if (!open) return;
  window.removeEventListener("pointermove", onMove);
  window.removeEventListener("pointerup", onUp);
  window.removeEventListener("pointercancel", onUp);
  open.host.remove();
  open = null;
}

export function isRadialOpen(): boolean {
  return open !== null;
}

/**
 * ボタンに長押しのサークルメニューを付ける。
 * PC は右クリックで即開き、タブレットは 200ms の長押し。
 * 動かさずに離したら tap を呼ぶ（ふつうのボタンとしても使える）。
 */
export function attachRadialButton(
  button: HTMLElement,
  menu: () => RadialMenu,
  tap?: () => void,
  list?: () => RadialItem[],
): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let opened = false;
  let sx = 0;
  let sy = 0;
  let pid: number | null = null;

  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  // 押している間だけ window を見る。ツール列は描き直されるので、
  // ボタンより長生きする購読を残さない
  const listen = (on: boolean) => {
    const fn = on ? window.addEventListener : window.removeEventListener;
    fn("pointermove", onMove as EventListener);
    fn("pointerup", onUp as EventListener);
    fn("pointercancel", onUp as EventListener);
  };

  const onMove = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    if (opened) return;
    // **動いても長押しを消さない**（`50` の直し）。ツール列のボタンは
    // `touch-action: none` でスクロールに使われないので、指のぶれで輪が
    // 出なくなるほうが痛い（実機の「段が足せない」）。
    // 大きく引いたら、200ms を待たずにその場で開く（Maya のマーキングメニュー）
    if (Math.hypot(e.clientX - sx, e.clientY - sy) > OPEN_DRAG) {
      cancel();
      opened = true;
      openRadial(menu(), sx, sy, list?.() ?? []);
      onMove(e);
    }
  };
  const onUp = (e: PointerEvent) => {
    if (e.pointerId !== pid) return;
    cancel();
    pid = null;
    listen(false);
    // サークルメニューを開いていたら、決定はそちらが受け取る
    if (!opened) tap?.();
    opened = false;
  };

  button.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
  button.addEventListener("contextmenu", (e) => e.preventDefault());
  button.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    pid = e.pointerId;
    sx = e.clientX;
    sy = e.clientY;
    opened = false;
    listen(true);
    if (e.pointerType === "mouse" && e.button === 2) {
      opened = true;
      openRadial(menu(), sx, sy, list?.() ?? []);
      return;
    }
    timer = setTimeout(() => {
      opened = true;
      openRadial(menu(), sx, sy, list?.() ?? []);
    }, 200);
  });
}
