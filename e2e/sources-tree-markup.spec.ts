import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The Sources tree is lists inside lists, and React only says so in the
// console: a row that renders its children without a list of its own puts an
// `<li>` straight inside an `<li>`, which the browser is free to re-nest as it
// pleases. Nothing on screen says it happened, so the check is the console
// itself — walked over a file that opens every shape of row the tree has: a
// repository with its sources, a source with its page images, and the
// unattached buckets of links and media.
const FILE = path.join(tmpdir(), `sources-tree-markup-${process.pid}.ged`);
const BOOK = "https://data.matricula-online.eu/sl/slovenia/maribor/sentjur-pri-celju/03869";

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kern/", "1 SEX F",
    "1 BIRT", "2 DATE 3 MAR 1880", "2 SOUR @S1@", "3 PAGE 11", "2 OBJE @M1@",
    "0 @I2@ INDI", "1 NAME Blaž /Kern/", "1 SEX M",
    "1 BIRT", "2 DATE 7 JUL 1885", "2 SOUR @S1@", "3 PAGE 12",
    // Cited straight from the person, under no source: the unattached buckets.
    "1 OBJE @M3@", "1 OBJE @M4@",
    // A source under a repository, with two page images of its own.
    "0 @S1@ SOUR", "1 TITL Krstna knjiga - 03869", "1 REPO @R1@", "1 OBJE @M1@", "1 OBJE @M2@",
    "0 @R1@ REPO", "1 NAME Nadškofijski arhiv Maribor",
    "0 @M1@ OBJE", `1 FILE ${BOOK}/?pg=11`, "2 FORM htm",
    "0 @M2@ OBJE", `1 FILE ${BOOK}/?pg=12`, "2 FORM htm",
    "0 @M3@ OBJE", `1 FILE ${BOOK}/?pg=13`, "2 FORM htm", "1 TITL Nepripeta povezava",
    "0 @M4@ OBJE", "1 FILE grobovi/kern.jpg", "2 FORM jpg", "1 TITL Nepripeta slika",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("the sources tree nests its rows as lists, not list items inside list items", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  // The file names a local scan, so the app offers to connect a media folder.
  const later = page.getByRole("button", { name: "Later" });
  if (await later.count()) await later.click();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Sources", { exact: true }).click();

  // Every level on screen at once: whatever the tree unfolded by itself, this
  // opens the rest — the repository, its source with the page images beneath
  // it, and the two unattached buckets.
  await expect(page.locator(".tools-tree").first()).toBeVisible();
  await expect(async () => {
    const shut = page.locator('.tools-tree-row button.tools-pair-toggle[aria-expanded="false"]');
    while (await shut.count()) await shut.first().click();
    expect(await shut.count()).toBe(0);
  }).toPass({ timeout: 15000 });

  // The rows really did render: the source's two page images sit under it.
  const source = page
    .locator(".tools-tree-node")
    .filter({ has: page.getByTitle("TITL: Krstna knjiga - 03869") })
    .last();
  await expect(source.locator(".tools-tree-children .tools-tree-node")).toHaveCount(2);

  // The structure itself, and not only React's word for it: a production build
  // warns about nothing, so the check that has to survive is the DOM's. Every
  // list item's nearest list-ish ancestor must be a list.
  const misnested = await page.evaluate(() =>
    [...document.querySelectorAll("li")]
      .filter((li) => li.parentElement?.closest("ul,ol,li") instanceof HTMLLIElement)
      .map((li) => li.className || "<li>"),
  );
  expect(misnested).toEqual([]);
  expect(errors, `console errors:\n${errors.join("\n")}`).toEqual([]);
});
