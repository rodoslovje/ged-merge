import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

const URL = "https://example.com/register-page";

/** One person whose birth carries a plain link chip (🔗, opens Edit Source). */
function writeFixture(): string {
  const ged = ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1 JAN 1900", `2 WWW ${URL}`, "0 TRLR", ""].join("\n");
  const filePath = path.join(tmpdir(), `icon-tip-${Date.now()}.ged`);
  writeFileSync(filePath, ged, "utf-8");
  return filePath;
}

async function openEdit(page: Page) {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(writeFixture());
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
}

test("a link chip's tooltip shows on hover, without the native title", async ({ page }) => {
  await openEdit(page);
  const chip = page.locator("button.edit-link-icon").first();
  await expect(chip).not.toHaveAttribute("title", /.*/);
  await chip.hover();
  const tip = page.locator(".icon-tip");
  await expect(tip).toBeVisible();
  await expect(tip).toContainText(URL);
  // Hover tips carry no actions — the ↗ beside the chip opens the link.
  await expect(tip.locator(".icon-tip-actions")).toHaveCount(0);
  await page.mouse.move(0, 0);
  await expect(tip).toHaveCount(0);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("the first tap shows the tooltip with its actions, Edit then opens the dialog", async ({ page }) => {
    await openEdit(page);
    const chip = page.locator("button.edit-link-icon").first();
    await chip.tap();
    const tip = page.locator(".icon-tip");
    await expect(tip).toContainText(URL);
    await expect(page.locator(".add-source-dialog")).toHaveCount(0);
    await expect(tip.getByRole("link", { name: /Open link/ })).toHaveAttribute("href", URL);

    await tip.getByRole("button", { name: "Edit", exact: true }).tap();
    await expect(page.locator(".add-source-dialog").getByLabel("URL")).toHaveValue(URL);
    await expect(tip).toHaveCount(0);
  });

  test("a second tap on the chip acts, a tap elsewhere just closes the tip", async ({ page }) => {
    await openEdit(page);
    const chip = page.locator("button.edit-link-icon").first();
    await chip.tap();
    await expect(page.locator(".icon-tip")).toBeVisible();
    await page.locator(".edit-person").tap({ position: { x: 5, y: 5 } });
    await expect(page.locator(".icon-tip")).toHaveCount(0);

    await chip.tap();
    await expect(page.locator(".icon-tip")).toBeVisible();
    await chip.tap();
    await expect(page.locator(".add-source-dialog").getByLabel("URL")).toHaveValue(URL);
  });
});
