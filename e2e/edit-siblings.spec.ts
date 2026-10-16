import { test, expect } from "@playwright/test";

// Ana (I1) is the middle child of Janez × Marija; Janez later had Lojze with Neža.
const GED = [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  "0 @I1@ INDI", "1 NAME Ana /Novak/", "1 SEX F", "1 BIRT", "2 DATE 1875", "1 FAMC @F1@",
  "0 @I2@ INDI", "1 NAME Janez /Novak/", "1 SEX M", "1 FAMS @F1@", "1 FAMS @F2@",
  "0 @I3@ INDI", "1 NAME Marija /Novak/", "1 SEX F", "1 FAMS @F1@",
  "0 @I4@ INDI", "1 NAME Ivan /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1870", "1 FAMC @F1@",
  "0 @I5@ INDI", "1 NAME Mira /Novak/", "1 SEX F", "1 BIRT", "2 DATE 1880", "1 FAMC @F1@",
  "0 @I6@ INDI", "1 NAME Lojze /Novak/", "1 SEX M", "1 BIRT", "2 DATE 1900", "1 FAMC @F2@",
  "0 @I7@ INDI", "1 NAME Neza /Zupan/", "1 SEX F", "1 FAMS @F2@",
  "0 @F1@ FAM", "1 HUSB @I2@", "1 WIFE @I3@", "1 CHIL @I5@", "1 CHIL @I1@", "1 CHIL @I4@",
  "0 @F2@ FAM", "1 HUSB @I2@", "1 WIFE @I7@", "1 CHIL @I6@",
  "0 TRLR", "",
].join("\n");

test("Edit shows the siblings under the parents and opens one with a click", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first()
    .setInputFiles({ name: "siblings.ged", mimeType: "text/plain", buffer: Buffer.from(GED, "utf-8") });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  // Edit opens on the file's first person, Ana.
  const row = page.locator(".edit-sibling-row");
  await expect(page.locator(".edit-sibling.self")).toContainText("Ana");

  // Birth order, Ana marked in her place, then the father's other family.
  await expect(row.locator(".edit-sibling .person-name")).toHaveText(["Ivan Novak", "Ana Novak", "Mira Novak", "Lojze Novak½"]);
  await expect(row.locator(".edit-sibling-group")).toHaveText("Father's other family");
  await expect(row.locator(".edit-sibling.half")).toHaveAttribute("title", /Half-brother · other parent: Neza Zupan/);

  await row.locator(".edit-sibling", { hasText: "Mira" }).click();
  await expect(page.locator(".edit-sibling.self")).toContainText("Mira");
});
