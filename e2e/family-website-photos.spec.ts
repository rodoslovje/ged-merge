import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { tmpdir } from "./tmpdir";
import { zipEntries, zipEntryStream } from "../src/geo/zip";

// Tools → Family website with photos: the download is a ZIP of the page and
// the photos of the people it publishes — never a photo with a hidden person
// on it, even a group photo of the long dead with one living face.
const DIR = path.join(tmpdir(), "family-website-photos");
const MEDIA = path.join(DIR, "media");
const FILE = path.join(DIR, "photos.ged");
// A 1×1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

mkdirSync(MEDIA, { recursive: true });
writeFileSync(path.join(MEDIA, "franc.png"), PNG);
// The original's time, which the ZIP keeps (so rsync skips an unchanged photo).
const TAKEN = new Date(Date.UTC(2015, 2, 4, 10, 20, 30));
utimesSync(path.join(MEDIA, "franc.png"), TAKEN, TAKEN);
writeFileSync(path.join(MEDIA, "group.png"), PNG);
writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Franc /Zorman/", "1 SEX M",
  "1 BIRT", "2 DATE 1890", "1 DEAT", "2 DATE 1960",
  "1 OBJE", "2 FILE franc.png",
  "1 OBJE @O1@",
  "0 @I2@ INDI", "1 NAME Petra /Zorman/", "1 SEX F",
  "1 BIRT", "2 DATE 1990",
  "1 OBJE @O1@",
  "0 @O1@ OBJE", "1 FILE group.png",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("the family website with photos downloads as a ZIP that works from disk", async ({ page }) => {
  // The folder picker the test can drive: the <input webkitdirectory> one.
  await page.addInitScript(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.locator(".tools-tab", { hasText: "Family website" }).click();
  await page.getByLabel("Photos", { exact: true }).check();
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".tools-publish").getByRole("button", { name: "Choose folder" }).click();
  await (await chooser).setFiles(MEDIA);
  await expect(page.locator(".tools-publish")).toContainText("Photos: 1 · left out for a hidden person on them: 1");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download website (.zip)" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/\.zip$/);
  const zip = readFileSync((await file.path())!);
  const buffer = zip.buffer.slice(zip.byteOffset, zip.byteOffset + zip.byteLength);
  const entries = zipEntries(buffer);
  // A small page, its data, the viewer named by its content, its fonts as
  // files, the photos.
  const fonts = entries.filter((e) => e.name.startsWith("fonts/"));
  expect(fonts.length).toBeGreaterThan(0);
  expect(entries.filter((e) => !fonts.includes(e)).map((e) => e.name.replace(/\/o[0-9a-z]+\./, "/ID.").replace(/-[0-9a-f]{8}\./, "-H."))).toEqual([
    "index.html", "data.js", "viewer-H.js", "viewer-H.css", "photos/ID.png",
  ]);
  expect(entries[0].uncompressedSize).toBeLessThan(10_000);
  // The extended-timestamp field, just before the photo's data.
  const photo = entries.find((e) => e.name.startsWith("photos/"))!;
  expect(new DataView(buffer).getUint32(photo.dataStart - 4, true)).toBe(TAKEN.getTime() / 1000);

  // Unpacked, as a relative would.
  const site = path.join(DIR, "site");
  mkdirSync(path.join(site, "photos"), { recursive: true });
  mkdirSync(path.join(site, "fonts"), { recursive: true });
  for (const e of entries) {
    writeFileSync(path.join(site, e.name), new Uint8Array(await new Response(zipEntryStream(buffer, e)).arrayBuffer()));
  }
  await page.goto(pathToFileURL(path.join(site, "index.html")).href);
  // Franc's face on the front page opens his page, with his photo.
  await page.getByRole("listitem", { name: "Franc Zorman" }).click();
  await expect(page.locator(".site-person-name")).toContainText("Franc");
  await expect(page.locator(".site-person img")).toHaveCount(1);
});
