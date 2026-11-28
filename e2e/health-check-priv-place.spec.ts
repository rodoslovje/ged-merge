import { test, expect } from "@playwright/test";

// Tools → Health check: `_PRIV` is the standard's RESN on a person, but on a
// note the version has nothing for it — the two are separate findings.
const GED = [
  "0 HEAD", "1 GEDC", "2 VERS 7.0",
  "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 _PRIV Y",
  "1 NOTE A private remark", "2 _PRIV Y",
  "0 @I2@ INDI", "1 NAME Jan /Kos/", "1 NOTE Another", "2 _PRIV Y",
  "0 TRLR", "",
].join("\n");

test("health check: _PRIV on a person and _PRIV on a note are two findings", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles({ name: "priv.ged", mimeType: "text/plain", buffer: Buffer.from(GED) });
  await page.locator(".edit-person").first().waitFor();

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Health check", { exact: true }).first().click();
  await page.getByRole("tab", { name: /GEDCOM .* compliance/ }).click();
  await expect(page.locator(".tools-issues").first()).toBeVisible();

  const rows = page.locator(".tools-issue", { hasText: "_PRIV" });
  await expect(rows).toHaveCount(2);
  await expect(rows.filter({ hasText: "_PRIV stands in for a structure GEDCOM 7.0 has of its own (1×)" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "Custom tag _PRIV (2×)" })).toHaveCount(1);
});
