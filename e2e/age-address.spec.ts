import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// The age a record states (`2 AGE 62y`) is an Age field on the event row, typed
// loosely and written in the file's grammar; the address opens into its
// labelled lines (`3 CITY`, `3 POST`) under the one-line ADDR, which keeps its
// text. Both are saved.

function fixture(): string {
  const file = path.join(tmpdir(), `age-address-${Date.now()}.ged`);
  writeFileSync(file, [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Anton /Renka/", "1 SEX M",
    "1 RESI", "2 DATE 1880", "2 ADDR Dunajska 5",
    "1 DEAT", "2 DATE 1890",
    "0 TRLR", "",
  ].join("\n"), "utf-8");
  return file;
}

/** The event row whose label reads `label`. */
function eventRow(page: Page, label: string): Locator {
  return page.locator(".edit-person .edit-event").filter({ has: page.locator(".edit-event-type-row", { hasText: label }) }).first();
}

async function saveContent(page: Page): Promise<string> {
  const saveBtn = page.locator(".app-head-actions .export-btn");
  await expect(saveBtn).toBeEnabled();
  await saveBtn.click();
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  return readFileSync((await (await downloadPromise).path())!, "utf-8");
}

test("an age and a structured address are edited and saved", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(fixture());
  await expect(page.locator(".edit-person .edit-name-input").first()).toHaveValue("Anton");

  // The death's age, from the row's "+ Add" menu.
  const death = eventRow(page, "Death");
  await death.locator(".edit-event-type-row").hover();
  await death.locator(".edit-event-addfield").click();
  await page.locator('.dd-menu .dd-item[data-value="age"]').click();
  const age = death.locator("input.edit-event-age-input");
  await expect(age).toBeFocused();
  await age.fill("62");
  await age.press("Tab");
  // Shown back as GEDCOM writes it.
  await expect(age).toHaveValue("62y");

  // The residence's one-line address opens into its labelled lines.
  const resi = eventRow(page, "Residence");
  await expect(resi.locator("input.edit-event-addr")).toHaveValue("Dunajska 5");
  await resi.locator(".edit-addr-toggle").click();
  const city = resi.locator('input[data-addr-part="CITY"]');
  await city.fill("Ljubljana");
  await city.press("Tab");
  await expect(resi.locator('input[data-addr-part="CITY"]')).toHaveValue("Ljubljana");
  const post = resi.locator('input[data-addr-part="POST"]');
  await post.fill("1000");
  await post.press("Tab");
  await expect(resi.locator('input[data-addr-part="POST"]')).toHaveValue("1000");

  const saved = await saveContent(page);
  expect(saved).toMatch(/1 DEAT\r?\n2 DATE 1890\r?\n2 AGE 62y\r?\n/);
  expect(saved).toMatch(/2 ADDR Dunajska 5\r?\n3 CITY Ljubljana\r?\n3 POST 1000\r?\n/);
});
