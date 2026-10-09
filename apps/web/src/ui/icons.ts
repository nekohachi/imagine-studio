// 24×24 の線アイコン(stroke、fill なし)。SVG の中身だけを持つ。
// 輪(RadialItem.icon)と上バーのボタンで共用する。

export const ICONS = {
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  wrench:
    '<path d="M14.5 4.5a4 4 0 0 0-4.6 5.4L4 15.8V20h4.2l5.9-5.9a4 4 0 0 0 5.4-4.6l-2.6 2.6-2.4-.6-.6-2.4z"/>',
  adjust: '<path d="M5 6h14M5 12h14M5 18h14"/><circle cx="9" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  select: '<path d="M5 5h4M15 5h4M5 19h4M15 19h4M5 9v2M5 15v2M19 9v2M19 15v2"/>',
  transform: '<path d="M6 6h12v12H6z"/><path d="M14 10l4-4M18 10V6h-4"/>',
  brush: '<path d="M18 4l2 2-9 9-2-2zM9 13c-2 0-3 1-3 3s-1 3-3 3c3 1 7 0 8-3z"/>',
  smudge: '<path d="M12 3c3 3 6 7 6 11a6 6 0 0 1-12 0c0-4 3-8 6-11z"/>',
  eraser: '<path d="M4 16l8-8 6 6-5 5H8z"/><path d="M13 21h7"/>',
  layers: '<path d="M12 4l8 4-8 4-8-4z"/><path d="M4 12l8 4 8-4M4 16l8 4 8-4"/>',
  undo: '<path d="M9 7L5 11l4 4"/><path d="M5 11h9a5 5 0 0 1 0 10h-3"/>',
  redo: '<path d="M15 7l4 4-4 4"/><path d="M19 11h-9a5 5 0 0 0 0 10h3"/>',
  fit: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>',
  dropper: '<path d="M14 6l4 4M5 19l7-7M12 12l-2-2 6-6 4 4-6 6z"/>',
  color: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  trash: '<path d="M5 7h14M9 7V4h6v3M8 7l1 13h6l1-13"/>',
  copy: '<path d="M8 8h11v11H8z"/><path d="M5 16V5h11"/>',
  merge: '<path d="M12 4v10M8 10l4 4 4-4"/><path d="M5 19h14"/>',
  up: '<path d="M12 19V5M6 11l6-6 6 6"/>',
  down: '<path d="M12 5v14M6 13l6 6 6-6"/>',
  eye: '<path d="M2 12s4-6 10-6 10 6 10 6-4 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="M3 3l18 18M10 6c.6-.1 1.3-.2 2-.2 6 0 10 6 10 6s-1.3 2-3.5 3.6M6.5 8.4C4 10.2 2 12 2 12s4 6 10 6c1.3 0 2.5-.3 3.6-.7"/>',
  rename: '<path d="M4 20h4l10-10-4-4L4 16z"/><path d="M12 8l4 4"/>',
  clear: '<path d="M6 6l12 12M18 6L6 18"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  save: '<path d="M5 4h11l3 3v13H5z"/><path d="M8 4v5h7V4M8 20v-6h8v6"/>',
  image: '<path d="M4 5h16v14H4z"/><path d="M4 16l5-5 4 4 3-3 4 4"/><circle cx="16" cy="9" r="1.5"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  star: '<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>',
  swap: '<path d="M7 7h11l-3-3M17 17H6l3 3"/>',
  json: '<path d="M8 4c-2 0-3 1-3 3v3c0 1-1 2-2 2 1 0 2 1 2 2v3c0 2 1 3 3 3M16 4c2 0 3 1 3 3v3c0 1 1 2 2 2-1 0-2 1-2 2v3c0 2-1 3-3 3"/>',
  pen: '<path d="M4 20l4-1 10-10-3-3L5 16z"/><path d="M13 7l3 3"/>',
  grid: '<path d="M4 4h16v16H4zM4 12h16M12 4v16"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function svgIcon(name: IconName, size = 22): string {
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}
