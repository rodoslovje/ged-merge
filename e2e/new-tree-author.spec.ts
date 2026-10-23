import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";

// The reader's name from Settings is the author (SUBM) a new tree is written
// with — and it stays the file's own submitter through the save.
test("a new tree names the reader from Settings as its author", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ authorName: "Ana Novak" }));
  });
  await page.goto("/");
  await page.locator(".lb-sample-row").first().click(); // "Start a new tree"
  await expect(page.locator(".edit-empty-add")).toBeFocused();
  await page.keyboard.press("Enter"); // adds the first person
  await page.keyboard.type("Janez");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Kranjec");
  await page.keyboard.press("Tab");
  await expect(page.locator(".edit-name-row .start-chip")).toHaveText("Start Person");

  await page.keyboard.press("ControlOrMeta+s");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download GEDCOM/ }).click();
  const text = await readFile(await (await download).path(), "utf-8");
  expect(text).toMatch(/0 @U1@ SUBM\r?\n1 NAME Ana Novak\r?\n/);
  expect(text).toMatch(/1 SUBM @U1@/);
});
