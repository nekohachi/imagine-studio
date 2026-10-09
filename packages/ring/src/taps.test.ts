import { describe, expect, it } from "vitest";
import { FingerTaps } from "./taps";
import { LongPress } from "./longpress";

function tap(ft: FingerTaps, n: number, t: number, ids = 0): number {
  for (let i = 0; i < n; i++) ft.down(ids + i, 100 + i * 40, 100, t + i * 10);
  for (let i = 0; i < n; i++) ft.up(ids + i, t + 150 + i * 5);
  return t + 160;
}

describe("FingerTaps", () => {
  it("2 本ダブルタップで (2, true)、1 回目は (2, false)", () => {
    const got: Array<[number, boolean]> = [];
    const ft = new FingerTaps((n, d) => got.push([n, d]));
    let t = tap(ft, 2, 0);
    tap(ft, 2, t + 100, 10);
    expect(got).toEqual([
      [2, false],
      [2, true],
    ]);
  });

  it("本数が違えばダブルにならない", () => {
    const got: Array<[number, boolean]> = [];
    const ft = new FingerTaps((n, d) => got.push([n, d]));
    const t = tap(ft, 2, 0);
    tap(ft, 3, t + 100, 10);
    expect(got).toEqual([
      [2, false],
      [3, false],
    ]);
  });

  it("動いたら、遅く離したら、ばらばらに着地したらタップではない", () => {
    const got: number[] = [];
    const ft = new FingerTaps((n) => got.push(n));
    ft.down(1, 0, 0, 0);
    ft.down(2, 50, 0, 10);
    ft.move(1, 30, 0);
    ft.up(1, 100);
    ft.up(2, 100);
    ft.down(1, 0, 0, 1000);
    ft.down(2, 50, 0, 1010);
    ft.up(1, 1500);
    ft.up(2, 1500);
    ft.down(1, 0, 0, 3000);
    ft.down(2, 50, 0, 3300);
    ft.up(1, 3350);
    ft.up(2, 3350);
    expect(got).toEqual([]);
  });

  it("1 本指はタップとして扱わない", () => {
    const got: number[] = [];
    const ft = new FingerTaps((n) => got.push(n));
    tap(ft, 1, 0);
    expect(got).toEqual([]);
  });

  it("4 本タップは単発で来る", () => {
    const got: Array<[number, boolean]> = [];
    const ft = new FingerTaps((n, d) => got.push([n, d]));
    tap(ft, 4, 0);
    expect(got).toEqual([[4, false]]);
  });
});

describe("LongPress", () => {
  it("動かなければ発火し、動けば取り消す", async () => {
    let fired = 0;
    const lp = new LongPress(() => fired++, 30, 12);
    lp.begin(1, 0, 0);
    expect(lp.update(1, 5, 5)).toBe(false);
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(1);
    expect(lp.didFire).toBe(true);
    lp.begin(2, 0, 0);
    expect(lp.update(2, 20, 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(fired).toBe(1);
  });
});
