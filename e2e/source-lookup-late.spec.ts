import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// "+ Add source" confirmed while the page behind the link is still being read:
// the source is written at once, and the page's title fills it when it comes.
const FILE = path.join(tmpdir(), "source-lookup-late.ged");
const URL = "https://example.org/krstna-knjiga";

writeFileSync(
  FILE,
  ["0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8", "0 @I1@ INDI", "1 NAME Blaž /Kern/", "1 SEX M", "0 TRLR"].join("\n"),
);

test("a page title that answers after the Add still fills the source", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
  });
  // The first relay holds its answer until the Add has gone through; the
  // others never answer.
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

  await page.locator(".edit-name-chip-add", { hasText: "Add Source" }).first().click();
  const dialog = page.locator(".add-source-dialog");
  await dialog.locator(".add-source-textarea").fill(URL);
  // Still reading: the hint is not yet the green of a finished lookup.
  await expect(dialog.locator(".add-source-hint.is-fetching")).toBeVisible();
  await dialog.getByRole("button", { name: "Add source", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".source-ref")).toHaveCount(1);

  release();
  await expect(page.locator(".source-ref").first()).toHaveAttribute("data-tip-heading", "Krstna knjiga Preddvor");
});
