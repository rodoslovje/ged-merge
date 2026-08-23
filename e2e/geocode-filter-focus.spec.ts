import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// An editor open on a row the filter hides comes back when the filter is
// cleared — and must come back quietly. It used to focus itself as it appeared,
// so the last Backspace of a filter being deleted threw the caret into some
// unrelated address's rename field, and the next keystrokes went there.

const FILE = path.join(tmpdir(), "geocode-filter-focus.ged");

const lines: string[] = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8"];
let n = 0;
for (const place of ["Kompolje, Dobrepolje, Slovenia", "Zlato polje, Kranj, Slovenia"]) {
  const [settlement, ...rest] = place.split(", ");
  for (let house = 1; house <= 3; house++) {
    n++;
    lines.push(`0 @I${n}@ INDI`, `1 NAME Oseba${n} /Kos/`);
    lines.push("1 BIRT", `2 PLAC ${settlement} ${house}, ${rest.join(", ")}`);
    lines.push("1 DEAT", `2 PLAC ${place}`);
  }
}
lines.push("0 TRLR", "");
writeFileSync(FILE, lines.join("\n"), "utf-8");

test("a rename editor brought back by a cleared filter does not take the keyboard", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 30000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();

  // Open the rename ✎ on a house of Kompolje — the click does focus the field.
  const kompolje = page.locator(".tools-geo-addr-group").filter({ hasText: "Kompolje" }).first();
  await kompolje.locator("button.tools-pair-toggle").first().click();
  await kompolje.locator("button.tools-place-edit-btn").first().click();
  const renameField = page.locator("input.tools-place-rename-input");
  await expect(renameField).toBeFocused();

  // Filter the whole group away, leaving the editor open behind the filter.
  const box = page.locator(".tools-geocode .tools-search-input").first();
  await box.click();
  await box.fill("zlato");
  await expect(renameField).toHaveCount(0);
  await expect(box).toBeFocused();

  // Delete the filter one character at a time: the row — and its editor — come
  // back on the keystroke that empties the box, and the caret stays put.
  for (let i = 0; i < 5; i++) await page.keyboard.press("Backspace");
  await expect(box).toHaveValue("");
  await expect(renameField).toHaveCount(1);
  await expect(box).toBeFocused();
});
