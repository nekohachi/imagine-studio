// icon.svg から PWA 用の PNG を作る(Chromium で描いて撮る)。
// 使い方: node scripts/make-icons.mjs
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const pub = resolve(new URL("../apps/web/public", import.meta.url).pathname);
const svg = await readFile(`${pub}/icon.svg`, "utf8");
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined });
try {
  for (const [name, size] of [
    ["icon-192.png", 192],
    ["icon-512.png", 512],
    ["apple-touch-icon.png", 180],
  ]) {
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<html><body style="margin:0;background:#1b1b1f">${svg.replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`
    );
    const buf = await page.screenshot({ type: "png", clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(`${pub}/${name}`, buf);
    await page.close();
    console.log("✅", name);
  }
} finally {
  await browser.close();
}
