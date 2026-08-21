import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Setting a house aside is remembered across reloads — and so is putting it
// back. The restore used to hold only for the session: the write stored the
// set-aside houses but never forgot the restored ones, so the next reload read
// the old judgement back and hid the row again.
const uid = `${process.pid}`;
const FILE = path.join(tmpdir(), `geocode-hide-restore-${uid}.ged`);

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Črni vrh 35",
    "1 RESI", "2 PLAC Črni vrh 46",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

/** Load the file and open Tools → Places → Geocoding, on a fresh page. */
async function openAddresses(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  // Places and addresses are two tabs of the geocoding page.
  await page.locator(".tools-geo-tabs [role=tab]", { hasText: "Addresses" }).click();
  // The houses live under their settlement, which starts collapsed.
  const group = page.locator(".tools-geo-addr-group").filter({ hasText: "Črni vrh" }).first();
  await expect(group).toBeVisible();
  if (!(await group.locator(".tools-geo-addr-row").count())) {
    await group.locator(".tools-tree-label").first().click();
  }
  return group.locator(".tools-geo-addr-row");
}

const writeBtn = (page: Page) => page.getByRole("button", { name: /Write coordinates/ });
/** The "Show hidden ⟨n⟩" tick, which is only offered while something is set aside. */
const showHidden = (page: Page) => page.locator("label.tools-reshape-site", { hasText: "Show hidden" });

test("a house set aside stays hidden across a reload, and a restored one comes back", async ({ page }) => {
  let rows = await openAddresses(page);
  await expect(rows).toHaveCount(2);

  // Set the first house aside and write that judgement.
  await rows.first().getByRole("button", { name: "Hide", exact: true }).click();
  await writeBtn(page).click();
  await expect(rows).toHaveCount(1);
  await expect(page.locator(".tools-applied-note")).toBeVisible(); // the write landed

  // A reload reads the judgement back: one house on the list, one set aside.
  rows = await openAddresses(page);
  await expect(rows).toHaveCount(1);
  await expect(showHidden(page)).toBeVisible();

  // Put it back on the list and write again.
  await showHidden(page).locator("input").check();
  await expect(rows).toHaveCount(2);
  await rows.first().getByRole("button", { name: "Restore", exact: true }).click();
  await writeBtn(page).click();
  // The write has landed once it says so — no coordinate was picked, so it is
  // the "nothing to change" note. (The tick stays on screen: it is still
  // ticked, and unticking it is how the reader puts the filter back.)
  await expect(page.locator(".tools-applied-note")).toBeVisible();

  // The restore survives the reload — the row is listed, and nothing is hidden.
  rows = await openAddresses(page);
  await expect(rows).toHaveCount(2);
  await expect(showHidden(page)).toHaveCount(0);
});
