import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// Search elsewhere from Edit: the prefilled search pages, the index's hits
// ranked against the person (the API is faked here), and "Compare", which
// loads one hit as the incoming file and opens its pair in Merge.
const FILE = path.join(tmpdir(), "index-search.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Janez /Penko/", "1 SEX M",
    "1 BIRT", "2 DATE 4 MAY 1862", "2 PLAC Petelinje", "1 FAMC @F1@",
    "0 @I2@ INDI", "1 NAME Jurij /Penko/", "1 SEX M", "1 BIRT", "2 DATE 11 APR 1820", "1 FAMS @F1@",
    "0 @F1@ FAM", "1 HUSB @I2@", "1 CHIL @I1@",
    "0 TRLR",
  ].join("\n"),
);

const HITS = [
  {
    id: 2, ext_id: "eb4c3216", contributor: "Markovič-matricula", name: "Ivan", surname: "Benko", sex: "",
    date_of_birth: "6 JUN 1861", place_of_birth: "Beltinci", parents_list: null, partners_list: null, links: null,
  },
  {
    id: 1, ext_id: "@I19364@", contributor: "Bandelj", name: "Janez", surname: "Penko", sex: "m",
    date_of_birth: "4 MAY 1862", place_of_birth: "Petelinje, Vojvodina Kranjska",
    date_of_death: "5 APR 1927", place_of_death: "Petelinje",
    parents_list: [
      { id: "@I19012@", sex: "m", name: "Jurij", surname: "Penko", date_of_birth: "11 APR 1820" },
      { id: "@I18998@", sex: "f", name: "Jožefa", surname: "Čelhar", date_of_birth: "11 FEB 1831" },
    ],
    partners_list: [{ id: "@I19369@", sex: "f", name: "Marija", surname: "Penko", date_of_birth: "23 AUG 1865" }],
    links: null,
  },
];

async function openPerson(page: Page, fetch: boolean): Promise<string[]> {
  const asked: string[] = [];
  await page.addInitScript((on) => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: on }));
  }, fetch);
  await page.route("**/indeks-api.rodoslovje.si/**", async (route) => {
    asked.push(route.request().url());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(HITS) });
  });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  await page.locator(".edit-search-btn").click();
  return asked;
}

test("the search panel prefills the other sites and stays offline with lookups off", async ({ page }) => {
  const asked = await openPerson(page, false);
  const panel = page.locator(".person-search");
  await expect(panel.getByRole("link", { name: "FamilySearch tree" })).toHaveAttribute(
    "href",
    /familysearch\.org\/search\/tree\/results\?q\.givenName=Janez&q\.surname=Penko&q\.birthLikeDate\.from=1860&q\.birthLikeDate\.to=1864/,
  );
  await expect(panel.getByRole("link", { name: "WikiTree" })).toHaveAttribute("href", /wpFirst=Janez&wpLast=Penko/);
  await expect(panel.getByRole("link", { name: "Geni" })).toHaveAttribute("href", /names=Janez\+Penko/);
  await expect(panel).toContainText("Look up details online");
  await expect(panel.getByRole("button", { name: "Search the index here" })).toHaveCount(0);
  expect(asked).toEqual([]);
});

test("index hits are ranked against the person and Compare opens the pair in Merge", async ({ page }) => {
  const asked = await openPerson(page, true);
  await page.getByRole("button", { name: "Search the index here" }).click();
  const hits = page.locator(".person-search-hit");
  await expect(hits).toHaveCount(2);
  await expect(hits.first()).toContainText("Janez Penko");
  await expect(hits.first()).toContainText("Jurij Penko");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("surname=Penko");
  expect(asked[0]).not.toContain("place");

  await hits.first().getByRole("button", { name: "Compare" }).click();
  await expect(page.locator(".candidate.selected")).toContainText("Janez Penko");
  await expect(page.locator(".compare-panel").first()).toBeVisible();
});
