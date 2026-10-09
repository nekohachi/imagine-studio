// ブラシの見た目を実際の Chromium で確かめるための写真。
// 使い方: pnpm build && node scripts/shot.mjs [出力.png]
// 各プリセットで 1 本ずつ、筆圧を変えながら曲線を描いて撮る。
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const out = process.argv[2] ?? "shot.png";
const root = resolve(new URL("../apps/web/dist", import.meta.url).pathname);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(root, p);
    await stat(file);
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  await page.goto(url);
  await page.waitForFunction(() => window.__imagine && window.__imagine.ready().version !== "", null, {
    timeout: 20000,
  });
  // 原寸に近い倍率で見たいので 1 回ズーム
  await page.mouse.move(500, 400);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(100);

  const presets = await page.$$eval("#preset option", (os) => os.map((o) => o.textContent));
  const colors = ["#c0392b", "#2980b9", "#27ae60", "#8e44ad", "#d35400", "#16a085", "#2c3e50", "#7f8c8d"];
  let y = 90;
  for (let i = 0; i < presets.length; i++) {
    await page.selectOption("#preset", String(i));
    await page.$eval("#color", (el, v) => {
      el.value = v;
      el.dispatchEvent(new Event("input"));
    }, colors[i % colors.length]);
    await page.waitForTimeout(50);
    // 筆圧を変えながら S 字を描く(mouse は筆圧 1 固定なので、太さは速度と入り抜きで変わる)
    await page.mouse.move(120, y);
    await page.mouse.down();
    for (let k = 1; k <= 60; k++) {
      const t = k / 60;
      await page.mouse.move(120 + t * 700, y + Math.sin(t * Math.PI * 2) * 30);
      await page.waitForTimeout(k < 30 ? 4 : 12);
    }
    await page.mouse.up();
    await page.waitForTimeout(150);
    // 混色を見るために、同じ場所に別の色をもう 1 本重ねる
    if (presets[i] === "水彩" || presets[i] === "油彩") {
      await page.$eval("#color", (el) => {
        el.value = "#f1c40f";
        el.dispatchEvent(new Event("input"));
      });
      await page.waitForTimeout(50);
      await page.mouse.move(300, y - 20);
      await page.mouse.down();
      for (let k = 1; k <= 40; k++) {
        await page.mouse.move(300 + k * 8, y - 20 + k * 1.2);
        await page.waitForTimeout(8);
      }
      await page.mouse.up();
      await page.waitForTimeout(150);
    }
    y += 80;
  }
  await page.screenshot({ path: out });
  console.log("✅", out, presets.join(" / "));
} finally {
  await browser.close();
  server.close();
}
