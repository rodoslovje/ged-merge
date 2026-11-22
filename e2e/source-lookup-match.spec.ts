import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import path from "path";
import { tmpdir } from "./tmpdir";

// A bare FamilySearch image link matches a source of the file only through
// what the page lookup answers (the collection). Once matched, the dialog must
// stay matched: dropping the answer on the match used to lose the match again,
// and the form flipped between the full entry and the match hint forever.
const FILE = path.join(tmpdir(), "source-lookup-match.ged");
const LINK = "https://www.familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS?cc=2040054&lang=en&i=555";
const COLLECTION = "Croatia, Church Books, 1516-1994";

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Blaž /Kern/", "1 SEX M",
    "0 @S1@ SOUR", `1 TITL ${COLLECTION}`,
    "0 TRLR",
  ].join("\n"),
);

const ARK_JSON = JSON.stringify({
  links: { self: { offset: 556, results: 689 } },
  sourceDescriptions: [
    {
      resourceType: "http://gedcomx.org/DigitalArtifact",
      citations: [
        {
          value:
            `"${COLLECTION}," database with images, <i>FamilySearch</i> ` +
            "(https://familysearch.org/ark:/61903/3:1:3QSQ-G99F-FHWS?cc=2040054 : 16 July 2014), " +
            "Roman Catholic (Rimokatolička crkva) > Pakrac > Births (Rođeni) 1892-1899 > image 556 of 689; " +
            "Arhiva Hrvatske u Zagrebu (Croatia State Archives), Zagreb.\n",
        },
      ],
    },
    { resourceType: "http://gedcomx.org/Collection", titles: [{ value: COLLECTION }] },
  ],
});

test("a link the lookup matches to an existing source stays matched", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
  });
  await page.route(/familysearch\.org\/das\//, (route) => route.fulfill({ status: 404, body: "" }));
  await page.route(/familysearch\.org\/ark:/, (route) =>
    route.fulfill({ contentType: "application/json", headers: { "access-control-allow-origin": "*" }, body: ARK_JSON }),
  );

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-name-input").first()).toHaveValue("Blaž");

  await page.locator(".edit-name-chip-add", { hasText: "Add Source" }).first().click();
  const dialog = page.locator(".add-source-dialog");
  await dialog.locator(".add-source-textarea").fill(LINK);
  await expect(dialog).toContainText(`Matches existing source “${COLLECTION}”`);

  // Settled: the hint stays and the full entry form never comes back.
  const hint = page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        let flips = 0;
        const dialog = document.querySelector(".add-source-dialog")!;
        const obs = new MutationObserver(() => flips++);
        obs.observe(dialog, { childList: true, subtree: true });
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(() => (obs.disconnect(), resolve(flips)), 500)));
      }),
  );
  expect(await hint).toBe(0);
});
