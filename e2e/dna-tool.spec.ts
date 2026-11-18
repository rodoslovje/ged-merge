import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Tools → DNA: the direct lines with their earliest known ancestor, and the
 * ancestral surnames downloaded as FamilyTreeDNA's Surname/Location CSV.
 * The maternal grandmother is known only as "Neža", so her mother — fully
 * named — stands as the maternal line's earliest known ancestor.
 */
const GED = `0 HEAD
1 GEDC
2 VERS 5.5.1
2 FORM LINEAGE-LINKED
1 CHAR UTF-8
0 @I1@ INDI
1 NAME Janez /Novak/
1 SEX M
1 BIRT
2 DATE 1950
1 FAMC @F1@
0 @I2@ INDI
1 NAME Anton /Novak/
1 SEX M
1 BIRT
2 DATE 1920
2 PLAC Šentvid, Ljubljana, Slovenija
1 FAMC @F2@
1 FAMS @F1@
0 @I3@ INDI
1 NAME Marija /Oblak/
1 SEX F
1 BIRT
2 DATE 1922
2 PLAC Kranj, Slovenija
1 FAMC @F3@
1 FAMS @F1@
0 @I4@ INDI
1 NAME Jožef /Novak/
1 SEX M
1 BIRT
2 DATE 1890
2 PLAC Šentvid, Ljubljana, Slovenija
1 FAMS @F2@
0 @I5@ INDI
1 NAME Neža //
1 SEX F
1 FAMC @F4@
1 FAMS @F3@
0 @I6@ INDI
1 NAME Uršula /Kos/
1 SEX F
1 BIRT
2 DATE 1860
2 PLAC Bled, Slovenija
1 FAMS @F4@
0 @F1@ FAM
1 HUSB @I2@
1 WIFE @I3@
1 CHIL @I1@
0 @F2@ FAM
1 HUSB @I4@
1 CHIL @I2@
0 @F3@ FAM
1 WIFE @I5@
1 CHIL @I3@
0 @F4@ FAM
1 WIFE @I6@
1 CHIL @I5@
0 TRLR
`;

test("DNA tool: earliest known ancestors and the FamilyTreeDNA surname CSV", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles({ name: "dna.ged", mimeType: "text/plain", buffer: Buffer.from(GED) });
  await expect(page.locator(".edit-person").first()).toBeVisible();
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("DNA", { exact: true }).first().click();

  const [paternal, maternal] = [page.locator(".tools-dna-line").nth(0), page.locator(".tools-dna-line").nth(1)];
  await expect(paternal.locator(".tools-dna-steps li")).toHaveCount(2);
  await expect(paternal.locator(".tools-dna-field-value").nth(0)).toHaveText("Jožef");
  await expect(maternal.locator(".tools-dna-steps li")).toHaveCount(3);
  await expect(maternal.locator(".tools-dna-field-value").nth(1)).toHaveText("Kos");
  await expect(maternal.locator(".tools-dna-field-value").nth(5)).toHaveText("Uršula Kos, b. 1860, Bled, Slovenija");

  // Picking Marija in the list makes her the maternal line's ancestor instead.
  await maternal.locator(".tools-dna-steps li").first().locator("input[type=radio]").check();
  await expect(maternal.locator(".tools-dna-field-value").nth(1)).toHaveText("Oblak");

  // Untick one surname row; the download carries the rest.
  await expect(page.locator(".tools-dna-table tbody tr")).toHaveCount(3);
  await page.locator(".tools-dna-table tbody tr", { hasText: "Kos" }).locator("input[type=checkbox]").uncheck();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download CSV for FamilyTreeDNA" }).click();
  const csv = readFileSync(await (await download).path(), "utf8");
  expect(csv).toBe("Surname,Location\r\nNovak,\"Šentvid, Slovenija\"\r\nOblak,\"Kranj, Slovenija\"\r\n");
});
