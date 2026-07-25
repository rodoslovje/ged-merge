import { test, expect } from "@playwright/test";
import { writeFileSync, existsSync } from "fs";
import os from "os";
import path from "path";

// The real file that triggered the loop for the user (index-scale, ~175k lines).
// Used when present; otherwise fall back to the synthetic file below.
const REAL = path.join(os.homedir(), "rodoslovje/srd-data/index/input/Pratnekar.ged");

// Reproduces the "Maximum update depth exceeded" loop reported on large,
// cluster-heavy duplicate lists: many same-person triples produce enough
// cluster-header rows to cross the virtualization threshold.

const BIG = path.join(os.tmpdir(), "dup-cluster-big.ged");

const HEAD = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
const lines: string[] = [...HEAD];
// Mixed list, mirroring a real MyHeritage export: mostly clean 2-copy
// duplicates (which render as flat LONE pairs), plus some 3-copy triples
// (which render as cluster HEADER rows). Surname lengths vary so some rows
// wrap to two lines and others don't — the heterogeneous row heights are what
// can make the virtual list's "dominant height" oscillate and loop forever.
// All copies share the same day-exact birth and parents, so they score high
// enough to clear the default >=85 filter.
let fam = 0;
function surname(i: number): string {
  // Alternate short and very long surnames — without the single-line fix these
  // wrap to two lines, so the height-uniformity assertion would catch it.
  return i % 2 === 0 ? `Kla${i}` : `Podgoriznadravskovasjadolinapribeljska${i}`;
}
// Each group is self-contained: a unique child given-name and birth year, so
// copies only match WITHIN their group (no cross-group duplicates). 2 copies →
// a lone pair; 3 copies → a multi-pair cluster header.
function addGroup(copies: number) {
  const f = fam++;
  const sn = surname(f);
  const year = 1700 + f;
  lines.push(`0 @FA${f}@ INDI`, `1 NAME Ata${f} /${sn}/`, "1 SEX M");
  lines.push(`0 @MO${f}@ INDI`, `1 NAME Mama${f} /${sn}/`, "1 SEX F");
  for (let c = 0; c < copies; c++) {
    lines.push(
      `0 @C${f}_${c}@ INDI`,
      `1 NAME Janez Nepomuk${f} /${sn}/`,
      "1 SEX M",
      "1 BIRT",
      `2 DATE 12 JAN ${year}`,
      "2 PLAC Kranj, Gorenjska, Slovenija",
      `1 FAMC @F${f}@`,
    );
  }
  const chil = Array.from({ length: copies }, (_, c) => `1 CHIL @C${f}_${c}@`);
  lines.push(`0 @F${f}@ FAM`, `1 HUSB @FA${f}@`, `1 WIFE @MO${f}@`, ...chil);
}
for (let i = 0; i < 220; i++) addGroup(2); // lone pairs
for (let i = 0; i < 60; i++) addGroup(3); // cluster headers
lines.push("0 TRLR", "");
writeFileSync(BIG, lines.join("\n"), "utf-8");

test("duplicate cluster list on a large file does not crash-loop", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  // Narrow viewport so long surnames wrap → row-height variance.
  await page.setViewportSize({ width: 760, height: 700 });
  await page.goto("/");
  // In CI the real corpus file is absent → the synthetic BIG file (which also
  // mixes lone pairs, cluster headers and long wrapping names) is used instead.
  const useReal = existsSync(REAL) && !process.env.SYNTH;
  await page.locator("input.file-input").first().setInputFiles(useReal ? REAL : BIG);
  await page.locator(".edit-person").first().waitFor({ timeout: 40000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Find duplicates").click();

  // The list should render, and the recoverable error card must NOT appear.
  await expect(page.locator(".tools-pairs")).toBeVisible({ timeout: 120000 });
  await page.waitForTimeout(800);

  const scroller = page.locator(".tools-view");

  // Every COLLAPSED row (lone pair or cluster header) must measure the same
  // height. If two heights coexist, the virtual list's row-height rebase
  // thrashes into an infinite render loop when scrolled across the boundary.
  // Sweep the whole (virtualized) list, collecting every collapsed-row height,
  // and also watch for the error boundary firing along the way.
  const scrollHeight = await scroller.evaluate((el) => el.scrollHeight);
  const heights = new Set<number>();
  let sawPair = false;
  let sawHeader = false;
  for (let top = 0; top <= scrollHeight; top += 300) {
    await scroller.evaluate((el, y) => { el.scrollTop = y; }, top);
    await page.waitForTimeout(50);
    if (await page.locator(".error-fallback").count()) break;
    const seen = await page.evaluate(() => {
      const pairs = [...document.querySelectorAll<HTMLElement>(".tools-pair")]
        .filter((e) => !e.querySelector(".tools-pair-compare"))
        .map((e) => Math.round(e.getBoundingClientRect().height));
      const heads = [...document.querySelectorAll<HTMLElement>(".tools-dup-cluster-head")]
        .map((e) => Math.round(e.getBoundingClientRect().height));
      return { pairs, heads };
    });
    if (seen.pairs.length) sawPair = true;
    if (seen.heads.length) sawHeader = true;
    for (const h of [...seen.pairs, ...seen.heads]) heights.add(h);
  }

  await expect(page.locator(".error-fallback"), "error boundary caught a crash").toHaveCount(0);
  const depthLoop = errors.filter((e) => /Maximum update depth/i.test(e));
  expect(depthLoop, `page errors:\n${errors.join("\n")}`).toHaveLength(0);
  // Confirm the list really is the large, mixed, virtualized shape we target.
  expect(sawPair && sawHeader, "expected both lone pairs and cluster headers").toBe(true);
  expect(heights.size, `collapsed rows must share one height, got ${[...heights].join(",")}`).toBe(1);
});
