import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { crc32, deflateSync } from "zlib";
import { tmpdir } from "./tmpdir";

// A group photo in Edit, where no face is found: a rectangle drawn on it is
// named as anyone in the file, shows at once, and its ✕ removes it again.
const DIR = path.join(tmpdir(), "photo-mark-person");
const MEDIA = path.join(DIR, "media");
const FILE = path.join(DIR, "group.ged");

/** A plain grey PNG — nothing a face finder would take for a head. */
function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(width, 0);
  head.writeUInt32BE(height, 4);
  head.set([8, 0, 0, 0, 0], 8); // 8-bit greyscale
  const rows = Buffer.alloc((width + 1) * height, 0x80);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0; // filter: none
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

mkdirSync(MEDIA, { recursive: true });
writeFileSync(path.join(MEDIA, "group.png"), png(400, 300));
writeFileSync(FILE, [
  "0 HEAD", "1 GEDC", "2 VERS 7.0",
  "0 @I1@ INDI", "1 NAME Franc /Zorman/", "1 SEX M", "1 FAMS @F1@",
  "1 OBJE @O1@",
  "0 @I2@ INDI", "1 NAME Petra /Zorman/", "1 SEX F", "1 FAMS @F1@",
  "0 @F1@ FAM", "1 HUSB @I1@", "1 WIFE @I2@",
  "0 @O1@ OBJE", "1 FILE group.png", "2 FORM image/png",
  "0 TRLR", "",
].join("\n"), "utf-8");

test("a rectangle drawn on a group photo is named as another person, and its ✕ removes it", async ({ page }) => {
  // The folder picker the test can drive: the <input webkitdirectory> one.
  await page.addInitScript(() => {
    delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
  });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor();

  const chooser = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Select Folder" }).click();
  await (await chooser).setFiles(MEDIA);

  await page.locator(".person-media-btn").first().click();
  const photo = page.locator(".person-media-cropwrap");
  await expect(photo.locator("img")).toBeVisible();

  await page.getByRole("button", { name: "Mark a person" }).click();
  const box = (await photo.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.6, { steps: 4 });
  await page.mouse.up();

  // The rectangle is not saved for the photo's own person: it asks who it is.
  const namer = page.locator(".photo-face-namer");
  await expect(namer).toBeVisible();
  await namer.getByText("Petra Zorman").click();

  // The mouse never left the photo, and the new region shows.
  const marked = photo.locator(".photo-crop-box", { hasText: "Petra Zorman" });
  await expect(marked).toBeVisible();

  await marked.locator(".photo-crop-remove").click();
  await expect(photo.locator(".photo-crop-box")).toHaveCount(0);
});
