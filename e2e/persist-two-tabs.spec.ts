import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { enablePersist, waitForCache } from "./persist-util";
import { tmpdir } from "./tmpdir";

const MAIN = path.join(tmpdir(), `persist-tabs-main-${process.pid}.ged`);
writeFileSync(MAIN, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1 JAN 1900",
  "0 TRLR", "",
].join("\n"), "utf-8");
const OTHER = path.join(tmpdir(), `persist-tabs-other-${process.pid}.ged`);
writeFileSync(OTHER, [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Kos/", "1 SEX F",
  "0 TRLR", "",
].join("\n"), "utf-8");

// The cache holds one workspace. Two tabs used to write to it in turn — one
// tab's session beside the other's edited file — and a reload restored a
// mixture. The first tab now owns the cache; a second one works uncached.
test("a second tab leaves the first tab's cached workspace alone", async ({ context, page }) => {
  await enablePersist(page);
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(MAIN);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  const given = page.locator(".edit-name-input").first();
  await given.fill("Janez TEST");
  await page.locator(".edit-name-input").nth(1).click(); // blur to commit
  await waitForCache(page, { mainContains: "Janez TEST" });

  // The second tab says so, restores nothing, and caches nothing of its own.
  const second = await context.newPage();
  await enablePersist(second);
  await second.goto("/");
  await expect(second.locator(".save-toast")).toContainText("open in another tab");
  await expect(second.locator(".edit-person")).toHaveCount(0);
  await second.locator("input.file-input").first().setInputFiles(OTHER);
  await second.getByRole("button", { name: "Edit", exact: true }).click();
  await second.locator(".edit-person").waitFor();
  await second.locator(".edit-name-input").first().fill("Ana TEST");
  await second.locator(".edit-name-input").nth(1).click();
  await expect(second.locator(".edit-name-input").first()).toHaveValue("Ana TEST");
  await second.close();

  // The first tab's reload restores its own work.
  await page.reload();
  await page.locator(".edit-person").waitFor();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez TEST", { timeout: 15000 });
});
