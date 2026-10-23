import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

/** One person whose file writes dates the standard way (`5 MAR 1850`). */
function writeFixture(): string {
  const ged = [
    "0 HEAD",
    "1 GEDC",
    "2 VERS 5.5.1",
    "0 @I1@ INDI",
    "1 NAME Janez /Novak/",
    "1 SEX M",
    "1 BIRT",
    "2 DATE 5 MAR 1850",
    "1 DEAT",
    "2 DATE 7 JUN 1910",
    "0 TRLR",
    "",
  ].join("\n");
  const filePath = path.join(tmpdir(), `date-entry-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

test("a typed date reads back in words and is written in the file's style", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const birth = page.locator(".edit-event").first().locator(".edit-event-date");
  const preview = page.locator(".edit-date-preview");

  // Local words and Slovenian spacing are read, and the preview says how.
  await birth.fill("okoli 5. 3. 1850");
  await expect(preview).toContainText("about 5 March 1850");
  await expect(preview).toContainText("saved as ABT 5 MAR 1850");
  await birth.press("Tab");
  await expect(birth).toHaveValue("ABT 5 MAR 1850");
  await expect(birth).toHaveClass(/is-approx/);
  await expect(preview).toHaveCount(0);

  // A numeric date whose day and month could swap offers the other reading.
  const death = page.locator(".edit-event").nth(1).locator(".edit-event-date");
  await death.fill("6.7.1910");
  await expect(preview).toContainText("6 July 1910");
  await preview.getByRole("button", { name: "or 7 June 1910" }).click();
  await expect(death).toHaveValue("7 JUN 1910");
  await expect(death).toBeFocused();

  // Text that is not a date is kept as typed, with a warning while typing.
  await death.fill("pred vojno");
  await expect(preview).toHaveClass(/is-unreadable/);
  await death.press("Tab");
  await expect(death).toHaveValue("pred vojno");
});

test("a time typed after the date is saved as the DATE's TIME", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const birth = page.locator(".edit-event").first().locator(".edit-event-date");
  await birth.fill("5. 3. 1850 9:05");
  await expect(page.locator(".edit-date-preview")).toContainText("5 March 1850 09:05");
  await birth.press("Tab");
  await expect(birth).toHaveValue("5 MAR 1850 09:05");

  await page.locator(".app-head-actions .export-btn").click();
  const downloadPromise = page.waitForEvent("download", (d) => d.suggestedFilename().endsWith(".ged"));
  await page.locator(".preview-actions .export-btn").click();
  const content = readFileSync((await (await downloadPromise).path())!, "utf-8");
  expect(content).toMatch(/2 DATE 5 MAR 1850\r?\n3 TIME 09:05/);
});

test("a date field's hover says how the date reads", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const birth = page.locator(".edit-event").first().locator(".edit-event-date");
  await expect(birth).toHaveAttribute("title", "Birth date\n5 March 1850");
  await birth.fill("CAL 1850");
  await expect(birth).toHaveAttribute("title", "Birth date\nabout 1850 (calculated)");
});

test("with a date display chosen, a date field shows it until it is edited", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gedmerge.settings", JSON.stringify({ dateDisplay: "DD.MM.YYYY" })));
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const birth = page.locator(".edit-event").first().locator(".edit-event-date");
  await expect(birth).toHaveValue("05.03.1850");
  // The hover carries the file's own text beside the words.
  await expect(birth).toHaveAttribute("title", "Birth date\n5 March 1850\n5 MAR 1850");
  await birth.click();
  await expect(birth).toHaveValue("5 MAR 1850");
});

test("with dates in words, a date field reads in words until it is edited", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("gedmerge.settings", JSON.stringify({ dateDisplay: "words" })));
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const birth = page.locator(".edit-event").first().locator(".edit-event-date");
  await expect(birth).toHaveValue("5 March 1850");
  await birth.click();
  await expect(birth).toHaveValue("5 MAR 1850");
  await birth.fill("~1850");
  await birth.press("Tab");
  await expect(birth).toHaveValue("about 1850");
  await birth.click();
  await expect(birth).toHaveValue("ABT 1850");
});
