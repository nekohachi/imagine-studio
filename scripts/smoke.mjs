// 実際の Chromium でビルド済みの apps/web/dist を開き、ペンで 1 本描いて、
// レイヤーに画素が乗ったことをワーカーから読み戻して確かめる。
// 使い方: pnpm build && node scripts/smoke.mjs
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(new URL("../apps/web/dist", import.meta.url).pathname);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".map": "application/json",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = join(root, p);
    const s = await stat(file);
    if (!s.isFile()) throw new Error("not file");
    res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const executablePath = process.env.PLAYWRIGHT_CHROMIUM ?? undefined;
const browser = await chromium.launch({
  executablePath,
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
let ok = true;
const fail = (msg) => {
  ok = false;
  console.log("❌", msg);
};
try {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.goto(url);
  await page.waitForFunction(() => window.__imagine && window.__imagine.ready().version !== "", null, {
    timeout: 20000,
  });
  const ready = await page.evaluate(() => window.__imagine.ready());
  console.log("✅ ワーカー起動", ready);

  const before = await page.evaluate(() => window.__imagine.readback());
  if (before !== 0) fail(`描く前にレイヤーが空でない: ${before}`);
  else console.log("✅ 描く前は空");

  // ペンで斜めに 1 本
  await page.mouse.move(100, 100);
  await page.mouse.down();
  for (let i = 1; i <= 40; i++) {
    await page.mouse.move(100 + i * 10, 100 + i * 6);
    await page.waitForTimeout(8);
  }
  await page.mouse.up();
  await page.waitForTimeout(200);

  const after = await page.evaluate(() => window.__imagine.readback());
  if (after < 500) fail(`描いた後の画素数が少なすぎる: ${after}`);
  else console.log(`✅ 描けた (painted=${after})`);

  const stats = await page.evaluate(() => window.__imagine.stats());
  if (!stats || stats.strokeDabs < 10) fail(`ダブ数が少ない: ${JSON.stringify(stats)}`);
  else console.log("✅ ダブ", stats.strokeDabs, "frameMs", stats.frameMs.toFixed(2));

  await page.screenshot({ path: "smoke.png" });

  // 自動保存(2 秒後)を待って開き直し、復元されることを確かめる
  await page.waitForTimeout(2600);
  await page.reload();
  await page.waitForFunction(() => window.__imagine && window.__imagine.ready().version !== "", null, {
    timeout: 20000,
  });
  const restored = await page.evaluate(() => window.__imagine.readback());
  if (restored !== after) fail(`自動保存から復元できていない: ${restored} (期待 ${after})`);
  else console.log(`✅ 自動保存から復元 (painted=${restored})`);

  // 復元直後は履歴が無いので、もう 1 本描いてから Undo を試す
  await page.mouse.move(400, 300);
  await page.mouse.down();
  await page.mouse.move(500, 400, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  await page.click("#undo");
  await page.waitForTimeout(200);
  const undone = await page.evaluate(() => window.__imagine.readback());
  if (undone !== after) fail(`Undo で戻らない: ${undone} (期待 ${after})`);
  else console.log("✅ Undo");
  if (errors.length) fail("ページエラー:\n" + errors.join("\n"));
} finally {
  await browser.close();
  server.close();
}
process.exit(ok ? 0 : 1);
