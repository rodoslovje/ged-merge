import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// "+ Add source" confirmed while the page behind the link is still being read:
// the dialog closes at once, and the source is written when the page answers —
// exactly what waiting in the dialog would have written, on the person the
// dialog was opened for.
const FILE = path.join(tmpdir(), "source-lookup-late.ged");
const URL = "https://example.org/krstna-knjiga";

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Blaž /Kern/", "1 SEX M", "1 FAMC @F1@",
    "0 @I2@ INDI", "1 NAME Mira /Kern/", "1 SEX F", "1 FAMC @F1@",
    "0 @F1@ FAM", "1 CHIL @I1@", "1 CHIL @I2@",
    "0 TRLR",
  ].join("\n"),
);

test("an Add confirmed mid-lookup waits for the page and lands where it was opened", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
  });
  // The first relay holds its answer until the test releases it; the others
  // never answer.
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api.allorigins.win/**", async (route) => {
    await released;
    await route.fulfill({ contentType: "text/html", body: "<html><head><title>Krstna knjiga Preddvor</title></head></html>" });
  });
  await page.route(/corsproxy\.io|codetabs\.com|r\.jina\.ai/, (route) => route.abort());

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();
  const name = page.locator(".edit-name-input").first();
  await expect(name).toHaveValue("Blaž");

  await page.locator(".edit-name-chip-add", { hasText: "Add Source" }).first().click();
  const dialog = page.locator(".add-source-dialog");
  await dialog.locator(".add-source-textarea").fill(URL);
  // Still reading: the hint is not yet the green of a finished lookup.
  await expect(dialog.locator(".add-source-hint.is-fetching")).toBeVisible();
  await dialog.getByRole("button", { name: "Add source", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  // Nothing is written before the page has answered.
  await expect(page.locator(".source-ref")).toHaveCount(0);

  // Another person is on screen when the answer comes.
  await page.locator(".edit-sibling", { hasText: "Mira" }).click();
  await expect(name).toHaveValue("Mira");
  release();

  // The citation went to Blaž, titled from the page — not to Mira.
  await page.locator(".edit-sibling", { hasText: "Blaž" }).click();
  await expect(name).toHaveValue("Blaž");
  await expect(page.locator(".source-ref")).toHaveCount(1);
  await expect(page.locator(".source-ref").first()).toHaveAttribute("data-tip-heading", "Krstna knjiga Preddvor");
  await page.locator(".edit-sibling", { hasText: "Mira" }).click();
  await expect(name).toHaveValue("Mira");
  await expect(page.locator(".source-ref")).toHaveCount(0);
});
