import { test, expect, type Page } from "@playwright/test";

/**
 * A save can be written straight to disk where the browser has the File System
 * Access API: into a folder the reader picks, or over the file they opened.
 * The native pickers cannot be driven from a test, so both are replaced with
 * ones that answer from the browser's private file system — real handles, with
 * real writes behind them.
 */
const GED = [
  "0 HEAD",
  "1 GEDC",
  "2 VERS 5.5.1",
  "1 CHAR UTF-8",
  "0 @I1@ INDI",
  "1 NAME Frances /Novak/",
  "1 SEX F",
  "0 TRLR",
  "",
].join("\n");

async function openWithPickers(page: Page, settings: object) {
  await page.addInitScript(({ ged, settings }) => {
    localStorage.setItem("gedmerge.settings", JSON.stringify(settings));
    const w = window as unknown as Record<string, unknown>;
    w.showOpenFilePicker = async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle("Novak.ged", { create: true });
      const writable = await handle.createWritable();
      await writable.write(ged);
      await writable.close();
      return [handle];
    };
    w.showDirectoryPicker = async () =>
      (await navigator.storage.getDirectory()).getDirectoryHandle("saves", { create: true });
  }, { ged: GED, settings });
  await page.goto("/");
  await page.locator(".lb-drop").click();
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  await page.getByRole("button", { name: "+ Add Note" }).first().click();
  const note = page.locator(".edit-note-chip [contenteditable]").first();
  await note.fill("Buried at Holy Hope Cemetery");
  await note.blur();
  await page.locator(".app-head-actions .export-btn").click();
}

/** The files in a folder of the private file system, name → text. */
function listing(page: Page, folder?: string) {
  return page.evaluate(async (folder) => {
    const root = await navigator.storage.getDirectory();
    const dir = folder ? await root.getDirectoryHandle(folder, { create: true }) : root;
    const out: Record<string, string> = {};
    for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
      if (h.kind === "file") out[name] = await (await (h as FileSystemFileHandle).getFile()).text();
    }
    return out;
  }, folder);
}

test("a save into a folder writes the dated GEDCOM and its report there", async ({ page }) => {
  await openWithPickers(page, { saveReport: true });
  let downloads = 0;
  page.on("download", () => downloads++);

  await page.getByRole("tab", { name: "A folder" }).click();
  await page.locator(".preview-actions .export-btn", { hasText: "Save GEDCOM" }).click();
  await expect(page.getByText("Saved to the folder “saves”.")).toBeVisible();

  const files = await listing(page, "saves");
  const names = Object.keys(files).sort();
  expect(names).toHaveLength(2);
  expect(names[0]).toMatch(/^Novak\.\d{4}-\d{2}-\d{2}\.gedmerge\.ged$/);
  expect(names[1]).toMatch(/^Novak\.\d{4}-\d{2}-\d{2}\.gedmerge\.report\.txt$/);
  expect(files[names[0]]).toContain("Buried at Holy Hope Cemetery");
  expect(files[names[1]]).toContain(names[0]);
  // The opened file is left as it was, and nothing went to Downloads.
  expect((await listing(page))["Novak.ged"]).toBe(GED);
  expect(downloads).toBe(0);
});

test("a save over the opened file replaces it", async ({ page }) => {
  await openWithPickers(page, { saveDestination: "file" });

  await expect(page.locator(".preview-files li code")).toHaveText(["Novak.ged"]);
  await page.locator(".preview-actions .export-btn", { hasText: "Save GEDCOM" }).click();
  await expect(page.getByText("Saved — Novak.ged was overwritten.")).toBeVisible();

  const files = await listing(page);
  expect(Object.keys(files)).toEqual(["Novak.ged"]);
  expect(files["Novak.ged"]).toContain("Buried at Holy Hope Cemetery");
});
