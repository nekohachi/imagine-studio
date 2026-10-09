import { execSync } from "node:child_process";
import { defineConfig } from "vitest/config";

// GitHub Pages はリポジトリ名のサブパスで配信されるので base を合わせる。
// 手元では "/"、Actions では IMAGINE_BASE=/imagine-studio/ を渡す。
const base = process.env.IMAGINE_BASE ?? "/";

function buildStamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const t = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  let sha = "";
  try {
    sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    /* git が無い場所でも組めるように */
  }
  return sha ? `${t} · ${sha}` : t;
}

export default defineConfig({
  base,
  build: {
    target: "es2022",
    sourcemap: true,
  },
  worker: {
    format: "es",
  },
  define: { __BUILD__: JSON.stringify(buildStamp()) },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
