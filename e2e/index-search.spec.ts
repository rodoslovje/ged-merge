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
    date_of_birth: "6 JUN 1861", place_of_birth: "Beltinci", parents_list: null, partners_list: null,
    links: ["https://data.matricula-online.eu/sl/slovenia/maribor/beltinci/00050/?pg=1"],
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
    same_as: [
      { contributor: "Mamić", ext_id: "@I7@", name: "Janez", surname: "Penko" },
      { contributor: "Hawlina", ext_id: "@I8@", name: "Janez", surname: "Penko" },
      { contributor: "Penko", ext_id: "@I1@", name: "Janez", surname: "Penko" },
    ],
  },
  {
    // The same Janez in another tree: grouped under the Bandelj record.
    id: 3, ext_id: "@I7@", contributor: "Mamić", name: "Janez", surname: "Penko", sex: "m",
    date_of_birth: "1862", parents_list: null, partners_list: null, links: null,
    same_as: [{ contributor: "Bandelj", ext_id: "@I19364@", name: "Janez", surname: "Penko" }],
  },
  {
    // A second record of him in the same tree: one "Mamić ×2", not two.
    id: 4, ext_id: "@I9@", contributor: "Mamić", name: "Janez", surname: "Penko", sex: "m",
    date_of_birth: "ABT 1862", parents_list: null, partners_list: null, links: null,
    same_as: [{ contributor: "Bandelj", ext_id: "@I19364@", name: "Janez", surname: "Penko" }],
  },
];

async function openPerson(page: Page, fetch: boolean, more: Record<string, unknown> = {}): Promise<string[]> {
  const asked: string[] = [];
  await page.addInitScript(([on, extra]) => {
    // The Relatives rail open, as a reader may have left it; the reader's own
    // tree on the index named.
    localStorage.setItem(
      "gedmerge.settings",
      JSON.stringify({ allowLinkFetch: on, widerFamily: { open: true }, indexContributor: "Penko", ...extra }),
    );
  }, [fetch, more] as const);
  await page.route(/indeks-api\.(rodoslovje\.si|rodoslovlje\.hr)\//, async (route) => {
    asked.push(route.request().url());
    await route.fulfill({
      contentType: "application/json",
      headers: { "X-Total-Count": "312", "Access-Control-Expose-Headers": "X-Total-Count" },
      body: JSON.stringify(HITS),
    });
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
  // One person in three trees: the reader's own (marked), Mamić (a hit), Hawlina.
  await expect(hits.first()).toContainText("Already in your tree");
  await expect(hits.first().locator(".person-search-also")).toHaveText("Also in: Mamić ×2 · Hawlina");
  await expect(page.locator(".edit-wider-count")).toHaveText("312");
  // What agrees stays plain (the same birth; "Petelinje" and "Petelinje,
  // Vojvodina Kranjska" name one village; the father); what the person lacks
  // is marked new.
  const first = hits.first();
  await expect(first.locator(".person-search-mark.differs")).toHaveCount(0);
  await expect(first.locator(".person-search-mark.adds")).toHaveText(["5 APR 1927", "Petelinje", "Jožefa Čelhar", "Marija Penko"]);
  await expect(first.locator(".person-search-mark.adds").first()).toHaveAttribute("title", "Not in your file yet");
  // A register transcription shows as the genealogist with the register's icon.
  const register = hits.nth(1).locator(".person-search-contributor");
  await expect(register).toHaveText("⛪Markovič");
  await expect(register).toHaveAttribute("title", "Parish-register index (Matricula) — Markovič\nOpen the genealogist's page on the index");
  await expect(register).toHaveAttribute("href", "https://indeks.rodoslovje.si/?t=contributors&c=Markovi%C4%8D");
  await expect(page.locator("#edit-search")).toContainText("The index has 312 matches for this search; the best 4 are ranked here.");
  expect(asked).toHaveLength(1);
  expect(asked[0]).toContain("surname=Penko");
  expect(asked[0]).toContain("exclude_contributor=Penko");
  expect(asked[0]).toContain("same_as=true");
  expect(asked[0]).not.toContain("place");

  // A hit opens into a comparison with the person, in the rail.
  await hits.first().getByRole("button", { name: "Compare" }).click();
  const compare = page.locator(".person-search-compare");
  await expect(compare).toContainText("1 / 4");
  const death = compare.locator("tr.field.incoming-only", { hasText: "1927" });
  await expect(death).toHaveCount(1);
  await expect(compare.locator("tr.field.agree", { hasText: "Penko" }).first()).toBeVisible();

  // Step through the same person's records in other trees (both of Mamić's),
  // then on to the next person, and back.
  const next = compare.getByRole("button", { name: "Next match" });
  const prev = compare.getByRole("button", { name: "Previous match" });
  await next.click();
  await expect(compare).toContainText("2 / 4");
  await expect(compare).toContainText("Mamić");
  await next.click();
  await expect(compare).toContainText("3 / 4");
  await expect(compare).toContainText("Mamić");
  await next.click();
  await expect(compare).toContainText("Ivan Benko");
  for (let i = 0; i < 3; i++) await prev.click();
  await expect(compare).toContainText("1 / 4");
  await expect(compare).toContainText("Bandelj");

  // Cite it: Add source opens with the hit's index link.
  await compare.getByRole("button", { name: "Add as source" }).click();
  await expect(page.locator(".add-source-dialog .add-source-textarea")).toHaveValue(/indeks\.rodoslovje\.si\/\?t=person.*id=%40I19364%40&c=Bandelj/);
  // Recognized as an index person link: the source proposes its own title.
  await expect(page.locator(".add-source-dialog").getByLabel("Title")).toHaveValue(/Janez Penko.*Bandelj.*Slovenski rodoslovni indeks/);
  await page.keyboard.press("Escape");

  await compare.getByRole("button", { name: /Back to the matches/ }).click();
  await expect(hits).toHaveCount(2);

  // Approximate off (the index's Exact): asked again, exactly.
  await expect(page.getByRole("checkbox", { name: "Approximate" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Approximate" }).uncheck();
  await expect(hits).toHaveCount(2);
  await expect.poll(() => asked.length).toBe(2);
  expect(asked[1]).toContain("exact=true");
  await expect(page.getByRole("link", { name: "Slovenian index" })).toHaveAttribute("href", /ex=1/);
});

test("ticked rows are copied into the person, citing the hit", async ({ page }) => {
  await openPerson(page, true);
  const hits = page.locator(".person-search-hit");
  await hits.first().getByRole("button", { name: "Compare" }).click();
  const compare = page.locator(".person-search-compare");
  const copy = compare.getByRole("button", { name: /Copy selected/ });
  await expect(copy).toBeDisabled();

  // One tick on the Death heading takes its date and place.
  await compare.getByRole("checkbox", { name: "Take Death" }).check();
  await expect(copy).toHaveText("Copy selected (2)");
  await expect(compare.getByRole("checkbox", { name: "Cite the index as the source" })).toBeChecked();
  await copy.click();

  // The person now has the death, cited from the index; the comparison agrees.
  const personPanel = page.locator(".edit-person");
  await expect(personPanel).toContainText("1862–1927");
  // The death's source: the index's own card-index glyph.
  await expect(personPanel).toContainText("📇");
  await expect(compare.locator("tr.field.agree", { hasText: "5 APR 1927" })).toHaveCount(1);
  await expect(copy).toBeDisabled();

  // A register transcription's own page shows in its comparison.
  const next = compare.getByRole("button", { name: "Next match" });
  for (let i = 0; i < 3; i++) await next.click();
  await expect(compare).toContainText("Ivan Benko");
  await expect(compare.locator('a[href*="matricula-online.eu"]')).toHaveCount(1);
});

test("the search sites follow their switches, the Croatian index with hits of its own", async ({ page }) => {
  // Croatian index on (off by default), Geni off.
  const asked = await openPerson(page, true, { searchSites: { indexHr: true, geni: false }, indexContributorHr: "Horvat" });
  const panel = page.locator("#edit-search");
  await expect(panel.getByRole("link", { name: "Croatian index" })).toHaveAttribute("href", /^https:\/\/indeks\.rodoslovlje\.hr\/\?t=person&n=Janez&sn=Penko/);
  await expect(panel.getByRole("link", { name: "Slovenian index" })).toBeVisible();
  await expect(panel.getByRole("link", { name: "Geni" })).toHaveCount(0);
  // Each index lists its own hits, under its own heading.
  await expect(panel.locator(".person-search-index")).toHaveCount(2);
  await expect(panel.locator(".person-search-hit")).toHaveCount(4);
  expect(asked.some((u) => u.includes("indeks-api.rodoslovlje.hr") && u.includes("exclude_contributor=Horvat"))).toBe(true);
  expect(asked.some((u) => u.includes("indeks-api.rodoslovje.si") && u.includes("exclude_contributor=Penko"))).toBe(true);
  // A Croatian hit's links point to the Croatian index.
  const hr = panel.locator(".person-search-index").nth(1);
  await expect(hr.locator(".person-search-contributor").first()).toHaveAttribute("href", /^https:\/\/indeks\.rodoslovlje\.hr\//);
  // Its comparison takes the rail; the Slovenian list steps aside.
  await hr.getByRole("button", { name: "Compare" }).first().click();
  await expect(panel.locator(".person-search-index").first()).toBeHidden();
  await expect(hr.locator(".person-search-compare thead th").last()).toHaveText("Croatian index");

  // Switched off in Settings: the Croatian index is gone from the rail.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Advanced" }).click();
  await page.getByRole("checkbox", { name: "Croatian index" }).uncheck();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("link", { name: "Croatian index" })).toHaveCount(0);
  await expect(panel.locator(".person-search-index")).toHaveCount(1);
  await expect(panel.locator(".person-search-index").first()).toBeVisible();
});
