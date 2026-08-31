import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** A baptism to name a godparent at, and somebody to name. */
function writeFixture(): string {
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 7.0",
    "1 CHAR UTF-8",
    "0 @I1@ INDI",
    "1 NAME Janez /Renko/",
    "1 SEX M",
    "1 BIRT",
    "2 DATE 31 AUG 1958",
    "1 BAPM",
    "2 DATE 31 AUG 1958",
    "0 @I2@ INDI",
    "1 NAME Jozefa /Pezdirc/",
    "1 SEX F",
    "1 BIRT",
    "2 DATE 1900",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `event-assoc-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("edit mode: an event's + Add menu records a godparent on that event", async ({ page }) => {
  const fixture = writeFixture();
  await page.goto("/");

  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // The baptism row's own "+ Add" menu.
  const bapm = page.locator(".edit-event").filter({ hasText: "Baptism" }).first();
  await bapm.locator(".edit-event-addfield").click();
  await page.getByRole("option", { name: "Association" }).click();

  // The person picker opens on that row — this is what did nothing before.
  const picker = bapm.locator(".relative-picker-input");
  await expect(picker).toBeVisible();

  await picker.fill("Jozefa");
  await bapm.getByRole("button", { name: /Jozefa/ }).first().click();

  // Then the role, defaulting to godparent.
  await bapm.getByRole("button", { name: "Save" }).click();

  // The associate now sits on the baptism row.
  await expect(bapm.locator(".edit-event-assoc")).toHaveCount(1);
  await expect(bapm.locator(".edit-event-assoc")).toContainText("Jozefa");
});

test("the picker survives the mousedown that opened it", async ({ page }) => {
  // The "+ Add" menu selects on mousedown, and that same mousedown was still
  // travelling to the document when the picker registered its outside-click
  // dismissal — so the picker opened and closed within one event and the row
  // looked inert. It must still be there a moment later.
  const fixture = writeFixture();
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(fixture);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const birth = page.locator(".edit-event").filter({ hasText: "Birth" }).first();
  await birth.locator(".edit-event-addfield").click();
  await page.locator(".dd-menu [role=option]", { hasText: "Association" }).click();
  await expect(birth.locator(".relative-picker-input")).toBeVisible();
  await expect(birth.locator(".relative-picker-input")).toBeVisible(); // still there a tick later
});
