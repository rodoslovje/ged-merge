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
    // The Relatives rail open, as a reader may have left it.
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: on, widerFamily: { open: true } }));
  }, fetch);
  await page.route("**/indeks-api.rodoslovje.si/**", async (route) => {
    asked.push(route.request().url());
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(HITS) });
  });
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Janez");
  await expect(page.locator("#edit-wider")).toBeVisible();
  // The search takes the Relatives rail's place.
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.locator("#edit-search")).toBeVisible();
  await expect(page.locator("#edit-wider")).toHaveCount(0);
  return asked;
}

test("the search rail prefills the other sites and stays offline with lookups off", async ({ page }) => {
  const asked = await openPerson(page, false);
  const panel = page.locator("#edit-search");
  await expect(panel.getByRole("link", { name: "FamilySearch tree" })).toHaveAttribute(
    "href",
    /familysearch\.org\/search\/tree\/results\?q\.givenName=Janez&q\.surname=Penko&q\.birthLikeDate\.from=1860&q\.birthLikeDate\.to=1864/,
  );
  await expect(panel.getByRole("link", { name: "WikiTree" })).toHaveAttribute("href", /wpFirst=Janez&wpLast=Penko/);
  await expect(panel.getByRole("link", { name: "Geni" })).toHaveAttribute("href", /names=Janez\+Penko/);
  await expect(panel).toContainText("Look up details online");
  expect(asked).toEqual([]);

  // Relatives back: the search rail gives way.
  await page.getByRole("button", { name: "Relatives", exact: true }).click();
  await expect(page.locator("#edit-wider")).toBeVisible();
  await expect(page.locator("#edit-search")).toHaveCount(0);
});

test("turning lookups on with the rail open lists the index's hits", async ({ page }) => {
  const asked = await openPerson(page, false);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Advanced" }).click();
  await page.getByRole("checkbox", { name: /Look up details online/ }).check();
  await page.keyboard.press("Escape");
  await expect(page.locator(".person-search-hit")).toHaveCount(2);
  expect(asked).toHaveLength(1);
});

test("index hits are ranked against the person and compared with them one by one", async ({ page }) => {
  const asked = await openPerson(page, true);
  const hits = page.locator(".person-search-hit");
  await expect(hits).toHaveCount(2);
  await expect(hits.first()).toContainText("Janez Penko");
  await expect(hits.first()).toContainText("Jurij Penko");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("surname=Penko");
  expect(asked[0]).not.toContain("place");

  // A hit opens into a comparison with the person, in the rail.
  await hits.first().getByRole("button", { name: "Compare" }).click();
  const compare = page.locator(".person-search-compare");
  await expect(compare).toContainText("1 / 2");
  const death = compare.locator("tr.field.incoming-only", { hasText: "1927" });
  await expect(death).toHaveCount(1);
  await expect(compare.locator("tr.field.agree", { hasText: "Penko" }).first()).toBeVisible();

  // Step to the next hit and back to the list.
  await compare.getByRole("button", { name: "Next match" }).click();
  await expect(compare).toContainText("2 / 2");
  await expect(compare).toContainText("Ivan Benko");
  await compare.getByRole("button", { name: "Previous match" }).click();
  await expect(compare).toContainText("Janez Penko");

  // Cite it: Add source opens with the hit's index link.
  await compare.getByRole("button", { name: "Add as source" }).click();
  await expect(page.locator(".add-source-dialog .add-source-textarea")).toHaveValue(/indeks\.rodoslovje\.si\/\?t=person.*id=%40I19364%40&c=Bandelj/);
  // Recognized as an index person link: the source proposes its own title.
  await expect(page.locator(".add-source-dialog").getByLabel("Title")).toHaveValue(/Janez Penko.*Bandelj.*Slovenski rodoslovni indeks/);
  await page.keyboard.press("Escape");

  await compare.getByRole("button", { name: /Back to the matches/ }).click();
  await expect(hits).toHaveCount(2);
});
