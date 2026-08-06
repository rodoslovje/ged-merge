import { test, expect } from "@playwright/test";

// A file whose media lives on disk: enough to trigger the offer to connect a
// media folder, without needing the files themselves.
const GED = [
  "0 HEAD",
  "1 SOUR Test",
  "1 GEDC",
  "2 VERS 5.5.1",
  "2 FORM LINEAGE-LINKED",
  "1 CHAR UTF-8",
  "0 @I1@ INDI",
  "1 NAME John /Doe/",
  "1 OBJE @O1@",
  "0 @O1@ OBJE",
  "1 FILE photos/john.jpg",
  "1 FORM jpg",
  "0 TRLR",
  "",
].join("\n");

const upload = { name: "media.ged", mimeType: "text/plain", buffer: Buffer.from(GED, "utf-8") };

// The offer used to be two buttons plus a "never" tick, which silenced the
// dialog even when you had just said yes. It is now three plain answers.
test("the media-folder offer gives three answers and honours the never one", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(upload);

  const dialog = page.locator(".confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Select Folder" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Later" })).toBeVisible();
  await expect(dialog.locator("input[type=checkbox]")).toHaveCount(0);

  // "Later" leaves the offer standing for the next load…
  await dialog.getByRole("button", { name: "Later" }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.locator("input.file-input").first().setInputFiles(upload);
  await expect(dialog).toBeVisible();

  // …"Never ask again" retires it for good.
  await dialog.getByRole("button", { name: "Never ask again" }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.locator("input.file-input").first().setInputFiles(upload);
  // The Tools tab only appears once the main file is loaded, so waiting for it
  // proves the parse finished and the offer genuinely stayed away.
  await expect(page.getByRole("button", { name: "Tools", exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
});
