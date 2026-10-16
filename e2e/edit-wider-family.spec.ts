import { test, expect } from "@playwright/test";

const indi = (id: string, name: string, sex: string, born: number, links: string[]) =>
  [`0 @${id}@ INDI`, `1 NAME ${name}`, `1 SEX ${sex}`, "1 BIRT", `2 DATE ${born}`, ...links];

// Rok (the file's first person, so Edit opens on him): parents Franc × Mojca,
// grandparents Gregor × Gala, Franc's brother Urban (married to Urša, son Cene).
const GED = [
  "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
  ...indi("R", "Rok /Novak/", "M", 1900, ["1 FAMC @F0@"]),
  ...indi("F", "Franc /Novak/", "M", 1870, ["1 FAMC @F1@", "1 FAMS @F0@"]),
  ...indi("M", "Mojca /Kos/", "F", 1875, ["1 FAMS @F0@"]),
  ...indi("GF", "Gregor /Novak/", "M", 1840, ["1 FAMS @F1@"]),
  ...indi("GM", "Gala /Novak/", "F", 1845, ["1 FAMS @F1@"]),
  ...indi("U", "Urban /Novak/", "M", 1872, ["1 FAMC @F1@", "1 FAMS @F3@"]),
  ...indi("UW", "Urša /Lah/", "F", 1874, ["1 FAMS @F3@"]),
  ...indi("C", "Cene /Novak/", "M", 1898, ["1 FAMC @F3@"]),
  "0 @F0@ FAM", "1 HUSB @F@", "1 WIFE @M@", "1 CHIL @R@",
  "0 @F1@ FAM", "1 HUSB @GF@", "1 WIFE @GM@", "1 CHIL @F@", "1 CHIL @U@",
  "0 @F3@ FAM", "1 HUSB @U@", "1 WIFE @UW@", "1 CHIL @C@",
  "0 TRLR", "",
].join("\n");

test("the Wider family panel lists relatives, reaches further and opens one", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first()
    .setInputFiles({ name: "wider.ged", mimeType: "text/plain", buffer: Buffer.from(GED, "utf-8") });
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.locator(".edit-person").waitFor();

  const panel = page.locator(".edit-wider");
  const names = panel.locator(".edit-wider-person-name");
  // The defaults: grandparents, then the father's brother.
  await expect(names).toHaveText(["Gregor Novak", "Gala Novak", "Urban Novak"]);
  await expect(panel.locator(".edit-wider-side-label")).toHaveText(["Father's side", "Father's side"]);

  // The depth controls start folded; the gear opens them.
  await expect(panel.locator(".edit-wider-depths")).toHaveCount(0);
  await panel.locator(".edit-wider-gear").click();

  // One more generation of other relatives brings the first cousin.
  await panel.locator(".edit-wider-depth", { hasText: "Other relatives" }).getByRole("button", { name: /more/ }).click();
  await expect(names).toHaveText(["Gregor Novak", "Gala Novak", "Urban Novak", "Cene Novak"]);

  // Partners of relatives: the uncle's wife, beside him.
  await panel.getByLabel("Partners of relatives").check();
  const inLaw = panel.locator(".edit-wider-person.in-law");
  await expect(inLaw).toContainText("Urša Lah");
  await expect(inLaw).toHaveAttribute("title", /partner of Urban Novak/);

  // A click opens the cousin; the toggle under Back closes and reopens the panel.
  await names.filter({ hasText: "Cene" }).click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Cene");
  const toggle = page.locator(".edit-wider-toggle");
  await toggle.click();
  await expect(panel).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(panel).toBeVisible();
});
