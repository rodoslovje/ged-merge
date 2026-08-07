import { test, expect } from "@playwright/test";
import { writeFileSync } from "fs";
import os from "os";
import path from "path";

// The geocode page for a file that keeps its addresses in the place value —
// the shape a Slovenian file most often has. Three things this guards:
//
//  - a place value that is really a house ("Črni vrh 35") is reviewed under its
//    settlement in the address list, and is *not* also a row of the place list;
//  - one house written two ways (the same number under two parishes) is a
//    single row;
//  - the page's filter narrows both lists at once, ignoring diacritics.

const FILE = path.join(os.tmpdir(), "geocode-addresses.ged");

writeFileSync(
  FILE,
  [
    "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
    "0 @I1@ INDI", "1 NAME Ana /Kos/",
    "1 BIRT", "2 PLAC Črni vrh 35",
    "1 RESI", "2 PLAC Črni vrh 46",
    "1 DEAT", "2 PLAC Črni vrh",
    "0 @I2@ INDI", "1 NAME Bo /Kos/",
    // One house, two spellings — the parish differs, the building does not.
    "1 BIRT", "2 PLAC Kranj (Slovenija), Stražišče 114 - župnija Šmartin",
    "1 DEAT", "2 PLAC Kranj (Slovenija), Stražišče 114 - župnija Kranj",
    "0 TRLR", "",
  ].join("\n"),
  "utf-8",
);

test("houses in the place value are grouped under their settlement, and the filter reaches both lists", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();

  // The list renders through the virtual-list spacers — count real rows only.
  const places = page.locator(".tools-geocode .tools-tree > li:not(.v-spacer)");
  const groups = page.locator(".tools-geo-addr-group");

  // The place list holds the settlements only: "Črni vrh" (the place-only
  // death) and "Kranj, Slovenija" is not one of the file's values, so the one
  // place row left is Črni vrh. The houses are not listed here at all.
  await expect(places).toHaveCount(1);
  await expect(places.first()).toContainText("Črni vrh");
  await expect(places.first()).not.toContainText("35");

  // Two groups: Črni vrh with its two houses, Kranj with the merged one.
  await expect(groups).toHaveCount(2);
  await expect(groups.filter({ hasText: "Kranj, Slovenija" })).toContainText("1 addresses");

  // Both are marked as keeping the address inside the place value, so neither
  // offers the move.
  await expect(page.getByRole("button", { name: /Move to another place/ })).toHaveCount(0);

  // The filter narrows both lists at once — and without the diacritics.
  await page.locator(".tools-geocode .tools-search-input").fill("crni");
  await expect(places).toHaveCount(1);
  await expect(groups).toHaveCount(1);
  await expect(groups.first()).toContainText("Črni vrh");

  // A house number reaches into the groups: the place list has nothing to show,
  // and says so rather than looking empty.
  await page.locator(".tools-geocode .tools-search-input").fill("114");
  await expect(places).toHaveCount(0);
  await expect(page.getByText("No matches.")).toBeVisible();
  await expect(groups).toHaveCount(1);
  // The addresses sit behind their own tab; the filter kept the group and
  // opened it, so switching over shows the address searched for.
  await page.getByRole("tab", { name: /Addresses/ }).click();
  // A filter landing on one place opens it, so the address searched for shows.
  await expect(page.getByText("Stražišče 114")).toBeVisible();
});

test("a fully placed place hides from the worklist and returns behind the toggle", async ({ page }) => {
  const file = path.join(os.tmpdir(), "geocode-placed-places.ged");
  writeFileSync(
    file,
    [
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/",
      // Every occurrence of Ljubljana carries its coordinate — finished work.
      "1 BIRT", "2 PLAC Ljubljana, Slovenija",
      "3 MAP", "4 LATI N46.05108", "4 LONG E14.50513",
      // Kranj still needs one — the worklist's only row.
      "1 DEAT", "2 PLAC Kranj, Slovenija",
      "0 TRLR", "",
    ].join("\n"),
    "utf-8",
  );

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();

  // Only the unplaced value is on the list; no "Already placed" chip yet.
  const places = page.locator(".tools-geocode .tools-tree > li:not(.v-spacer)");
  await expect(places).toHaveCount(1);
  await expect(places.first()).toContainText("Kranj");
  await expect(page.getByRole("button", { name: /Already placed/ })).toHaveCount(0);

  // The toggle brings the placed row back, marked as placed and staged by
  // nothing until a different coordinate is picked — and the chip counts it.
  await page.getByText("Show already placed").click();
  await expect(places).toHaveCount(2);
  const placedRow = places.filter({ hasText: "Ljubljana" });
  await expect(placedRow).toContainText("placed");
  await expect(placedRow).toContainText("46.0511, 14.5051");
  await expect(placedRow.locator(".tools-geo-coord-btn.staged")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Already placed/ })).toContainText("1");

  // Unticking puts the finished work away again.
  await page.getByText("Show already placed").click();
  await expect(places).toHaveCount(1);
});

test("staged picks survive a trip to Edit, including a stray Escape there", async ({ page }) => {
  const file = path.join(os.tmpdir(), "geocode-staged-state.ged");
  writeFileSync(
    file,
    [
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/",
      // One occurrence carries the coordinate, one is missing — a confident
      // "from this file" row Select confident can stage.
      "1 BIRT", "2 PLAC Kranj, Slovenija",
      "3 MAP", "4 LATI N46.23887", "4 LONG E14.35561",
      "1 DEAT", "2 PLAC Kranj, Slovenija",
      "1 RESI", "2 PLAC Novo mesto, Slovenija",
      "0 TRLR", "",
    ].join("\n"),
    "utf-8",
  );

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();

  await page.getByRole("button", { name: /Select confident/ }).click();
  const staged = page.locator(".tools-geocode .tools-geo-coord-btn.staged");
  await expect(staged).toHaveCount(1);

  // A detour through Edit, with an Escape pressed on the page body there —
  // the hidden geocode panel must not treat it as its own "go back" (that
  // used to unmount the panel and drop every staged tick).
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".edit-person").first()).toBeVisible();
  await page.locator("body").press("Escape");
  await page.getByRole("button", { name: "Tools", exact: true }).click();

  await expect(page.locator(".tools-geocode")).toBeVisible();
  await expect(staged).toHaveCount(1);
});

test("an address with no house number is reviewed too, with nothing to look up", async ({ page }) => {
  const file = path.join(os.tmpdir(), "geocode-no-number.ged");
  writeFileSync(
    file,
    [
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/",
      // The hamlet is in the ADDR line, with no number — the register cannot be
      // asked, and the place value names only the town, so nothing else in the
      // app can place this event.
      "1 BIRT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče",
      "1 DEAT", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče 114",
      "0 TRLR", "",
    ].join("\n"),
    "utf-8",
  );

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();

  const group = page.locator(".tools-geo-addr-group").filter({ hasText: "Kranj, Slovenija" });
  await group.locator(".tools-pair-toggle").first().click();
  const rows = group.locator(".tools-geo-addr-row");
  await expect(rows).toHaveCount(2);

  // The bare hamlet says there is nothing to ask the register (the numbered
  // house says no such thing — online lookups being opt-in is a separate
  // matter), and the chip counts exactly the one row.
  await expect(rows.filter({ hasText: /Stražišče(?! 114)/ })).toContainText("nothing to look up");
  await expect(rows.filter({ hasText: "Stražišče 114" })).not.toContainText("nothing to look up");
  await expect(page.getByRole("button", { name: /By hand only/ })).toContainText("1");
});

test("a house already placed says so, and its coordinate opens the panel", async ({ page }) => {
  const file = path.join(os.tmpdir(), "geocode-placed.ged");
  writeFileSync(
    file,
    [
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/",
      // Kranj's own position: the event that names no address.
      "1 BIRT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.23887", "4 LONG E14.35573",
      // Two houses of one hamlet, placed together at its centre.
      "1 RESI", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.21806", "4 LONG E14.36897", "2 ADDR Drulovka 2",
      "1 DEAT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.21806", "4 LONG E14.36897", "2 ADDR Drulovka 4",
      // And one that has had nothing done to it.
      "1 CENS", "2 PLAC Kranj, Slovenija", "2 ADDR Cesta na Klanec 55",
      "0 TRLR", "",
    ].join("\n"),
    "utf-8",
  );

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();

  const group = page.locator(".tools-geo-addr-group").first();
  await group.locator(".tools-pair-toggle").first().click();

  // Placed houses are finished work and stay off the list by default — the
  // worklist holds only the house that has had nothing done to it, and the
  // "Already placed" chip is gone with them.
  await expect(group.locator(".tools-geo-addr-row")).toHaveCount(1);
  await expect(page.getByRole("button", { name: /Already placed/ })).toHaveCount(0);

  // Ticking "Show already placed" lists the hamlet's two placed houses again;
  // the third is still not placed, and the returned chip counts exactly the two.
  await page.getByText("Show already placed").click();
  // A placed house wears the same "placed" chip a placed place row does.
  const placed = group.locator(".tools-geo-addr-row").filter({ has: page.locator(".tools-reshape-badge") });
  await expect(placed).toHaveCount(2);
  await expect(placed.first()).toContainText("46.21806, 14.36897");
  await expect(
    group.locator(".tools-geo-addr-row").filter({ hasText: "Cesta na Klanec 55" }).locator(".tools-reshape-badge"),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Already placed/ })).toContainText("2");

  // Its position is also the way in: one click opens the coordinate panel, with
  // the point on its own map, so a rough placement can be sharpened.
  await expect(page.locator(".edit-coord-pop")).toHaveCount(0);
  await placed.first().locator(".tools-geo-coord-btn").click();
  await expect(page.locator(".edit-coord-pop")).toBeVisible();
  await expect(page.locator(".edit-coord-pop .leaflet-interactive").first()).toBeVisible({ timeout: 15000 });
});

test("a position staged for a house survives renaming that house's address", async ({ page }) => {
  const file = path.join(os.tmpdir(), "geocode-rename-pick.ged");
  writeFileSync(
    file,
    [
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/",
      // The settlement's own position, and one house that merely inherits it —
      // the row this test places and renames.
      "1 BIRT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.23887", "4 LONG E14.35573",
      "1 RESI", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.23887", "4 LONG E14.35573", "2 ADDR Drulovka 2",
      // A second house, so the list still has a row after the first is placed.
      "1 DEAT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.23887", "4 LONG E14.35573", "2 ADDR Drulovka 4",
      "0 TRLR", "",
    ].join("\n"),
    "utf-8",
  );

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();

  const group = page.locator(".tools-geo-addr-group").first();
  await group.locator(".tools-pair-toggle").first().click();
  const row = group.locator(".tools-geo-addr-row").filter({ hasText: "Drulovka 2" });

  // Place the house by hand: the address opens the coordinate panel.
  await row.locator(".tools-geo-addr-name").click();
  await page.locator(".edit-coord-manual input").fill("46.11111, 14.22222");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect(row.locator(".tools-geo-picked-from")).toHaveText(/manual/i);
  await expect(page.getByRole("button", { name: /Write coordinates \(1\)/ })).toBeEnabled();

  // Correcting the spelling afterwards is about the name, not the position:
  // the staged pick has to travel to the renamed row, or it is lost silently
  // and only the rename reaches the file.
  await row.locator(".tools-geo-addr-head").hover();
  await row.getByTitle(/Rename/).click();
  await row.locator(".tools-place-rename-input").fill("Drulovka 2a");
  await row.getByRole("button", { name: "Rename", exact: true }).click();

  const renamed = group.locator(".tools-geo-addr-row").filter({ hasText: "Drulovka 2a" });
  await expect(renamed.locator(".tools-geo-picked-from")).toHaveText(/manual/i);
  const write = page.getByRole("button", { name: /Write coordinates \(1\)/ });
  await expect(write).toBeEnabled();
  await write.click();
  await expect(page.getByText("1 record updated")).toBeVisible();
  // Placed at the position staged before the rename — the house is now
  // house-precise, so it leaves the list of addresses still to place.
  await expect(group.locator(".tools-geo-addr-row").filter({ hasText: "Drulovka 2a" })).toHaveCount(0);
});

test("OpenStreetMap answers the addresses the register cannot take", async ({ page }) => {
  const file = path.join(os.tmpdir(), "geocode-osm-fallback.ged");
  writeFileSync(
    file,
    [
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/",
      "1 BIRT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.23887", "4 LONG E14.35573",
      // A hamlet with no house number: the address register has no question to
      // ask, so this row used to say "nothing to look up" and stop there.
      "1 RESI", "2 PLAC Kranj, Slovenija", "2 ADDR Stražišče",
      // A second house, so the list still has a row after the first is placed.
      "1 DEAT", "2 PLAC Kranj, Slovenija", "2 ADDR Drulovka 4",
      "0 TRLR", "",
    ].join("\n"),
    "utf-8",
  );

  // Online lookups are opt-in; the service itself is stubbed, so the test never
  // reaches nominatim.openstreetmap.org.
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
  });
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        {
          lat: "46.24500",
          lon: "14.33500",
          name: "Stražišče",
          display_name: "Stražišče, Kranj, Slovenija",
          type: "suburb",
          address: { suburb: "Stražišče", municipality: "Kranj", country: "Slovenija" },
        },
      ]),
    }),
  );

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();

  const group = page.locator(".tools-geo-addr-group").first();
  await group.locator(".tools-pair-toggle").first().click();
  const row = group.locator(".tools-geo-addr-row").filter({ hasText: "Stražišče" });

  // The register offers nothing here; OpenStreetMap does, and its hit is a
  // candidate like any other — badged so its provenance stays visible.
  await expect(row.getByRole("button", { name: /Search address register/ })).toHaveCount(0);
  await row.getByRole("button", { name: "Search OpenStreetMap" }).click();
  const candidate = row.locator(".tools-geo-candidates li").filter({ hasText: "Stražišče, Kranj" });
  await expect(candidate).toBeVisible();
  await expect(candidate).toContainText("OSM");
  await expect(candidate).toContainText("46.24500, 14.33500");

  // The number is the row's radio — clicking it stages the answer.
  await candidate.locator(".tools-geo-cand-num").click();
  const write = page.getByRole("button", { name: /Write coordinates \(1\)/ });
  await expect(write).toBeEnabled();
  await write.click();
  await expect(page.getByText("1 record updated")).toBeVisible();
});

test("hits that share a name are told apart by what they are, and numbered onto one map", async ({ page }) => {
  const file = path.join(os.tmpdir(), "geocode-osm-samename.ged");
  writeFileSync(
    file,
    [
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/",
      "1 BIRT", "2 PLAC Kranj, Slovenija", "3 MAP", "4 LATI N46.23958", "4 LONG E14.35629",
      "1 RESI", "2 PLAC Kranj, Slovenija", "2 ADDR Huje",
      "0 TRLR", "",
    ].join("\n"),
    "utf-8",
  );

  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
  });
  // What OpenStreetMap really answers for "Huje, Kranj": the suburb, the street
  // named after it, and a service road off that street — three rows whose
  // display lines are word for word the same.
  await page.route("**/nominatim.openstreetmap.org/**", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify([
        { lat: "46.2424418", lon: "14.3613533", name: "Huje", display_name: "Huje, Kranj, 4000, Slovenija", category: "place", type: "suburb" },
        { lat: "46.2407809", lon: "14.3591113", name: "Huje", display_name: "Huje, Kranj, 4000, Slovenija", category: "highway", type: "residential" },
        { lat: "46.2423203", lon: "14.3597308", name: "Huje", display_name: "Huje, Kranj, 4000, Slovenija", category: "highway", type: "service" },
      ]),
    }),
  );

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();

  const group = page.locator(".tools-geo-addr-group").first();
  await group.locator(".tools-pair-toggle").first().click();
  const row = group.locator(".tools-geo-addr-row").filter({ has: page.getByRole("button", { name: "Huje", exact: true }) });
  await row.getByRole("button", { name: "Search OpenStreetMap" }).click();

  const candidates = row.locator(".tools-geo-candidates li");
  await expect(candidates).toHaveCount(3);
  // The display lines are identical, so what each hit *is* carries the answer,
  // and the numbers tie each line to its pin.
  await expect(candidates.nth(0)).toContainText("suburb");
  await expect(candidates.nth(1)).toContainText("residential street");
  await expect(candidates.nth(2)).toContainText("service road");
  await expect(candidates.locator(".tools-geo-cand-num")).toHaveText(["1", "2", "3"]);

  // Any answer's coordinate opens the row's own panel, which draws all three
  // under those same numbers — the map is what tells them apart.
  await candidates.nth(2).locator(".tools-geo-coord-btn").click();
  const pop = page.locator(".edit-coord-pop");
  await expect(pop).toBeVisible();
  await expect(pop.locator(".edit-coord-results .tools-geo-cand-num")).toHaveText(["1", "2", "3"]);
  await expect(pop.locator(".mini-pin-badge")).toHaveCount(3);
});

test("the lookup answers in the language the file writes, not the interface's", async ({ page }) => {
  const file = path.join(os.tmpdir(), "geocode-osm-language.ged");
  writeFileSync(
    file,
    [
      "0 HEAD", "1 GEDC", "2 VERS 5.5.1", "1 CHAR UTF-8",
      "0 @I1@ INDI", "1 NAME Ana /Kos/",
      // Two places, two languages: an American one written in English, and a
      // Slovenian one written in Slovenian. The interface is English here, so
      // the second is the one that proves the language follows the file.
      "1 BIRT", "2 PLAC Joliet, Will, Illinois, United States", "2 ADDR Parks Avenue",
      "1 DEAT", "2 PLAC Kranj, Slovenija", "2 ADDR Huje",
      "0 TRLR", "",
    ].join("\n"),
    "utf-8",
  );

  const asked: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("gedmerge.settings", JSON.stringify({ allowLinkFetch: true }));
  });
  await page.route("**/nominatim.openstreetmap.org/**", (route) => {
    asked.push(route.request().url());
    return route.fulfill({ contentType: "application/json", body: "[]" });
  });

  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(file);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();

  for (const group of await page.locator(".tools-geo-addr-group").all()) {
    await group.locator(".tools-pair-toggle").first().click();
  }
  const search = page.getByRole("button", { name: "Search OpenStreetMap" });
  // The button goes once its row has an answer, so the list shrinks under the
  // loop: take the count first, and always click whichever is left.
  const rows = await search.count();
  for (let i = 0; i < rows; i++) {
    await search.first().click();
    // Nominatim allows one request a second and the client queues to match.
    await expect.poll(() => asked.length, { timeout: 10000 }).toBe(i + 1);
  }

  const query = (part: string) => asked.find((u) => decodeURIComponent(u).includes(part)) ?? "";
  expect(query("United States")).toContain("accept-language=en");
  expect(query("Kranj, Slovenija")).toContain("accept-language=sl");
});

test("one coordinate can be given to a whole place's addresses at once", async ({ page }) => {
  await page.goto("/");
  await page.locator("input.file-input").first().setInputFiles(FILE);
  await page.locator(".edit-person").first().waitFor({ timeout: 15000 });

  await page.getByRole("button", { name: "Tools", exact: true }).click();
  await page.getByText("Places", { exact: true }).click();
  await page.getByRole("button", { name: /Geocoding/ }).click();
  await page.getByRole("tab", { name: /Addresses/ }).click();

  // Črni vrh keeps its two houses in the place values; neither is in any
  // register, which is the case this flow exists for.
  const group = page.locator(".tools-geo-addr-group").filter({ hasText: "Črni vrh" });
  await group.locator(".tools-pair-toggle").first().click();
  await group.getByRole("button", { name: /Place several at one coordinate/ }).click();

  // Both addresses are ticked to begin with, and nothing can be taken until a
  // position is chosen — the file gives this place none.
  const take = group.getByRole("button", { name: /Take this for/ });
  await expect(take).toBeDisabled();

  // The panel's own picker, not the per-row ones below it.
  await group.locator(".tools-geo-addr-move .edit-event-coord").click();
  await page.locator(".edit-coord-manual input").fill("46.10101, 14.20202");
  await page.getByRole("button", { name: "Set", exact: true }).click();
  await expect(take).toBeEnabled();

  // The position beside the pin opens the same panel — the coordinate on
  // screen is the thing being changed, and every address row is opened by
  // clicking exactly this.
  await group.locator(".tools-geo-addr-move .tools-place-rename-hint").first().click();
  await expect(page.locator(".edit-coord-pop")).toBeVisible();
  await page.keyboard.press("Escape");

  // A prefix narrows the ticks to the houses that start with it — folded, so
  // "crni vrh 4" reaches "Črni vrh 46" — and clearing it ticks the place again.
  await group.locator(".tools-geo-addr-chip-input").fill("crni vrh 4");
  await expect(group.getByRole("button", { name: /Take this for 1 address/ })).toBeEnabled();
  await group.locator(".tools-geo-addr-chip-clear").click();
  await expect(take).toBeEnabled();
  await take.click();

  // Each row now says where its position came from, so a village staged in one
  // go can be read off the list instead of one tooltip at a time.
  await expect(group.locator(".tools-geo-picked-from")).toHaveCount(2);
  await expect(group.locator(".tools-geo-picked-from").first()).toHaveText(/manual/i);

  // Staged for both houses, then written in one step.
  const write = page.getByRole("button", { name: /Write coordinates \(2\)/ });
  await expect(write).toBeEnabled();
  await write.click();
  await expect(page.getByText(/\d+ records? updated/)).toBeVisible();
});
